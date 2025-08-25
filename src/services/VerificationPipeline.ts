import type { InferencePort, InferenceResult } from '../core/infer/InferencePort';
import type { VerificationResult } from '../adapters/lmstudio/QwenVerifierInference';
import { ConfidenceRouter, type RoutingContext, type RoutingResult } from '../core/verification/ConfidenceRouter';
import { CardVerificationService } from './CardVerificationService';
import { logger } from '../utils/logger';
import { startGlobalProfiler, endGlobalProfiler, getGlobalProfiler } from '../utils/performanceProfiler';
import { CardRepository } from '../storage/CardRepository';
import { Card, CardStatus } from '../types';
import path from 'path';

export interface VerifiedResult {
  // Original inference result
  primary_result: InferenceResult;
  
  // Verification details
  verification_result?: VerificationResult;
  routing_decision: RoutingResult;
  
  // Final adjusted result
  final_confidence: number;
  adjusted_result: InferenceResult;
  
  // Pipeline metadata
  processing_time_ms: number;
  verification_path: 'skipped' | 'optional' | 'required';
  database_validated: boolean;
  should_review: boolean;
  
  // Performance breakdown
  timing_breakdown: {
    primary_inference_ms: number;
    routing_ms: number;
    verification_ms?: number;
    database_check_ms?: number;
    total_ms: number;
  };
  
  // Storage
  card_id?: string;
  stored_at?: Date;
}

export interface PipelineOptions {
  // Model configuration
  primary_adapter: InferencePort;
  verifier_adapter?: InferencePort;
  
  // Processing options
  skip_database_verification?: boolean;
  force_verification?: boolean;
  batch_mode?: boolean;
  
  // Context enrichment
  card_context?: RoutingContext;
  
  // Timeouts
  primary_timeout?: number;
  verifier_timeout?: number;
}

/**
 * Dual-verify pipeline orchestrator
 * 
 * Implements CardMint CTO's dual-verify strategy:
 * 1. Primary VLM (Qwen2.5-VL-7B) inference
 * 2. Confidence-based routing decision
 * 3. Optional secondary verification (Qwen2.5-0.5B)
 * 4. Database cross-checking and validation
 * 5. Final confidence adjustment and storage
 */
export class VerificationPipeline {
  private readonly confidenceRouter: ConfidenceRouter;
  private readonly verificationService: CardVerificationService;
  private readonly cardRepository: CardRepository;
  
  // Pipeline statistics
  private totalProcessed = 0;
  private skipVerifyCount = 0;
  private verifyOptionalCount = 0;
  private verifyRequiredCount = 0;
  private averageLatency = 0;

  constructor() {
    this.confidenceRouter = new ConfidenceRouter();
    this.verificationService = new CardVerificationService();
    this.cardRepository = new CardRepository();
    
    logger.info('VerificationPipeline initialized');
  }

