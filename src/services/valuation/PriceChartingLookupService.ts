import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../../utils/logger';
import type { PriceData, PriceLookupKey } from '../local-matching/types';

const logger = createLogger('PriceChartingLookupService');

interface PriceChartingRecord {
  id: string;
  'console-name': string;
  'product-name': string;
  'loose-price': string;
  'cib-price': string;
  'new-price': string;
  'graded-price': string;
  'bgs-10-price': string;
  'release-date': string;
  [key: string]: string;
}

interface ProcessedPriceRecord {
  id: string;
  product_name: string;
  console_name: string;
  loose_price: number | null;
  graded_price: number | null;
  bgs_10_price: number | null;
  release_date: string;
  normalized_key: string;
  set_name?: string;
  card_name?: string;
  card_number?: string;
}

export class PriceChartingLookupService {
  private priceMap: Map<string, ProcessedPriceRecord> = new Map();
  private aliasMap: Map<string, string[]> = new Map();
  private pokemonLexicon: Map<string, string[]> = new Map();
  
  private readonly csvPath: string;
  private readonly lexiconPath: string;
  private readonly cacheSize = 10000; // LRU cache size
  private readonly cacheTtl = 1000 * 60 * 15; // 15 minutes
  private recentQueries: Map<string, { data: PriceData; timestamp: number }> = new Map();
  
  private initialized = false;
  private loading = false;

  constructor() {
    const dataRoot = process.env.DATA_ROOT || './data';
    this.csvPath = process.env.PRICECHARTING_CSV_PATH || path.join(dataRoot, 'pricecharting_pokemon.csv');
    this.lexiconPath = path.join(dataRoot, 'pokemon_lexicon.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.loading) return;
    this.loading = true;
    
    try {
      logger.info('Loading PriceCharting CSV and lexicon data...');
      
      // Load Pokemon lexicon for aliases
      await this.loadPokemonLexicon();
      
      // Load and process CSV data
      await this.loadPriceChartingData();
      
      this.initialized = true;
      logger.info(`PriceCharting lookup initialized: ${this.priceMap.size} records loaded`);
    } catch (error) {
      logger.error('Failed to initialize PriceCharting lookup service:', error);
      throw error;
    } finally {
      this.loading = false;
    }
  }

  private async loadPokemonLexicon(): Promise<void> {
    try {
      const lexiconData = await fs.readFile(this.lexiconPath, 'utf-8');
      const lexicon = JSON.parse(lexiconData);
      
      // Build alias map from pokemon names
      if (lexicon.pokemon_names && Array.isArray(lexicon.pokemon_names)) {
        for (const name of lexicon.pokemon_names) {
          const normalized = this.normalizeText(name);
          const aliases = this.pokemonLexicon.get(normalized) || [];
          aliases.push(name);
          this.pokemonLexicon.set(normalized, aliases);
        }
      }
      
      logger.debug(`Loaded ${this.pokemonLexicon.size} Pokemon names from lexicon`);
    } catch (error) {
      logger.warn('Failed to load Pokemon lexicon:', error);
    }
  }

  private async loadPriceChartingData(): Promise<void> {
    const csvContent = await fs.readFile(this.csvPath, 'utf-8');
    const lines = csvContent.split('\n');
    
    if (lines.length === 0) {
      throw new Error('Empty CSV file');
    }
    
    const headers = lines[0].split(',');
    let processedCount = 0;
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      try {
        const record = this.parseCSVLine(line, headers);
        if (record) {
          const processed = this.processRecord(record);
          if (processed) {
            this.priceMap.set(processed.normalized_key, processed);
            processedCount++;
          }
        }
      } catch (error) {
        logger.debug(`Error processing line ${i}:`, error);
      }
    }
    
    logger.info(`Processed ${processedCount} price records`);
  }

  private parseCSVLine(line: string, headers: string[]): PriceChartingRecord | null {
    const values = this.parseCSVRow(line);
    if (values.length !== headers.length) return null;
    
    const record: PriceChartingRecord = {} as PriceChartingRecord;
    for (let i = 0; i < headers.length; i++) {
      record[headers[i]] = values[i] || '';
    }
    
    return record;
  }

