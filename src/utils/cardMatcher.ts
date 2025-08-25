/* TODO: Review and add specific port type imports from @core/* */
import { pokemonTCGService, PokemonCard } from '../services/PokemonTCGService';
import { priceChartingService, PriceChartingProduct } from '../services/PriceChartingService';
import { ports } from '../app/wiring';
import { logger } from './logger';

export interface OCRResult {
  card_name?: string;
  hp?: number;
  pokemon_type?: string;
  stage?: string;
  set_name?: string;
  set_code?: string;
  set_number?: string;
  set_total?: number;
  rarity?: string;
  attacks?: Array<{
    name: string;
    damage?: string;
    energy_cost?: string[];
    effect?: string;
  }>;
  abilities?: Array<{
    name: string;
    effect: string;
  }>;
  weakness?: string;
  resistance?: string;
  retreat_cost?: number;
  illustrator?: string;
  regulation_mark?: string;
  is_first_edition?: boolean;
  is_promo?: boolean;
  is_holo?: boolean;
  variant_type?: string;
  pokedex_entry?: string;
  confidence_scores?: Record<string, number>;
  overall_confidence?: number;
  image?: Buffer;
  image_path?: string;
  processing_timestamp?: string;
  needs_review?: boolean;
  pricecharting_query?: string;
}

export interface EnrichedCardData {
  // Identity
  id: string;
  card_name: string;
  set_name: string;
  set_code?: string;
  card_number: string;
  set_total?: number;
  rarity?: string;
  
  // Pokemon-specific
  hp?: number;
  pokemon_type?: string[];
  stage?: string;
  evolves_from?: string;
  evolves_to?: string[];
  attacks?: any[];
  abilities?: any[];
  weakness?: any[];
  resistance?: any[];
  retreat_cost?: number;
  
  // Visual characteristics
  is_first_edition: boolean;
  is_shadowless: boolean;
  is_holo: boolean;
  is_reverse_holo: boolean;
  is_promo: boolean;
  variant_type?: string;
  
  // API identifiers
  pokemontcg_id?: string;
  pricecharting_id?: number;
  tcgplayer_id?: string;
  
  // Images
  official_image_url?: string;
  captured_image_path?: string;
  
  // Pricing data
  pricing: {
    tcgplayer?: {
      market?: number;
      low?: number;
      mid?: number;
      high?: number;
      direct_low?: number;
      url?: string;
      updated_at?: string;
    };
    pricecharting?: {
      ungraded?: number;
      psa9?: number;
      psa10?: number;
      bgs10?: number;
      market?: number;
    };
    combined_market?: number;
  };
  
  // Validation scores
  validation: {
    ocr_confidence: number;
    api_match_confidence: number;
    image_similarity?: number;
    overall_confidence: number;
    needs_review: boolean;
    review_reasons: string[];
  };
  
  // Metadata
  processing_timestamp: string;
  data_sources: string[];
  processing_time_ms?: number;
}

export interface MatchOptions {
  validateImage?: boolean;
  requireHighConfidence?: boolean;
  includeAlternatives?: boolean;
  maxAlternatives?: number;
}

export class CardMatcher {
  private readonly HIGH_VALUE_THRESHOLD = 10000; // $100 in cents
  private readonly AUTO_MATCH_THRESHOLD = 0.85;
  private readonly REVIEW_THRESHOLD = 0.70;

  constructor() {
    logger.info('Card Matcher initialized');
  }

