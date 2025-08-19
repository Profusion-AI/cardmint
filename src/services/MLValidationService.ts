const logger = { 
  info: (msg: string, data?: any) => console.log(`[ML-Validation] ${msg}`, data || ''),
  error: (msg: string, data?: any) => console.error(`[ML-Validation] ERROR: ${msg}`, data || ''),
  warn: (msg: string, data?: any) => console.warn(`[ML-Validation] WARN: ${msg}`, data || ''),
  debug: (msg: string, data?: any) => console.log(`[ML-Validation] DEBUG: ${msg}`, data || '')
};
import { pokemonTCGService, PokemonCard } from './PokemonTCGService';
import { MLPrediction } from '../ml/MLServiceClient';
import { OCRResult } from '../ocr/OCRService';

export interface EnhancedCardData {
  // ML Prediction Data
  mlPrediction?: MLPrediction;
  mlConfidence?: number;
  
  // OCR Data
  ocrResult?: OCRResult;
  ocrConfidence?: number;
  
  // API Validation
  apiCard?: PokemonCard;
  apiConfidence?: number;
  apiAlternatives?: PokemonCard[];
  
  // Combined Result
  finalCard?: PokemonCard;
  finalConfidence: number;
  validationMethod: 'ml-only' | 'ocr-only' | 'ml-validated' | 'ocr-validated' | 'combined';
  requiresReview: boolean;
  discrepancies: string[];
  enrichmentData?: {
    officialImage?: string;
    marketPrice?: number;
    tcgPlayerUrl?: string;
    rarity?: string;
    setInfo?: {
      name: string;
      series: string;
      releaseDate: string;
    };
  };
}

export class MLValidationService {
  private readonly confidenceThresholds = {
    mlHigh: 0.85,      // High confidence ML prediction
    mlMedium: 0.70,    // Medium confidence ML prediction
    ocrHigh: 0.90,     // High confidence OCR
    apiMatch: 0.80,    // Good API match
    combined: 0.90,    // Combined threshold for auto-approval
    review: 0.70,      // Below this requires manual review
  };

  constructor() {
    logger.info('ML Validation Service initialized');
  }

