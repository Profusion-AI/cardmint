import { Card, CardStatus } from '../types';
import { InferenceResult } from '../core/infer/InferencePort';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import Database from 'better-sqlite3';
import path from 'path';

export interface CardQuery {
  card_name?: string;
  set_code?: string;
  number?: string;
  confidence_min?: number;
  value_tier?: string;
  limit?: number;
}

export interface VerificationMatch {
  card_id: string;
  card_name: string;
  set_code: string;
  number: string;
  similarity_score: number;
  match_method: 'exact' | 'fuzzy' | 'semantic';
}

export interface CardStorageConfig {
  database_path: string;
  enable_wal: boolean;
  cache_size_mb: number;
  enable_fts: boolean; // Full-text search
}

export abstract class CardStorage {
  abstract findCards(query: CardQuery): Promise<Card[]>;
  abstract storeCard(card: Partial<Card>): Promise<Card>;
  abstract verifyCard(name: string, set?: string): Promise<VerificationMatch[]>;
  abstract fuzzySearch(name: string, threshold?: number): Promise<VerificationMatch[]>;
  abstract getStats(): Promise<{ total_cards: number; processed_today: number; verification_rate: number }>;
}

export class SQLiteCardStorage extends CardStorage {
  private db: Database.Database;
  private config: CardStorageConfig;

  // Prepared statements for performance
  private insertCardStmt: Database.Statement;
  private findCardStmt: Database.Statement;
  private fuzzySearchStmt: Database.Statement;
  private verifyExactStmt: Database.Statement;

  constructor(config: CardStorageConfig) {
    super();
    this.config = config;
    
    // Initialize SQLite with production optimizations
    this.db = new Database(config.database_path);
    this.initializeDatabase();
    this.prepareStatements();
    
    logger.info('SQLiteCardStorage initialized', { 
      path: config.database_path,
      wal: config.enable_wal 
    });
  }

  private initializeDatabase(): void {
    // Enable WAL mode for better concurrency
    if (this.config.enable_wal) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    
    // Performance optimizations
    this.db.pragma(`cache_size = -${this.config.cache_size_mb * 1024}`); // Convert MB to KB (negative = KB)
    this.db.pragma('temp_store = memory');
    this.db.pragma('mmap_size = 268435456'); // 256MB

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        image_url TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        -- Card metadata (JSON stored as TEXT)
        card_name TEXT,
        card_set TEXT,
        card_number TEXT,
        rarity TEXT,
        
        -- Processing metadata
        run_id TEXT,
        processing_mode TEXT DEFAULT 'distributed',
        verification_path TEXT, -- 'accepted', 'verified', 'flagged'
        primary_confidence REAL,
        verifier_confidence REAL,
        confidence_adjustment REAL,
        
        -- Value tier and flags
        value_tier TEXT, -- 'common', 'rare', 'holo', 'vintage', 'high_value'
        semantic_flags TEXT, -- JSON array as TEXT
        
        -- Performance tracking
        processing_time_ms INTEGER,
        verification_time_ms INTEGER
      );

