import type { InferenceResult } from '../infer/InferencePort';
import { createLogger } from '../../utils/logger';
import { getGlobalProfiler } from '../../utils/performanceProfiler';
import { FedoraVerificationService, type VerificationResult, type VerificationRequest } from '../../services/FedoraVerificationService';
import { lmStudioConfig } from '../../config/lmstudio';

export type RoutingDecision = 'skip_verify' | 'verify_optional' | 'verify_required';

export interface RoutingContext {
  // Card characteristics
  estimated_value?: number; // in cents
  is_holo?: boolean;
  is_first_edition?: boolean;
  is_vintage?: boolean; // pre-2003 sets
  rarity?: string;
  
  // Processing context
  batch_mode?: boolean;
  user_confidence_override?: number;
  force_verification?: boolean;
}

export interface RoutingResult {
  decision: RoutingDecision;
  reason: string;
  confidence_threshold_used: number;
  should_flag_for_review: boolean;
  priority_score: number; // 0-100, higher = more important
  verification_applied?: boolean; // NEW: indicates if Fedora verification was used
  verification_adjustment?: number; // NEW: confidence adjustment from verification
  final_confidence?: number; // NEW: confidence after verification adjustment
}

/**
 * Enhanced Confidence-based routing with GPT-OSS-20B verification
 * August 29, 2025 - Dual LM Studio Integration
 * 
 * Routing Rules (CardMint Enhanced Strategy):
 * - ≥90%: Skip verification (~70% of cards, high-confidence path)
 * - 70-89%: GPT-OSS-20B verification (~20% of cards, medium-confidence) **NEW**
 * - <70% OR high-value: Required verification + review flagging
 * - Special handling: holo, vintage, first edition always verify
 * 
 * NEW: Fedora GPT-OSS-20B verification provides semantic validation
 * and confidence adjustments (-0.2 to +0.1) for medium-confidence cards
 */
export class ConfidenceRouter {
  private readonly log = createLogger('confidence-router');
  private fedoraVerifier?: FedoraVerificationService; // NEW: Fedora verification service
  
  // Thresholds from existing CardMatcher - maintaining consistency
  private readonly SKIP_VERIFY_THRESHOLD = 0.90;     // High confidence, skip verifier
  private readonly VERIFY_OPTIONAL_THRESHOLD = 0.70;  // Medium confidence, selective verify
  private readonly HIGH_VALUE_THRESHOLD = 10000;      // $100 in cents
  
  // Special card type thresholds
  private readonly HOLO_VERIFY_THRESHOLD = 0.85;      // Lower threshold for holo cards
  private readonly VINTAGE_VERIFY_THRESHOLD = 0.80;   // Lower threshold for vintage
  private readonly FIRST_ED_VERIFY_THRESHOLD = 0.85;  // Lower threshold for 1st edition

  constructor() {
    this.log.debug('ConfidenceRouter initialized with enhanced verification cascade');
    
    // Initialize Fedora verification service if enabled
    if (lmStudioConfig.verification.enabled && lmStudioConfig.fedora.enabled) {
      this.fedoraVerifier = new FedoraVerificationService(
        lmStudioConfig.fedora.url,
        lmStudioConfig.fedora.identifier
      );
      this.log.info('Fedora GPT-OSS-20B verification service initialized');
    } else {
      this.log.warning('Fedora verification disabled - running Mac-only pipeline');
    }
  }

  /**
   * Enhanced routing with Fedora GPT-OSS-20B verification
   * NEW: Applies verification for medium-confidence cards (70-89%)
   */
  async routeWithVerification(
    inferenceResult: InferenceResult,
    context: RoutingContext = {}
  ): Promise<RoutingResult> {
    const profiler = getGlobalProfiler();
    
    try {
      profiler?.startStage('enhanced_confidence_routing', {
        confidence: inferenceResult.confidence,
        card: inferenceResult.card_title,
        verification_enabled: !!this.fedoraVerifier
      });

      // Step 1: Determine initial routing decision
      const initialRouting = this.determineRouting(inferenceResult, context);
      
      // Step 2: Apply Fedora verification if appropriate
      let finalRouting = initialRouting;
      
      if (this.shouldApplyVerification(initialRouting, context)) {
        const verificationResult = await this.applyFedoraVerification(
          inferenceResult, 
          context
        );
        
        if (verificationResult) {
          finalRouting = this.adjustRoutingWithVerification(
            initialRouting, 
            verificationResult, 
            inferenceResult.confidence
          );
        }
      }

      profiler?.endStage('enhanced_confidence_routing', {
        initial_decision: initialRouting.decision,
        final_decision: finalRouting.decision,
        verification_applied: finalRouting.verification_applied,
        confidence_adjustment: finalRouting.verification_adjustment
      });

      this.log.debug(
        `Enhanced routing for "${inferenceResult.card_title}": ` +
        `${initialRouting.decision} → ${finalRouting.decision} ` +
        `(${finalRouting.reason})`
      );

      return finalRouting;

    } catch (error) {
      profiler?.endStage('enhanced_confidence_routing', { error: String(error) });
      this.log.error(`Enhanced routing failed: ${String(error)}`);
      
      // Safe fallback: use original routing method
      return this.route(inferenceResult, context);
    }
  }