  /**
   * Main entry point for card identification
   */
  async identifyCard(
    ocrResult: OCRResult, 
    options: MatchOptions = {}
  ): Promise<EnrichedCardData> {
    const startTime = Date.now();
    const reviewReasons: string[] = [];

    try {
      logger.info('Starting card identification', {
        cardName: ocrResult.card_name,
        setInfo: ocrResult.set_name || ocrResult.set_code,
        hasImage: !!ocrResult.image
      });

      // Step 1: Find best match from Pokemon TCG API
      const tcgMatch = await pokemonTCGService.findBestMatch(ocrResult);
      
      if (!tcgMatch.card) {
        logger.warn('No Pokemon TCG match found', { ocrResult });
        reviewReasons.push('No Pokemon TCG API match found');
        
        // Fallback to PriceCharting only
        return await this.enrichWithPriceChartingOnly(ocrResult, reviewReasons);
      }

      // Step 2: Get PriceCharting data
      const pcMatch = await priceChartingService.findBestMatch(
        tcgMatch.card.name,
        tcgMatch.card.set.name,
        tcgMatch.card.number
      );

      // Step 3: Validate with image comparison if available
      let imageSimilarity: number | undefined;
      if (options.validateImage && ocrResult.image && tcgMatch.card) {
        const officialImage = await pokemonTCGService.getCardImage(tcgMatch.card);
        if (officialImage) {
          const similarity = await ports.validate.compareImages(ocrResult.image, officialImage);
          imageSimilarity = similarity.overall;
          
          if (imageSimilarity < 0.7) {
            reviewReasons.push(`Low image similarity: ${(imageSimilarity * 100).toFixed(1)}%`);
          }
        }
      }

      // Step 4: Validate OCR against API data
      const validation = await pokemonTCGService.validateOCRResult(
        ocrResult,
        tcgMatch.card
      );

      if (!validation.isValid) {
        reviewReasons.push(...validation.discrepancies);
      }

      // Step 5: Build enriched card data
      const enrichedData = await this.enrichCardData(
        ocrResult,
        tcgMatch.card,
        pcMatch.product,
        {
          tcgMatchConfidence: tcgMatch.confidence,
          pcMatchConfidence: pcMatch.confidence,
          imageSimilarity,
          validationResult: validation
        }
      );

      // Step 6: Determine if manual review is needed
      enrichedData.validation.needs_review = this.needsManualReview(
        enrichedData,
        reviewReasons
      );
      enrichedData.validation.review_reasons = reviewReasons;

      // Add processing metadata
      enrichedData.processing_time_ms = Date.now() - startTime;

      logger.info('Card identification completed', {
        cardName: enrichedData.card_name,
        confidence: enrichedData.validation.overall_confidence,
        needsReview: enrichedData.validation.needs_review,
        processingTime: enrichedData.processing_time_ms
      });

      return enrichedData;

    } catch (error) {
      logger.error('Card identification failed', { error, ocrResult });
      
      // Return OCR data with error flag
      return this.createErrorResult(ocrResult, error as Error, reviewReasons);
    }
  }

