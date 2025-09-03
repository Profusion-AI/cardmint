#!/usr/bin/env tsx
/**
 * Add Composite Covering Indexes for Exact Matching Speed
 * Surgical schema enhancement for sub-millisecond exact matching
 */

import Database from 'better-sqlite3';
import { createLogger } from '../src/utils/logger';

const log = createLogger('add-composite-indexes');

class CompositeIndexMigration {
  constructor(private db: Database.Database) {}

  async apply(): Promise<void> {
    log.info('⚡ Adding composite covering indexes for exact matching...');

    try {
      // Primary composite covering index - the workhorse for exact triplet queries
      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_cards_norm_triplet
        ON cards(normalized_name, normalized_set, normalized_number)
      `).run();
      log.info('✅ Created composite triplet index: normalized_name + normalized_set + normalized_number');

      // Fallback composite indexes for partial matches
      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_cards_norm_name_set
        ON cards(normalized_name, normalized_set)
      `).run();
      log.info('✅ Created composite index: normalized_name + normalized_set');

      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_cards_norm_name_number
        ON cards(normalized_name, normalized_number)
      `).run();
      log.info('✅ Created composite index: normalized_name + normalized_number');

      // Partial index for non-empty triplets (performance boost for common queries)
      this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_cards_norm_triplet_nonempty
        ON cards(normalized_name, normalized_set, normalized_number)
        WHERE normalized_name <> '' AND normalized_set <> '' AND normalized_number <> ''
      `).run();
      log.info('✅ Created partial triplet index (non-empty values only)');

      // Verify index creation
      const indexes = this.db.prepare(`
        SELECT name, sql FROM sqlite_master 
        WHERE type='index' AND name LIKE 'idx_cards_norm%'
        ORDER BY name
      `).all();

      log.info('📋 Created composite indexes:');
      indexes.forEach((idx: any) => {
        log.debug(`  ✓ ${idx.name}`);
      });

      // Performance verification - explain query plan
      const explainTriplet = this.db.prepare(`
        EXPLAIN QUERY PLAN 
        SELECT id, name, set_name, card_number 
        FROM cards 
        WHERE normalized_name = 'pikachu' 
          AND normalized_set = 'base set' 
          AND normalized_number = '25'
      `).all();

      log.info('🔍 Query plan verification for triplet lookup:');
      explainTriplet.forEach((step: any) => {
        log.debug(`  ${step.detail}`);
      });

      log.info('⚡ Composite indexes added successfully - exact matching optimized!');

    } catch (error) {
      log.error('❌ Failed to add composite indexes:', error);
      throw error;
    }
  }
}

async function main() {
  const dbPath = process.env.DB_PATH || './data/cardmint.db';
  
  log.info(`⚡ Adding composite indexes: ${dbPath}`);

  let db: Database.Database | null = null;
  
  try {
    db = new Database(dbPath);
    const migration = new CompositeIndexMigration(db);
    await migration.apply();
    
    log.info('🎉 Composite index migration completed successfully!');
    
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

export { CompositeIndexMigration };