#!/usr/bin/env tsx
/**
 * Safe QA Foundation Migration
 * Handles existing schema gracefully and adds new features incrementally
 */

import Database from 'better-sqlite3';
import { createLogger } from '../src/utils/logger';

// Import TextNormalizer with comprehensive fallback
let textNormalizer: any;
let isUsingFallback = false;

try {
  const { textNormalizer: normalizer } = require('../src/validation/TextNormalizer');
  if (normalizer && typeof normalizer.generateVariants === 'function') {
    textNormalizer = normalizer;
  } else {
    throw new Error('TextNormalizer imported but generateVariants method not found');
  }
} catch (error) {
  console.warn('Failed to import TextNormalizer, using robust fallback:', error.message);
  isUsingFallback = true;
  
  // Robust fallback normalizer that matches expected interface
  textNormalizer = {
    generateVariants: (cardData: any) => {
      // Defensive input handling
      const safeName = cardData?.name || cardData || '';
      const safeSetName = cardData?.set_name || '';
      const safeCardNumber = cardData?.card_number || '';
      
      // Normalize with proper error handling
      const normalizeSafe = (input: any): string => {
        if (input === null || input === undefined) return '';
        const str = String(input);
        return str.toLowerCase().trim().replace(/\s+/g, ' ');
      };
      
      const normalizedName = normalizeSafe(safeName);
      const normalizedSet = normalizeSafe(safeSetName);
      const normalizedNumber = normalizeSafe(safeCardNumber);
      
      return {
        normalized_name: normalizedName,
        normalized_set: normalizedSet, 
        normalized_number: normalizedNumber,
        search_variants: [normalizedName, normalizedSet, normalizedNumber].filter(v => v.length > 0)
      };
    }
  };
}

const log = createLogger('safe-qa-migration');

class SafeQAMigration {
  constructor(private db: Database.Database) {}

  async apply(): Promise<void> {
    log.info('🚀 Starting safe QA migration...');

    try {
      // Step 1: Enable WAL mode and performance PRAGMAs
      await this.applyPerformancePRAGMAs();
      
      // Step 2: Add normalization columns to cards table
      await this.addNormalizationColumns();
      
      // Step 3: Create FTS5 table with proper tokenizer
      await this.createOptimizedFTS();
      
      // Step 4: Create QA verification tables
      await this.createQAVerificationTables();
      
      // Step 5: Create aliases table
      await this.createAliasesTable();
      
      // Step 6: Create system metadata table
      await this.createSystemMetadata();
      
      // Step 7: Normalize existing data
      await this.normalizeExistingData();

      // Step 7.5: Create FTS triggers AFTER normalization to avoid trigger conflicts
      await this.createFTSTriggers();

      // Step 8: Create useful views
      await this.createViews();
      
      log.info('✅ Safe QA migration completed successfully');
      
    } catch (error) {
      log.error('❌ Migration failed:', error);
      throw error;
    }
  }

  private async applyPerformancePRAGMAs(): Promise<void> {
    log.info('🔧 Applying performance PRAGMAs...');

    // First set all non-return PRAGMAs
    const setPragmas = [
      'PRAGMA synchronous=NORMAL', 
      'PRAGMA cache_size=-80000',
      'PRAGMA temp_store=MEMORY',
      'PRAGMA foreign_keys=ON'
    ];

    for (const pragma of setPragmas) {
      try {
        this.db.prepare(pragma).run();
        log.debug(`✓ ${pragma}`);
      } catch (error) {
        log.warn(`⚠ Failed: ${pragma} - ${error}`);
      }
    }

    // Handle return PRAGMAs separately
    try {
      const journalResult = this.db.prepare('PRAGMA journal_mode=WAL').get();
      log.debug(`✓ PRAGMA journal_mode=WAL -> ${JSON.stringify(journalResult)}`);
    } catch (error) {
      log.warn(`⚠ Failed: PRAGMA journal_mode=WAL - ${error}`);
    }

    try {
      const mmapResult = this.db.prepare('PRAGMA mmap_size=3000000000').get();
      log.debug(`✓ PRAGMA mmap_size=3000000000 -> ${JSON.stringify(mmapResult)}`);
    } catch (error) {
      log.warn(`⚠ Failed: PRAGMA mmap_size=3000000000 - ${error}`);
    }

    // Verify WAL mode
    const journalMode = this.db.prepare('PRAGMA journal_mode').get() as any;
    if (journalMode?.journal_mode !== 'wal') {
      log.warn(`⚠ WAL mode not active: ${journalMode?.journal_mode}`);
    } else {
      log.info('✅ WAL mode active');
    }
  }