  private parseCSVRow(row: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current);
    return result;
  }

  private processRecord(record: PriceChartingRecord): ProcessedPriceRecord | null {
    // Skip non-Pokemon cards
    if (!record['console-name'] || !record['console-name'].toLowerCase().includes('pokemon')) {
      return null;
    }
    
    const productName = record['product-name'] || '';
    const parsed = this.parseProductName(productName);
    
    const processed: ProcessedPriceRecord = {
      id: record.id,
      product_name: productName,
      console_name: record['console-name'],
      loose_price: this.parsePrice(record['loose-price']),
      graded_price: this.parsePrice(record['graded-price']),
      bgs_10_price: this.parsePrice(record['bgs-10-price']),
      release_date: record['release-date'] || '',
      normalized_key: '',
      ...parsed
    };
    
    // Generate normalized key
    processed.normalized_key = this.generateNormalizedKey({
      set: parsed.set_name || '',
      number: parsed.card_number || '',
      name: parsed.card_name || ''
    });
    
    return processed;
  }

  private parseProductName(productName: string): {set_name?: string, card_name?: string, card_number?: string} {
    // Extract card information from product name
    // Examples: "Charizard #6", "Base Set Charizard #6/102", etc.
    
    const result: {set_name?: string, card_name?: string, card_number?: string} = {};
    
    // Extract card number (pattern: #123 or #123/456)
    const numberMatch = productName.match(/#(\d+(?:\/\d+)?)/);
    if (numberMatch) {
      result.card_number = numberMatch[1];
    }
    
    // Extract set name (before card name, if present)
    const parts = productName.split(' ');
    let nameStart = 0;
    
    // Common set name patterns
    const setPatterns = [
      'Base Set', 'Jungle', 'Fossil', 'Team Rocket', 'Gym Heroes', 'Gym Challenge',
      'Neo Genesis', 'Neo Discovery', 'Neo Destiny', 'Neo Revelation',
      'Expedition', 'Aquapolis', 'Skyridge'
    ];
    
    for (const setPattern of setPatterns) {
      if (productName.toLowerCase().startsWith(setPattern.toLowerCase())) {
        result.set_name = setPattern;
        nameStart = setPattern.split(' ').length;
        break;
      }
    }
    
    // Extract card name (remaining text, excluding number)
    let cardName = parts.slice(nameStart).join(' ');
    cardName = cardName.replace(/#\d+(?:\/\d+)?/, '').trim();
    
    if (cardName) {
      result.card_name = cardName;
    }
    
    return result;
  }

  private parsePrice(priceStr: string): number | null {
    if (!priceStr || priceStr === '') return null;
    
    // Remove currency symbols and parse
    const cleaned = priceStr.replace(/[$,]/g, '');
    const price = parseFloat(cleaned);
    
    return isNaN(price) ? null : Math.round(price * 100); // Convert to cents
  }

  private normalizeText(text: string): string {
    return text.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/\s+/g, '');
  }

  private generateNormalizedKey(lookup: PriceLookupKey): string {
    const set = this.normalizeText(lookup.set);
    const number = lookup.number.replace(/\D/g, ''); // Extract just digits
    const name = this.normalizeText(lookup.name);
    return `${set}|${number}|${name}`;
  }

  async lookupPrice(key: PriceLookupKey): Promise<PriceData | null> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const cacheKey = this.generateNormalizedKey(key);
    
    // Check cache first
    const cached = this.recentQueries.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTtl) {
      return cached.data;
    }
    
    // Try exact match first
    const record = this.priceMap.get(cacheKey);
    if (record) {
      const priceData = this.recordToPriceData(record);
      this.updateCache(cacheKey, priceData);
      return priceData;
    }
    
    // Try fuzzy matching
    const fuzzyResult = await this.fuzzyLookup(key);
    if (fuzzyResult) {
      this.updateCache(cacheKey, fuzzyResult);
      return fuzzyResult;
    }
    
    return null;
  }

  private async fuzzyLookup(key: PriceLookupKey): Promise<PriceData | null> {
    // Try variations of the lookup key
    const variations = this.generateKeyVariations(key);
    
    for (const variation of variations) {
      const normalizedKey = this.generateNormalizedKey(variation);
      const record = this.priceMap.get(normalizedKey);
      if (record) {
        return this.recordToPriceData(record);
      }
    }
    
    return null;
  }

  private generateKeyVariations(key: PriceLookupKey): PriceLookupKey[] {
    const variations: PriceLookupKey[] = [key];
    
    // Try without set name
    variations.push({
      set: '',
      number: key.number,
      name: key.name
    });
    
    // Try with Pokemon aliases
    const normalizedName = this.normalizeText(key.name);
    const aliases = this.pokemonLexicon.get(normalizedName) || [];
    for (const alias of aliases) {
      variations.push({
        set: key.set,
        number: key.number,
        name: alias
      });
    }
    
    return variations;
  }

  private recordToPriceData(record: ProcessedPriceRecord): PriceData {
    return {
      loose_price: record.loose_price,
      graded_price: record.graded_price,
      bgs_10_price: record.bgs_10_price,
      market_price: record.loose_price || record.graded_price,
      currency: 'USD',
      updated_at: new Date()
    };
  }

  private updateCache(key: string, data: PriceData): void {
    // Implement LRU cache eviction
    if (this.recentQueries.size >= this.cacheSize) {
      const oldestKey = this.recentQueries.keys().next().value;
      this.recentQueries.delete(oldestKey);
    }
    
    this.recentQueries.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getStats(): {totalRecords: number, cacheSize: number, initialized: boolean} {
    return {
      totalRecords: this.priceMap.size,
      cacheSize: this.recentQueries.size,
      initialized: this.initialized
    };
  }

  clearCache(): void {
    this.recentQueries.clear();
    logger.debug('Price lookup cache cleared');
  }
}