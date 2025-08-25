import fs from 'fs/promises';
import path from 'path';
import NodeCache from 'node-cache';
import axios, { AxiosInstance } from 'axios';
import { parse } from 'csv-parse/sync';
import { logger } from '../utils/logger';

export interface PriceChartingProduct {
  id: number;
  console_name: string;  // Set name
  product_name: string;  // Card name with number
  loose_price: number;   // Ungraded price in cents
  cib_price: number;     // Complete in box price
  new_price: number;     // Sealed/mint price
  graded_price: number;  // Generic graded price
  bgs_10_price: number;  // BGS 10 price
  condition_17_price: number;  // PSA 9 price
  condition_18_price: number;  // PSA 10 price
  box_only_price: number;
  manual_only_price: number;
  sales_volume: number;
  genre: string;
  tcg_id: string;
  asin: string;
  epid: string;
  release_date: string;
}

export interface SearchResult {
  products: PriceChartingProduct[];
  query: string;
  timestamp: Date;
}

export interface PriceData {
  ungraded: number;
  psa9: number;
  psa10: number;
  bgs10: number;
  market: number;  // Calculated average
}

export class PriceChartingService {
  private api: AxiosInstance;
  private cache: NodeCache;
  private apiKey: string;
  private csvCache: Map<string, PriceChartingProduct> = new Map();
  private lastCsvUpdate: Date | null = null;

  constructor() {
    this.apiKey = process.env.PRICECHARTING_API_KEY || '';
    
    if (!this.apiKey) {
      logger.warn('PriceCharting API key not configured');
    }

    const baseURL = process.env.PRICECHARTING_BASE_URL || 'https://www.pricecharting.com';
    const cacheTTL = parseInt(process.env.PRICECHARTING_CACHE_TTL || '86400');

    this.api = axios.create({
      baseURL,
      timeout: 10000,
      headers: {
        'User-Agent': 'CardMint/1.0'
      }
    });

    // Cache with 24 hour TTL by default
    this.cache = new NodeCache({ 
      stdTTL: cacheTTL,
      checkperiod: 600  // Check for expired keys every 10 minutes
    });

    logger.info('PriceCharting service initialized', {
      baseURL,
      cacheTTL,
      hasApiKey: !!this.apiKey
    });
  }

  /**
   * Search for products by query string
   */
  async searchProducts(query: string, limit: number = 20): Promise<SearchResult> {
    if (!this.apiKey) {
      throw new Error('PriceCharting API key not configured');
    }

    const cacheKey = `search:${query}:${limit}`;
    const cached = this.cache.get<SearchResult>(cacheKey);
    
    if (cached) {
      logger.debug('Cache hit for search', { query });
      return cached;
    }

    try {
      logger.info('Searching PriceCharting', { query });
      
      const response = await this.api.get('/api/products', {
        params: {
          t: this.apiKey,
          q: query
        }
      });

      const result: SearchResult = {
        products: response.data.products || [],
        query,
        timestamp: new Date()
      };

      // Convert prices from cents to dollars for easier use
      result.products = result.products.map(p => this.normalizePrices(p));

      this.cache.set(cacheKey, result);
      
      logger.info('Search completed', { 
        query, 
        resultsCount: result.products.length 
      });

      return result;

    } catch (error) {
      logger.error('PriceCharting search failed', { query, error });
      throw error;
    }
  }

  /**
   * Get a specific product by ID
   */
  async getProduct(productId: number): Promise<PriceChartingProduct | null> {
    if (!this.apiKey) {
      throw new Error('PriceCharting API key not configured');
    }

    const cacheKey = `product:${productId}`;
    const cached = this.cache.get<PriceChartingProduct>(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await this.api.get('/api/product', {
        params: {
          t: this.apiKey,
          id: productId
        }
      });

      if (!response.data) {
        return null;
      }

      const product = this.normalizePrices(response.data);
      this.cache.set(cacheKey, product);

      return product;

    } catch (error) {
      logger.error('Failed to get product', { productId, error });
      return null;
    }
  }

  /**
   * Find best match for OCR results
   */
  async findBestMatch(
    cardName: string,
    setName?: string,
    cardNumber?: string
  ): Promise<{ product: PriceChartingProduct | null; confidence: number }> {
    
    // Build search query from available fields
    const queryParts = [cardName];
    if (setName) queryParts.push(setName);
    if (cardNumber) queryParts.push(cardNumber);
    
    const query = queryParts.join(' ');
    
    try {
      const searchResults = await this.searchProducts(query);
      
      if (searchResults.products.length === 0) {
        return { product: null, confidence: 0 };
      }

      // Score each result
      const scoredResults = searchResults.products.map(product => ({
        product,
        score: this.calculateMatchScore(product, cardName, setName, cardNumber)
      }));

      // Sort by score and get best match
      scoredResults.sort((a, b) => b.score - a.score);
      const bestMatch = scoredResults[0];

      logger.info('Match found', {
        query,
        bestScore: bestMatch.score,
        productName: bestMatch.product.product_name
      });

      return {
        product: bestMatch.product,
        confidence: bestMatch.score
      };

    } catch (error) {
      logger.error('Failed to find match', { cardName, error });
      return { product: null, confidence: 0 };
    }
  }