  /**
   * Original routing method (maintained for backward compatibility)
   */
  async route(
    inferenceResult: InferenceResult,
    context: RoutingContext = {}
  ): Promise<RoutingResult> {
    const profiler = getGlobalProfiler();
    
    try {
      profiler?.startStage('confidence_routing', {
        confidence: inferenceResult.confidence,
        card: inferenceResult.card_title,
        has_context: Object.keys(context).length > 0
      });

      const result = this.determineRouting(inferenceResult, context);

      profiler?.endStage('confidence_routing', {
        decision: result.decision,
        reason: result.reason,
        priority: result.priority_score
      });

      this.log.debug(`Routing decision for "${inferenceResult.card_title}": ${result.decision} (${result.reason})`);
      return result;

    } catch (error) {
      profiler?.endStage('confidence_routing', { error: String(error) });
      this.log.error(`Confidence routing failed: ${String(error)}`);
      
      // Safe fallback: verify everything when in doubt
      return {
        decision: 'verify_required',
        reason: 'routing_error_fallback',
        confidence_threshold_used: 0.5,
        should_flag_for_review: true,
        priority_score: 100
      };
    }
  }

  /**
   * Batch routing for multiple cards (optimized)
   */
  async routeBatch(
    results: InferenceResult[],
    contexts: RoutingContext[] = []
  ): Promise<RoutingResult[]> {
    const profiler = getGlobalProfiler();
    
    try {
      profiler?.startStage('batch_routing', {
        batch_size: results.length,
        has_contexts: contexts.length > 0
      });

      const routingResults = results.map((result, index) => {
        const context = contexts[index] || { batch_mode: true };
        return this.determineRouting(result, context);
      });

      // Calculate batch statistics
      const skipCount = routingResults.filter(r => r.decision === 'skip_verify').length;
      const optionalCount = routingResults.filter(r => r.decision === 'verify_optional').length;
      const requiredCount = routingResults.filter(r => r.decision === 'verify_required').length;

      profiler?.endStage('batch_routing', {
        skip_verify: skipCount,
        verify_optional: optionalCount,
        verify_required: requiredCount,
        verification_rate: ((optionalCount + requiredCount) / results.length * 100).toFixed(1)
      });

      this.log.info(`Batch routing: ${skipCount} skip, ${optionalCount} optional, ${requiredCount} required (${((optionalCount + requiredCount) / results.length * 100).toFixed(1)}% verification rate)`);
      
      return routingResults;

    } catch (error) {
      profiler?.endStage('batch_routing', { error: String(error) });
      this.log.error(`Batch routing failed: ${String(error)}`);
      
      // Safe fallback
      return results.map(() => ({
        decision: 'verify_required' as const,
        reason: 'batch_routing_error',
        confidence_threshold_used: 0.5,
        should_flag_for_review: true,
        priority_score: 100
      }));
    }
  }

  /**
   * Get routing statistics for monitoring
   */
  getRoutingStats(): {
    thresholds: Record<string, number>;
    decision_distribution: Record<string, number>;
  } {
    return {
      thresholds: {
        skip_verify: this.SKIP_VERIFY_THRESHOLD,
        verify_optional: this.VERIFY_OPTIONAL_THRESHOLD,
        high_value: this.HIGH_VALUE_THRESHOLD / 100, // Convert to dollars
        holo_verify: this.HOLO_VERIFY_THRESHOLD,
        vintage_verify: this.VINTAGE_VERIFY_THRESHOLD,
        first_edition_verify: this.FIRST_ED_VERIFY_THRESHOLD
      },
      decision_distribution: {
        // These would be tracked in a real implementation
        skip_verify_rate: 0.70,
        verify_optional_rate: 0.20,
        verify_required_rate: 0.10
      }
    };
  }

