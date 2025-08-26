import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger';

const logger = createLogger('sqlite-database');

let db: Database.Database | null = null;

export interface Card {
  id: string;
  captured_at: string;
  processed_at?: string;
  image_url: string;
  thumbnail_url?: string;
  ocr_text?: string;
  metadata?: any;
  status: string;
  confidence_score?: number;
  error_message?: string;
  processing_time_ms?: number;
  // Pokemon-specific fields
  name?: string;
  set_name?: string;
  card_number?: string;
  rarity?: string;
  type?: string;
  price_usd?: number;
  price_updated_at?: string;
  tcg_player_id?: string;
  price_charting_id?: string;
}

export async function initializeDatabase(): Promise<void> {
  try {
    // Create data directory if it doesn't exist
    const dbDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      logger.info(`Created database directory: ${dbDir}`);
    }

    const dbPath = path.join(dbDir, 'cardmint.db');
    logger.info(`Initializing SQLite database at: ${dbPath}`);

    // Open database with better-sqlite3
    db = new Database(dbPath);
    
    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    
    // Test connection
    const version = db.prepare('SELECT sqlite_version() as version').get() as { version: string };
    logger.info(`SQLite connected successfully, version: ${version.version}`);
    
    // Create tables
    await createTables();
    
  } catch (error) {
    logger.error('Failed to initialize SQLite database:', error);
    throw error;
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    logger.info('Closing SQLite database...');
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

async function createTables(): Promise<void> {
  const database = getDatabase();
  
  try {
    // Create cards table with all necessary fields
    database.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT,
        image_url TEXT NOT NULL,
        thumbnail_url TEXT,
        ocr_text TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence_score REAL DEFAULT 0,
        error_message TEXT,
        processing_time_ms INTEGER,
        -- Pokemon-specific fields
        name TEXT,
        set_name TEXT,
        card_number TEXT,
        rarity TEXT,
        type TEXT,
        price_usd REAL,
        price_updated_at TEXT,
        tcg_player_id TEXT,
        price_charting_id TEXT,
        -- Indexes for performance
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_cards_captured_at ON cards(captured_at);
      CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
      CREATE INDEX IF NOT EXISTS idx_cards_set_name ON cards(set_name);
      CREATE INDEX IF NOT EXISTS idx_cards_card_number ON cards(card_number);
      
      -- Processing queue table
      CREATE TABLE IF NOT EXISTS processing_queue (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        card_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_queue_status ON processing_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_created_at ON processing_queue(created_at);
      
      -- Metrics table for performance tracking
      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        labels TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
      
      -- Trigger to update the updated_at timestamp
      CREATE TRIGGER IF NOT EXISTS update_cards_timestamp 
      AFTER UPDATE ON cards
      BEGIN
        UPDATE cards SET updated_at = datetime('now') WHERE id = NEW.id;
      END;
    `);
    
    logger.info('Database tables created successfully');
    
    // Log table info
    const tables = database.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' 
      ORDER BY name
    `).all() as { name: string }[];
    
    logger.info(`Created tables: ${tables.map(t => t.name).join(', ')}`);
    
  } catch (error) {
    logger.error('Failed to create tables:', error);
    throw error;
  }
}

// Helper functions for common operations
export function insertCard(card: Partial<Card>): Card {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    INSERT INTO cards (
      image_url, thumbnail_url, ocr_text, metadata, status,
      confidence_score, name, set_name, card_number, rarity, type
    ) VALUES (
      @image_url, @thumbnail_url, @ocr_text, @metadata, @status,
      @confidence_score, @name, @set_name, @card_number, @rarity, @type
    )
    RETURNING *
  `);
  
  const metadata = card.metadata ? JSON.stringify(card.metadata) : null;
  
  const result = stmt.get({
    image_url: card.image_url || '',
    thumbnail_url: card.thumbnail_url || null,
    ocr_text: card.ocr_text || null,
    metadata: metadata,
    status: card.status || 'pending',
    confidence_score: card.confidence_score || 0,
    name: card.name || null,
    set_name: card.set_name || null,
    card_number: card.card_number || null,
    rarity: card.rarity || null,
    type: card.type || null
  }) as Card;
  
  return result;
}

export function updateCard(id: string, updates: Partial<Card>): Card | undefined {
  const database = getDatabase();
  
  const fields = Object.keys(updates)
    .filter(key => key !== 'id')
    .map(key => `${key} = @${key}`)
    .join(', ');
  
  if (!fields) {
    throw new Error('No fields to update');
  }
  
  const stmt = database.prepare(`
    UPDATE cards 
    SET ${fields}, processed_at = datetime('now')
    WHERE id = @id
    RETURNING *
  `);
  
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : undefined;
  
  const result = stmt.get({
    ...updates,
    metadata,
    id
  }) as Card | undefined;
  
  return result;
}

export function getCard(id: string): Card | undefined {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM cards WHERE id = ?
  `);
  
  const result = stmt.get(id) as Card | undefined;
  
  if (result && result.metadata) {
    try {
      result.metadata = JSON.parse(result.metadata);
    } catch (e) {
      // Keep as string if not valid JSON
    }
  }
  
  return result;
}

export function getAllCards(limit = 100, offset = 0): Card[] {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT * FROM cards 
    ORDER BY captured_at DESC 
    LIMIT ? OFFSET ?
  `);
  
  const results = stmt.all(limit, offset) as Card[];
  
  // Parse metadata JSON for each card
  results.forEach(card => {
    if (card.metadata) {
      try {
        card.metadata = JSON.parse(card.metadata);
      } catch (e) {
        // Keep as string if not valid JSON
      }
    }
  });
  
  return results;
}

export function searchCards(cardName: string, setCode?: string): Card[] {
  const database = getDatabase();
  
  let query = `
    SELECT * FROM cards 
    WHERE name LIKE ? COLLATE NOCASE
  `;
  let params: any[] = [`%${cardName}%`];
  
  if (setCode) {
    query += ` AND set_name LIKE ? COLLATE NOCASE`;
    params.push(`%${setCode}%`);
  }
  
  query += ` ORDER BY 
    CASE 
      WHEN name = ? THEN 1
      WHEN name LIKE ? THEN 2
      ELSE 3 
    END,
    confidence_score DESC
  `;
  params.push(cardName, `${cardName}%`);
  
  const stmt = database.prepare(query);
  const results = stmt.all(...params) as Card[];
  
  // Parse metadata JSON for each card
  results.forEach(card => {
    if (card.metadata) {
      try {
        card.metadata = JSON.parse(card.metadata);
      } catch (e) {
        // Keep as string if not valid JSON
      }
    }
  });
  
  return results;
}

export function getCardCount(): number {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT COUNT(*) as count FROM cards
  `);
  
  const result = stmt.get() as { count: number };
  return result.count;
}

export function getQueueStatus(): any {
  const database = getDatabase();
  
  const stmt = database.prepare(`
    SELECT 
      status,
      COUNT(*) as count
    FROM processing_queue
    GROUP BY status
  `);
  
  const results = stmt.all() as { status: string; count: number }[];
  
  const status: any = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0
  };
  
  results.forEach(row => {
    status[row.status] = row.count;
  });
  
  return status;
}