  /**
   * Main pipeline entry point - single card processing
   */
  async processWithVerification(
    imagePath: string,
    options: PipelineOptions
  ): Promise<VerifiedResult> {
    const pipelineStart = Date.now();
    const profiler = startGlobalProfiler(`verify_${path.basename(imagePath)}`);
    
    try {
      logger.info(`Starting verified processing: ${path.basename(imagePath)}`);
      
      // Set card info for profiling
      try {
        const fs = await import('fs/promises');
        const stats = await fs.stat(imagePath);
        profiler.setCardInfo(path.basename(imagePath), stats.size);
      } catch (error) {
        logger.debug('Could not get file stats for profiling:', error);
      }

      // Step 1: Primary VLM inference
      profiler.startStage('primary_inference');
      const primaryStart = Date.now();
      const primaryResult = await options.primary_adapter.classify(imagePath, {
        timeout: options.primary_timeout || 30000
      });
      const primaryTime = Date.now() - primaryStart;
      profiler.endStage('primary_inference', {
        confidence: primaryResult.confidence,
        card: primaryResult.card_title
      });

      // Step 2: Confidence routing
      profiler.startStage('confidence_routing');
      const routingStart = Date.now();
      const routingResult = await this.confidenceRouter.route(primaryResult, {
        ...options.card_context,
        force_verification: options.force_verification,
        batch_mode: options.batch_mode
      });
      const routingTime = Date.now() - routingStart;
      profiler.endStage('confidence_routing');

      // Step 3: Optional verification
      let verificationResult: VerificationResult | undefined;
      let verificationTime = 0;
      let databaseTime = 0;
      
      if (routingResult.decision !== 'skip_verify' && options.verifier_adapter) {
        profiler.startStage('verification_process');
        const verifyStart = Date.now();
        
        try {
          // Check if adapter supports verification
          if ('verify' in options.verifier_adapter && 
              typeof options.verifier_adapter.verify === 'function') {
            verificationResult = await options.verifier_adapter.verify(
              primaryResult,
              imagePath,
              {
                timeout: options.verifier_timeout || 10000,
                skip_database_check: options.skip_database_verification,
                primary_confidence: primaryResult.confidence
              }
            );
          } else {
            // Fallback: use classify method
            logger.debug('Using fallback verification via classify method');
            const secondaryResult = await options.verifier_adapter.classify(imagePath, {
              timeout: options.verifier_timeout || 10000
            });
            
            // Create mock verification result
            verificationResult = {
              agrees_with_primary: this.calculateAgreement(primaryResult, secondaryResult),
              confidence_adjustment: 0.0,
              database_matches: [],
              semantic_flags: [],
              verification_time_ms: Date.now() - verifyStart,
              verifier_confidence: secondaryResult.confidence
            };
          }
          
          verificationTime = Date.now() - verifyStart;
          
        } catch (verifyError) {
          logger.error('Verification failed, continuing without:', verifyError);
          verificationResult = {
            agrees_with_primary: false,
            confidence_adjustment: -0.1, // Penalty for verification failure
            database_matches: [],
            semantic_flags: ['verification_failed'],
            verification_time_ms: Date.now() - verifyStart,
            verifier_confidence: 0.0
          };
          verificationTime = Date.now() - verifyStart;
        }
        
        profiler.endStage('verification_process');
      }

      // Step 4: Database validation (if not done during verification)
      if (!options.skip_database_verification && !verificationResult?.database_matches?.length) {
        profiler.startStage('database_validation');
        const dbStart = Date.now();
        
        try {
          const databaseMatches = await this.verificationService.verifyAgainstDatabase(
            primaryResult,
            { max_matches: 3 }
          );
          
          if (verificationResult) {
            verificationResult.database_matches = databaseMatches;
          }
          
          databaseTime = Date.now() - dbStart;
        } catch (dbError) {
          logger.error('Database validation failed:', dbError);
          databaseTime = Date.now() - dbStart;
        }
        
        profiler.endStage('database_validation');
      }

      // Step 5: Final confidence calculation
      const finalConfidence = this.calculateFinalConfidence(
        primaryResult,
        verificationResult,
        routingResult
      );

      // Create adjusted result
      const adjustedResult: InferenceResult = {
        ...primaryResult,
        confidence: finalConfidence
      };

      // Step 6: Store in database
      let cardId: string | undefined;
      let storedAt: Date | undefined;
      
      try {
        const card = await this.storeCard(imagePath, adjustedResult, verificationResult, routingResult);
        cardId = card.id;
        storedAt = new Date();
        
        // Store verification result
        if (verificationResult) {
          await this.verificationService.storeVerificationResult(
            cardId,
            primaryResult,
            verificationResult
          );
        }
      } catch (storageError) {
        logger.error('Failed to store card:', storageError);
      }

      // Build final result
      const totalTime = Date.now() - pipelineStart;
      
      const result: VerifiedResult = {
        primary_result: primaryResult,
        verification_result: verificationResult,
        routing_decision: routingResult,
        final_confidence: finalConfidence,
        adjusted_result: adjustedResult,
        processing_time_ms: totalTime,
        verification_path: routingResult.decision === 'skip_verify' ? 'skipped' :
                          routingResult.decision === 'verify_optional' ? 'optional' : 'required',
        database_validated: !options.skip_database_verification,
        should_review: routingResult.should_flag_for_review || finalConfidence < 0.7,
        timing_breakdown: {
          primary_inference_ms: primaryTime,
          routing_ms: routingTime,
          verification_ms: verificationTime || undefined,
          database_check_ms: databaseTime || undefined,
          total_ms: totalTime
        },
        card_id: cardId,
        stored_at: storedAt
      };

      // Update statistics
      this.updateStatistics(result);

      // Log pipeline report
      const report = endGlobalProfiler({ log: true });
      
      logger.info(`Verification pipeline completed: ${result.adjusted_result.card_title} ` +
                 `(confidence: ${primaryResult.confidence.toFixed(3)} → ${finalConfidence.toFixed(3)}, ` +
                 `path: ${result.verification_path}, time: ${totalTime}ms)`);

      return result;

    } catch (error) {
      endGlobalProfiler({ log: true });
      logger.error('Verification pipeline failed:', error);
      throw error;
    }
  }