  private async addNormalizationColumns(): Promise<void> {
    log.info('📝 Adding normalization columns to cards table...');

    const columns = [
      'normalized_name TEXT',
      'normalized_set TEXT',
      'normalized_number TEXT'
    ];

    for (const column of columns) {
      try {
        this.db.prepare(`ALTER TABLE cards ADD COLUMN ${column}`).run();
        log.debug(`✓ Added column: ${column}`);
      } catch (error) {
        if (error.message.includes('duplicate column name')) {
          log.debug(`- Column already exists: ${column}`);
        } else {
          log.warn(`⚠ Failed to add column ${column}: ${error}`);
        }
      }
    }

    // Create indexes on normalization columns
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_cards_normalized_name ON cards(normalized_name)',
      'CREATE INDEX IF NOT EXISTS idx_cards_normalized_set ON cards(normalized_set)',
      'CREATE INDEX IF NOT EXISTS idx_cards_normalized_number ON cards(normalized_number)'
    ];

    for (const index of indexes) {
      try {
        this.db.prepare(index).run();
        log.debug(`✓ Created index: ${index.split(' ')[5]}`);
      } catch (error) {
        log.warn(`⚠ Index creation failed: ${error}`);
      }
    }
  }

  private async createOptimizedFTS(): Promise<void> {
    log.info('🔍 Creating optimized FTS5 table...');

    // Ensure old FTS triggers don't fire during bulk normalization
    try {
      this.db.prepare('DROP TRIGGER IF EXISTS cards_fts_insert').run();
      this.db.prepare('DROP TRIGGER IF EXISTS cards_fts_update').run();
      this.db.prepare('DROP TRIGGER IF EXISTS cards_fts_delete').run();
      log.debug('- Dropped existing FTS triggers (if any)');
    } catch (error) {
      log.warn('⚠ Failed to drop existing FTS triggers:', error);
    }

    // Drop existing FTS table if it exists
    try {
      this.db.prepare('DROP TABLE IF EXISTS cards_fts').run();
      log.debug('- Dropped existing cards_fts table');
    } catch (error) {
      log.debug('- No existing cards_fts table to drop');
    }

    // Create FTS5 table optimized for Pokemon names
    const createFTS = `
      CREATE VIRTUAL TABLE cards_fts USING fts5(
        name,
        set_name,
        card_number,
        normalized_name,
        normalized_set,
        content='cards',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      )
    `;

    try {
      this.db.prepare(createFTS).run();
      log.info('✅ Created FTS5 table with unicode61 tokenizer');
    } catch (error) {
      log.error('❌ Failed to create FTS5 table:', error);
      throw error;
    }

    // Defer trigger creation until after normalization
    log.info('ℹ️ Deferring FTS trigger creation until after normalization');
  }

  private async createFTSTriggers(): Promise<void> {
    log.info('🔗 Creating FTS5 synchronization triggers...');
    const triggers = [
      `CREATE TRIGGER IF NOT EXISTS cards_fts_insert
       AFTER INSERT ON cards
       WHEN NEW.normalized_name IS NOT NULL
       BEGIN
         INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
         VALUES (NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set);
       END`,
      `CREATE TRIGGER IF NOT EXISTS cards_fts_update
       AFTER UPDATE ON cards
       BEGIN
         -- Always delete old index row (if it existed)
         INSERT INTO cards_fts(cards_fts, rowid) VALUES('delete', OLD.rowid);
         -- Insert new index row only when normalized is present
         INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
         SELECT NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set
         WHERE NEW.normalized_name IS NOT NULL;
       END`,
      `CREATE TRIGGER IF NOT EXISTS cards_fts_delete
       AFTER DELETE ON cards
       BEGIN
         INSERT INTO cards_fts(cards_fts, rowid) VALUES('delete', OLD.rowid);
       END`
    ];
    for (const trigger of triggers) {
      try {
        this.db.prepare(trigger).run();
        log.debug('✓ Created FTS trigger');
      } catch (error) {
        log.warn('⚠ FTS trigger creation failed:', error);
      }
    }
  }

  private async createQAVerificationTables(): Promise<void> {
    log.info('📋 Creating QA verification tables...');

    const createQATable = `
      CREATE TABLE IF NOT EXISTS qa_verifications (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        card_id TEXT NOT NULL REFERENCES cards(id),
        
        -- Status tracking
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        
        -- Idempotency versioning
        resolver_version TEXT NOT NULL,
        model_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        job_version INTEGER NOT NULL DEFAULT 1,
        
        -- Input/Output data
        input_data TEXT NOT NULL,
        image_path TEXT,
        source_model TEXT NOT NULL,
        verdict TEXT,
        chosen_card_id TEXT,
        confidence_adjustment REAL DEFAULT 0,
        final_confidence REAL,
        
        -- Metadata
        evidence TEXT,
        error_message TEXT,
        latency_ms INTEGER,
        retry_count INTEGER DEFAULT 0,
        last_heartbeat TEXT,
        expires_at TEXT,
        
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      )
    `;

    try {
      this.db.prepare(createQATable).run();
      log.info('✅ Created qa_verifications table');
    } catch (error) {
      if (error.message.includes('already exists')) {
        log.debug('- qa_verifications table already exists');
      } else {
        log.error('❌ Failed to create qa_verifications table:', error);
        throw error;
      }
    }

    // Create indexes
    const qaIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_qa_status ON qa_verifications(status)',
      'CREATE INDEX IF NOT EXISTS idx_qa_card_id ON qa_verifications(card_id)',
      'CREATE INDEX IF NOT EXISTS idx_qa_created_at ON qa_verifications(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_qa_expires_at ON qa_verifications(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_qa_heartbeat ON qa_verifications(last_heartbeat)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_idempotency ON qa_verifications(card_id, input_hash, resolver_version, model_version)'
    ];

    for (const index of qaIndexes) {
      try {
        this.db.prepare(index).run();
        log.debug(`✓ Created QA index: ${index.split(' ')[5]}`);
      } catch (error) {
        log.warn(`⚠ QA index creation failed: ${error}`);
      }
    }
  }

  private async createAliasesTable(): Promise<void> {
    log.info('🏷️  Creating aliases table...');

    const createAliasTable = `
      CREATE TABLE IF NOT EXISTS card_aliases (
        alias TEXT PRIMARY KEY,
        canonical_id TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now')),
        created_by TEXT DEFAULT 'system'
      )
    `;

    try {
      this.db.prepare(createAliasTable).run();
      log.info('✅ Created card_aliases table');
    } catch (error) {
      if (error.message.includes('already exists')) {
        log.debug('- card_aliases table already exists');
      } else {
        log.error('❌ Failed to create card_aliases table:', error);
        throw error;
      }
    }

    // Create alias indexes
    const aliasIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON card_aliases(canonical_id)',
      'CREATE INDEX IF NOT EXISTS idx_aliases_type ON card_aliases(alias_type)',
      'CREATE INDEX IF NOT EXISTS idx_aliases_confidence ON card_aliases(confidence DESC)'
    ];

    for (const index of aliasIndexes) {
      try {
        this.db.prepare(index).run();
        log.debug(`✓ Created alias index: ${index.split(' ')[5]}`);
      } catch (error) {
        log.warn(`⚠ Alias index creation failed: ${error}`);
      }
    }
  }

  private async createSystemMetadata(): Promise<void> {
    log.info('⚙️  Creating system metadata table...');

    const createMetaTable = `
      CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        description TEXT
      )
    `;

    try {
      this.db.prepare(createMetaTable).run();
      log.info('✅ Created system_metadata table');
    } catch (error) {
      if (error.message.includes('already exists')) {
        log.debug('- system_metadata table already exists');
      } else {
        log.error('❌ Failed to create system_metadata table:', error);
        throw error;
      }
    }

    // Initialize metadata
    const metadata = [
      ['resolver_version', 'v1.0.0', 'Current deterministic resolver version'],
      ['aliases_last_updated', new Date().toISOString(), 'Last time aliases were modified'],
      ['fts_schema_version', 'v1.0.0', 'FTS5 schema and tokenizer version'],
      ['migration_version', '005', 'Last applied migration version']
    ];

    const insertMeta = this.db.prepare(`
      INSERT OR REPLACE INTO system_metadata (key, value, description)
      VALUES (?, ?, ?)
    `);

    for (const [key, value, description] of metadata) {
      try {
        insertMeta.run(key, value, description);
        log.debug(`✓ Set metadata: ${key} = ${value}`);
      } catch (error) {
        log.warn(`⚠ Failed to set metadata ${key}: ${error}`);
      }
    }
  }

  private async normalizeExistingData(): Promise<void> {
    log.info('🔄 Normalizing existing card data...');

    // Check how many cards need normalization
    const unnormalized = this.db.prepare(`
      SELECT COUNT(*) as count FROM cards 
      WHERE normalized_name IS NULL
    `).get() as { count: number };

    if (unnormalized.count === 0) {
      log.info('✅ All cards already normalized');
      return;
    }

    log.info(`📝 Normalizing ${unnormalized.count} cards...`);

    // Log normalizer status
    log.info(`📚 TextNormalizer: ${isUsingFallback ? 'Using fallback implementation' : 'Using imported implementation'}`);

    // Validate textNormalizer before processing
    log.debug(`TextNormalizer type: ${typeof textNormalizer}`);
    log.debug(`generateVariants exists: ${typeof textNormalizer?.generateVariants === 'function'}`);

    // Check database constraints and indexes that might cause issues
    const tableInfo = this.db.prepare("PRAGMA table_info(cards)").all();
    log.debug(`Cards table columns: ${JSON.stringify(tableInfo.map((col: any) => `${col.name}:${col.type}${col.notnull ? '(NOT NULL)' : ''}`))}`);

    const indexList = this.db.prepare("PRAGMA index_list(cards)").all();
    log.debug(`Cards table indexes: ${JSON.stringify(indexList.map((idx: any) => `${idx.name}${idx.unique ? '(UNIQUE)' : ''}`))}`);

    // Test normalizer with sample data
    try {
      const testVariants = textNormalizer.generateVariants({
        name: 'Test Card',
        set_name: 'Base Set',  
        card_number: '1/102'
      });
      log.debug(`Test normalization result: ${JSON.stringify(testVariants)}`);
    } catch (error) {
      log.error(`❌ TextNormalizer test failed: ${error}`);
      throw new Error(`TextNormalizer validation failed: ${error}`);
    }

    // Check for potential collision issues before processing
    const potentialCollisions = this.db.prepare(`
      WITH normed AS (
        SELECT id, name, set_name, card_number,
               LOWER(COALESCE(TRIM(name), '')) AS norm_name,
               LOWER(COALESCE(TRIM(set_name), '')) AS norm_set,
               LOWER(COALESCE(TRIM(card_number), '')) AS norm_number
        FROM cards
        WHERE normalized_name IS NULL
      )
      SELECT norm_name, norm_set, norm_number, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
      FROM normed
      GROUP BY norm_name, norm_set, norm_number
      HAVING COUNT(*) > 1
    `).all();

    if (potentialCollisions.length > 0) {
      log.warn(`⚠ Found ${potentialCollisions.length} potential normalization collisions`);
      for (const collision of potentialCollisions) {
        log.debug(`  Collision: "${collision.norm_name}|${collision.norm_set}|${collision.norm_number}" affects ${collision.cnt} cards: ${collision.ids}`);
      }
    }

    // Process cards individually with comprehensive error handling
    const updateStmt = this.db.prepare(`
      UPDATE cards 
      SET normalized_name = ?, normalized_set = ?, normalized_number = ?
      WHERE id = ?
    `);

    const failedCards: Array<{id: string, error: string}> = [];
    let processed = 0;
    let skipped = 0;

    // Get all cards that need normalization
    const cardsToNormalize = this.db.prepare(`
      SELECT id, name, set_name, card_number 
      FROM cards 
      WHERE normalized_name IS NULL
      ORDER BY id
    `).all();

    log.info(`Processing ${cardsToNormalize.length} cards individually for detailed error tracking...`);

    // Process each card in its own transaction with savepoint
    this.db.prepare('BEGIN IMMEDIATE').run();
    
    try {
      for (const card of cardsToNormalize) {
        this.db.prepare('SAVEPOINT norm_card').run();
        
        try {
          // Defensive input sanitization
          const safeName = (card.name === null || card.name === undefined) ? '' : String(card.name);
          const safeSetName = (card.set_name === null || card.set_name === undefined) ? '' : String(card.set_name);
          const safeCardNumber = (card.card_number === null || card.card_number === undefined) ? '' : String(card.card_number);

          // Generate variants with error handling
          let variants;
          try {
            variants = textNormalizer.generateVariants({
              name: safeName,
              set_name: safeSetName,
              card_number: safeCardNumber
            });
          } catch (normError) {
            log.warn(`⚠ Normalizer failed for card ${card.id}, using fallback: ${normError}`);
            // Use basic fallback normalization
            variants = {
              normalized_name: safeName.toLowerCase().trim(),
              normalized_set: safeSetName.toLowerCase().trim(),
              normalized_number: safeCardNumber.toLowerCase().trim()
            };
          }

          // Validate variants structure
          if (!variants || typeof variants !== 'object') {
            throw new Error(`Invalid variants returned: ${JSON.stringify(variants)}`);
          }

          const normalizedName = variants.normalized_name || '';
          const normalizedSet = variants.normalized_set || '';
          const normalizedNumber = variants.normalized_number || '';

          // Attempt update
          const result = updateStmt.run(normalizedName, normalizedSet, normalizedNumber, card.id);
          
          if (result.changes !== 1) {
            throw new Error(`Update affected ${result.changes} rows, expected 1`);
          }

          this.db.prepare('RELEASE norm_card').run();
          processed++;

          if (processed % 100 === 0) {
            log.info(`📝 Processed ${processed}/${cardsToNormalize.length} cards (${failedCards.length} failed)`);
          }

        } catch (error) {
          this.db.prepare('ROLLBACK TO norm_card').run();
          this.db.prepare('RELEASE norm_card').run();
          
          const errorMsg = error instanceof Error ? error.message : String(error);
          failedCards.push({ id: card.id, error: errorMsg });
          skipped++;
          
          log.error(`❌ Failed to normalize card ${card.id}: ${errorMsg}`);
          log.debug(`   Card data: name="${card.name}" set="${card.set_name}" number="${card.card_number}"`);
          
          // Continue processing other cards rather than failing completely
        }
      }

      this.db.prepare('COMMIT').run();
      
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }

    // Summary
    log.info(`✅ Normalization complete: ${processed} success, ${skipped} failed`);
    
    if (failedCards.length > 0) {
      log.warn(`⚠ ${failedCards.length} cards failed normalization:`);
      failedCards.slice(0, 10).forEach(f => log.debug(`  - ${f.id}: ${f.error}`));
      if (failedCards.length > 10) {
        log.debug(`  ... and ${failedCards.length - 10} more`);
      }
    }

    if (processed > 0) {
      // Rebuild FTS index only if we normalized some cards
      await this.rebuildFTSIndex();
      log.info(`✅ Normalized ${processed} cards and rebuilt FTS index`);
    }
  }

  private async rebuildFTSIndex(): Promise<void> {
    log.debug('🔄 Rebuilding FTS index...');

    try {
      // Use built-in rebuild for external-content FTS
      this.db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')").run();
      this.db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('optimize')").run();

      const count = this.db.prepare("SELECT COUNT(*) as count FROM cards_fts").get() as { count: number };
      log.debug(`✓ FTS index rebuilt with ${count.count} entries`);
      
    } catch (error) {
      log.warn('⚠ FTS rebuild failed:', error);
    }
  }

  private async createViews(): Promise<void> {
    log.info('👁️  Creating useful views...');

    const views = [
      `CREATE VIEW IF NOT EXISTS qa_stuck_jobs AS
       SELECT * FROM qa_verifications 
       WHERE status IN ('ENQUEUED', 'PROCESSING')
         AND (last_heartbeat IS NULL OR datetime(last_heartbeat) < datetime('now', '-10 minutes'))`,
      
      `CREATE VIEW IF NOT EXISTS qa_verification_stats AS
       SELECT 
         status,
         COUNT(*) as count,
         AVG(latency_ms) as avg_latency_ms,
         MIN(created_at) as oldest,
         MAX(created_at) as newest
       FROM qa_verifications
       WHERE created_at > datetime('now', '-24 hours')
       GROUP BY status`
    ];

    for (const view of views) {
      try {
        this.db.prepare(view).run();
        log.debug('✓ Created view');
      } catch (error) {
        log.warn('⚠ View creation failed:', error);
      }
    }
  }

  async verify(): Promise<void> {
    log.info('🔍 Verifying migration results...');

    // Check tables exist
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as { name: string }[];

    const expectedTables = ['cards', 'cards_fts', 'card_aliases', 'qa_verifications', 'system_metadata'];
    const missingTables = expectedTables.filter(table => 
      !tables.some(t => t.name === table)
    );

    if (missingTables.length > 0) {
      throw new Error(`Missing tables: ${missingTables.join(', ')}`);
    }

    // Check FTS functionality
    try {
      const ftsTest = this.db.prepare(`
        SELECT COUNT(*) as count FROM cards_fts
      `).get() as { count: number };
      log.info(`✅ FTS5 index contains ${ftsTest.count} entries`);
    } catch (error) {
      log.warn('⚠ FTS test failed:', error);
    }

    // Check normalization
    const normalized = this.db.prepare(`
      SELECT COUNT(*) as count FROM cards 
      WHERE normalized_name IS NOT NULL
    `).get() as { count: number };

    log.info(`✅ ${normalized.count} cards normalized`);

    // Database integrity check
    const integrity = this.db.prepare("PRAGMA integrity_check").get() as any;
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`Integrity check failed: ${integrity.integrity_check}`);
    }

    log.info('✅ Migration verification passed');
  }
}

async function main() {
  const dbPath = process.env.DB_PATH || './data/cardmint.db';
  
  log.info(`🚀 Starting safe QA migration: ${dbPath}`);

  let db: Database.Database | null = null;
  
  try {
    db = new Database(dbPath);
    const migration = new SafeQAMigration(db);
    
    await migration.apply();
    await migration.verify();
    
    log.info('🎉 Safe QA migration completed successfully!');
    
  } catch (error) {
    log.error('💥 Migration failed:', error);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

export { SafeQAMigration };