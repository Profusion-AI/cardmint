import Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { PriceChartingProduct, PriceData } from './PriceChartingService';

/**
 * Market Price Ingestion Service
 * 
 * Maps vendor-specific pricing data to our standardized market_price_samples schema.
 * Handles basis mapping (vendor conditions → our basis system) and stores time-series data.
 */

interface MarketPriceSample {
  card_id: string;
  vendor: string;
  basis: string;          // 'ungraded','NM','LP','PSA','BGS','CGC'
  finish: string;
  edition: string; 
  price_cents: number;
  currency: string;
  grade_numeric?: number;
  product_id?: string;
  metadata?: string;
}

interface VendorConditionMapping {
  vendor: string;
  vendor_condition: string;
  code?: string;          // Our condition code
  grade_min?: number;
  grade_max?: number;
  is_graded: boolean;
  confidence: number;
}

export class MarketPriceIngestion {
  private db: Database.Database;
  private conditionMappings: Map<string, VendorConditionMapping[]>;

  constructor(database: Database.Database) {
    this.db = database;
    this.conditionMappings = new Map();
    this.loadConditionMappings();
  }

  /**
   * Load vendor condition mappings from database
   */
  private loadConditionMappings() {
    const mappings = this.db.prepare(`
      SELECT vendor, vendor_condition, code, grade_min, grade_max, is_graded, confidence
      FROM vendor_condition_map
      ORDER BY vendor, confidence DESC
    `).all() as VendorConditionMapping[];

    // Group by vendor for faster lookups
    for (const mapping of mappings) {
      const vendorMappings = this.conditionMappings.get(mapping.vendor) || [];
      vendorMappings.push(mapping);
      this.conditionMappings.set(mapping.vendor, vendorMappings);
    }

    logger.info('Loaded vendor condition mappings', {
      vendors: this.conditionMappings.size,
      totalMappings: mappings.length
    });
  }

  /**
   * Map vendor condition to our basis system
   */
  private mapConditionToBasis(vendor: string, vendorCondition: string): { basis: string; grade_numeric?: number } | null {
    const mappings = this.conditionMappings.get(vendor);
    if (!mappings) {
      logger.warn('No condition mappings for vendor', { vendor });
      return null;
    }

    // Find exact match first
    const exactMatch = mappings.find(m => m.vendor_condition === vendorCondition);
    if (exactMatch) {
      if (exactMatch.is_graded) {
        // For graded cards, extract grade from condition string
        const gradeMatch = vendorCondition.match(/(\d+(?:\.\d+)?)/);
        const grade = gradeMatch ? parseFloat(gradeMatch[1]) : exactMatch.grade_min;
        
        // Determine grading company from condition string
        if (vendorCondition.toLowerCase().includes('psa')) return { basis: 'PSA', grade_numeric: grade };
        if (vendorCondition.toLowerCase().includes('bgs')) return { basis: 'BGS', grade_numeric: grade };
        if (vendorCondition.toLowerCase().includes('cgc')) return { basis: 'CGC', grade_numeric: grade };
        
        return { basis: 'PSA', grade_numeric: grade }; // Default to PSA for generic grades
      } else {
        // Raw condition mapping
        return { basis: exactMatch.code! };
      }
    }

    // Fallback to partial matching
    const partialMatch = mappings.find(m => 
      vendorCondition.toLowerCase().includes(m.vendor_condition.toLowerCase())
    );
    
    if (partialMatch) {
      return partialMatch.is_graded 
        ? { basis: 'PSA', grade_numeric: partialMatch.grade_min }
        : { basis: partialMatch.code! };
    }

    logger.warn('No condition mapping found', { vendor, vendorCondition });
    return null;
  }

  /**
   * Ingest PriceCharting product data
   */
  async ingestPriceChartingProduct(
    cardId: string, 
    product: PriceChartingProduct,
    finish: string = 'normal',
    edition: string = 'unlimited'
  ): Promise<void> {
    const samples: MarketPriceSample[] = [];
    const vendor = 'pricecharting';

    // Map PriceCharting price fields to our basis system
    const priceFieldMappings = [
      { field: 'loose_price', basis: 'ungraded' },        // Ungraded per PC docs
      { field: 'bgs_10_price', basis: 'BGS', grade: 10.0 },
      { field: 'condition_17_price', basis: 'CGC', grade: 10.0 },
      { field: 'condition_18_price', basis: 'SGC', grade: 10.0 },
      { field: 'graded_price', basis: 'graded' },          // Generic graded (no company)
    ];

    for (const mapping of priceFieldMappings) {
      const price = (product as any)[mapping.field];
      if (price && price > 0) {
        samples.push({
          card_id: cardId,
          vendor,
          basis: mapping.basis,
          finish,
          edition,
          price_cents: Math.round(price), // PriceCharting already returns cents
          currency: 'USD',
          grade_numeric: (mapping as any).grade,
          product_id: product.id.toString(),
          metadata: JSON.stringify({
            product_name: product.product_name,
            console_name: product.console_name,
            tcg_id: product.tcg_id,
            sales_volume: product.sales_volume
          })
        });
      }
    }

    if (samples.length > 0) {
      await this.bulkInsertSamples(samples);
      logger.debug('Ingested PriceCharting samples', {
        cardId,
        productId: product.id,
        sampleCount: samples.length
      });
    }
  }

