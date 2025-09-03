/**
 * ValuationService: In-process card valuation with raw vs graded comparison
 * 
 * Features:
 * - Pure read-only SQLite queries (no API calls)
 * - Sub-10ms prepared statement performance
 * - Configurable grading assumptions via environment
 * - 15-minute memoization cache for repeated queries
 * - GPT-friendly JSON output for minimal token usage
 */

import Database from 'better-sqlite3';
import NodeCache from 'node-cache';
import { createLogger } from '../utils/logger';
import { DeterministicResolver, ResolutionResult, QueryInput } from '../resolution/DeterministicResolver';

const logger = createLogger('valuation-service');

// Configuration interface
interface ValuationConfig {
  enabled: boolean;
  fees: {
    ebayRaw: number;
    fanaticsGraded: number;
  };
  costs: {
    gradingBase: number;    // in cents
    shipToGrader: number;   // in cents
    shipToBuyerRaw: number; // in cents
    shipToBuyerGraded: number; // in cents
  };
  priors: {
    psa9Probability: number;
    psa10Probability: number;
  };
  cacheTtlMinutes: number;
}

// Price data from latest_market_prices view
interface PriceRow {
  basis: string;
  price_cents: number;
  grade_numeric?: number;
  vendor: string;
}

interface GradedPrice {
  grade: number;
  price: number;
  basis: string; // PSA, BGS, CGC, SGC
}

// Valuation result for GPT consumption
export interface ValuationResult {
  recommendation: 'raw' | 'graded' | 'insufficient_data';
  rawNetCents: number;
  gradedNetCents: number;
  chosenBasis: string;
  assumptions: {
    fees: { raw: number; graded: number };
    costs: { grading: number; shipping: number };
    priors: { psa9: number; psa10: number };
  };
  confidence: number;
  evidence: string[];
}

export class ValuationService {
  private db: Database.Database;
  private cache: NodeCache;
  private config: ValuationConfig;
  private resolver: DeterministicResolver;

  // Prepared statements for lightning-fast queries
  private stmtLatestPrices: Database.Statement<[string, string, string]>;
  