      -- Indexes for fast lookups
      CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(card_name);
      CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(card_set);
      CREATE INDEX IF NOT EXISTS idx_cards_confidence ON cards(confidence_score);
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_cards_tier ON cards(value_tier);
      CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at);
      
      -- Composite indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_cards_name_set ON cards(card_name, card_set);
      CREATE INDEX IF NOT EXISTS idx_cards_verification ON cards(verification_path, confidence_score);
    `);

    // Full-text search table if enabled
    if (this.config.enable_fts) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
          id UNINDEXED,
          card_name,
          card_set,
          content='cards',
          content_rowid='rowid'
        );

        -- Triggers to keep FTS in sync
        CREATE TRIGGER IF NOT EXISTS cards_fts_insert AFTER INSERT ON cards BEGIN
          INSERT INTO cards_fts(id, card_name, card_set) VALUES (new.id, new.card_name, new.card_set);
        END;

        CREATE TRIGGER IF NOT EXISTS cards_fts_delete AFTER DELETE ON cards BEGIN
          DELETE FROM cards_fts WHERE id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS cards_fts_update AFTER UPDATE ON cards BEGIN
          DELETE FROM cards_fts WHERE id = old.id;
          INSERT INTO cards_fts(id, card_name, card_set) VALUES (new.id, new.card_name, new.card_set);
        END;
      `);
    }

    // Reference table for known Pokemon cards (for verification)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pokemon_reference (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        set_code TEXT NOT NULL,
        set_name TEXT,
        number TEXT,
        rarity TEXT,
        
        -- Normalized names for matching
        name_normalized TEXT,
        
        -- Metadata
        artist TEXT,
        flavor_text TEXT,
        hp INTEGER,
        card_type TEXT,
        
        -- Pricing and rarity
        market_price_usd REAL,
        last_price_update DATETIME,
        
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_reference_name ON pokemon_reference(name_normalized);
      CREATE INDEX IF NOT EXISTS idx_reference_set ON pokemon_reference(set_code);
      CREATE INDEX IF NOT EXISTS idx_reference_name_set ON pokemon_reference(name_normalized, set_code);
    `);

    logger.debug('Database schema initialized');
  }

  private prepareStatements(): void {
    // Insert card statement
    this.insertCardStmt = this.db.prepare(`
      INSERT OR REPLACE INTO cards (
        id, image_url, status, confidence_score, card_name, card_set, card_number, 
        rarity, run_id, processing_mode, verification_path, primary_confidence, 
        verifier_confidence, confidence_adjustment, value_tier, semantic_flags,
        processing_time_ms, verification_time_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Find cards statement
    this.findCardStmt = this.db.prepare(`
      SELECT * FROM cards 
      WHERE (? IS NULL OR card_name LIKE ?)
        AND (? IS NULL OR card_set = ?)
        AND (? IS NULL OR card_number = ?)
        AND (? IS NULL OR confidence_score >= ?)
        AND (? IS NULL OR value_tier = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `);

    // Exact verification lookup
    this.verifyExactStmt = this.db.prepare(`
      SELECT id, name, set_code, number, 1.0 as similarity_score, 'exact' as match_method
      FROM pokemon_reference
      WHERE name_normalized = ? AND (? IS NULL OR set_code = ?)
      LIMIT 3
    `);

    // Fuzzy search using trigram similarity (simulated with LIKE)
    this.fuzzySearchStmt = this.db.prepare(`
      SELECT id, name, set_code, number, 
             (CASE 
               WHEN name_normalized = ? THEN 1.0
               WHEN name_normalized LIKE ? THEN 0.8
               ELSE 0.6
             END) as similarity_score,
             'fuzzy' as match_method
      FROM pokemon_reference
      WHERE name_normalized LIKE ? 
         OR name_normalized LIKE ?
      ORDER BY similarity_score DESC
      LIMIT 5
    `);

    logger.debug('Prepared statements initialized');
  }

  async findCards(query: CardQuery): Promise<Card[]> {
    const start = Date.now();
    
    try {
      const rows = this.findCardStmt.all(
        query.card_name || null,
        query.card_name ? `%${query.card_name}%` : null,
        query.set_code || null,
        query.number || null,
        query.confidence_min || null,
        query.value_tier || null,
        query.limit || 100
      );

      const cards = rows.map(this.rowToCard);
      
      const queryTime = Date.now() - start;
      metrics.recordHistogram('db_query_latency_ms', queryTime);
      
      return cards;
      
    } catch (error) {
      logger.error('Database query failed:', error);
      metrics.recordError('db_query_failed');
      throw error;
    }
  }

  async storeCard(cardData: Partial<Card>): Promise<Card> {
    const start = Date.now();
    
    try {
      const id = cardData.id || `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const metadata = cardData.metadata;
      
      this.insertCardStmt.run(
        id,
        cardData.imageUrl || '',
        cardData.status || CardStatus.PENDING,
        cardData.confidenceScore || 0,
        metadata?.cardName || null,
        metadata?.cardSet || null,
        metadata?.cardNumber || null,
        metadata?.customFields?.rarity || null,
        metadata?.runId || null,
        metadata?.customFields?.processing_mode || 'distributed',
        metadata?.customFields?.verification_path || null,
        metadata?.customFields?.primary_confidence || null,
        metadata?.customFields?.verifier_confidence || null,
        metadata?.customFields?.confidence_adjustment || null,
        metadata?.customFields?.value_tier || null,
        metadata?.customFields?.semantic_flags ? JSON.stringify(metadata.customFields.semantic_flags) : null,
        metadata?.customFields?.processing_time_ms || null,
        metadata?.customFields?.verification_time_ms || null
      );

      const storeTime = Date.now() - start;
      metrics.recordHistogram('db_store_latency_ms', storeTime);
      metrics.incrementCounter('cards_stored_total');

      // Return the stored card
      const storedCards = await this.findCards({ card_name: metadata?.cardName, limit: 1 });
      return storedCards[0] || { id, ...cardData } as Card;
      
    } catch (error) {
      logger.error('Database store failed:', error);
      metrics.recordError('db_store_failed');
      throw error;
    }
  }

  async verifyCard(name: string, set?: string): Promise<VerificationMatch[]> {
    const start = Date.now();
    
    try {
      const normalizedName = this.normalizeName(name);
      
      // Try exact match first
      let matches = this.verifyExactStmt.all(normalizedName, set || null) as VerificationMatch[];
      
      if (matches.length === 0) {
        // Fall back to fuzzy search
        matches = await this.fuzzySearch(name, 0.6);
      }

      const verifyTime = Date.now() - start;
      metrics.recordHistogram('db_verify_latency_ms', verifyTime);
      
      return matches;
      
    } catch (error) {
      logger.error('Database verification failed:', error);
      metrics.recordError('db_verify_failed');
      return [];
    }
  }

  async fuzzySearch(name: string, threshold = 0.7): Promise<VerificationMatch[]> {
    const normalizedName = this.normalizeName(name);
    const fuzzyPattern = `%${normalizedName}%`;
    const startsWithPattern = `${normalizedName}%`;
    
    const matches = this.fuzzySearchStmt.all(
      normalizedName,      // Exact match check
      startsWithPattern,   // Starts with pattern
      fuzzyPattern,        // Contains pattern
      fuzzyPattern         // Second contains pattern for OR clause
    ) as VerificationMatch[];

    return matches.filter(match => match.similarity_score >= threshold);
  }

  async getStats(): Promise<{ total_cards: number; processed_today: number; verification_rate: number }> {
    try {
      const totalResult = this.db.prepare('SELECT COUNT(*) as count FROM cards').get() as { count: number };
      const todayResult = this.db.prepare(`
        SELECT COUNT(*) as count FROM cards 
        WHERE date(created_at) = date('now')
      `).get() as { count: number };
      const verifiedResult = this.db.prepare(`
        SELECT COUNT(*) as count FROM cards 
        WHERE verification_path = 'verified'
      `).get() as { count: number };

      const verificationRate = totalResult.count > 0 
        ? verifiedResult.count / totalResult.count 
        : 0;

      return {
        total_cards: totalResult.count,
        processed_today: todayResult.count,
        verification_rate: verificationRate
      };
      
    } catch (error) {
      logger.error('Stats query failed:', error);
      return { total_cards: 0, processed_today: 0, verification_rate: 0 };
    }
  }

  // Utility methods
  private rowToCard(row: any): Card {
    return {
      id: row.id,
      imageUrl: row.image_url,
      status: row.status,
      confidenceScore: row.confidence_score,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at || row.created_at),
      metadata: {
        cardName: row.card_name,
        cardSet: row.card_set,
        cardNumber: row.card_number,
        runId: row.run_id,
        customFields: {
          rarity: row.rarity,
          processing_mode: row.processing_mode,
          verification_path: row.verification_path,
          primary_confidence: row.primary_confidence,
          verifier_confidence: row.verifier_confidence,
          confidence_adjustment: row.confidence_adjustment,
          value_tier: row.value_tier,
          semantic_flags: row.semantic_flags ? JSON.parse(row.semantic_flags) : [],
          processing_time_ms: row.processing_time_ms,
          verification_time_ms: row.verification_time_ms
        }
      }
    };
  }

  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' ')        // Normalize whitespace
      .trim();
  }

  close(): void {
    this.db.close();
    logger.info('SQLiteCardStorage connection closed');
  }
}

// Factory function for easy switching between storage implementations
export function createCardStorage(config: CardStorageConfig): CardStorage {
  // For now, always return SQLite. Later, this can switch based on config
  return new SQLiteCardStorage(config);
}