  /**
   * Combine data from multiple sources into enriched format
   */
  async enrichCardData(
    ocrResult: OCRResult,
    tcgCard: PokemonCard | null,
    pcProduct: PriceChartingProduct | null,
    confidenceData: {
      tcgMatchConfidence: number;
      pcMatchConfidence: number;
      imageSimilarity?: number;
      validationResult: any;
    }
  ): Promise<EnrichedCardData> {
    const dataSources: string[] = ['ocr'];
    
    // Start with OCR data as base
    const enriched: EnrichedCardData = {
      id: tcgCard?.id || `ocr_${Date.now()}`,
      card_name: tcgCard?.name || ocrResult.card_name || 'Unknown',
      set_name: tcgCard?.set.name || ocrResult.set_name || 'Unknown',
      set_code: tcgCard?.set.id || ocrResult.set_code,
      card_number: tcgCard?.number || ocrResult.set_number || '0',
      set_total: tcgCard?.set.total || ocrResult.set_total,
      rarity: tcgCard?.rarity || ocrResult.rarity,
      
      // Pokemon-specific fields
      hp: tcgCard?.hp ? parseInt(tcgCard.hp) : ocrResult.hp,
      pokemon_type: tcgCard?.types || (ocrResult.pokemon_type ? [ocrResult.pokemon_type] : undefined),
      stage: tcgCard?.subtypes?.join(', ') || ocrResult.stage,
      evolves_from: tcgCard?.evolvesFrom,
      evolves_to: tcgCard?.evolvesTo,
      attacks: tcgCard?.attacks || ocrResult.attacks,
      abilities: tcgCard?.abilities || ocrResult.abilities,
      weakness: tcgCard?.weaknesses,
      resistance: tcgCard?.resistances,
      retreat_cost: tcgCard?.convertedRetreatCost || ocrResult.retreat_cost,
      
      // Visual characteristics
      is_first_edition: ocrResult.is_first_edition || false,
      is_shadowless: false, // Would need visual detection
      is_holo: ocrResult.is_holo || false,
      is_reverse_holo: ocrResult.variant_type === 'reverse_holo',
      is_promo: ocrResult.is_promo || false,
      variant_type: ocrResult.variant_type,
      
      // API identifiers
      pokemontcg_id: tcgCard?.id,
      pricecharting_id: pcProduct?.id,
      tcgplayer_id: tcgCard?.tcgplayer?.url?.match(/(\d+)$/)?.[1],
      
      // Images
      official_image_url: tcgCard?.images.large,
      captured_image_path: ocrResult.image_path,
      
      // Pricing data
      pricing: {},
      
      // Validation scores
      validation: {
        ocr_confidence: ocrResult.overall_confidence || 0,
        api_match_confidence: confidenceData.tcgMatchConfidence,
        image_similarity: confidenceData.imageSimilarity,
        overall_confidence: 0,
        needs_review: false,
        review_reasons: []
      },
      
      processing_timestamp: new Date().toISOString(),
      data_sources: dataSources
    };

    // Add Pokemon TCG data if available
    if (tcgCard) {
      dataSources.push('pokemontcg');
      
      // Extract TCGPlayer pricing
      if (tcgCard.tcgplayer?.prices) {
        const tcgPrices = pokemonTCGService.extractTCGPlayerPrices(tcgCard);
        if (tcgPrices) {
          enriched.pricing.tcgplayer = {
            market: tcgPrices.market ? tcgPrices.market * 100 : undefined, // Convert to cents
            low: tcgPrices.low ? tcgPrices.low * 100 : undefined,
            mid: tcgPrices.mid ? tcgPrices.mid * 100 : undefined,
            high: tcgPrices.high ? tcgPrices.high * 100 : undefined,
            direct_low: tcgPrices.directLow ? tcgPrices.directLow * 100 : undefined,
            url: tcgPrices.url,
            updated_at: tcgPrices.updatedAt
          };
        }
      }
    }

    // Add PriceCharting data if available
    if (pcProduct) {
      dataSources.push('pricecharting');
      
      const pcPrices = priceChartingService.extractPrices(pcProduct);
      enriched.pricing.pricecharting = {
        ungraded: pcPrices.ungraded,
        psa9: pcPrices.psa9,
        psa10: pcPrices.psa10,
        bgs10: pcPrices.bgs10,
        market: pcPrices.market
      };
    }

    // Calculate combined market price
    const marketPrices = [
      enriched.pricing.tcgplayer?.market,
      enriched.pricing.pricecharting?.market
    ].filter(p => p !== undefined && p > 0);

    if (marketPrices.length > 0) {
      enriched.pricing.combined_market = Math.round(
        marketPrices.reduce((a, b) => a! + b!, 0) / marketPrices.length
      );
    }

    // Calculate overall confidence
    enriched.validation.overall_confidence = this.calculateOverallConfidence(
      enriched.validation.ocr_confidence,
      confidenceData.tcgMatchConfidence,
      confidenceData.pcMatchConfidence,
      confidenceData.imageSimilarity
    );

    enriched.data_sources = dataSources;

    return enriched;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(
    ocrConfidence: number,
    tcgConfidence: number,
    pcConfidence: number,
    imageSimilarity?: number
  ): number {
    const scores = [ocrConfidence, tcgConfidence, pcConfidence];
    const weights = [0.25, 0.35, 0.20];
    
    if (imageSimilarity !== undefined) {
      scores.push(imageSimilarity);
      weights.push(0.20);
    } else {
      // Redistribute weight if no image comparison
      weights[0] = 0.30;
      weights[1] = 0.45;
      weights[2] = 0.25;
    }
    
    // Normalize weights
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map(w => w / totalWeight);
    
    // Calculate weighted average
    let weightedSum = 0;
    for (let i = 0; i < scores.length; i++) {
      weightedSum += scores[i] * normalizedWeights[i];
    }
    
    return Math.round(weightedSum * 100) / 100;
  }

  /**
   * Determine if manual review is needed
   */
  needsManualReview(enrichedData: EnrichedCardData, reviewReasons: string[]): boolean {
    // Always review high-value cards
    if (enrichedData.pricing.combined_market && 
        enrichedData.pricing.combined_market > this.HIGH_VALUE_THRESHOLD) {
      reviewReasons.push('High value card');
      return true;
    }

    // Review special editions
    if (enrichedData.is_first_edition) {
      reviewReasons.push('1st Edition card');
      return true;
    }

    // Review low confidence matches
    if (enrichedData.validation.overall_confidence < this.AUTO_MATCH_THRESHOLD) {
      reviewReasons.push(`Low confidence: ${(enrichedData.validation.overall_confidence * 100).toFixed(1)}%`);
      return true;
    }

    // Review if no API matches found
    if (!enrichedData.pokemontcg_id && !enrichedData.pricecharting_id) {
      reviewReasons.push('No API matches found');
      return true;
    }

    // Review if image validation failed
    if (enrichedData.validation.image_similarity !== undefined && 
        enrichedData.validation.image_similarity < 0.7) {
      reviewReasons.push('Image validation failed');
      return true;
    }

    // Review if OCR confidence is low
    if (enrichedData.validation.ocr_confidence < 0.85) {
      reviewReasons.push('Low OCR confidence');
      return true;
    }

    return false;
  }

  /**
   * Fallback to PriceCharting only when Pokemon TCG API fails
   */
  private async enrichWithPriceChartingOnly(
    ocrResult: OCRResult,
    reviewReasons: string[]
  ): Promise<EnrichedCardData> {
    const pcMatch = await priceChartingService.findBestMatch(
      ocrResult.card_name || '',
      ocrResult.set_name,
      ocrResult.set_number
    );

    return this.enrichCardData(
      ocrResult,
      null,
      pcMatch.product,
      {
        tcgMatchConfidence: 0,
        pcMatchConfidence: pcMatch.confidence,
        validationResult: { isValid: false, confidence: 0, discrepancies: [], suggestions: [] }
      }
    );
  }

  /**
   * Create error result when identification fails
   */
  private createErrorResult(
    ocrResult: OCRResult,
    error: Error,
    reviewReasons: string[]
  ): EnrichedCardData {
    return {
      id: `error_${Date.now()}`,
      card_name: ocrResult.card_name || 'Unknown',
      set_name: ocrResult.set_name || 'Unknown',
      card_number: ocrResult.set_number || '0',
      
      is_first_edition: false,
      is_shadowless: false,
      is_holo: false,
      is_reverse_holo: false,
      is_promo: false,
      
      pricing: {},
      
      validation: {
        ocr_confidence: ocrResult.overall_confidence || 0,
        api_match_confidence: 0,
        overall_confidence: 0,
        needs_review: true,
        review_reasons: [...reviewReasons, `Error: ${error.message}`]
      },
      
      processing_timestamp: new Date().toISOString(),
      data_sources: ['ocr']
    };
  }

  /**
   * Batch process multiple cards
   */
  async processBatch(
    ocrResults: OCRResult[],
    options: MatchOptions = {}
  ): Promise<EnrichedCardData[]> {
    logger.info(`Starting batch processing of ${ocrResults.length} cards`);
    
    const results: EnrichedCardData[] = [];
    const batchSize = 5; // Process 5 cards in parallel
    
    for (let i = 0; i < ocrResults.length; i += batchSize) {
      const batch = ocrResults.slice(i, i + batchSize);
      
      const batchResults = await Promise.all(
        batch.map(ocr => this.identifyCard(ocr, options))
      );
      
      results.push(...batchResults);
      
      logger.info(`Processed ${Math.min(i + batchSize, ocrResults.length)} of ${ocrResults.length} cards`);
    }
    
    // Calculate batch statistics
    const stats = {
      total: results.length,
      successful: results.filter(r => r.validation.overall_confidence > 0.85).length,
      needsReview: results.filter(r => r.validation.needs_review).length,
      averageConfidence: results.reduce((sum, r) => sum + r.validation.overall_confidence, 0) / results.length
    };
    
    logger.info('Batch processing completed', stats);
    
    return results;
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      autoMatchThreshold: this.AUTO_MATCH_THRESHOLD,
      reviewThreshold: this.REVIEW_THRESHOLD,
      highValueThreshold: this.HIGH_VALUE_THRESHOLD
    };
  }
}

// Singleton instance
export const cardMatcher = new CardMatcher();