  /**
   * Validate and enrich ML prediction using Pokemon TCG API
   */
  async validateMLPrediction(mlPrediction: MLPrediction, ocrResult?: OCRResult): Promise<EnhancedCardData> {
    const startTime = Date.now();
    const result: EnhancedCardData = {
      mlPrediction,
      mlConfidence: mlPrediction.ensemble_confidence,
      ocrResult,
      ocrConfidence: ocrResult?.avg_confidence,
      finalConfidence: 0,
      validationMethod: 'ml-only',
      requiresReview: false,
      discrepancies: [],
    };

    try {
      // Step 1: Search for card using ML prediction
      const mlSearchData = this.convertMLToSearchData(mlPrediction);
      const mlMatch = await pokemonTCGService.findBestMatch(mlSearchData);
      
      if (mlMatch.card && mlMatch.confidence > this.confidenceThresholds.apiMatch) {
        result.apiCard = mlMatch.card;
        result.apiConfidence = mlMatch.confidence;
        result.apiAlternatives = mlMatch.alternativeMatches;
        
        // Validate ML prediction against API data
        const validation = await pokemonTCGService.validateOCRResult(mlSearchData, mlMatch.card);
        
        if (validation.isValid) {
          // ML prediction validated by API
          result.validationMethod = 'ml-validated';
          result.finalCard = mlMatch.card;
          result.finalConfidence = this.calculateCombinedConfidence(
            mlPrediction.ensemble_confidence,
            mlMatch.confidence,
            validation.confidence
          );
          
          // Boost confidence when ML and API agree
          if (result.finalConfidence > 0.85) {
            result.finalConfidence = Math.min(result.finalConfidence * 1.1, 0.99);
          }
        } else {
          result.discrepancies = validation.discrepancies;
        }
      }

      // Step 2: If ML validation failed but we have OCR, try OCR validation
      if (!result.finalCard && ocrResult?.extracted_card_info) {
        const ocrMatch = await pokemonTCGService.findBestMatch(ocrResult.extracted_card_info);
        
        if (ocrMatch.card && ocrMatch.confidence > this.confidenceThresholds.apiMatch) {
          result.apiCard = ocrMatch.card;
          result.apiConfidence = ocrMatch.confidence;
          result.validationMethod = 'ocr-validated';
          result.finalCard = ocrMatch.card;
          result.finalConfidence = this.calculateCombinedConfidence(
            0,
            ocrMatch.confidence,
            ocrResult.avg_confidence || 0
          );
        }
      }

      // Step 3: If both ML and OCR exist, try combined validation
      if (mlPrediction && ocrResult && !result.finalCard) {
        const combinedData = this.combineMLAndOCR(mlPrediction, ocrResult);
        const combinedMatch = await pokemonTCGService.findBestMatch(combinedData);
        
        if (combinedMatch.card) {
          result.apiCard = combinedMatch.card;
          result.apiConfidence = combinedMatch.confidence;
          result.validationMethod = 'combined';
          result.finalCard = combinedMatch.card;
          result.finalConfidence = this.calculateCombinedConfidence(
            mlPrediction.ensemble_confidence,
            combinedMatch.confidence,
            ocrResult.avg_confidence || 0
          );
        }
      }

      // Step 4: Enrich with additional data if we found a card
      if (result.finalCard) {
        result.enrichmentData = await this.enrichCardData(result.finalCard);
      }

      // Step 5: Determine if review is needed
      result.requiresReview = this.shouldRequireReview(result);

      const processingTime = Date.now() - startTime;
      logger.info(`ML validation completed in ${processingTime}ms`, {
        method: result.validationMethod,
        confidence: result.finalConfidence,
        cardFound: !!result.finalCard,
        requiresReview: result.requiresReview,
      });

      return result;

    } catch (error) {
      logger.error('ML validation failed', { error });
      result.requiresReview = true;
      return result;
    }
  }

  /**
   * Convert ML prediction to search data format
   */
  private convertMLToSearchData(mlPrediction: MLPrediction): any {
    return {
      card_name: mlPrediction.card_name,
      set_name: mlPrediction.set_name,
      set_number: mlPrediction.card_number,
      rarity: mlPrediction.rarity,
      // Additional fields from ML prediction
      confidence: mlPrediction.ensemble_confidence,
      models_used: mlPrediction.active_models,
    };
  }

  /**
   * Combine ML and OCR data for better matching
   */
  private combineMLAndOCR(mlPrediction: MLPrediction, ocrResult: OCRResult): any {
    const combined: any = {};
    
    // Prefer ML for visual features
    if (mlPrediction.card_name && mlPrediction.confidence > 0.7) {
      combined.card_name = mlPrediction.card_name;
    } else if (ocrResult.extracted_card_info?.card_name) {
      combined.card_name = ocrResult.extracted_card_info.card_name;
    }
    
    // Prefer OCR for text features
    if (ocrResult.extracted_card_info?.card_number) {
      combined.set_number = ocrResult.extracted_card_info.card_number;
    } else if (mlPrediction.card_number) {
      combined.set_number = mlPrediction.card_number;
    }
    
    // Combine set information
    combined.set_name = mlPrediction.set_name || ocrResult.extracted_card_info?.card_set;
    combined.rarity = mlPrediction.rarity || ocrResult.extracted_card_info?.rarity;
    
    // Add OCR-specific fields if available
    if (ocrResult.extracted_card_info) {
      const info = ocrResult.extracted_card_info;
      if (info.hp) combined.hp = info.hp;
      if (info.pokemon_type) combined.pokemon_type = info.pokemon_type;
      if (info.stage) combined.stage = info.stage;
    }
    
    return combined;
  }

