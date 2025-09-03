import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from '../../utils/logger';
import type { DatabaseRecord, PriceLookupKey } from '../local-matching/types';

const logger = createLogger('DatabaseQueryService');

export interface DatabaseConnection {
  readonly name: string;
  readonly path: string;
  readonly db: Database.Database;
}

export class DatabaseQueryService {
  private connections: Map<string, DatabaseConnection> = new Map();
  private preparedStatements: Map<string, Database.Statement> = new Map();
  
  private readonly dataRoot: string;
  private initialized = false;

  constructor() {
    this.dataRoot = process.env.DATA_ROOT || './data';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    logger.info('Initializing database connections');
    
    // Initialize database connections
    await this.initializeDatabase('cardmint', path.join(this.dataRoot, 'cardmint.db'));
    await this.initializeDatabase('canonical', path.join(this.dataRoot, 'canonical.db'));
    await this.initializeDatabase('pokemon_cards', path.join(this.dataRoot, 'pokemon_cards.db'));
    await this.initializeDatabase('card_database', path.join(this.dataRoot, 'card_database.sqlite'));
    
    // Prepare common queries
    this.prepareStatements();
    
    this.initialized = true;
    logger.info('Database connections initialized successfully');
  }

  private async initializeDatabase(name: string, dbPath: string): Promise<void> {
    try {
      const db = new Database(dbPath, { 
        readonly: true,
        fileMustExist: true
      });
      
      // Optimize for read performance
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = 10000');
      db.pragma('temp_store = memory');
      
      // Enable memory mapping for better read performance
      db.pragma('mmap_size = 268435456'); // 256MB
      
      this.connections.set(name, { name, path: dbPath, db });
      logger.info(`Connected to database: ${name} at ${dbPath}`);
    } catch (error) {
      logger.warn(`Failed to connect to database ${name} at ${dbPath}:`, error);
    }
  }

  private prepareStatements(): void {
    // Card lookup by name patterns
    this.prepareStatement('findCardByName', 'cardmint', `
      SELECT id, name, set_name, set_code, number, rarity, hp, types, stage, aliases, release_year
      FROM pokemon_cards 
      WHERE LOWER(name) LIKE LOWER(?) 
      ORDER BY name LIMIT 10
    `);
    
    // Card lookup by set and number
    this.prepareStatement('findCardBySetNumber', 'cardmint', `
      SELECT id, name, set_name, set_code, number, rarity, hp, types, stage, aliases, release_year
      FROM pokemon_cards 
      WHERE LOWER(set_name) LIKE LOWER(?) AND number = ?
      ORDER BY name LIMIT 5
    `);
    
    // Composite lookup for exact matches
    this.prepareStatement('findCardExact', 'cardmint', `
      SELECT id, name, set_name, set_code, number, rarity, hp, types, stage, aliases, release_year
      FROM pokemon_cards 
      WHERE LOWER(name) = LOWER(?) AND LOWER(set_name) = LOWER(?) AND number = ?
      LIMIT 1
    `);
    
    // Set lookup for validation
    this.prepareStatement('findSetByName', 'cardmint', `
      SELECT DISTINCT set_name, set_code 
      FROM pokemon_cards 
      WHERE LOWER(set_name) LIKE LOWER(?) 
      ORDER BY set_name LIMIT 5
    `);
    
    // Number format validation
    this.prepareStatement('validateCardNumber', 'cardmint', `
      SELECT COUNT(*) as count
      FROM pokemon_cards 
      WHERE LOWER(set_name) = LOWER(?) AND number = ?
    `);
  }

  private prepareStatement(key: string, dbName: string, sql: string): void {
    const connection = this.connections.get(dbName);
    if (!connection) {
      logger.warn(`Database connection not found: ${dbName}`);
      return;
    }
    
    try {
      const stmt = connection.db.prepare(sql);
      this.preparedStatements.set(key, stmt);
      logger.debug(`Prepared statement: ${key}`);
    } catch (error) {
      logger.warn(`Failed to prepare statement ${key}:`, error);
    }
  }

  async findCardByName(name: string): Promise<DatabaseRecord[]> {
    const stmt = this.preparedStatements.get('findCardByName');
    if (!stmt) return [];
    
    try {
      const results = stmt.all(`%${name}%`) as DatabaseRecord[];
      return results;
    } catch (error) {
      logger.error('Error finding card by name:', error);
      return [];
    }
  }

  async findCardBySetAndNumber(setName: string, number: string): Promise<DatabaseRecord[]> {
    const stmt = this.preparedStatements.get('findCardBySetNumber');
    if (!stmt) return [];
    
    try {
      const results = stmt.all(`%${setName}%`, number) as DatabaseRecord[];
      return results;
    } catch (error) {
      logger.error('Error finding card by set and number:', error);
      return [];
    }
  }

  async findCardExact(name: string, setName: string, number: string): Promise<DatabaseRecord | null> {
    const stmt = this.preparedStatements.get('findCardExact');
    if (!stmt) return null;
    
    try {
      const result = stmt.get(name, setName, number) as DatabaseRecord | undefined;
      return result || null;
    } catch (error) {
      logger.error('Error finding exact card match:', error);
      return null;
    }
  }

  async findSetByName(setName: string): Promise<Array<{set_name: string, set_code: string}>> {
    const stmt = this.preparedStatements.get('findSetByName');
    if (!stmt) return [];
    
    try {
      const results = stmt.all(`%${setName}%`) as Array<{set_name: string, set_code: string}>;
      return results;
    } catch (error) {
      logger.error('Error finding set by name:', error);
      return [];
    }
  }

  async validateCardNumber(setName: string, number: string): Promise<boolean> {
    const stmt = this.preparedStatements.get('validateCardNumber');
    if (!stmt) return false;
    
    try {
      const result = stmt.get(setName, number) as {count: number};
      return result.count > 0;
    } catch (error) {
      logger.error('Error validating card number:', error);
      return false;
    }
  }

  // Utility method for custom queries (with safety checks)
  async executeReadOnly(dbName: string, sql: string, params: any[] = []): Promise<any[]> {
    const connection = this.connections.get(dbName);
    if (!connection) {
      throw new Error(`Database connection not found: ${dbName}`);
    }
    
    // Safety check for read-only operations
    const sqlLower = sql.toLowerCase().trim();
    if (!sqlLower.startsWith('select') && !sqlLower.startsWith('with')) {
      throw new Error('Only SELECT and WITH queries are allowed');
    }
    
    try {
      const stmt = connection.db.prepare(sql);
      return stmt.all(...params);
    } catch (error) {
      logger.error(`Error executing query on ${dbName}:`, error);
      throw error;
    }
  }

  // Normalize keys for lookups
  static normalizeKey(key: PriceLookupKey): string {
    const set = key.set.toLowerCase().replace(/[^a-z0-9]/g, '');
    const number = key.number.toLowerCase();
    const name = key.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${set}|${number}|${name}`;
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) {
      try {
        connection.db.close();
        logger.debug(`Closed database connection: ${connection.name}`);
      } catch (error) {
        logger.warn(`Error closing database ${connection.name}:`, error);
      }
    }
    this.connections.clear();
    this.preparedStatements.clear();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getDatabaseInfo(): Array<{name: string, path: string, connected: boolean}> {
    return Array.from(this.connections.values()).map(conn => ({
      name: conn.name,
      path: conn.path,
      connected: true
    }));
  }
}