#!/usr/bin/env tsx
/**
 * FTS5 Rebuild Script for Bulk Operations
 * Use this when importing large datasets or after schema changes
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../src/utils/logger';
import { textNormalizer } from '../src/validation/TextNormalizer';

const log = createLogger('fts-rebuild');

interface RebuildOptions {
  skipNormalization?: boolean;
  batchSize?: number;
  vacuum?: boolean;
  reindex?: boolean;
}

class FTSRebuilder {
  constructor(private dbPath: string) {}

  async rebuild(options: RebuildOptions = {}): Promise<void> {
    const {
      skipNormalization = false,
      batchSize = 5000,
      vacuum = true,
      reindex = true
    } = options;

    log.info(`🔧 Starting FTS rebuild: ${this.dbPath}`);
    log.info(`Options: skip_normalization=${skipNormalization}, batch_size=${batchSize}, vacuum=${vacuum}`);

    const db = new Database(this.dbPath);
    
    try {
      // Enable WAL mode for performance
      db.prepare('PRAGMA journal_mode=WAL').run();
      db.prepare('PRAGMA synchronous=NORMAL').run();
      db.prepare('PRAGMA cache_size=-100000').run(); // 100MB cache for rebuild

      // Step 1: Vacuum and analyze if requested
      if (vacuum) {
        log.info('🧹 Running VACUUM...');
        db.prepare('VACUUM').run();
        log.info('📊 Running ANALYZE...');
        db.prepare('ANALYZE').run();
      }

      // Step 2: Normalize data if needed
      if (!skipNormalization) {
        await this.normalizeData(db, batchSize);
      }

      // Step 3: Disable FTS triggers
      log.info('⏸️  Disabling FTS triggers...');
      this.disableFTSTriggers(db);

      // Step 4: Clear and rebuild FTS index
      log.info('🔄 Rebuilding FTS5 index...');
      await this.rebuildFTSIndex(db);

      // Step 5: Re-enable FTS triggers
      log.info('▶️  Re-enabling FTS triggers...');
      this.enableFTSTriggers(db);

      // Step 6: Optimize FTS index
      log.info('⚡ Optimizing FTS5 index...');
      db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('optimize')").run();

      // Step 7: Reindex if requested
      if (reindex) {
        log.info('📇 Running REINDEX...');
        db.prepare('REINDEX').run();
      }

      // Step 8: Verification
      await this.verifyRebuild(db);

      log.info('✅ FTS rebuild completed successfully');

    } catch (error) {
      log.error('❌ FTS rebuild failed:', error);
      throw error;
    } finally {
      db.close();
    }
  }

  private async normalizeData(db: Database, batchSize: number): Promise<void> {
    // Count unnormalized cards
    const { count } = db.prepare(`
      SELECT COUNT(*) as count FROM cards 
      WHERE normalized_name IS NULL OR normalized_name = ''
    `).get() as { count: number };

    if (count === 0) {
      log.info('📋 All cards already normalized');
      return;
    }

    log.info(`📝 Normalizing ${count} cards in batches of ${batchSize}...`);

    const updateStmt = db.prepare(`
      UPDATE cards 
      SET normalized_name = ?, normalized_set = ?, normalized_number = ?
      WHERE id = ?
    `);

    const transaction = db.transaction((cards: any[]) => {
      for (const card of cards) {
        const variants = textNormalizer.generateVariants({
          name: card.name,
          set_name: card.set_name,
          card_number: card.card_number
        });

        updateStmt.run(
          variants.normalized_name,
          variants.normalized_set,
          variants.normalized_number,
          card.id
        );
      }
    });

    let processed = 0;
    while (processed < count) {
      const batch = db.prepare(`
        SELECT id, name, set_name, card_number 
        FROM cards 
        WHERE normalized_name IS NULL OR normalized_name = ''
        LIMIT ?
      `).all(batchSize);

      if (batch.length === 0) break;

      transaction(batch);
      processed += batch.length;

      const pct = ((processed / count) * 100).toFixed(1);
      log.info(`📝 Normalized ${processed}/${count} cards (${pct}%)`);
    }

    // Update metadata
    db.prepare(`
      INSERT OR REPLACE INTO system_metadata (key, value, description)
      VALUES ('normalization_completed', datetime('now'), 'Last normalization run')
    `).run();
  }

  private async rebuildFTSIndex(db: Database): Promise<void> {
    // Clear existing FTS data
    log.info('🗑️  Clearing existing FTS data...');
    db.prepare("DELETE FROM cards_fts").run();

    // Get count for progress tracking
    const { count } = db.prepare("SELECT COUNT(*) as count FROM cards WHERE normalized_name IS NOT NULL").get() as { count: number };
    
    if (count === 0) {
      log.warn('⚠️  No normalized cards found for FTS indexing');
      return;
    }

    // Rebuild in batches for memory efficiency
    const batchSize = 10000;
    let processed = 0;

    const insertStmt = db.prepare(`
      INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((cards: any[]) => {
      for (const card of cards) {
        insertStmt.run(
          card.rowid,
          card.name || '',
          card.set_name || '',
          card.card_number || '',
          card.normalized_name || '',
          card.normalized_set || ''
        );
      }
    });

    log.info(`📇 Rebuilding FTS index for ${count} cards...`);

    while (processed < count) {
      const batch = db.prepare(`
        SELECT rowid, name, set_name, card_number, normalized_name, normalized_set
        FROM cards 
        WHERE normalized_name IS NOT NULL
        LIMIT ? OFFSET ?
      `).all(batchSize, processed);

      if (batch.length === 0) break;

      transaction(batch);
      processed += batch.length;

      const pct = ((processed / count) * 100).toFixed(1);
      log.info(`📇 Indexed ${processed}/${count} cards (${pct}%)`);
    }

    // Update FTS statistics
    db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')").run();
  }

  private disableFTSTriggers(db: Database): void {
    const triggers = ['cards_fts_insert', 'cards_fts_update', 'cards_fts_delete'];
    for (const trigger of triggers) {
      try {
        db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
      } catch (error) {
        log.warn(`Failed to drop trigger ${trigger}:`, error);
      }
    }
  }

  private enableFTSTriggers(db: Database): void {
    // Load trigger definitions from migration file
    const migrationPath = join(__dirname, '../src/storage/migrations/005_qa_foundation_enhanced.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');
    
    // Extract trigger definitions
    const triggerRegex = /CREATE TRIGGER[^;]+;/gims;
    const triggers = migrationSQL.match(triggerRegex) || [];
    
    for (const trigger of triggers) {
      if (trigger.includes('cards_fts_')) {
        try {
          db.prepare(trigger).run();
        } catch (error) {
          log.warn('Failed to recreate FTS trigger:', error);
        }
      }
    }
  }

  private async verifyRebuild(db: Database): Promise<void> {
    // Verify FTS index integrity
    const ftsCount = db.prepare("SELECT COUNT(*) as count FROM cards_fts").get() as { count: number };
    const cardsCount = db.prepare("SELECT COUNT(*) as count FROM cards WHERE normalized_name IS NOT NULL").get() as { count: number };
    
    log.info(`🔍 Verification: ${ftsCount.count} FTS entries, ${cardsCount.count} normalized cards`);
    
    if (ftsCount.count !== cardsCount.count) {
      log.warn(`⚠️  Mismatch: FTS has ${ftsCount.count} entries, cards has ${cardsCount.count} normalized`);
    }

    // Test FTS functionality
    const testResult = db.prepare(`
      SELECT COUNT(*) as count FROM cards_fts WHERE cards_fts MATCH 'charizard'
    `).get() as { count: number };
    
    log.info(`🧪 FTS test query: ${testResult.count} results for 'charizard'`);

    // Check index integrity
    const integrityResult = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrityResult.integrity_check !== 'ok') {
      throw new Error(`Database integrity check failed: ${integrityResult.integrity_check}`);
    }

    log.info('✅ Verification passed');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0] || './data/cardmint.db';
  
  const options: RebuildOptions = {
    skipNormalization: args.includes('--skip-normalization'),
    batchSize: parseInt(args.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] || '5000'),
    vacuum: !args.includes('--no-vacuum'),
    reindex: !args.includes('--no-reindex')
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: tsx scripts/fts-rebuild.ts [database_path] [options]

Options:
  --skip-normalization    Skip text normalization step
  --batch-size=N         Process N records at a time (default: 5000)
  --no-vacuum            Skip VACUUM operation
  --no-reindex           Skip REINDEX operation
  --help, -h             Show this help message

Examples:
  tsx scripts/fts-rebuild.ts
  tsx scripts/fts-rebuild.ts ./data/cardmint.db
  tsx scripts/fts-rebuild.ts --skip-normalization --batch-size=10000
    `);
    process.exit(0);
  }

  const rebuilder = new FTSRebuilder(dbPath);
  
  try {
    console.time('fts-rebuild');
    await rebuilder.rebuild(options);
    console.timeEnd('fts-rebuild');
    process.exit(0);
  } catch (error) {
    console.error('Rebuild failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { FTSRebuilder };