  /**
   * Calculate combined confidence from multiple sources
   */
  private calculateCombinedConfidence(
    mlConfidence: number,
    apiConfidence: number,
    ocrConfidence: number
  ): number {
    const weights = {
      ml: 0.4,   // ML visual recognition weight
      api: 0.4,  // API match weight
      ocr: 0.2,  // OCR text extraction weight
    };
    
    let totalWeight = 0;
    let weightedSum = 0;
    
    if (mlConfidence > 0) {
      weightedSum += mlConfidence * weights.ml;
      totalWeight += weights.ml;
    }
    
    if (apiConfidence > 0) {
      weightedSum += apiConfidence * weights.api;
      totalWeight += weights.api;
    }
    
    if (ocrConfidence > 0) {
      weightedSum += ocrConfidence * weights.ocr;
      totalWeight += weights.ocr;
    }
    
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Enrich card data with additional information
   */
  private async enrichCardData(card: PokemonCard): Promise<EnhancedCardData['enrichmentData']> {
    const enrichment: EnhancedCardData['enrichmentData'] = {
      officialImage: card.images.large,
      rarity: card.rarity,
      setInfo: {
        name: card.set.name,
        series: card.set.series,
        releaseDate: card.set.releaseDate,
      },
    };
    
    // Extract pricing data if available
    const tcgPrices = pokemonTCGService.extractTCGPlayerPrices(card);
    if (tcgPrices) {
      enrichment.marketPrice = tcgPrices.market || tcgPrices.mid;
      enrichment.tcgPlayerUrl = tcgPrices.url;
    }
    
    return enrichment;
  }

  /**
   * Determine if manual review is required
   */
  private shouldRequireReview(result: EnhancedCardData): boolean {
    // Always review if confidence is too low
    if (result.finalConfidence < this.confidenceThresholds.review) {
      return true;
    }
    
    // Review if there are significant discrepancies
    if (result.discrepancies.length > 2) {
      return true;
    }
    
    // Review high-value cards (if we have pricing)
    if (result.enrichmentData?.marketPrice && result.enrichmentData.marketPrice > 100) {
      return result.finalConfidence < this.confidenceThresholds.combined;
    }
    
    // Review if ML and OCR disagree significantly
    if (result.mlPrediction && result.ocrResult) {
      const mlName = result.mlPrediction.card_name?.toLowerCase();
      const ocrName = result.ocrResult.extracted_card_info?.card_name?.toLowerCase();
      
      if (mlName && ocrName && mlName !== ocrName) {
        // Check if names are similar enough
        const similarity = this.calculateStringSimilarity(mlName, ocrName);
        if (similarity < 0.7) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Calculate string similarity (simple implementation)
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1;
    
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
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
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Batch validate multiple predictions
   */
  async validateBatch(
    predictions: Array<{ mlPrediction?: MLPrediction; ocrResult?: OCRResult }>
  ): Promise<EnhancedCardData[]> {
    logger.info(`Validating batch of ${predictions.length} predictions`);
    
    // Process in parallel with concurrency limit
    const batchSize = 5;
    const results: EnhancedCardData[] = [];
    
    for (let i = 0; i < predictions.length; i += batchSize) {
      const batch = predictions.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(p => this.validateMLPrediction(p.mlPrediction!, p.ocrResult))
      );
      results.push(...batchResults);
      
      logger.debug(`Validated ${results.length}/${predictions.length} predictions`);
    }
    
    // Calculate batch statistics
    const validated = results.filter(r => r.finalCard).length;
    const avgConfidence = results
      .filter(r => r.finalConfidence > 0)
      .reduce((sum, r) => sum + r.finalConfidence, 0) / validated;
    const requireReview = results.filter(r => r.requiresReview).length;
    
    logger.info('Batch validation complete', {
      total: predictions.length,
      validated,
      avgConfidence,
      requireReview,
    });
    
    return results;
  }
}

// Singleton instance
export const mlValidationService = new MLValidationService();