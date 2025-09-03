#!/usr/bin/env tsx
/**
 * PriceCharting CSV Bulk Import System
 * Transform 71k+ raw CSV into normalized CardMint database
 * 
 * Features:
 * - Batched transactions for performance
 * - Pokemon-aware name/set parsing  
 * - Automatic normalization and FTS indexing
 * - Duplicate detection and merging
 * - Progress reporting and error handling
 */

import fs from 'fs';
import csv from 'csv-parser';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { createLogger } from '../src/utils/logger';

const log = createLogger('import-pricecharting');

interface PriceChartingRow {
  id: string;
  'console-name': string;
  'product-name': string;
  'loose-price': string;
  'cib-price': string;
  'new-price': string;
  'graded-price': string;
  'tcg-id': string;
  'release-date': string;
  'sales-volume': string;
}

interface ParsedCard {
  priceCharting_id: string;
  name: string;
  set_name: string;
  card_number: string;
  price_loose: number | null;
  price_cib: number | null;
  price_new: number | null;
  price_graded: number | null;
  tcg_player_id: string | null;
  release_date: string | null;
  sales_volume: number | null;
  raw_product_name: string;
  raw_console_name: string;
}

class PriceChartingImporter {
  private db: Database.Database;
  private batchSize = 1000;
  private processed = 0;
  private errors: string[] = [];

  // Prepared statements for performance
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private checkExistingStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    
    // Performance PRAGMAs for bulk import
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -80000'); // ~80MB
    this.db.pragma('busy_timeout = 5000');
    
    // Prepare UPSERT statement for canonical deduplication
    this.insertStmt = this.db.prepare(`
      INSERT INTO cards (
        id, name, set_name, card_number,
        price_usd, price_updated_at, price_charting_id, tcg_player_id,
        metadata, created_at, updated_at,
        normalized_name, normalized_set, normalized_number,
        image_url, captured_at, status
      ) VALUES (
        @id, @name, @set_name, @card_number,
        @price_usd, datetime('now'), @price_charting_id, @tcg_player_id,
        @metadata, datetime('now'), datetime('now'),
        @normalized_name, @normalized_set, @normalized_number,
        @image_url, datetime('now'), 'imported'
      )
      ON CONFLICT(id) DO UPDATE SET
        price_usd        = COALESCE(excluded.price_usd, cards.price_usd),
        price_updated_at = CASE WHEN excluded.price_usd IS NOT NULL THEN datetime('now') ELSE cards.price_updated_at END,
        price_charting_id= COALESCE(cards.price_charting_id, excluded.price_charting_id),
        tcg_player_id    = COALESCE(cards.tcg_player_id, excluded.tcg_player_id),
        metadata         = COALESCE(excluded.metadata, cards.metadata),
        updated_at       = datetime('now')
    `);

    // No longer needed - UPSERT handles everything
    this.checkExistingStmt = this.db.prepare('SELECT 1'); // Dummy
    this.updateStmt = this.db.prepare('SELECT 1'); // Dummy

