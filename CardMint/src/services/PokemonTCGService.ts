import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

// Pokemon TCG API Types
export interface PokemonCard {
  id: string;
  name: string;
  supertype: string; // Pokemon, Trainer, Energy
  subtypes?: string[]; // Stage 1, VMAX, etc.
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  evolvesTo?: string[];
  rules?: string[];
  ancientTrait?: {
    name: string;
    text: string;
  };
  abilities?: Array<{
    name: string;
    text: string;
    type: string;
  }>;
  attacks?: Array<{
    name: string;
    cost: string[];
    convertedEnergyCost: number;
    damage: string;
    text: string;
  }>;
  weaknesses?: Array<{
    type: string;
    value: string;
  }>;
  resistances?: Array<{
    type: string;
    value: string;
  }>;
  retreatCost?: string[];
  convertedRetreatCost?: number;
  set: {
    id: string;
    name: string;
    series: string;
    printedTotal: number;
    total: number;
    legalities?: {
      unlimited?: string;
      standard?: string;
      expanded?: string;
    };
    ptcgoCode?: string;
    releaseDate: string;
    updatedAt: string;
    images: {
      symbol: string;
      logo: string;
    };
  };
  number: string;
  artist?: string;
  rarity?: string;
  flavorText?: string;
  nationalPokedexNumbers?: number[];
  legalities?: {
    unlimited?: string;
    standard?: string;
    expanded?: string;
  };
  regulationMark?: string;
  images: {
    small: string;
    large: string;
  };
  tcgplayer?: {
    url: string;
    updatedAt: string;
    prices?: {
      normal?: PriceData;
      holofoil?: PriceData;
      reverseHolofoil?: PriceData;
      '1stEditionNormal'?: PriceData;
      '1stEditionHolofoil'?: PriceData;
      unlimitedHolofoil?: PriceData;
    };
  };
  cardmarket?: {
    url: string;
    updatedAt: string;
    prices?: {
      averageSellPrice?: number;
      lowPrice?: number;
      trendPrice?: number;
      germanProLow?: number;
      suggestedPrice?: number;
      reverseHoloSell?: number;
      reverseHoloLow?: number;
      reverseHoloTrend?: number;
      lowPriceExPlus?: number;
      avg1?: number;
      avg7?: number;
      avg30?: number;
      reverseHoloAvg1?: number;
      reverseHoloAvg7?: number;
      reverseHoloAvg30?: number;
    };
  };
}

interface PriceData {
  low?: number;
  mid?: number;
  high?: number;
  market?: number;
  directLow?: number;
}

export interface SearchQuery {
  q?: string; // Lucene-like query string
  page?: number;
  pageSize?: number;
  orderBy?: string;
}

