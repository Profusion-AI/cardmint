/**
 * LocalMatchingService - Orchestrates pluggable matching strategies
 * Implements confidence fusion and caching for optimal performance
 */

import * as fs from 'fs/promises';
import { createLogger } from '../../utils/logger';
import { createPerformanceLogger } from '../../utils/localMatchingMetrics';
import { DatabaseQueryService } from '../db/DatabaseQueryService';
import { PriceChartingLookupService } from '../valuation/PriceChartingLookupService';
import { PerceptualHashMatcher } from './matchers/PerceptualHashMatcher';
import { SetIconMatcher } from './matchers/SetIconMatcher';
import { NumberMatcher } from './matchers/NumberMatcher';
import { TextMatcher } from './matchers/TextMatcher';
import { 
  Matcher, 
  MatchResult, 
  MatchCandidate,
  MatchMethod,
  LocalMode,
  LocalMatchMetrics 
} from './types';

const logger = createLogger('LocalMatchingService');

export interface LocalMatchingConfig {
  min_confidence: number;
  strategies: MatchMethod[];
  fusion_method: 'weighted' | 'max' | 'consensus';
  cache_enabled: boolean;
  cache_ttl_ms: number;
  mode: LocalMode;
}

export interface LocalMatchingResult {
  matched: boolean;
  confidence: number;
  best_candidate?: MatchCandidate;
  strategy_chain: string[];
  conf_scores: Record<string, number>;
  processing_time_ms: number;
  cached: boolean;
  decision: 'auto_approved' | 'needs_ml' | 'rejected';
  metadata: {
    fusion_method: string;
    strategies_used: number;
    database_lookups: number;
    price_lookups: number;
  };
}

export class LocalMatchingService {
  private matchers: Map<MatchMethod, Matcher> = new Map();
  private resultCache: Map<string, {result: LocalMatchingResult, timestamp: number}> = new Map();
  
  private readonly config: LocalMatchingConfig;
  private readonly dbService: DatabaseQueryService;
  private readonly priceService: PriceChartingLookupService;
  
  private initialized = false;

  constructor(
    dbService: DatabaseQueryService,
    priceService: PriceChartingLookupService,
    config?: Partial<LocalMatchingConfig>
  ) {
    this.dbService = dbService;
    this.priceService = priceService;
    
    this.config = {
      min_confidence: parseFloat(process.env.LOCAL_MATCH_MIN_CONF || '0.85'),
      strategies: ['phash', 'set_icon', 'number', 'text'],
      fusion_method: 'weighted',
      cache_enabled: true,
      cache_ttl_ms: 1000 * 60 * 15, // 15 minutes
      mode: (process.env.LOCAL_MODE as LocalMode) || LocalMode.HYBRID,
      ...config
    };
    
    logger.info('LocalMatchingService initialized with config:', this.config);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    logger.info('Initializing Local Matching Service...');
    
    // Initialize dependencies
    await this.dbService.initialize();
    await this.priceService.initialize();
    
    // Register available matchers (implementation will be added)
    // For now, we'll create placeholder matchers
    await this.registerMatchers();
    
    this.initialized = true;
    logger.info('Local Matching Service initialized successfully');
  }

  private async registerMatchers(): Promise<void> {
    logger.info('Registering production-ready matchers...');
    
    // Register real matchers with initialization
    const matchers = [
      new PerceptualHashMatcher(),
      new SetIconMatcher(), 
      new NumberMatcher(),
      new TextMatcher()
    ];
    
    // Initialize each matcher and register if successful
    for (const matcher of matchers) {
      try {
        await matcher.initialize();
        this.matchers.set(matcher.name, matcher);
        logger.debug(`Registered ${matcher.name} matcher successfully`);
      } catch (error) {
        logger.error(`Failed to register ${matcher.name} matcher:`, error);
        // Continue with other matchers rather than failing completely
      }
    }
    
    if (this.matchers.size === 0) {
      throw new Error('No matchers could be initialized');
    }
    
    logger.info(`Registered ${this.matchers.size} matching strategies successfully`);
  }

