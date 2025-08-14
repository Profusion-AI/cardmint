import { getPool } from './database';
import { RedisCache } from './redis';
import { createLogger } from '../utils/logger';
import { Card, CardStatus } from '../types';

const logger = createLogger('card-repository');

export class CardRepository {
  private cache: RedisCache;
  
  constructor() {
    this.cache = new RedisCache('cards', 300); // 5 minute cache
  }
  
  async createCard(card: Partial<Card>): Promise<Card> {
    const pool = getPool();
    
    try {
      const query = `
        INSERT INTO cards (
          image_url, thumbnail_url, status, metadata, ocr_data
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      
      const values = [
        card.imageUrl,
        card.thumbnailUrl || null,
        card.status || CardStatus.CAPTURED,
        JSON.stringify(card.metadata || {}),
        card.ocrData ? JSON.stringify(card.ocrData) : null,
      ];
      
      const result = await pool.query(query, values);
      const newCard = this.mapRowToCard(result.rows[0]);
      
      await this.cache.set(newCard.id, newCard);
      
      logger.debug(`Created card ${newCard.id}`);
      return newCard;
      
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
    
    const pool = getPool();
    
    try {
      const result = await pool.query(
        'SELECT * FROM cards WHERE id = $1',
        [id]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const card = this.mapRowToCard(result.rows[0]);
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
    const pool = getPool();
    
    try {
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;
      
      if (updates.status !== undefined) {
        updateFields.push(`status = $${paramCount++}`);
        values.push(updates.status);
      }
      
      if (updates.processedAt !== undefined) {
        updateFields.push(`processed_at = $${paramCount++}`);
        values.push(updates.processedAt);
      }
      
      if (updates.metadata !== undefined) {
        updateFields.push(`metadata = $${paramCount++}`);
        values.push(JSON.stringify(updates.metadata));
      }
      
      if (updates.ocrData !== undefined) {
        updateFields.push(`ocr_data = $${paramCount++}`);
        values.push(JSON.stringify(updates.ocrData));
      }
      
      if (updates.error !== undefined) {
        updateFields.push(`error = $${paramCount++}`);
        values.push(updates.error);
      }
      
      if (updateFields.length === 0) {
        return await this.getCard(id);
      }
      
      values.push(id);
      
      const query = `
        UPDATE cards
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;
      
      const result = await pool.query(query, values);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const card = this.mapRowToCard(result.rows[0]);
      await this.cache.delete(id);
      
      logger.debug(`Updated card ${id}`);
      return card;
      
    } catch (error) {
      logger.error(`Failed to update card ${id}:`, error);
      throw error;
    }
  }
  
  async updateStatus(
    id: string,
    status: CardStatus,
    error?: string
  ): Promise<void> {
    await this.updateCard(id, { status, error });
  }
  
  async listCards(
    filters?: {
      status?: CardStatus;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<Card[]> {
    const pool = getPool();
    
    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramCount = 1;
      
      if (filters?.status) {
        conditions.push(`status = $${paramCount++}`);
        values.push(filters.status);
      }
      
      if (filters?.startDate) {
        conditions.push(`captured_at >= $${paramCount++}`);
        values.push(filters.startDate);
      }
      
      if (filters?.endDate) {
        conditions.push(`captured_at <= $${paramCount++}`);
        values.push(filters.endDate);
      }
      
      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      
      const limit = filters?.limit || 100;
      const offset = filters?.offset || 0;
      
      values.push(limit, offset);
      
      const query = `
        SELECT * FROM cards
        ${whereClause}
        ORDER BY captured_at DESC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
      `;
      
      const result = await pool.query(query, values);
      
      return result.rows.map(this.mapRowToCard);
      
    } catch (error) {
      logger.error('Failed to list cards:', error);
      throw error;
    }
  }
  
  async deleteCard(id: string): Promise<boolean> {
    const pool = getPool();
    
    try {
      const result = await pool.query(
        'DELETE FROM cards WHERE id = $1',
        [id]
      );
      
      await this.cache.delete(id);
      
      return (result.rowCount ?? 0) > 0;
      
    } catch (error) {
      logger.error(`Failed to delete card ${id}:`, error);
      throw error;
    }
  }
  
  private mapRowToCard(row: any): Card {
    return {
      id: row.id,
      capturedAt: row.captured_at,
      processedAt: row.processed_at,
      imageUrl: row.image_url,
      thumbnailUrl: row.thumbnail_url,
      status: row.status as CardStatus,
      metadata: row.metadata || {},
      ocrData: row.ocr_data,
      error: row.error,
    };
  }
}