  /**
   * Batch processing with parallel verification
   */
  async processBatch(
    imagePaths: string[],
    options: PipelineOptions
  ): Promise<VerifiedResult[]> {
    logger.info(`Starting batch verification: ${imagePaths.length} cards`);
    
    const batchStart = Date.now();
    const results: VerifiedResult[] = [];
    
    // Process in smaller chunks for memory management
    const chunkSize = 4; // Parallel limit
    
    for (let i = 0; i < imagePaths.length; i += chunkSize) {
      const chunk = imagePaths.slice(i, i + chunkSize);
      
      const chunkPromises = chunk.map(imagePath => 
        this.processWithVerification(imagePath, {
          ...options,
          batch_mode: true
        }).catch(error => {
          logger.error(`Batch processing failed for ${imagePath}:`, error);
          return null;
        })
      );
      
      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults.filter((r): r is VerifiedResult => r !== null));
      
      // Brief delay between chunks to prevent overwhelming the system
      if (i + chunkSize < imagePaths.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const batchTime = Date.now() - batchStart;
    const avgTimePerCard = batchTime / results.length;
    
    logger.info(`Batch verification completed: ${results.length}/${imagePaths.length} cards, ` +
               `${avgTimePerCard.toFixed(0)}ms avg, ${batchTime}ms total`);
    
    return results;
  }

  /**
   * Get pipeline statistics
   */
  getStatistics() {
    const verificationRate = this.totalProcessed > 0 
      ? (this.verifyOptionalCount + this.verifyRequiredCount) / this.totalProcessed
      : 0;

    return {
      total_processed: this.totalProcessed,
      verification_rate: verificationRate,
      routing_distribution: {
        skip_verify: this.skipVerifyCount,
        verify_optional: this.verifyOptionalCount,
        verify_required: this.verifyRequiredCount
      },
      average_latency_ms: this.averageLatency
    };
  }

  private calculateAgreement(primary: InferenceResult, secondary: InferenceResult): boolean {
    // Simple name similarity check
    const primaryName = primary.card_title?.toLowerCase() || '';
    const secondaryName = secondary.card_title?.toLowerCase() || '';
    
    if (!primaryName || !secondaryName) return false;
    
    // Basic similarity - can be enhanced
    return primaryName.includes(secondaryName) || 
           secondaryName.includes(primaryName) ||
           this.levenshteinDistance(primaryName, secondaryName) < 3;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
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

  private calculateFinalConfidence(
    primaryResult: InferenceResult,
    verificationResult?: VerificationResult,
    routingResult?: RoutingResult
  ): number {
    let finalConfidence = primaryResult.confidence;
    
    // Apply verification adjustment
    if (verificationResult) {
      finalConfidence += verificationResult.confidence_adjustment;
    }
    
    // Apply routing-based adjustments
    if (routingResult) {
      // Small bonus for high-priority cards that were verified
      if (routingResult.priority_score > 80 && verificationResult?.agrees_with_primary) {
        finalConfidence += 0.02;
      }
    }
    
    // Clamp to valid range
    return Math.max(0, Math.min(1, finalConfidence));
  }

  private async storeCard(
    imagePath: string,
    result: InferenceResult,
    verificationResult?: VerificationResult,
    routingResult?: RoutingResult
  ): Promise<Card> {
    const cardData: Partial<Card> = {
      imageUrl: imagePath,
      status: CardStatus.PROCESSED,
      metadata: {
        cardName: result.card_title,
        cardSet: result.set_name,
        cardNumber: result.identifier.number,
        runId: `dual_verify_${Date.now()}`,
        customFields: {
          primary_confidence: result.confidence,
          verification_path: routingResult?.decision,
          verifier_agrees: verificationResult?.agrees_with_primary,
          confidence_adjustment: verificationResult?.confidence_adjustment,
          semantic_flags: verificationResult?.semantic_flags,
          processing_time_ms: result.inference_time_ms
        }
      },
      confidenceScore: this.calculateFinalConfidence(result, verificationResult, routingResult)
    };

    return await this.cardRepository.createCard(cardData);
  }

  private updateStatistics(result: VerifiedResult): void {
    this.totalProcessed++;
    
    switch (result.verification_path) {
      case 'skipped':
        this.skipVerifyCount++;
        break;
      case 'optional':
        this.verifyOptionalCount++;
        break;
      case 'required':
        this.verifyRequiredCount++;
        break;
    }
    
    // Update rolling average latency
    this.averageLatency = (this.averageLatency * (this.totalProcessed - 1) + result.processing_time_ms) / this.totalProcessed;
  }
}