  private determineRouting(
    result: InferenceResult,
    context: RoutingContext
  ): RoutingResult {
    const confidence = context.user_confidence_override ?? result.confidence;
    
    // Force verification override
    if (context.force_verification) {
      return {
        decision: 'verify_required',
        reason: 'force_verification_override',
        confidence_threshold_used: 0.0,
        should_flag_for_review: true,
        priority_score: 100
      };
    }

    // High-value card check (always verify regardless of confidence)
    if (context.estimated_value && context.estimated_value >= this.HIGH_VALUE_THRESHOLD) {
      return {
        decision: 'verify_required',
        reason: 'high_value_card',
        confidence_threshold_used: 0.0,
        should_flag_for_review: true,
        priority_score: 95
      };
    }

    // Special card type checks (lower thresholds)
    if (context.is_holo && confidence < this.HOLO_VERIFY_THRESHOLD) {
      return {
        decision: 'verify_required',
        reason: 'holo_card_verification',
        confidence_threshold_used: this.HOLO_VERIFY_THRESHOLD,
        should_flag_for_review: confidence < this.VERIFY_OPTIONAL_THRESHOLD,
        priority_score: 85
      };
    }

    if (context.is_first_edition && confidence < this.FIRST_ED_VERIFY_THRESHOLD) {
      return {
        decision: 'verify_required',
        reason: 'first_edition_verification',
        confidence_threshold_used: this.FIRST_ED_VERIFY_THRESHOLD,
        should_flag_for_review: confidence < this.VERIFY_OPTIONAL_THRESHOLD,
        priority_score: 80
      };
    }

    if (context.is_vintage && confidence < this.VINTAGE_VERIFY_THRESHOLD) {
      return {
        decision: 'verify_required',
        reason: 'vintage_card_verification',
        confidence_threshold_used: this.VINTAGE_VERIFY_THRESHOLD,
        should_flag_for_review: confidence < this.VERIFY_OPTIONAL_THRESHOLD,
        priority_score: 75
      };
    }

    // Standard confidence-based routing
    if (confidence >= this.SKIP_VERIFY_THRESHOLD) {
      return {
        decision: 'skip_verify',
        reason: 'high_confidence',
        confidence_threshold_used: this.SKIP_VERIFY_THRESHOLD,
        should_flag_for_review: false,
        priority_score: 10
      };
    }

    if (confidence >= this.VERIFY_OPTIONAL_THRESHOLD) {
      return {
        decision: 'verify_optional',
        reason: 'medium_confidence',
        confidence_threshold_used: this.VERIFY_OPTIONAL_THRESHOLD,
        should_flag_for_review: false,
        priority_score: 50
      };
    }

    // Low confidence - always verify and flag for review
    return {
      decision: 'verify_required',
      reason: 'low_confidence',
      confidence_threshold_used: this.VERIFY_OPTIONAL_THRESHOLD,
      should_flag_for_review: true,
      priority_score: 90
    };
  }

  /**
   * Helper to determine if a card is vintage (pre-2003)
   */
  static isVintageCard(setName: string): boolean {
    if (!setName) return false;
    
    const vintageSetPatterns = [
      /base\s?set/i,
      /jungle/i,
      /fossil/i,
      /team\s?rocket/i,
      /gym\s?(heroes|challenge)/i,
      /neo\s?(genesis|discovery|destiny|revelation)/i,
      /e-card/i,
      /expedition/i,
      /aquapolis/i,
      /skyridge/i
    ];

    return vintageSetPatterns.some(pattern => pattern.test(setName));
  }

  /**
   * Helper to estimate card value from basic attributes
   * (Would be enhanced with actual pricing API integration)
   */
  static estimateCardValue(result: InferenceResult, context: RoutingContext): number {
    let baseValue = 100; // $1 baseline in cents

    // Rarity multipliers
    const rarityMultipliers = {
      'Secret Rare': 50,
      'Ultra Rare': 20,
      'Rare Holo': 10,
      'Rare': 3,
      'Uncommon': 1.5,
      'Common': 1
    };

    const rarity = context.rarity || result.raw?.rarity;
    if (rarity && rarityMultipliers[rarity as keyof typeof rarityMultipliers]) {
      baseValue *= rarityMultipliers[rarity as keyof typeof rarityMultipliers];
    }

    // Special variant bonuses
    if (context.is_first_edition) baseValue *= 5;
    if (context.is_holo) baseValue *= 3;
    if (context.is_vintage) baseValue *= 4;

    return Math.round(baseValue);
  }

  /**
   * NEW: Determine if Fedora verification should be applied
   */
  private shouldApplyVerification(
    routing: RoutingResult, 
    context: RoutingContext
  ): boolean {
    // Don't verify if Fedora service not available
    if (!this.fedoraVerifier) {
      return false;
    }

    // Skip high-confidence cards unless forced
    if (routing.decision === 'skip_verify' && !context.force_verification) {
      return lmStudioConfig.verification.skip_high_confidence === false;
    }

    // Apply verification for medium-confidence cards (the target use case)
    if (routing.decision === 'verify_optional') {
      return true;
    }

    // Always verify low-confidence cards (but they already require human review)
    if (routing.decision === 'verify_required') {
      return true;
    }

    return false;
  }