  constructor(database: Database.Database, resolver: DeterministicResolver) {
    this.db = database;
    this.resolver = resolver;
    
    // Load configuration from environment
    this.config = this.loadConfiguration();
    
    if (!this.config.enabled) {
      logger.info('ValuationService disabled via VALUATION_ENABLED=false');
      return;
    }

    // Initialize cache with configured TTL
    this.cache = new NodeCache({
      stdTTL: this.config.cacheTtlMinutes * 60,
      checkperiod: 600, // Check for expired keys every 10 minutes
      useClones: false  // Faster access, but be careful with mutations
    });

    // Prepare statements for optimal performance
    this.prepareStatements();

    logger.info('ValuationService initialized', {
      enabled: this.config.enabled,
      cacheTtlMinutes: this.config.cacheTtlMinutes,
      gradingCost: this.config.costs.gradingBase,
      ebayFee: this.config.fees.ebayRaw,
      fanaticsFee: this.config.fees.fanaticsGraded
    });
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfiguration(): ValuationConfig {
    return {
      enabled: process.env.VALUATION_ENABLED === 'true',
      fees: {
        ebayRaw: parseFloat(process.env.FEE_EBAY_RAW || '0.13'),
        fanaticsGraded: parseFloat(process.env.FEE_FANATICS_GRADED || '0.10')
      },
      costs: {
        gradingBase: parseInt(process.env.GRADING_COST_BASE || '2000'), // $20
        shipToGrader: parseInt(process.env.SHIP_TO_GRADER || '500'), // $5
        shipToBuyerRaw: parseInt(process.env.SHIP_TO_BUYER_RAW || '300'), // $3
        shipToBuyerGraded: parseInt(process.env.SHIP_TO_BUYER_GRADED || '500') // $5
      },
      priors: {
        psa9Probability: parseFloat(process.env.PSA9_PROBABILITY || '0.70'),
        psa10Probability: parseFloat(process.env.PSA10_PROBABILITY || '0.30')
      },
      cacheTtlMinutes: parseInt(process.env.CACHE_TTL_MINUTES || '15')
    };
  }

  /**
   * Prepare SQL statements for optimal performance
   */
  private prepareStatements(): void {
    // Fetch latest prices with basis priority (PSA > BGS > CGC > SGC)
    this.stmtLatestPrices = this.db.prepare(`
      SELECT basis, price_cents, grade_numeric, vendor
      FROM latest_market_prices
      WHERE card_id = ? 
        AND finish = COALESCE(?, 'normal')
        AND edition = COALESCE(?, 'unlimited')
      ORDER BY 
        CASE basis 
          WHEN 'PSA' THEN 1 
          WHEN 'BGS' THEN 2 
          WHEN 'CGC' THEN 3 
          WHEN 'SGC' THEN 4 
          WHEN 'ungraded' THEN 5
          ELSE 6 
        END,
        grade_numeric DESC
    `);
  }

  /**
   * Main valuation API - resolves card and compares raw vs graded value
   */
  async compareResale(input: {
    query?: string;
    cardId?: string;
    variant?: { finish?: string; edition?: string };
  }): Promise<ValuationResult> {
    if (!this.config.enabled) {
      throw new Error('ValuationService is disabled');
    }

    const startTime = Date.now();
    
    try {
      // Generate cache key
      const cacheKey = this.generateCacheKey(input);
      const cached = this.cache.get<ValuationResult>(cacheKey);
      
      if (cached) {
        logger.debug('Cache hit for valuation', { cacheKey });
        return cached;
      }

      // Resolve card if query provided
      let cardId = input.cardId;
      let resolutionResult: ResolutionResult | null = null;

      if (!cardId && input.query) {
        const queryInput: QueryInput = this.parseQuery(input.query);
        resolutionResult = await this.resolver.resolve(queryInput);
        
        if (resolutionResult.verdict === 'UNCERTAIN' || !resolutionResult.chosen_card) {
          return this.createInsufficientDataResult('Could not resolve card from query');
        }
        
        cardId = resolutionResult.chosen_card.id;
      }

      if (!cardId) {
        return this.createInsufficientDataResult('No cardId or query provided');
      }

      // Fetch market prices
      const prices = this.fetchMarketPrices(
        cardId,
        input.variant?.finish,
        input.variant?.edition
      );

      if (prices.length === 0) {
        return this.createInsufficientDataResult('No market price data available');
      }

      // Separate raw and graded prices
      const rawPrice = this.extractRawPrice(prices);
      const gradedPrices = this.extractGradedPrices(prices);

      // Compute expected nets
      const rawNet = this.computeRawNet(rawPrice);
      const gradedNet = this.computeGradedNet(gradedPrices);

      // Build result
      const result: ValuationResult = {
        recommendation: gradedNet > rawNet ? 'graded' : 'raw',
        rawNetCents: rawNet,
        gradedNetCents: gradedNet,
        chosenBasis: this.getChosenBasis(gradedPrices),
        assumptions: {
          fees: {
            raw: this.config.fees.ebayRaw,
            graded: this.config.fees.fanaticsGraded
          },
          costs: {
            grading: this.config.costs.gradingBase,
            shipping: this.config.costs.shipToGrader + this.config.costs.shipToBuyerGraded
          },
          priors: {
            psa9: this.config.priors.psa9Probability,
            psa10: this.config.priors.psa10Probability
          }
        },
        confidence: this.calculateConfidence(rawPrice, gradedPrices, resolutionResult),
        evidence: this.generateEvidence(rawPrice, gradedPrices, rawNet, gradedNet)
      };

      // Cache result
      this.cache.set(cacheKey, result);

      // Log metrics
      const latencyMs = Date.now() - startTime;
      logger.info('Valuation computed', {
        cardId,
        recommendation: result.recommendation,
        rawNet: result.rawNetCents,
        gradedNet: result.gradedNetCents,
        confidence: result.confidence,
        latencyMs,
        hasPrices: prices.length > 0
      });

      return result;

    } catch (error) {
      logger.error('Valuation failed', { 
        input, 
        error: error instanceof Error ? error.message : String(error) 
      });
      
      return this.createInsufficientDataResult('Internal error during valuation');
    }
  }

  /**
   * Generate cache key from input parameters
   */
  private generateCacheKey(input: any): string {
    const key = JSON.stringify({
      query: input.query,
      cardId: input.cardId,
      variant: input.variant || {}
    });
    return `valuation:${Buffer.from(key).toString('base64')}`;
  }

  /**
   * Parse free-form query into structured fields
   */
  private parseQuery(query: string): QueryInput {
    // Simple parsing - could be enhanced
    return { raw: query.trim() };
  }

  /**
   * Fetch latest market prices for a card
   */
  private fetchMarketPrices(cardId: string, finish?: string, edition?: string): PriceRow[] {
    return this.stmtLatestPrices.all(
      cardId,
      finish || 'normal',
      edition || 'unlimited'
    ) as PriceRow[];
  }

  /**
   * Extract raw/ungraded price from price data
   */
  private extractRawPrice(prices: PriceRow[]): number {
    const rawPrice = prices.find(p => p.basis === 'ungraded');
    return rawPrice?.price_cents || 0;
  }

  /**
   * Extract graded prices with grade information
   */
  private extractGradedPrices(prices: PriceRow[]): GradedPrice[] {
    return prices
      .filter(p => p.basis !== 'ungraded' && p.grade_numeric)
      .map(p => ({
        grade: p.grade_numeric!,
        price: p.price_cents,
        basis: p.basis
      }))
      .sort((a, b) => b.grade - a.grade); // Sort highest grade first
  }

  /**
   * Compute expected net for raw sale
   */
  private computeRawNet(rawPrice: number): number {
    if (rawPrice <= 0) return 0;
    
    const grossPrice = rawPrice;
    const marketplaceFee = grossPrice * this.config.fees.ebayRaw;
    const shippingCost = this.config.costs.shipToBuyerRaw;
    
    return Math.max(0, grossPrice - marketplaceFee - shippingCost);
  }

  /**
   * Compute expected net for graded sale using grade outcome priors
   */
  private computeGradedNet(gradedPrices: GradedPrice[]): number {
    if (gradedPrices.length === 0) return 0;

    // Find PSA 9 and PSA 10 prices, or use best available
    const psa9Price = this.findPriceForGrade(gradedPrices, 9) || 
                     this.estimatePriceForGrade(gradedPrices, 9);
    const psa10Price = this.findPriceForGrade(gradedPrices, 10) || 
                      this.estimatePriceForGrade(gradedPrices, 10);

    // Compute expected sale price using priors
    const expectedSalePrice = 
      (psa9Price * this.config.priors.psa9Probability) +
      (psa10Price * this.config.priors.psa10Probability);

    if (expectedSalePrice <= 0) return 0;

    // Compute net after all costs
    const marketplaceFee = expectedSalePrice * this.config.fees.fanaticsGraded;
    const totalCosts = 
      this.config.costs.gradingBase +
      this.config.costs.shipToGrader +
      this.config.costs.shipToBuyerGraded;

    return Math.max(0, expectedSalePrice - marketplaceFee - totalCosts);
  }

  /**
   * Find price for specific grade in graded prices
   */
  private findPriceForGrade(gradedPrices: GradedPrice[], targetGrade: number): number {
    const match = gradedPrices.find(p => Math.abs(p.grade - targetGrade) < 0.1);
    return match?.price || 0;
  }

  /**
   * Estimate price for grade using available data
   */
  private estimatePriceForGrade(gradedPrices: GradedPrice[], targetGrade: number): number {
    if (gradedPrices.length === 0) return 0;

    // Simple heuristic: use highest available grade price
    const bestPrice = gradedPrices[0].price;
    
    if (targetGrade === 9 && gradedPrices[0].grade >= 9) {
      return bestPrice * 0.8; // PSA 9 typically ~80% of PSA 10
    } else if (targetGrade === 10 && gradedPrices[0].grade >= 9) {
      return bestPrice * 1.25; // PSA 10 typically ~125% of PSA 9
    }
    
    return bestPrice;
  }

  /**
   * Get the chosen grading company basis
   */
  private getChosenBasis(gradedPrices: GradedPrice[]): string {
    if (gradedPrices.length === 0) return 'PSA (default)';
    
    // Return the basis of the highest grade available
    return gradedPrices[0].basis;
  }

  /**
   * Calculate overall confidence in valuation
   */
  private calculateConfidence(
    rawPrice: number, 
    gradedPrices: GradedPrice[], 
    resolutionResult?: ResolutionResult | null
  ): number {
    let confidence = 0.5; // Base confidence

    // Resolution confidence
    if (resolutionResult) {
      confidence *= resolutionResult.confidence;
    } else {
      confidence *= 0.9; // Slight reduction if no resolution needed
    }

    // Price data availability
    if (rawPrice > 0) confidence += 0.2;
    if (gradedPrices.length > 0) confidence += 0.2;
    if (gradedPrices.length >= 2) confidence += 0.1;

    return Math.min(1.0, confidence);
  }

  /**
   * Generate human-readable evidence for the recommendation
   */
  private generateEvidence(
    rawPrice: number,
    gradedPrices: GradedPrice[],
    rawNet: number,
    gradedNet: number
  ): string[] {
    const evidence: string[] = [];

    if (rawPrice > 0) {
      evidence.push(`Raw market price: $${(rawPrice / 100).toFixed(2)}`);
      evidence.push(`Raw net after fees: $${(rawNet / 100).toFixed(2)}`);
    }

    if (gradedPrices.length > 0) {
      const best = gradedPrices[0];
      evidence.push(`Best graded price: ${best.basis} ${best.grade} at $${(best.price / 100).toFixed(2)}`);
      evidence.push(`Graded net after costs: $${(gradedNet / 100).toFixed(2)}`);
    }

    const netDifference = gradedNet - rawNet;
    if (netDifference > 0) {
      evidence.push(`Grading advantage: $${(netDifference / 100).toFixed(2)}`);
    } else if (netDifference < 0) {
      evidence.push(`Raw advantage: $${(-netDifference / 100).toFixed(2)}`);
    }

    return evidence;
  }

  /**
   * Create result for insufficient data scenarios
   */
  private createInsufficientDataResult(reason: string): ValuationResult {
    return {
      recommendation: 'insufficient_data',
      rawNetCents: 0,
      gradedNetCents: 0,
      chosenBasis: 'none',
      assumptions: {
        fees: { raw: this.config.fees.ebayRaw, graded: this.config.fees.fanaticsGraded },
        costs: { grading: this.config.costs.gradingBase, shipping: 0 },
        priors: { psa9: this.config.priors.psa9Probability, psa10: this.config.priors.psa10Probability }
      },
      confidence: 0,
      evidence: [reason]
    };
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats() {
    return {
      entries: this.cache.keys().length,
      hits: this.cache.getStats().hits,
      misses: this.cache.getStats().misses,
      ttlMinutes: this.config.cacheTtlMinutes
    };
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache.flushAll();
  }
}