export interface SearchResponse {
  data: PokemonCard[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

export interface SetInfo {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  images: {
    symbol: string;
    logo: string;
  };
}

export interface ValidationResult {
  isValid: boolean;
  confidence: number;
  discrepancies: string[];
  suggestions: string[];
}

export interface MatchResult {
  card: PokemonCard | null;
  confidence: number;
  alternativeMatches: PokemonCard[];
}

export class PokemonTCGService {
  private api: AxiosInstance;
  private cache: NodeCache;
  private apiKey: string;
  private imageCacheDir: string;

  constructor() {
    this.apiKey = process.env.POKEMONTCG_API_KEY || '';
    this.imageCacheDir = process.env.POKEMONTCG_IMAGE_CACHE_DIR || './cache/card_images';
    
    if (!this.apiKey) {
      logger.warn('Pokemon TCG API key not configured');
    }

    const baseURL = process.env.POKEMONTCG_BASE_URL || 'https://api.pokemontcg.io/v2';
    const cacheTTL = parseInt(process.env.POKEMONTCG_CACHE_TTL || '86400');

    this.api = axios.create({
      baseURL,
      timeout: 15000,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      }
    });

    // Cache with 24 hour TTL by default
    this.cache = new NodeCache({ 
      stdTTL: cacheTTL,
      checkperiod: 600  // Check for expired keys every 10 minutes
    });

    // Ensure image cache directory exists
    this.initializeImageCache();

    logger.info('Pokemon TCG service initialized', {
      baseURL,
      cacheTTL,
      hasApiKey: !!this.apiKey,
      imageCacheDir: this.imageCacheDir
    });
  }

  /**
   * Initialize image cache directory
   */
  private async initializeImageCache(): Promise<void> {
    try {
      await fs.mkdir(this.imageCacheDir, { recursive: true });
      logger.info('Image cache directory initialized', { dir: this.imageCacheDir });
    } catch (error) {
      logger.error('Failed to create image cache directory', { error });
    }
  }

  /**
   * Search for cards using Lucene-like query syntax
   */
  async searchCards(query: SearchQuery): Promise<SearchResponse> {
    const cacheKey = `search:${JSON.stringify(query)}`;
    const cached = this.cache.get<SearchResponse>(cacheKey);
    
    if (cached) {
      logger.debug('Cache hit for search', { query });
      return cached;
    }

    try {
      logger.info('Searching Pokemon TCG', { query });
      
      const response = await this.api.get('/cards', {
        params: {
          q: query.q,
          page: query.page || 1,
          pageSize: query.pageSize || 20,
          orderBy: query.orderBy
        }
      });

      const result: SearchResponse = response.data;
      this.cache.set(cacheKey, result);
      
      logger.info('Search completed', { 
        query: query.q,
        resultsCount: result.count,
        totalCount: result.totalCount
      });

      return result;

    } catch (error) {
      logger.error('Pokemon TCG search failed', { query, error });
      throw error;
    }
  }

  /**
   * Get a specific card by ID
   */
  async getCardById(id: string): Promise<PokemonCard | null> {
    const cacheKey = `card:${id}`;
    const cached = this.cache.get<PokemonCard>(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await this.api.get(`/cards/${id}`);
      
      if (!response.data?.data) {
        return null;
      }

      const card = response.data.data;
      this.cache.set(cacheKey, card);

      return card;

    } catch (error) {
      logger.error('Failed to get card', { id, error });
      return null;
    }
  }

  /**
   * Download and cache card image
   */
  async getCardImage(card: PokemonCard, useHighRes: boolean = true): Promise<Buffer | null> {
    const imageUrl = useHighRes ? card.images.large : card.images.small;
    const imageHash = createHash('md5').update(imageUrl).digest('hex');
    const imagePath = path.join(this.imageCacheDir, `${imageHash}.jpg`);

    try {
      // Check if image is already cached
      try {
        const cachedImage = await fs.readFile(imagePath);
        logger.debug('Image cache hit', { cardId: card.id });
        return cachedImage;
      } catch (error) {
        // Image not cached, download it
      }

      logger.info('Downloading card image', { cardId: card.id, url: imageUrl });
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      const imageBuffer = Buffer.from(response.data);
      
      // Save to cache
      await fs.writeFile(imagePath, imageBuffer);
      logger.info('Card image cached', { cardId: card.id, path: imagePath });

      return imageBuffer;

    } catch (error) {
      logger.error('Failed to get card image', { cardId: card.id, error });
      return null;
    }
  }

  /**
   * Get all cards in a set
   */
  async getSetCards(setId: string): Promise<PokemonCard[]> {
    const cacheKey = `set:${setId}`;
    const cached = this.cache.get<PokemonCard[]>(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const allCards: PokemonCard[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.searchCards({
          q: `set.id:${setId}`,
          page,
          pageSize: 250 // Max page size
        });

        allCards.push(...response.data);
        
        hasMore = response.page * response.pageSize < response.totalCount;
        page++;
      }

      // Sort by card number
      allCards.sort((a, b) => {
        const numA = parseInt(a.number) || 0;
        const numB = parseInt(b.number) || 0;
        return numA - numB;
      });

      this.cache.set(cacheKey, allCards);
      
      logger.info('Retrieved set cards', { 
        setId, 
        cardCount: allCards.length 
      });

      return allCards;

    } catch (error) {
      logger.error('Failed to get set cards', { setId, error });
      return [];
    }
  }

  /**
   * Get all available sets
   */
  async getSets(): Promise<SetInfo[]> {
    const cacheKey = 'sets:all';
    const cached = this.cache.get<SetInfo[]>(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await this.api.get('/sets', {
        params: {
          pageSize: 500 // Get all sets
        }
      });

      const sets = response.data.data || [];
      
      // Cache for 7 days (sets don't change often)
      this.cache.set(cacheKey, sets, 604800);

      return sets;

    } catch (error) {
      logger.error('Failed to get sets', { error });
      return [];
    }
  }

  /**
   * Validate OCR result against official card data
   */
  async validateOCRResult(ocrData: any, card: PokemonCard): Promise<ValidationResult> {
    const discrepancies: string[] = [];
    const suggestions: string[] = [];
    let matchScore = 0;
    let totalChecks = 0;

    // Validate card name
    if (ocrData.card_name) {
      totalChecks++;
      const nameMatch = this.fuzzyMatch(ocrData.card_name, card.name);
      if (nameMatch > 0.9) {
        matchScore++;
      } else if (nameMatch > 0.7) {
        matchScore += 0.5;
        suggestions.push(`Card name might be: ${card.name}`);
      } else {
        discrepancies.push(`Name mismatch: OCR="${ocrData.card_name}" vs API="${card.name}"`);
      }
    }

    // Validate HP
    if (ocrData.hp && card.hp) {
      totalChecks++;
      if (ocrData.hp.toString() === card.hp) {
        matchScore++;
      } else {
        discrepancies.push(`HP mismatch: OCR="${ocrData.hp}" vs API="${card.hp}"`);
      }
    }

    // Validate card number
    if (ocrData.set_number) {
      totalChecks++;
      const ocrNumber = ocrData.set_number.toString();
      if (ocrNumber === card.number || ocrNumber === `#${card.number}`) {
        matchScore++;
      } else {
        discrepancies.push(`Number mismatch: OCR="${ocrNumber}" vs API="${card.number}"`);
      }
    }

    // Validate set
    if (ocrData.set_name || ocrData.set_code) {
      totalChecks++;
      const setMatch = this.matchSet(ocrData, card.set);
      if (setMatch > 0.8) {
        matchScore++;
      } else if (setMatch > 0.5) {
        matchScore += 0.5;
        suggestions.push(`Set might be: ${card.set.name}`);
      } else {
        discrepancies.push(`Set mismatch: OCR="${ocrData.set_name || ocrData.set_code}" vs API="${card.set.name}"`);
      }
    }

    // Validate rarity
    if (ocrData.rarity && card.rarity) {
      totalChecks++;
      if (this.normalizeRarity(ocrData.rarity) === this.normalizeRarity(card.rarity)) {
        matchScore++;
      } else {
        suggestions.push(`Rarity might be: ${card.rarity}`);
      }
    }

    // Validate Pokemon type
    if (ocrData.pokemon_type && card.types) {
      totalChecks++;
      if (card.types.some(type => type.toLowerCase() === ocrData.pokemon_type.toLowerCase())) {
        matchScore++;
      } else {
        suggestions.push(`Types are: ${card.types.join(', ')}`);
      }
    }

    // Validate stage/subtype
    if (ocrData.stage && card.subtypes) {
      totalChecks++;
      if (card.subtypes.some(subtype => 
        subtype.toLowerCase().includes(ocrData.stage.toLowerCase()) ||
        ocrData.stage.toLowerCase().includes(subtype.toLowerCase())
      )) {
        matchScore++;
      }
    }

    const confidence = totalChecks > 0 ? matchScore / totalChecks : 0;

    return {
      isValid: confidence > 0.8,
      confidence,
      discrepancies,
      suggestions
    };
  }

  /**
   * Find best matching card for OCR result
   */
  async findBestMatch(ocrData: any): Promise<MatchResult> {
    // Build search query from OCR data
    const queryParts: string[] = [];
    
    if (ocrData.card_name) {
      // Use exact phrase matching for card name
      queryParts.push(`name:"${ocrData.card_name}"`);
    }
    
    if (ocrData.set_code) {
      queryParts.push(`set.id:${ocrData.set_code.toLowerCase()}*`);
    } else if (ocrData.set_name) {
      queryParts.push(`set.name:"${ocrData.set_name}"`);
    }
    
    if (ocrData.set_number) {
      queryParts.push(`number:${ocrData.set_number}`);
    }
    
    if (ocrData.hp) {
      queryParts.push(`hp:${ocrData.hp}`);
    }

    const query = queryParts.join(' ');
    
    if (!query) {
      return {
        card: null,
        confidence: 0,
        alternativeMatches: []
      };
    }

    try {
      const searchResults = await this.searchCards({
        q: query,
        pageSize: 10
      });

      if (searchResults.data.length === 0) {
        // Try a looser search with just the card name
        if (ocrData.card_name) {
          const looseResults = await this.searchCards({
            q: `name:${ocrData.card_name}`,
            pageSize: 20
          });
          
          if (looseResults.data.length > 0) {
            const scored = await this.scoreMatches(ocrData, looseResults.data);
            return {
              card: scored[0].card,
              confidence: scored[0].score,
              alternativeMatches: scored.slice(1, 4).map(s => s.card)
            };
          }
        }
        
        return {
          card: null,
          confidence: 0,
          alternativeMatches: []
        };
      }

      // Score and rank matches
      const scored = await this.scoreMatches(ocrData, searchResults.data);
      
      return {
        card: scored[0].card,
        confidence: scored[0].score,
        alternativeMatches: scored.slice(1, 4).map(s => s.card)
      };

    } catch (error) {
      logger.error('Failed to find match', { ocrData, error });
      return {
        card: null,
        confidence: 0,
        alternativeMatches: []
      };
    }
  }

  /**
   * Score and rank card matches
   */
  private async scoreMatches(ocrData: any, cards: PokemonCard[]): Promise<Array<{card: PokemonCard, score: number}>> {
    const scored = [];
    
    for (const card of cards) {
      let score = 0;
      let weights = 0;
      
      // Name match (40% weight)
      if (ocrData.card_name) {
        const nameScore = this.fuzzyMatch(ocrData.card_name, card.name);
        score += nameScore * 40;
        weights += 40;
      }
      
      // Card number match (25% weight)
      if (ocrData.set_number && card.number) {
        const numberMatch = ocrData.set_number.toString() === card.number.toString() ? 1 : 0;
        score += numberMatch * 25;
        weights += 25;
      }
      
      // Set match (20% weight)
      if (ocrData.set_name || ocrData.set_code) {
        const setScore = this.matchSet(ocrData, card.set);
        score += setScore * 20;
        weights += 20;
      }
      
      // HP match (10% weight)
      if (ocrData.hp && card.hp) {
        const hpMatch = ocrData.hp.toString() === card.hp.toString() ? 1 : 0;
        score += hpMatch * 10;
        weights += 10;
      }
      
      // Rarity match (5% weight)
      if (ocrData.rarity && card.rarity) {
        const rarityMatch = this.normalizeRarity(ocrData.rarity) === this.normalizeRarity(card.rarity) ? 1 : 0;
        score += rarityMatch * 5;
        weights += 5;
      }
      
      scored.push({
        card,
        score: weights > 0 ? score / weights : 0
      });
    }
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    return scored;
  }

  /**
   * Fuzzy string matching
   */
  private fuzzyMatch(str1: string, str2: string): number {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();
    
    if (s1 === s2) return 1;
    
    // Check if one contains the other
    if (s1.includes(s2) || s2.includes(s1)) {
      return 0.9;
    }
    
    // Levenshtein distance calculation
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    
    return Math.max(0, 1 - (distance / maxLength));
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Match set information
   */
  private matchSet(ocrData: any, apiSet: any): number {
    let bestScore = 0;
    
    // Try to match by set code
    if (ocrData.set_code && apiSet.id) {
      const codeScore = this.fuzzyMatch(ocrData.set_code, apiSet.id);
      bestScore = Math.max(bestScore, codeScore);
      
      // Also try ptcgoCode
      if (apiSet.ptcgoCode) {
        const ptcgoScore = this.fuzzyMatch(ocrData.set_code, apiSet.ptcgoCode);
        bestScore = Math.max(bestScore, ptcgoScore);
      }
    }
    
    // Try to match by set name
    if (ocrData.set_name && apiSet.name) {
      const nameScore = this.fuzzyMatch(ocrData.set_name, apiSet.name);
      bestScore = Math.max(bestScore, nameScore);
    }
    
    return bestScore;
  }

  /**
   * Normalize rarity strings for comparison
   */
  private normalizeRarity(rarity: string): string {
    return rarity
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace('holo', '')
      .replace('rare', '')
      .replace('reverse', '')
      .trim();
  }

  /**
   * Build Lucene query from OCR result
   */
  buildSearchQuery(ocrData: any): string {
    const parts: string[] = [];
    
    // Card name - most important
    if (ocrData.card_name) {
      // Remove any special characters that might break the query
      const cleanName = ocrData.card_name.replace(/[^\w\s-]/g, '');
      parts.push(`name:"${cleanName}"`);
    }
    
    // Set information
    if (ocrData.set_code) {
      parts.push(`(set.id:${ocrData.set_code.toLowerCase()}* OR set.ptcgoCode:${ocrData.set_code})`);
    } else if (ocrData.set_name) {
      parts.push(`set.name:"${ocrData.set_name}"`);
    }
    
    // Card number
    if (ocrData.set_number) {
      parts.push(`number:${ocrData.set_number}`);
    }
    
    // HP
    if (ocrData.hp) {
      parts.push(`hp:${ocrData.hp}`);
    }
    
    // Types
    if (ocrData.pokemon_type) {
      parts.push(`types:${ocrData.pokemon_type.toLowerCase()}`);
    }
    
    // Rarity
    if (ocrData.rarity) {
      parts.push(`rarity:"${ocrData.rarity}"`);
    }
    
    // Special editions
    if (ocrData.is_first_edition) {
      parts.push('name:"1st edition"');
    }
    
    return parts.join(' ');
  }

  /**
   * Extract TCGPlayer pricing data
   */
  extractTCGPlayerPrices(card: PokemonCard): any {
    if (!card.tcgplayer?.prices) {
      return null;
    }
    
    const prices = card.tcgplayer.prices;
    
    // Determine which price variant to use based on card properties
    let selectedPrices: PriceData | undefined;
    
    if (prices['1stEditionHolofoil']) {
      selectedPrices = prices['1stEditionHolofoil'];
    } else if (prices['1stEditionNormal']) {
      selectedPrices = prices['1stEditionNormal'];
    } else if (prices.holofoil) {
      selectedPrices = prices.holofoil;
    } else if (prices.reverseHolofoil) {
      selectedPrices = prices.reverseHolofoil;
    } else if (prices.normal) {
      selectedPrices = prices.normal;
    }
    
    if (!selectedPrices) {
      return null;
    }
    
    return {
      low: selectedPrices.low || 0,
      mid: selectedPrices.mid || 0,
      high: selectedPrices.high || 0,
      market: selectedPrices.market || 0,
      directLow: selectedPrices.directLow || 0,
      url: card.tcgplayer.url,
      updatedAt: card.tcgplayer.updatedAt
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cacheEntries: this.cache.keys().length,
      imageCacheDir: this.imageCacheDir
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.flushAll();
    logger.info('Pokemon TCG cache cleared');
  }
}

// Singleton instance
export const pokemonTCGService = new PokemonTCGService();