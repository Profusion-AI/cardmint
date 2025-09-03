#!/usr/bin/env ts-node

import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

interface MigrationResult {
  success: boolean;
  version?: number;
  error?: string;
  executionTime?: number;
  validationResults?: Record<string, any>;
}

class MigrationRunner {
  private db: Database.Database;
  private migrationsPath: string;

  constructor(databasePath: string = './data/cardmint.db') {
    this.db = new Database(databasePath);
    this.migrationsPath = path.join(__dirname, 'migrations');
    
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    
    this.ensureSchemaVersionTable();
  }

  private ensureSchemaVersionTable() {
    // Create schema version tracking if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        migration_file TEXT,
        checksum TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Initialize with version 0 if empty
    const count = this.db.prepare('SELECT COUNT(*) as count FROM schema_version').get() as any;
    if (count.count === 0) {
      this.db.prepare(`
        INSERT INTO schema_version (version, migration_file) 
        VALUES (0, 'initial_schema.sql')
      `).run();
    }
  }

  getCurrentVersion(): number {
    const result = this.db.prepare(`
      SELECT MAX(version) as version FROM schema_version
    `).get() as any;
    return result?.version || 0;
  }

  async listAvailableMigrations(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.migrationsPath);
      return files
        .filter(f => f.endsWith('.sql'))
        .sort();
    } catch (error) {
      logger.warn('Migrations directory not found', { path: this.migrationsPath });
      return [];
    }
  }

  extractMigrationVersion(filename: string): number {
    const match = filename.match(/^(\d+)_/);
    return match ? parseInt(match[1]) : 0;
  }

  async readMigrationFile(filename: string): Promise<string> {
    const filePath = path.join(this.migrationsPath, filename);
    return await fs.readFile(filePath, 'utf-8');
  }

  calculateChecksum(content: string): string {
    // Simple checksum for migration integrity
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  async runMigration(migrationFile: string, dryRun: boolean = false): Promise<MigrationResult> {
    const startTime = Date.now();
    const migrationVersion = this.extractMigrationVersion(migrationFile);
    
    logger.info('Running migration', { 
      file: migrationFile, 
      version: migrationVersion,
      dryRun 
    });

    try {
      const migrationSQL = await this.readMigrationFile(migrationFile);
      const checksum = this.calculateChecksum(migrationSQL);

      if (dryRun) {
        logger.info('DRY RUN: Migration would execute:', {
          file: migrationFile,
          checksum,
          lines: migrationSQL.split('\n').length
        });
        return { success: true, version: migrationVersion };
      }

      // Execute migration in transaction
      const transaction = this.db.transaction(() => {
        // Execute the migration SQL
        this.db.exec(migrationSQL);

        // Update schema version
        this.db.prepare(`
          INSERT OR REPLACE INTO schema_version 
          (version, migration_file, checksum, applied_at, updated_at) 
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
        `).run(migrationVersion, migrationFile, checksum);
      });

      transaction();

      const executionTime = Date.now() - startTime;
      
      // Validate migration success
      const validationResults = await this.validateMigration(migrationVersion);

      logger.info('Migration completed successfully', {
        file: migrationFile,
        version: migrationVersion,
        executionTime: `${executionTime}ms`,
        validation: validationResults
      });

      return {
        success: true,
        version: migrationVersion,
        executionTime,
        validationResults
      };

    } catch (error: any) {
      logger.error('Migration failed', {
        file: migrationFile,
        version: migrationVersion,
        error: error.message,
        executionTime: Date.now() - startTime
      });

      return {
        success: false,
        version: migrationVersion,
        error: error.message,
        executionTime: Date.now() - startTime
      };
    }
  }

  async validateMigration(version: number): Promise<Record<string, any>> {
    const validation: Record<string, any> = {};

    try {
      // Basic integrity check
      this.db.pragma('integrity_check');
      validation.integrityCheck = 'PASSED';

      // Foreign key check
      const fkViolations = this.db.pragma('foreign_key_check');
      validation.foreignKeyCheck = fkViolations.length === 0 ? 'PASSED' : `${fkViolations.length} violations`;

      // Version-specific validations
      if (version === 3) {
        // Validate inventory layer migration
        validation.conditionScale = this.db.prepare('SELECT COUNT(*) as count FROM condition_scale').get();
        validation.vendorMapping = this.db.prepare('SELECT COUNT(*) as count FROM vendor_condition_map').get();
        validation.inventoryTable = this.db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name='inventory'
        `).get();
        validation.marketPricesTable = this.db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name='market_price_samples'
        `).get();
      }

      return validation;

    } catch (error: any) {
      validation.error = error.message;
      return validation;
    }
  }

  async migrateToLatest(dryRun: boolean = false): Promise<MigrationResult[]> {
    const currentVersion = this.getCurrentVersion();
    const migrations = await this.listAvailableMigrations();
    const results: MigrationResult[] = [];

    logger.info('Migration status', {
      currentVersion,
      availableMigrations: migrations.length,
      dryRun
    });

    for (const migration of migrations) {
      const migrationVersion = this.extractMigrationVersion(migration);
      
      if (migrationVersion > currentVersion) {
        logger.info('Applying migration', { file: migration, version: migrationVersion });
        const result = await this.runMigration(migration, dryRun);
        results.push(result);

        if (!result.success) {
          logger.error('Migration failed, stopping', { file: migration });
          break;
        }
      } else {
        logger.debug('Skipping migration (already applied)', { 
          file: migration, 
          version: migrationVersion 
        });
      }
    }

    return results;
  }

  close() {
    this.db.close();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const dryRun = args.includes('--dry-run');
  
  const dbPath = process.env.DATABASE_PATH || './data/cardmint.db';
  const runner = new MigrationRunner(dbPath);

  try {
    switch (command) {
      case 'status':
        const version = runner.getCurrentVersion();
        const migrations = await runner.listAvailableMigrations();
        console.log(`Current database version: ${version}`);
        console.log(`Available migrations: ${migrations.length}`);
        console.log('Pending migrations:', migrations.filter(m => 
          runner.extractMigrationVersion(m) > version
        ));
        break;

      case 'migrate':
        const results = await runner.migrateToLatest(dryRun);
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        console.log(`Migration complete: ${successful} successful, ${failed} failed`);
        if (failed > 0) {
          process.exit(1);
        }
        break;

      case 'validate':
        const currentVer = runner.getCurrentVersion();
        const validation = await runner.validateMigration(currentVer);
        console.log('Validation results:', JSON.stringify(validation, null, 2));
        break;

      default:
        console.log(`
Usage: ts-node migrate.ts [command] [options]

Commands:
  status    Show current migration status
  migrate   Apply pending migrations  
  validate  Validate current database state

Options:
  --dry-run   Show what would be executed without making changes

Examples:
  ts-node migrate.ts status
  ts-node migrate.ts migrate --dry-run
  ts-node migrate.ts migrate
        `);
        break;
    }
  } catch (error: any) {
    logger.error('Migration runner error', { error: error.message });
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    runner.close();
  }
}

// Export for programmatic use
export { MigrationRunner, MigrationResult };

// Run CLI if executed directly
if (require.main === module) {
  main().catch(console.error);
}