/**
 * Database Initialization with Performance Optimization
 * Applies PRAGMAs and normalizes existing data
 */

import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger';
import { textNormalizer } from '../validation/TextNormalizer';

const log = createLogger('db-initializer');

export class DatabaseInitializer {
  constructor(private db: Database) {}

  /**
   * Apply production PRAGMAs for optimal read performance
   */
  async applyPerformancePRAGMAs(): Promise<void> {
    log.info('Applying performance PRAGMAs...');

    const pragmas = [
      // WAL mode for concurrent reads (most important)
      'PRAGMA journal_mode=WAL',
      
      // Normal synchronous for speed vs safety balance
      'PRAGMA synchronous=NORMAL',
      
      // 80MB cache (negative = KB, so -80000 = 80MB)
      'PRAGMA cache_size=-80000',
      
      // Keep temporary data in memory
      'PRAGMA temp_store=MEMORY',
      
      // Enable memory mapping (3GB limit)
      'PRAGMA mmap_size=3000000000',
      
      // Foreign key constraints
      'PRAGMA foreign_keys=ON',
      
      // Query optimization
      'PRAGMA optimize',
    ];

    for (const pragma of pragmas) {
      try {
        const result = this.db.prepare(pragma).get();
        log.debug(`Applied: ${pragma} -> ${JSON.stringify(result)}`);
      } catch (error) {
        log.warn(`Failed to apply ${pragma}:`, error);
      }
    }

    // Verify WAL mode is active (critical for performance)
    const journalMode = this.db.prepare('PRAGMA journal_mode').get();
    if (journalMode?.journal_mode !== 'wal') {
      throw new Error(`Failed to enable WAL mode, got: ${journalMode?.journal_mode}`);
    }

    log.info('Performance PRAGMAs applied successfully');
  }

  /**
   * Normalize existing card data for better matching
   */
  async normalizeExistingData(): Promise<void> {
    log.info('Normalizing existing card data...');

    // Get count of cards needing normalization
    const unnormalizedCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM cards 
      WHERE normalized_name IS NULL
    `).get() as { count: number };

    if (unnormalizedCount.count === 0) {
      log.info('All cards already normalized');
      return;
    }

    log.info(`Normalizing ${unnormalizedCount.count} cards...`);

    // Disable FTS triggers during bulk update (performance optimization)
    this.disableFTSTriggers();

    const updateStmt = this.db.prepare(`
      UPDATE cards 
      SET normalized_name = ?, normalized_set = ?, normalized_number = ?
      WHERE id = ?
    `);

    // Process in batches to avoid memory issues
    const batchSize = 1000;
    let processed = 0;

    const transaction = this.db.transaction((cards: any[]) => {
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

    while (processed < unnormalizedCount.count) {
      const batch = this.db.prepare(`
        SELECT id, name, set_name, card_number 
        FROM cards 
        WHERE normalized_name IS NULL 
        LIMIT ?
      `).all(batchSize);

      if (batch.length === 0) break;

      transaction(batch);
      processed += batch.length;

      if (processed % 5000 === 0) {
        log.info(`Normalized ${processed}/${unnormalizedCount.count} cards`);
      }
    }

    // Re-enable FTS triggers and rebuild FTS index
    this.enableFTSTriggers();
    await this.rebuildFTSIndex();

    log.info(`Normalization complete: ${processed} cards processed`);
  }

  /**
   * Rebuild FTS5 index (for bulk imports or schema changes)
   */
  async rebuildFTSIndex(): Promise<void> {
    log.info('Rebuilding FTS5 index...');

    try {
      // Clear existing FTS data
      this.db.prepare("DELETE FROM cards_fts").run();
      
      // Rebuild from cards table
      this.db.prepare(`
        INSERT INTO cards_fts(
          rowid, name, set_name, card_number, normalized_name, normalized_set
        )
        SELECT 
          rowid, name, set_name, card_number, normalized_name, normalized_set
        FROM cards
        WHERE normalized_name IS NOT NULL
      `).run();

      // FTS5 optimize for better performance
      this.db.prepare("INSERT INTO cards_fts(cards_fts) VALUES('optimize')").run();

      const indexedCount = this.db.prepare("SELECT COUNT(*) as count FROM cards_fts").get() as { count: number };
      log.info(`FTS5 index rebuilt with ${indexedCount.count} entries`);

    } catch (error) {
      log.error('Failed to rebuild FTS index:', error);
      throw error;
    }
  }

  /**
   * Populate initial aliases from common OCR patterns
   */
  async populateInitialAliases(): Promise<void> {
    log.info('Populating initial card aliases...');

    const aliases = [
      // Common OCR errors for popular cards
      { alias: 'charizerd', canonical_id: 'base1-4', type: 'ocr_variant', confidence: 0.95 },
      { alias: 'charzard', canonical_id: 'base1-4', type: 'common_typo', confidence: 0.90 },
      { alias: 'charizard holo', canonical_id: 'base1-4', type: 'variant', confidence: 0.98 },
      { alias: 'charizard shadowless', canonical_id: 'base1-4', type: 'variant', confidence: 0.95 },
      
      { alias: 'pikacu', canonical_id: 'base1-58', type: 'ocr_variant', confidence: 0.90 },
      { alias: 'pikacbu', canonical_id: 'base1-58', type: 'ocr_variant', confidence: 0.85 },
      
      { alias: 'blastolse', canonical_id: 'base1-2', type: 'ocr_variant', confidence: 0.90 },
      { alias: 'venasaur', canonical_id: 'base1-15', type: 'ocr_variant', confidence: 0.90 },
      
      // Set name aliases
      { alias: 'base', canonical_id: 'base1', type: 'set_nickname', confidence: 1.0 },
      { alias: 'base set', canonical_id: 'base1', type: 'set_name', confidence: 1.0 },
      { alias: 'jungle', canonical_id: 'jungle', type: 'set_name', confidence: 1.0 },
      { alias: 'fossil', canonical_id: 'fossil', type: 'set_name', confidence: 1.0 },
      { alias: 'team rocket', canonical_id: 'base5', type: 'set_name', confidence: 1.0 },
      
      // Common edition variants
      { alias: '1st edition', canonical_id: 'first_edition', type: 'edition_variant', confidence: 1.0 },
      { alias: 'shadowless', canonical_id: 'shadowless', type: 'edition_variant', confidence: 1.0 },
      { alias: 'unlimited', canonical_id: 'unlimited', type: 'edition_variant', confidence: 1.0 },
    ];

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO card_aliases (alias, canonical_id, alias_type, confidence, created_by)
      VALUES (?, ?, ?, ?, 'system_init')
    `);