  async match(imagePath: string, imageBuffer?: Buffer): Promise<LocalMatchingResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const startTime = Date.now();
    const cacheKey = await this.generateCacheKey(imagePath, imageBuffer);
    
    // Check cache first
    if (this.config.cache_enabled) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        return cached;
      }
    }
    
    const result = await this.performMatching(imagePath, imageBuffer);
    result.processing_time_ms = Date.now() - startTime;
    
    // Cache result
    if (this.config.cache_enabled) {
      this.cacheResult(cacheKey, result);
    }
    
    return result;
  }

  private async performMatching(imagePath: string, imageBuffer?: Buffer): Promise<LocalMatchingResult> {
    const strategyResults: MatchResult[] = [];
    const strategyChain: string[] = [];
    const confScores: Record<string, number> = {};
    let dbLookups = 0;
    let priceLookups = 0;
    
    // Run strategies in order
    for (const strategyName of this.config.strategies) {
      const matcher = this.matchers.get(strategyName);
      if (!matcher || !matcher.isReady()) {
        logger.debug(`Skipping unavailable strategy: ${strategyName}`);
        continue;
      }
      
      try {
        logger.debug(`Running strategy: ${strategyName}`);
        const result = await matcher.match(imagePath, imageBuffer);
        
        strategyResults.push(result);
        strategyChain.push(strategyName);
        confScores[strategyName] = result.confidence;
        
        // Early termination for high-confidence matches
        if (result.confidence >= 0.95 && strategyName === 'phash') {
          logger.debug(`Early termination on high-confidence ${strategyName} match`);
          break;
        }
        
      } catch (error) {
        logger.warn(`Strategy ${strategyName} failed:`, error);
        confScores[strategyName] = 0;
      }
    }
    
    // Fuse results
    const fusedResult = this.fuseResults(strategyResults);
    
    // If no best candidate, try synthesizing from strategy parts
    let bestCandidate = fusedResult.best;
    if (!bestCandidate) {
      const synth = this.trySynthesizeCandidate(strategyResults as any, confScores);
      if (synth) {
        bestCandidate = synth;
      }
    }

    // Enhance with database and price lookups
    if (bestCandidate && fusedResult.confidence >= 0.5) {
      bestCandidate = await this.enhanceCandidate(bestCandidate);
      dbLookups++;
      
      if (fusedResult.best.price_data) {
        priceLookups++;
      }
    }
    
    // Make decision
    const decision = this.makeDecision(fusedResult.confidence);
    
    return {
      matched: fusedResult.confidence >= this.config.min_confidence,
      confidence: fusedResult.confidence,
      best_candidate: bestCandidate,
      strategy_chain: strategyChain,
      conf_scores: confScores,
      processing_time_ms: 0, // Will be set by caller
      cached: false,
      decision,
      metadata: {
        fusion_method: this.config.fusion_method,
        strategies_used: strategyResults.length,
        database_lookups: dbLookups,
        price_lookups: priceLookups
      }
    };
  }

  private fuseResults(results: MatchResult[]): {confidence: number, best?: MatchCandidate} {
    if (results.length === 0) {
      return { confidence: 0 };
    }
    
    switch (this.config.fusion_method) {
      case 'max':
        return this.fuseMax(results);
      case 'consensus':
        return this.fuseConsensus(results);
      case 'weighted':
      default:
        return this.fuseWeighted(results);
    }
  }

  // Combine confident parts across strategies into a single canonical key
  static synthesizeCanonicalKey(
    parts: {
      setCode?: { value: string; conf: number };
      number?: { value: string; conf: number };
      setSize?: { value: string; conf: number };
      name?: { value: string; conf: number };
      promo?: { value: string; conf: number };
    },
    thresholds?: { setMin?: number; numberMin?: number; nameMin?: number }
  ): string | undefined {
    const setMin = thresholds?.setMin ?? parseFloat(process.env.SET_ICON_NCC_THRESH || '0.78');
    const numberMin = thresholds?.numberMin ?? parseFloat(process.env.EVAL_MIN_OCR_CONF || '0.6');
    const nameMin = thresholds?.nameMin ?? 0.7;

    const set = parts.setCode && parts.setCode.conf >= setMin ? parts.setCode.value : '*';
    const num = parts.number && parts.number.conf >= numberMin ? parts.number.value : '*';
    const size = parts.setSize && parts.setSize.conf >= numberMin ? parts.setSize.value : '*';
    const name = parts.name && parts.name.conf >= nameMin ? parts.name.value : '*';

    if (set === '*' && num === '*' && name === '*') return undefined;
    return `${(set || '*').toLowerCase()}|${num}|${size}|${(name || '*').toLowerCase()}`;
  }

  private trySynthesizeCandidate(results: MatchResult[], confScores: Record<string, number>): MatchCandidate | undefined {
    // Gather parts from individual strategy best candidates (runtime fields)
    const getBest = (method: string) => results.find(r => (r as any).method === method) as any;
    const setRes = getBest('set_icon');
    const numRes = getBest('number');
    const textRes = getBest('text');

    const setCandidate = setRes?.best_candidate as MatchCandidate | undefined;
    const numCandidate = numRes?.best_candidate as MatchCandidate | undefined;
    const textCandidate = textRes?.best_candidate as MatchCandidate | undefined;

    const setCode = setCandidate?.metadata && (setCandidate.metadata as any).set_code
      ? String((setCandidate.metadata as any).set_code)
      : (setCandidate?.canonical_key ? String(setCandidate.canonical_key).split('|')[0] : undefined);

    const numberVal = numCandidate?.metadata && (numCandidate.metadata as any).extracted_number
      ? String((numCandidate.metadata as any).extracted_number)
      : (numCandidate?.canonical_key ? String(numCandidate.canonical_key).split('|')[1] : undefined);

    const promoName = textCandidate?.metadata && (textCandidate.metadata as any).extracted_text
      ? String((textCandidate.metadata as any).extracted_text).toLowerCase()
      : undefined;

    const key = LocalMatchingService.synthesizeCanonicalKey({
      setCode: setCode ? { value: setCode, conf: confScores['set_icon'] || 0 } : undefined,
      number: numberVal ? { value: numberVal, conf: confScores['number'] || 0 } : undefined,
      name: promoName ? { value: promoName, conf: confScores['text'] || 0 } : undefined
    });

    if (!key) return undefined;

    const conf = Math.min(
      setCode ? (confScores['set_icon'] || 0) : 1,
      numberVal ? (confScores['number'] || 0) : 1,
      promoName ? (confScores['text'] || 1) : 1
    );

    return {
      canonical_key: key,
      confidence: conf,
      metadata: {
        synthesized: true
      }
    } as any;
  }

  private fuseWeighted(results: MatchResult[]): {confidence: number, best?: MatchCandidate} {
    // Updated weights based on CTO guidance: phash:0.35, set_icon:0.35, number:0.2, text:0.1
    const weights: Record<MatchMethod, number> = {
      phash: 0.35,    // High weight for perceptual matching
      set_icon: 0.35, // High weight for set icon matching (equal to pHash)
      number: 0.20,   // Medium weight for number validation
      text: 0.10,     // Lowest weight, most error-prone
      fusion: 0.0     // Not used in fusion
    };
    
    let weightedSum = 0;
    let totalWeight = 0;
    let bestCandidate: MatchCandidate | undefined;
    let highestConfidence = 0;
    
    for (const result of results) {
      const weight = weights[result.method] || 0.1;
      weightedSum += result.confidence * weight;
      totalWeight += weight;
      
      if (result.confidence > highestConfidence && result.best) {
        highestConfidence = result.confidence;
        bestCandidate = result.best;
      }
    }
    
    const fusedConfidence = totalWeight > 0 ? weightedSum / totalWeight : 0;
    
    return {
      confidence: fusedConfidence,
      best: bestCandidate
    };
  }

  private fuseMax(results: MatchResult[]): {confidence: number, best?: MatchCandidate} {
    let maxConfidence = 0;
    let bestCandidate: MatchCandidate | undefined;
    
    for (const result of results) {
      if (result.confidence > maxConfidence) {
        maxConfidence = result.confidence;
        bestCandidate = result.best;
      }
    }
    
    return {
      confidence: maxConfidence,
      best: bestCandidate
    };
  }

  private fuseConsensus(results: MatchResult[]): {confidence: number, best?: MatchCandidate} {
    // Simple consensus: require at least 2 strategies to agree
    if (results.length < 2) {
      return this.fuseMax(results);
    }
    
    // Group candidates by similarity
    const candidateGroups: MatchCandidate[][] = [];
    
    for (const result of results) {
      if (!result.best) continue;
      
      let addedToGroup = false;
      for (const group of candidateGroups) {
        if (this.candidatesMatch(result.best, group[0])) {
          group.push(result.best);
          addedToGroup = true;
          break;
        }
      }
      
      if (!addedToGroup) {
        candidateGroups.push([result.best]);
      }
    }
    
    // Find largest consensus group
    let largestGroup: MatchCandidate[] = [];
    for (const group of candidateGroups) {
      if (group.length > largestGroup.length) {
        largestGroup = group;
      }
    }
    
    if (largestGroup.length >= 2) {
      // Calculate consensus confidence
      const relevantResults = results.filter(r => 
        r.best && largestGroup.some(c => this.candidatesMatch(r.best!, c))
      );
      
      const avgConfidence = relevantResults.reduce((sum, r) => sum + r.confidence, 0) / relevantResults.length;
      
      return {
        confidence: avgConfidence * (largestGroup.length / results.length), // Boost for consensus
        best: largestGroup[0]
      };
    }
    
    // Fall back to max fusion
    return this.fuseMax(results);
  }

  private candidatesMatch(a: MatchCandidate, b: MatchCandidate): boolean {
    // Simple matching criteria
    return (
      a.set === b.set &&
      a.number === b.number &&
      a.name?.toLowerCase() === b.name?.toLowerCase()
    );
  }

  private async enhanceCandidate(candidate: MatchCandidate): Promise<MatchCandidate> {
    const enhanced = { ...candidate };
    
    try {
      // Database lookup for additional metadata
      if (candidate.name && candidate.set && candidate.number) {
        const dbRecord = await this.dbService.findCardExact(
          candidate.name,
          candidate.set,
          candidate.number
        );
        
        if (dbRecord) {
          enhanced.rarity = dbRecord.rarity;
        }
      }
      
      // Price lookup
      if (candidate.name && candidate.set && candidate.number) {
        const priceData = await this.priceService.lookupPrice({
          name: candidate.name,
          set: candidate.set,
          number: candidate.number
        });
        
        if (priceData) {
          enhanced.price_data = priceData;
        }
      }
      
    } catch (error) {
      logger.debug('Error enhancing candidate:', error);
    }
    
    return enhanced;
  }

  private makeDecision(confidence: number): 'auto_approved' | 'needs_ml' | 'rejected' {
    if (this.config.mode === LocalMode.LOCAL_ONLY) {
      return confidence >= this.config.min_confidence ? 'auto_approved' : 'rejected';
    }
    
    if (this.config.mode === LocalMode.ML_ONLY) {
      return 'needs_ml';
    }
    
    // HYBRID mode
    if (confidence >= this.config.min_confidence) {
      return 'auto_approved';
    } else if (confidence >= 0.3) {
      return 'needs_ml';
    } else {
      return 'rejected';
    }
  }

  private async generateCacheKey(imagePath: string, imageBuffer?: Buffer): Promise<string> {
    // Simple cache key based on file path and modification time
    try {
      const stat = await fs.stat(imagePath);
      return `${imagePath}:${stat.mtime.getTime()}:${stat.size}`;
    } catch (error) {
      return imagePath;
    }
  }

  private getCachedResult(cacheKey: string): LocalMatchingResult | null {
    const cached = this.resultCache.get(cacheKey);
    if (!cached) return null;
    
    const isExpired = (Date.now() - cached.timestamp) > this.config.cache_ttl_ms;
    if (isExpired) {
      this.resultCache.delete(cacheKey);
      return null;
    }
    
    return { ...cached.result, cached: true };
  }

  private cacheResult(cacheKey: string, result: LocalMatchingResult): void {
    // Simple LRU eviction
    if (this.resultCache.size >= 1000) {
      const oldestKey = this.resultCache.keys().next().value;
      this.resultCache.delete(oldestKey);
    }
    
    this.resultCache.set(cacheKey, {
      result: { ...result, cached: false },
      timestamp: Date.now()
    });
  }

  getStats(): {
    initialized: boolean;
    matchers: number;
    cache_size: number;
    config: LocalMatchingConfig;
  } {
    return {
      initialized: this.initialized,
      matchers: this.matchers.size,
      cache_size: this.resultCache.size,
      config: this.config
    };
  }

  clearCache(): void {
    this.resultCache.clear();
    logger.debug('Local matching cache cleared');
  }

  /**
   * Synthesizes a canonical key from partial strategy outputs when confidence gates are met.
   * Returns a wildcard-aware key like `${set}|${number}|${setSize}|${name}` (lowercased),
   * substituting '*' for unavailable parts.
   */
  static synthesizeCanonicalKey(parts: {
    setCode?: { value: string; conf: number };
    number?: { value: string; conf: number };
    setSize?: { value: string; conf: number };
    name?: { value: string; conf: number };
    promo?: { value: string; conf: number };
  }, thresholds?: {
    setMin?: number;
    numberMin?: number;
    nameMin?: number;
  }): string {
    const setMin = thresholds?.setMin ?? 0.78; // aligns with NCC threshold
    const numMin = thresholds?.numberMin ?? 0.60; // OCR min confidence
    const nameMin = thresholds?.nameMin ?? 0.60;

    // Prefer promo-only keys where applicable
    if (parts.promo && parts.promo.conf >= numMin) {
      const promo = parts.promo.value.toLowerCase();
      return `promo|${promo}|*|*`;
    }

    const setKey = parts.setCode && parts.setCode.conf >= setMin
      ? parts.setCode.value.toLowerCase()
      : '*';

    const numberKey = parts.number && parts.number.conf >= numMin
      ? parts.number.value
      : '*';

    const setSizeKey = parts.setSize && parts.setSize.conf >= numMin
      ? parts.setSize.value
      : '*';

    const nameKey = parts.name && parts.name.conf >= nameMin
      ? (parts.name.value || '').toLowerCase().replace(/\s+/g, '-')
      : '*';

    return `${setKey}|${numberKey}${setSizeKey !== '*' && numberKey !== '*' && !/\//.test(numberKey) ? `/${setSizeKey}` : ''}|${setSizeKey === '*' ? '*' : setSizeKey}|${nameKey}`
      .replace('|*/*|', '|*|')
      .replace('||', '|')
      .replace(/\|\|/g, '|');
  }
}

