#!/usr/bin/env tsx
/**
 * Apply QA Foundation Migration
 * Upgrades database with FTS5, normalization, and QA verification tables
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../src/utils/logger';
import { DatabaseInitializer } from '../src/storage/DatabaseInitializer';

const log = createLogger('qa-migration');

async function applyMigration() {
  const dbPath = process.env.DB_PATH || './data/cardmint.db';
  
  log.info(`🚀 Applying QA Foundation Migration to: ${dbPath}`);

  let db: Database.Database | null = null;
  
  try {
    // Open database
    db = new Database(dbPath);
    
    // Check current state
    const tables = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as { name: string }[];
    
    log.info(`📋 Current tables: ${tables.map(t => t.name).join(', ')}`);

    // Read migration SQL
    const migrationPath = join(__dirname, '../src/storage/migrations/005_qa_foundation_enhanced.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf-8');
    
    log.info('📝 Executing migration SQL...');
    
    // Execute migration in transaction
    const transaction = db.transaction(() => {
      // Split SQL by statements and execute
      const statements = migrationSQL
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
      
      for (const statement of statements) {
        if (statement.toLowerCase().startsWith('pragma')) {
          // Skip PRAGMA statements in migration (handled by initializer)
          continue;
        }
        
        try {
          db!.prepare(statement).run();
        } catch (error) {
          // Some statements may fail if already exist - that's OK
          log.debug(`Statement skipped: ${statement.substring(0, 50)}... (${error})`);
        }
      }
    });
    
    transaction();
    
    log.info('✅ Migration SQL executed');

    // Initialize database with performance settings
    const initializer = new DatabaseInitializer(db);
    await initializer.initialize();
    
    // Verify migration success
    const newTables = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as { name: string }[];
    
    const expectedTables = [
      'cards', 'cards_fts', 'card_aliases', 'qa_verifications', 'system_metadata'
    ];
    
    const missingTables = expectedTables.filter(table => 
      !newTables.some(t => t.name === table)
    );
    
    if (missingTables.length > 0) {
      throw new Error(`Missing tables after migration: ${missingTables.join(', ')}`);
    }
    
    log.info(`📋 Final tables: ${newTables.map(t => t.name).join(', ')}`);
    
    // Test FTS functionality
    const ftsTest = db.prepare(`
      SELECT COUNT(*) as count FROM cards_fts
    `).get() as { count: number };
    
    log.info(`🔍 FTS5 index contains ${ftsTest.count} entries`);
    
    // Check system metadata
    const metadata = db.prepare(`
      SELECT key, value FROM system_metadata
    `).all();
    
    log.info('🏷️  System metadata:');
    metadata.forEach(({ key, value }) => {
      log.info(`  ${key}: ${value}`);
    });

    log.info('✅ QA Foundation Migration completed successfully');
    
  } catch (error) {
    log.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

// Run migration if called directly
if (require.main === module) {
  applyMigration().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

export { applyMigration };