  /**
   * Calculate match confidence score
   */
  private calculateMatchScore(
    product: PriceChartingProduct,
    cardName: string,
    setName?: string,
    cardNumber?: string
  ): number {
    let score = 0;

    // Normalize strings for comparison
    const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const productNameNorm = normalize(product.product_name);
    const cardNameNorm = normalize(cardName);

    // Card name match (40 points max)
    if (productNameNorm.includes(cardNameNorm) || cardNameNorm.includes(productNameNorm)) {
      score += 40;
    } else {
      // Partial match based on word overlap
      const productWords = productNameNorm.split(' ');
      const cardWords = cardNameNorm.split(' ');
      const overlap = cardWords.filter(w => productWords.includes(w)).length;
      score += (overlap / cardWords.length) * 30;
    }

    // Card number match (30 points)
    if (cardNumber) {
      const numberMatch = product.product_name.match(/#?\d+(?:\/\d+)?/);
      if (numberMatch && numberMatch[0].includes(cardNumber)) {
        score += 30;
      }
    }

    // Set name match (20 points)
    if (setName) {
      const setNameNorm = normalize(setName);
      const consoleNameNorm = normalize(product.console_name);
      
      if (consoleNameNorm.includes(setNameNorm) || setNameNorm.includes(consoleNameNorm)) {
        score += 20;
      }
    }

    // Special edition bonus (10 points)
    const special = ['1st edition', 'shadowless', 'holo', 'reverse'];
    special.forEach(term => {
      if (productNameNorm.includes(term) && cardName.toLowerCase().includes(term)) {
        score += 10;
      }
    });

    return Math.min(score, 100);  // Cap at 100
  }

  /**
   * Download and cache full Pokemon CSV database
   */
  async updateCsvCache(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('PriceCharting API key not configured');
    }

    try {
      logger.info('Downloading PriceCharting Pokemon database...');
      
      const response = await this.api.get('/price-guide/download-custom', {
        params: {
          t: this.apiKey,
          category: 'pokemon-cards'
        },
        responseType: 'text'
      });

      // Parse CSV
      const records = parse(response.data, {
        columns: true,
        skip_empty_lines: true,
        cast: (value, context) => {
          // Convert price fields to numbers
          if (context.column && context.column.includes('price')) {
            const cleaned = value.replace(/[$,]/g, '');
            return cleaned ? parseFloat(cleaned) * 100 : 0;  // Convert to cents
          }
          return value;
        }
      });

      // Build cache map
      this.csvCache.clear();
      records.forEach((record: any) => {
        this.csvCache.set(record.id, record as PriceChartingProduct);
      });

      this.lastCsvUpdate = new Date();
      
      logger.info('CSV cache updated', {
        recordCount: this.csvCache.size,
        timestamp: this.lastCsvUpdate
      });

      // Save to disk for persistence
      await this.saveCsvCache();

    } catch (error) {
      logger.error('Failed to update CSV cache', { error });
      throw error;
    }
  }

  /**
   * Save CSV cache to disk
   */
  private async saveCsvCache(): Promise<void> {
    const cacheDir = path.join(process.cwd(), 'cache');
    const cacheFile = path.join(cacheDir, 'pricecharting_pokemon.json');

    try {
      await fs.mkdir(cacheDir, { recursive: true });
      
      const cacheData = {
        timestamp: this.lastCsvUpdate,
        data: Array.from(this.csvCache.entries())
      };

      await fs.writeFile(cacheFile, JSON.stringify(cacheData));
      logger.info('CSV cache saved to disk');

    } catch (error) {
      logger.error('Failed to save CSV cache', { error });
    }
  }

  /**
   * Load CSV cache from disk
   */
  async loadCsvCache(): Promise<void> {
    const cacheFile = path.join(process.cwd(), 'cache', 'pricecharting_pokemon.json');

    try {
      const data = await fs.readFile(cacheFile, 'utf-8');
      const cacheData = JSON.parse(data);

      this.csvCache = new Map(cacheData.data);
      this.lastCsvUpdate = new Date(cacheData.timestamp);

      logger.info('CSV cache loaded from disk', {
        recordCount: this.csvCache.size,
        timestamp: this.lastCsvUpdate
      });

    } catch (error) {
      logger.warn('Could not load CSV cache from disk', { error });
    }
  }

  /**
   * Get price data for display
   */
  extractPrices(product: PriceChartingProduct): PriceData {
    const prices: PriceData = {
      ungraded: product.loose_price || 0,
      psa9: product.condition_17_price || 0,
      psa10: product.condition_18_price || 0,
      bgs10: product.bgs_10_price || 0,
      market: 0
    };

    // Calculate market average from available prices
    const validPrices = [
      prices.ungraded,
      prices.psa9,
      prices.psa10,
      prices.bgs10
    ].filter(p => p > 0);

    if (validPrices.length > 0) {
      prices.market = Math.round(
        validPrices.reduce((a, b) => a + b, 0) / validPrices.length
      );
    }

    return prices;
  }

  /**
   * Convert prices from cents to dollars
   */
  private normalizePrices(product: any): PriceChartingProduct {
    const priceFields = [
      'loose_price', 'cib_price', 'new_price', 'graded_price',
      'bgs_10_price', 'condition_17_price', 'condition_18_price',
      'box_only_price', 'manual_only_price'
    ];

    const normalized = { ...product };
    
    // Already in cents from API, just ensure they're numbers
    priceFields.forEach(field => {
      if (normalized[field]) {
        normalized[field] = parseInt(normalized[field]);
      }
    });

    return normalized;
  }

  /**
   * Check if cache needs update
   */
  shouldUpdateCache(): boolean {
    if (!this.lastCsvUpdate) return true;
    
    const hoursSinceUpdate = 
      (Date.now() - this.lastCsvUpdate.getTime()) / (1000 * 60 * 60);
    
    return hoursSinceUpdate > 24;  // Update daily
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      csvRecords: this.csvCache.size,
      lastCsvUpdate: this.lastCsvUpdate,
      cacheEntries: this.cache.keys().length,
      shouldUpdate: this.shouldUpdateCache()
    };
  }
}

// Singleton instance
export const priceChartingService = new PriceChartingService();