  /**
   * Ingest TCGPlayer pricing data
   */
  async ingestTCGPlayerPricing(
    cardId: string,
    tcgplayerData: any,
    finish: string = 'normal',
    edition: string = 'unlimited'
  ): Promise<void> {
    const samples: MarketPriceSample[] = [];
    const vendor = 'tcgplayer';

    // TCGPlayer has condition-based pricing
    const conditionPrices = tcgplayerData.prices || {};
    
    for (const [condition, priceData] of Object.entries(conditionPrices)) {
      const mapping = this.mapConditionToBasis(vendor, condition);
      if (!mapping) continue;

      const price = (priceData as any)?.market || (priceData as any)?.mid;
      if (price && price > 0) {
        samples.push({
          card_id: cardId,
          vendor,
          basis: mapping.basis,
          finish,
          edition,
          price_cents: Math.round(price * 100), // Convert dollars to cents
          currency: 'USD',
          grade_numeric: mapping.grade_numeric,
          product_id: tcgplayerData.productId?.toString(),
          metadata: JSON.stringify({
            condition,
            low: (priceData as any)?.low,
            high: (priceData as any)?.high,
            direct_low: (priceData as any)?.directLow
          })
        });
      }
    }

    if (samples.length > 0) {
      await this.bulkInsertSamples(samples);
      logger.debug('Ingested TCGPlayer samples', {
        cardId,
        sampleCount: samples.length
      });
    }
  }

  /**
   * Ingest generic vendor pricing data
   */
  async ingestGenericPricing(
    cardId: string,
    vendor: string,
    priceData: { condition: string; price: number; currency?: string }[],
    finish: string = 'normal',
    edition: string = 'unlimited'
  ): Promise<void> {
    const samples: MarketPriceSample[] = [];

    for (const data of priceData) {
      const mapping = this.mapConditionToBasis(vendor, data.condition);
      if (!mapping) continue;

      samples.push({
        card_id: cardId,
        vendor,
        basis: mapping.basis,
        finish,
        edition,
        price_cents: Math.round(data.price * 100), // Assume dollars, convert to cents
        currency: data.currency || 'USD',
        grade_numeric: mapping.grade_numeric
      });
    }

    if (samples.length > 0) {
      await this.bulkInsertSamples(samples);
      logger.debug('Ingested generic vendor samples', {
        cardId,
        vendor,
        sampleCount: samples.length
      });
    }
  }

  /**
   * Bulk insert market price samples
   */
  private async bulkInsertSamples(samples: MarketPriceSample[]): Promise<void> {
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO market_price_samples 
      (card_id, vendor, basis, finish, edition, price_cents, currency, grade_numeric, product_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((samples: MarketPriceSample[]) => {
      for (const sample of samples) {
        insertStmt.run(
          sample.card_id,
          sample.vendor,
          sample.basis,
          sample.finish,
          sample.edition,
          sample.price_cents,
          sample.currency,
          sample.grade_numeric,
          sample.product_id,
          sample.metadata
        );
      }
    });

    transaction(samples);
  }

  /**
   * Get latest market prices for a card
   */
  getLatestPrices(cardId: string): any[] {
    return this.db.prepare(`
      SELECT vendor, basis, finish, edition, price_cents, grade_numeric, sampled_at
      FROM latest_market_prices
      WHERE card_id = ?
      ORDER BY basis, vendor
    `).all(cardId);
  }

  /**
   * Get price history for a card
   */
  getPriceHistory(
    cardId: string, 
    vendor?: string, 
    basis?: string, 
    days: number = 30
  ): any[] {
    let query = `
      SELECT vendor, basis, price_cents, grade_numeric, sampled_at
      FROM market_price_samples
      WHERE card_id = ? 
        AND sampled_at >= datetime('now', '-${days} days')
    `;
    const params = [cardId];

    if (vendor) {
      query += ' AND vendor = ?';
      params.push(vendor);
    }

    if (basis) {
      query += ' AND basis = ?';
      params.push(basis);
    }

    query += ' ORDER BY sampled_at DESC';

    return this.db.prepare(query).all(...params);
  }

  /**
   * Update condition mappings (reload from database)
   */
  refreshConditionMappings(): void {
    this.conditionMappings.clear();
    this.loadConditionMappings();
  }

  /**
   * Add new condition mapping
   */
  addConditionMapping(mapping: Omit<VendorConditionMapping, 'id'>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO vendor_condition_map
      (vendor, vendor_condition, code, grade_min, grade_max, is_graded, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      mapping.vendor,
      mapping.vendor_condition,
      mapping.code,
      mapping.grade_min,
      mapping.grade_max,
      mapping.is_graded ? 1 : 0,
      mapping.confidence
    );

    this.refreshConditionMappings();
  }
}

// Export singleton instance
let marketPriceIngestion: MarketPriceIngestion | null = null;

export function getMarketPriceIngestion(database: Database.Database): MarketPriceIngestion {
  if (!marketPriceIngestion) {
    marketPriceIngestion = new MarketPriceIngestion(database);
  }
  return marketPriceIngestion;
}