    log.info('🏗️ PriceCharting importer initialized with prepared statements');
  }

  /**
   * Parse Pokemon product name into components
   * Examples:
   *   "Charizard #6" → name: "Charizard", number: "6" 
   *   "Pikachu - Base Set #25" → name: "Pikachu", set: "Base Set", number: "25"
   */
  private parseProductName(productName: string, consoleName: string): {
    name: string;
    set_name: string; 
    card_number: string;
  } {
    let name = '';
    let set_name = '';
    let card_number = '';

    // Common Pokemon TCG console/set mapping
    const consoleSetMap: { [key: string]: string } = {
      'Pokemon 1998 KFC': 'KFC Promo',
      'Pokemon Base Set': 'Base Set',
      'Pokemon Jungle': 'Jungle',
      'Pokemon Fossil': 'Fossil', 
      'Pokemon Team Rocket': 'Team Rocket',
      'Pokemon Neo Genesis': 'Neo Genesis',
      'Pokemon Neo Discovery': 'Neo Discovery',
      'Pokemon Neo Destiny': 'Neo Destiny',
      'Pokemon Neo Revelation': 'Neo Revelation',
      'Pokemon Gym Heroes': 'Gym Heroes',
      'Pokemon Gym Challenge': 'Gym Challenge',
      'Pokemon Base Set 2': 'Base Set 2',
      'Pokemon Legendary Collection': 'Legendary Collection',
      'Pokemon Ruby Sapphire': 'Ruby & Sapphire',
      'Pokemon EX': 'EX Series',
      'Pokemon Diamond Pearl': 'Diamond & Pearl',
      'Pokemon HeartGold SoulSilver': 'HeartGold & SoulSilver',
      'Pokemon Black White': 'Black & White',
      'Pokemon XY': 'XY',
      'Pokemon Sun Moon': 'Sun & Moon',
      'Pokemon Sword Shield': 'Sword & Shield',
      'Pokemon Scarlet Violet': 'Scarlet & Violet'
    };

    // Extract set from console name
    set_name = consoleSetMap[consoleName] || consoleName.replace(/^Pokemon\s+/, '');

    // Parse product name for card name and number
    // Pattern: "Card Name #123" or "Card Name - Set #123" 
    const numberMatch = productName.match(/#(\d+(?:\/\d+)?)/);
    if (numberMatch) {
      card_number = numberMatch[1];
      // Remove the number part to get the name
      name = productName.replace(/#\d+(?:\/\d+)?$/, '').trim();
      
      // Remove set name if it appears in product name
      const setInProduct = productName.match(/(.+?)\s*-\s*([^#]+)\s*#/);
      if (setInProduct) {
        name = setInProduct[1].trim();
        // Use the set from product if it's more specific
        const extractedSet = setInProduct[2].trim();
        if (extractedSet && !set_name.includes(extractedSet)) {
          set_name = extractedSet;
        }
      }
    } else {
      // No number found, entire product name is the card name
      name = productName.trim();
    }

    return {
      name: name.trim(),
      set_name: set_name.trim(),
      card_number: card_number.trim()
    };
  }

  /**
   * Normalize text exactly matching DeterministicResolver logic
   */
  private normalize = (s: any): string => {
    if (s == null) return '';
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  };

  private normalizeCardNumber = (s: any): string => {
    const base = this.normalize(s);
    if (!base) return '';
    
    const left = base.split('/')[0];
    return left.replace(/^0+/, '') || '0';
  };

  /**
   * Parse CSV row into structured card data
   */
  private parseRow(row: PriceChartingRow): ParsedCard {
    const { name, set_name, card_number } = this.parseProductName(
      row['product-name'], 
      row['console-name']
    );

    // Parse prices (remove $ and convert to float)
    const parsePrice = (price: string): number | null => {
      if (!price || price === '') return null;
      const cleaned = price.replace(/[$,]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? null : parsed;
    };

    return {
      priceCharting_id: row.id,
      name,
      set_name,
      card_number,
      price_loose: parsePrice(row['loose-price']),
      price_cib: parsePrice(row['cib-price']),
      price_new: parsePrice(row['new-price']),
      price_graded: parsePrice(row['graded-price']),
      tcg_player_id: row['tcg-id'] || null,
      release_date: row['release-date'] || null,
      sales_volume: row['sales-volume'] ? parseInt(row['sales-volume']) : null,
      raw_product_name: row['product-name'],
      raw_console_name: row['console-name']
    };
  }

  /**
   * Generate unique card ID from normalized components with strong SHA-1 hash
   */
  private generateCardId(card: ParsedCard): string {
    const name = this.normalize(card.name);
    const set = this.normalize(card.set_name);
    const num = this.normalizeCardNumber(card.card_number);
    
    // Canonical identity from normalized triplet
    const base = [name, set, num].join('|');
    
    // Strong 160-bit deterministic hash
    const sha1 = createHash('sha1').update(base).digest('hex');
    return `cm_${sha1}`;
  }

  /**
   * Process batch of cards with UPSERT for canonical deduplication
   */
  private processBatch(cards: ParsedCard[]): void {
    const transaction = this.db.transaction(() => {
      for (const card of cards) {
        try {
          // Single UPSERT path - no pre-checks, no branching
          const params = {
            id: this.generateCardId(card),
            name: card.name,
            set_name: card.set_name,
            card_number: card.card_number,
            price_usd: card.price_graded ?? card.price_new ?? card.price_cib ?? card.price_loose ?? null,
            price_charting_id: card.priceCharting_id,
            tcg_player_id: card.tcg_player_id,
            image_url: `https://www.pricecharting.com/card/${card.priceCharting_id}`, // Placeholder URL
            metadata: JSON.stringify({
              price_loose: card.price_loose,
              price_cib: card.price_cib,
              price_new: card.price_new,
              price_graded: card.price_graded,
              sales_volume: card.sales_volume,
              release_date: card.release_date,
              raw_product_name: card.raw_product_name,
              raw_console_name: card.raw_console_name,
              imported_from: 'pricecharting'
            }),
            normalized_name: this.normalize(card.name),
            normalized_set: this.normalize(card.set_name),
            normalized_number: this.normalizeCardNumber(card.card_number)
          };

          this.insertStmt.run(params);
          this.processed++;
          
        } catch (error: any) {
          this.errors.push(`Card ${card.priceCharting_id}: ${error.code || 'NO_CODE'} ${error.message}`);
          
          if (this.errors.length > 100) {
            throw new Error('Too many errors during import');
          }
        }
      }
    });

    transaction();
  }

  /**
   * Main import process
   */
  public async import(csvPath: string): Promise<void> {
    log.info(`🚀 Starting PriceCharting CSV import: ${csvPath}`);
    
    const startTime = Date.now();
    let batch: ParsedCard[] = [];
    let rowCount = 0;

    return new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on('data', (row: PriceChartingRow) => {
          rowCount++;
          try {
            const card = this.parseRow(row);
            batch.push(card);

            // Process batch when full
            if (batch.length >= this.batchSize) {
              this.processBatch(batch);
              batch = [];
              
              if (this.processed % 10000 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const rate = this.processed / elapsed;
                log.info(`📈 Progress: ${this.processed.toLocaleString()} cards (${rate.toFixed(0)}/sec, ${this.errors.length} errors)`);
              }
            }
          } catch (error) {
            this.errors.push(`Row ${rowCount} parsing error: ${error instanceof Error ? error.message : String(error)}`);
            log.error(`Row ${rowCount} error:`, error);
            
            if (this.errors.length > 10) {
              reject(new Error(`Too many parsing errors (${this.errors.length}). Stopping import.`));
              return;
            }
          }
        })
        .on('end', () => {
          try {
            // Process final batch
            if (batch.length > 0) {
              this.processBatch(batch);
            }

            const elapsed = (Date.now() - startTime) / 1000;
            log.info(`✅ Import completed: ${this.processed.toLocaleString()} cards in ${elapsed.toFixed(1)}s`);
            log.info(`📊 Error rate: ${this.errors.length}/${this.processed} (${(this.errors.length/Math.max(this.processed,1)*100).toFixed(2)}%)`);
            
            if (this.errors.length > 0) {
              log.warn(`⚠️ First 10 errors:`);
              this.errors.slice(0, 10).forEach(err => log.warn(`   ${err}`));
            }

            resolve();
          } catch (error) {
            log.error('Final batch processing failed:', error);
            reject(error);
          }
        })
        .on('error', reject);
    });
  }

  /**
   * Post-import FTS rebuild
   */
  public async rebuildFTS(): Promise<void> {
    log.info('🔄 Rebuilding FTS index for 70k+ cards...');
    
    const startTime = Date.now();
    
    // Use FTS rebuild command for external-content tables
    this.db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')").run();
    this.db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('optimize')").run();
    
    const count = this.db.prepare("SELECT COUNT(*) as count FROM cards_fts").get() as { count: number };
    const elapsed = (Date.now() - startTime) / 1000;
    
    log.info(`✅ FTS rebuilt: ${count.count.toLocaleString()} entries in ${elapsed.toFixed(1)}s`);
  }
}

async function main() {
  const csvPath = './data/pricecharting_pokemon.csv';
  const dbPath = process.env.DB_PATH || './data/cardmint.db';
  
  log.info(`📦 Importing PriceCharting data: ${csvPath} → ${dbPath}`);

  let db: Database.Database | null = null;
  
  try {
    if (!fs.existsSync(csvPath)) {
      throw new Error(`CSV file not found: ${csvPath}`);
    }

    db = new Database(dbPath);
    const importer = new PriceChartingImporter(db);
    
    // Clear any existing test data first
    const existingCount = db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number };
    if (existingCount.count > 0) {
      log.info(`📋 Found ${existingCount.count} existing cards - will merge/update`);
    }

    // Add canonical unique index for UPSERT performance
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_canonical
        ON cards(normalized_name, normalized_set, normalized_number)
        WHERE normalized_name <> '' AND normalized_set <> '' AND normalized_number <> '';
      `);
      log.info('✅ Created canonical unique index for deduplication');
    } catch (e) {
      log.warn('⚠️ Canonical unique index creation failed (likely preexisting dupes). Proceeding without it:', e);
    }

    // Drop FTS triggers during import to avoid conflicts
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS cards_fts_insert;
        DROP TRIGGER IF EXISTS cards_fts_update;
        DROP TRIGGER IF EXISTS cards_fts_delete;
      `);
      log.info('🔧 Dropped FTS triggers for bulk import performance');
    } catch (e) {
      log.warn('⚠️ FTS trigger drop failed:', e);
    }

    await importer.import(csvPath);
    await importer.rebuildFTS();
    
    // Recreate FTS triggers after import
    try {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS cards_fts_insert
        AFTER INSERT ON cards
        WHEN NEW.normalized_name IS NOT NULL
        BEGIN
          INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
          VALUES (NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set);
        END;

        CREATE TRIGGER IF NOT EXISTS cards_fts_update
        AFTER UPDATE ON cards
        BEGIN
          INSERT INTO cards_fts(cards_fts, rowid) VALUES('delete', OLD.rowid);
          INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
          SELECT NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set
          WHERE NEW.normalized_name IS NOT NULL;
        END;

        CREATE TRIGGER IF NOT EXISTS cards_fts_delete
        AFTER DELETE ON cards
        BEGIN
          INSERT INTO cards_fts(cards_fts, rowid) VALUES('delete', OLD.rowid);
        END;
      `);
      log.info('✅ Recreated FTS triggers for ongoing synchronization');
    } catch (e) {
      log.warn('⚠️ FTS trigger recreation failed:', e);
    }
    
    // Final statistics
    const finalStats = db.prepare(`
      SELECT 
        COUNT(*) as total_cards,
        COUNT(DISTINCT name) as unique_names,
        COUNT(DISTINCT set_name) as unique_sets,
        COUNT(price_charting_id) as has_pc_id,
        COUNT(price_usd) as has_price,
        AVG(price_usd) as avg_price
      FROM cards
    `).get() as any;

    log.info('🎉 FINAL DATABASE STATISTICS:');
    log.info(`   Total cards: ${finalStats.total_cards.toLocaleString()}`);
    log.info(`   Unique names: ${finalStats.unique_names.toLocaleString()}`);
    log.info(`   Unique sets: ${finalStats.unique_sets.toLocaleString()}`);
    log.info(`   Cards with PriceCharting ID: ${finalStats.has_pc_id.toLocaleString()}`);
    log.info(`   Cards with price: ${finalStats.has_price.toLocaleString()}`);
    log.info(`   Average price: $${finalStats.avg_price ? finalStats.avg_price.toFixed(2) : 'N/A'}`);
    
    log.info('🎯 CardMint database is now production-ready with 70k+ Pokemon cards!');
    
  } catch (error) {
    log.error('💥 Import failed:', error);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Import failed:', error);
    process.exit(1);
  });
}