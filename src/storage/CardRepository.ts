import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { Card, CardStatus } from '../types';
import { getDatabase, insertCard, updateCard as updateCardDb, getCard as getCardDb, getAllCards } from './sqlite-database';
import { RedisCache } from './redis';

const logger = createLogger('card-repository-sqlite');

export class CardRepository {
  private cache: RedisCache;
  
  constructor() {
    this.cache = new RedisCache('cards', 300); // 5 minute cache
  }
  
  async createCard(card: Partial<Card>): Promise<Card> {
    try {
      // Map from Card type to database schema
      const dbCard = {
        id: uuidv4(),
        image_url: card.imageUrl || '',
        thumbnail_url: card.thumbnailUrl,
        status: card.status || CardStatus.CAPTURED,
        metadata: card.metadata || {},
        ocr_text: card.ocrData ? JSON.stringify(card.ocrData) : undefined,
        confidence_score: card.confidenceScore || 0,
        name: card.name,
        set_name: card.setName,
        card_number: card.cardNumber,
        rarity: card.rarity,
        type: card.type,
      };
      
      const newCard = insertCard(dbCard);
      
      // Map back to Card type
      const mappedCard = this.mapRowToCard(newCard);
      
      await this.cache.set(mappedCard.id, mappedCard);
      
      logger.debug(`Created card ${mappedCard.id}`);
      return mappedCard;
      
    } catch (error) {
      logger.error('Failed to create card:', error);
      throw error;
    }
  }
  
  async getCard(id: string): Promise<Card | null> {
    // Check cache first
    const cached = await this.cache.get<Card>(id);
    if (cached) {
      return cached;
    }
    
    try {
      const dbCard = getCardDb(id);
      
      if (!dbCard) {
        return null;
      }
      
      const card = this.mapRowToCard(dbCard);
      await this.cache.set(id, card);
      
      return card;
      
    } catch (error) {
      logger.error(`Failed to get card ${id}:`, error);
      throw error;
    }
  }
  
  async updateCard(
    id: string,
    updates: Partial<Card>
  ): Promise<Card | null> {
    try {
      // Map from Card type to database schema
      const dbUpdates: any = {};
      
      if (updates.status !== undefined) {
        dbUpdates.status = updates.status;
      }
      
      if (updates.processedAt !== undefined) {
        dbUpdates.processed_at = updates.processedAt?.toISOString();
      }
      
      if (updates.metadata !== undefined) {
        dbUpdates.metadata = updates.metadata;
      }
      
      if (updates.ocrData !== undefined) {
        dbUpdates.ocr_text = JSON.stringify(updates.ocrData);
      }
      
      if (updates.confidenceScore !== undefined) {
        dbUpdates.confidence_score = updates.confidenceScore;
      }
      
      if (updates.errorMessage !== undefined) {
        dbUpdates.error_message = updates.errorMessage;
      }
      
      if (updates.processingTimeMs !== undefined) {
        dbUpdates.processing_time_ms = updates.processingTimeMs;
      }
      
      if (updates.name !== undefined) {
        dbUpdates.name = updates.name;
      }
      
      if (updates.setName !== undefined) {
        dbUpdates.set_name = updates.setName;
      }
      
      if (updates.cardNumber !== undefined) {
        dbUpdates.card_number = updates.cardNumber;
      }
      
      if (updates.rarity !== undefined) {
        dbUpdates.rarity = updates.rarity;
      }
      
      if (updates.type !== undefined) {
        dbUpdates.type = updates.type;
      }
      
      if (updates.priceUsd !== undefined) {
        dbUpdates.price_usd = updates.priceUsd;
      }
      
      const updatedCard = updateCardDb(id, dbUpdates);
      
      if (!updatedCard) {
        return null;
      }
      
      const card = this.mapRowToCard(updatedCard);
      
      // Invalidate cache
      await this.cache.delete(id);
      
      logger.debug(`Updated card ${id}`);
      return card;
      
    } catch (error) {
      logger.error(`Failed to update card ${id}:`, error);
      throw error;
    }
  }
  