  /**
   * NEW: Apply Fedora GPT-OSS-20B verification
   */
  private async applyFedoraVerification(
    inferenceResult: InferenceResult,
    context: RoutingContext
  ): Promise<VerificationResult | null> {
    if (!this.fedoraVerifier) {
      return null;
    }

    try {
      const verificationRequest: VerificationRequest = {
        card_title: inferenceResult.card_title,
        identifier: inferenceResult.identifier,
        set_name: inferenceResult.set_name,
        first_edition: inferenceResult.first_edition,
        confidence: inferenceResult.confidence,
        source_model: inferenceResult.model_used || 'qwen2.5-vl-7b'
      };

      const verificationResult = await this.fedoraVerifier.verify(
        verificationRequest,
        {
          timeout: lmStudioConfig.fedora.timeout_ms,
          skip_database_check: context.batch_mode // Skip DB lookup in batch mode for speed
        }
      );

      this.log.debug(
        `Fedora verification: ${verificationResult.agrees_with_primary ? 'AGREES' : 'DISAGREES'} ` +
        `(adjustment: ${verificationResult.confidence_adjustment.toFixed(3)}, ` +
        `flags: ${verificationResult.semantic_flags.length})`
      );

      return verificationResult;

    } catch (error) {
      this.log.warning(`Fedora verification failed: ${error}`);
      
      // Return neutral result on error if fallback is enabled
      if (lmStudioConfig.verification.fallback_on_error) {
        return {
          agrees_with_primary: true,
          confidence_adjustment: 0,
          database_matches: [],
          semantic_flags: ['verification_service_error'],
          verification_time_ms: 0,
          verifier_confidence: 0.5
        };
      }

      return null;
    }
  }

  /**
   * NEW: Adjust routing decision based on verification results
   */
  private adjustRoutingWithVerification(
    originalRouting: RoutingResult,
    verificationResult: VerificationResult,
    originalConfidence: number
  ): RoutingResult {
    const adjustedConfidence = Math.max(
      0, 
      Math.min(1, originalConfidence + verificationResult.confidence_adjustment)
    );

    // Determine new decision based on adjusted confidence
    let newDecision = originalRouting.decision;
    let newReason = originalRouting.reason;

    // Upgrade decision if verification significantly boosted confidence
    if (verificationResult.confidence_adjustment > 0.05) {
      if (adjustedConfidence >= this.SKIP_VERIFY_THRESHOLD && originalRouting.decision !== 'skip_verify') {
        newDecision = 'skip_verify';
        newReason = 'verification_boosted_confidence';
      } else if (adjustedConfidence >= this.VERIFY_OPTIONAL_THRESHOLD && originalRouting.decision === 'verify_required') {
        newDecision = 'verify_optional';
        newReason = 'verification_reduced_concern';
      }
    }

    // Downgrade decision if verification found significant issues
    if (verificationResult.confidence_adjustment < -0.05 || verificationResult.semantic_flags.length > 2) {
      if (originalRouting.decision === 'skip_verify') {
        newDecision = 'verify_optional';
        newReason = 'verification_found_concerns';
      } else if (originalRouting.decision === 'verify_optional') {
        newDecision = 'verify_required';
        newReason = 'verification_major_concerns';
      }
    }

    // Check for specific semantic flags that require attention
    const criticalFlags = ['multiple_field_discrepancies', 'no_exact_database_match', 'format_validation_failed'];
    const hasCriticalFlag = verificationResult.semantic_flags.some(flag => criticalFlags.includes(flag));

    return {
      ...originalRouting,
      decision: newDecision,
      reason: newReason,
      should_flag_for_review: originalRouting.should_flag_for_review || hasCriticalFlag || !verificationResult.agrees_with_primary,
      priority_score: hasCriticalFlag ? Math.max(originalRouting.priority_score, 85) : originalRouting.priority_score,
      verification_applied: true,
      verification_adjustment: verificationResult.confidence_adjustment,
      final_confidence: adjustedConfidence
    };
  }

  /**
   * NEW: Get Fedora verification service health status
   */
  async getFedoraVerificationHealth(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    if (!this.fedoraVerifier) {
      return { healthy: false, error: 'Fedora verification service not initialized' };
    }

    return this.fedoraVerifier.healthCheck();
  }

  /**
   * NEW: Get verification statistics
   */
  getFedoraVerificationStats() {
    if (!this.fedoraVerifier) {
      return null;
    }

    return this.fedoraVerifier.getStats();
  }
}