    let inserted = 0;
    for (const alias of aliases) {
      try {
        insertStmt.run(alias.alias, alias.canonical_id, alias.type, alias.confidence);
        inserted++;
      } catch (error) {
        log.warn(`Failed to insert alias ${alias.alias}:`, error);
      }
    }

    // Update system metadata
    this.db.prepare(`
      UPDATE system_metadata 
      SET value = datetime('now') 
      WHERE key = 'aliases_last_updated'
    `).run();

    log.info(`Populated ${inserted} initial aliases`);
  }

  /**
   * Create prepared statements cache for better performance
   */
  createPreparedStatementCache(): Map<string, any> {
    log.info('Creating prepared statement cache...');

    const statements = new Map();

    // Common exact lookups
    statements.set('findByCanonicalKey', 
      this.db.prepare('SELECT * FROM cards WHERE canonical_key = ?'));
    
    statements.set('findByNormalizedName', 
      this.db.prepare('SELECT * FROM cards WHERE normalized_name = ? LIMIT 5'));
    
    // FTS5 searches with BM25 ranking
    statements.set('ftsSearch', 
      this.db.prepare(`
        SELECT c.*, bm25(cards_fts) as rank
        FROM cards c
        JOIN cards_fts ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `));
    
    statements.set('ftsSearchWithSetFilter',
      this.db.prepare(`
        SELECT c.*, bm25(cards_fts) as rank
        FROM cards c
        JOIN cards_fts ON c.rowid = cards_fts.rowid
        WHERE cards_fts MATCH ? AND c.normalized_set LIKE ?
        ORDER BY rank
        LIMIT 10
      `));

    // Alias lookups
    statements.set('findAlias',
      this.db.prepare('SELECT * FROM card_aliases WHERE alias = ?'));
    
    statements.set('findCardById',
      this.db.prepare('SELECT * FROM cards WHERE id = ?'));

    // Set and number similarity searches
    statements.set('findBySetAndNumber',
      this.db.prepare(`
        SELECT * FROM cards 
        WHERE normalized_set = ? AND normalized_number = ?
        LIMIT 5
      `));

    statements.set('findBySetSimilar',
      this.db.prepare(`
        SELECT * FROM cards 
        WHERE normalized_set LIKE ? 
        ORDER BY normalized_name
        LIMIT 10
      `));

    log.info(`Created ${statements.size} prepared statements`);
    return statements;
  }

  /**
   * Disable FTS triggers for bulk operations
   */
  private disableFTSTriggers(): void {
    const triggers = ['cards_fts_insert', 'cards_fts_update', 'cards_fts_delete'];
    for (const trigger of triggers) {
      try {
        this.db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
      } catch (error) {
        log.warn(`Failed to drop trigger ${trigger}:`, error);
      }
    }
    log.debug('FTS triggers disabled');
  }

  /**
   * Re-enable FTS triggers after bulk operations
   */
  private enableFTSTriggers(): void {
    // Re-create triggers (they're in the migration file)
    const triggers = [
      `CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards 
       WHEN NEW.normalized_name IS NOT NULL
       BEGIN
         INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
         VALUES (NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set);
       END`,
       
      `CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE ON cards
       WHEN NEW.normalized_name IS NOT NULL
       BEGIN
         INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number, normalized_name, normalized_set)
         VALUES ('delete', OLD.rowid, OLD.name, OLD.set_name, OLD.card_number, OLD.normalized_name, OLD.normalized_set);
         INSERT INTO cards_fts(rowid, name, set_name, card_number, normalized_name, normalized_set)
         VALUES (NEW.rowid, NEW.name, NEW.set_name, NEW.card_number, NEW.normalized_name, NEW.normalized_set);
       END`,
       
      `CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards BEGIN
         INSERT INTO cards_fts(cards_fts, rowid, name, set_name, card_number, normalized_name, normalized_set)
         VALUES ('delete', OLD.rowid, OLD.name, OLD.set_name, OLD.card_number, OLD.normalized_name, OLD.normalized_set);
       END`
    ];

    for (const trigger of triggers) {
      try {
        this.db.prepare(trigger).run();
      } catch (error) {
        log.warn('Failed to recreate FTS trigger:', error);
      }
    }
    log.debug('FTS triggers re-enabled');
  }

  /**
   * Full database initialization sequence
   */
  async initialize(): Promise<void> {
    log.info('Starting database initialization...');

    try {
      // 1. Apply performance PRAGMAs first
      await this.applyPerformancePRAGMAs();
      
      // 2. Normalize existing data
      await this.normalizeExistingData();
      
      // 3. Populate initial aliases
      await this.populateInitialAliases();
      
      // 4. Create prepared statement cache
      const statementCache = this.createPreparedStatementCache();
      
      log.info('Database initialization complete');
      return statementCache;
      
    } catch (error) {
      log.error('Database initialization failed:', error);
      throw error;
    }
  }
}