  async getAllCards(limit = 100, offset = 0): Promise<Card[]> {
    try {
      const dbCards = getAllCards(limit, offset);
      return dbCards.map(row => this.mapRowToCard(row));
    } catch (error) {
      logger.error('Failed to get all cards:', error);
      throw error;
    }
  }

  // Alias for API compatibility
  async listCards(options: { limit?: number; offset?: number } = {}): Promise<Card[]> {
    return this.getAllCards(options.limit, options.offset);
  }
  
  async findByImagePath(imagePath: string): Promise<Card | null> {
    const database = getDatabase();
    
    try {
      const stmt = database.prepare(
        'SELECT * FROM cards WHERE image_url = ? LIMIT 1'
      );
      
      const row = stmt.get(imagePath) as any;
      
      if (!row) {
        return null;
      }
      
      return this.mapRowToCard(row);
      
    } catch (error) {
      logger.error(`Failed to find card by image path ${imagePath}:`, error);
      throw error;
    }
  }
  
  async getCardsByStatus(
    status: CardStatus,
    limit = 100
  ): Promise<Card[]> {
    const database = getDatabase();
    
    try {
      const stmt = database.prepare(`
        SELECT * FROM cards 
        WHERE status = ? 
        ORDER BY captured_at DESC 
        LIMIT ?
      `);
      
      const rows = stmt.all(status, limit) as any[];
      
      return rows.map(row => this.mapRowToCard(row));
      
    } catch (error) {
      logger.error(`Failed to get cards by status ${status}:`, error);
      throw error;
    }
  }
  
  async getRecentCards(hours = 24): Promise<Card[]> {
    const database = getDatabase();
    
    try {
      const stmt = database.prepare(`
        SELECT * FROM cards 
        WHERE datetime(captured_at) > datetime('now', '-' || ? || ' hours')
        ORDER BY captured_at DESC
      `);
      
      const rows = stmt.all(hours) as any[];
      
      return rows.map(row => this.mapRowToCard(row));
      
    } catch (error) {
      logger.error('Failed to get recent cards:', error);
      throw error;
    }
  }
  
  async getQueueStatus(): Promise<any> {
    const database = getDatabase();
    
    try {
      const stmt = database.prepare(`
        SELECT 
          status,
          COUNT(*) as count,
          MIN(captured_at) as oldest,
          MAX(captured_at) as newest
        FROM cards
        GROUP BY status
      `);
      
      const rows = stmt.all() as any[];
      
      const status: any = {
        total: 0,
        byStatus: {}
      };
      
      rows.forEach(row => {
        status.byStatus[row.status] = {
          count: row.count,
          oldest: row.oldest,
          newest: row.newest
        };
        status.total += row.count;
      });
      
      return status;
      
    } catch (error) {
      logger.error('Failed to get queue status:', error);
      throw error;
    }
  }
  
  private mapRowToCard(row: any): Card {
    let ocrData = null;
    if (row.ocr_text) {
      try {
        ocrData = JSON.parse(row.ocr_text);
      } catch (e) {
        ocrData = { text: row.ocr_text };
      }
    }
    
    let metadata = {};
    if (row.metadata) {
      try {
        metadata = typeof row.metadata === 'string' 
          ? JSON.parse(row.metadata) 
          : row.metadata;
      } catch (e) {
        metadata = {};
      }
    }
    
    return {
      id: row.id,
      capturedAt: new Date(row.captured_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
      imageUrl: row.image_url,
      thumbnailUrl: row.thumbnail_url,
      status: row.status as CardStatus,
      metadata: metadata,
      ocrData: ocrData,
      confidenceScore: row.confidence_score,
      errorMessage: row.error_message,
      processingTimeMs: row.processing_time_ms,
      // Pokemon-specific fields
      name: row.name,
      setName: row.set_name,
      cardNumber: row.card_number,
      rarity: row.rarity,
      type: row.type,
      priceUsd: row.price_usd,
      priceUpdatedAt: row.price_updated_at ? new Date(row.price_updated_at) : undefined,
      tcgPlayerId: row.tcg_player_id,
      priceChartingId: row.price_charting_id,
    };
  }
}