// Placeholder matcher implementation
class PlaceholderMatcher implements Matcher {
  constructor(
    public readonly name: MatchMethod,
    private baseConfidence: number
  ) {}

  async match(imagePath: string, imageBuffer?: Buffer): Promise<MatchResult> {
    const startTime = Date.now();
    
    // Generate a deterministic but varied confidence based on path
    const pathHash = imagePath.split('').reduce((hash, char) => {
      return ((hash << 5) - hash + char.charCodeAt(0)) & 0xffffffff;
    }, 0);
    
    const variance = (Math.abs(pathHash) % 20) / 100; // 0-0.19 variance
    const confidence = Math.max(0, Math.min(1, this.baseConfidence + variance - 0.1));
    
    const processingTime = Date.now() - startTime;
    
    const result: MatchResult = {
      method: this.name,
      confidence,
      candidates: [],
      processing_time_ms: processingTime,
      timings: {
        [this.name]: processingTime
      }
    };
    
    if (confidence > 0.5) {
      result.best = {
        id: `placeholder-${this.name}`,
        name: 'Placeholder Card',
        set: 'Test Set',
        number: '001',
        score: confidence
      };
      result.candidates = [result.best];
    }
    
    return result;
  }

  async precompute?(): Promise<void> {
    // Placeholder implementation
  }

  isReady(): boolean {
    return true;
  }
}
