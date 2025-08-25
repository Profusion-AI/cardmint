import type { InferenceResult } from '../infer/InferencePort';
import { logger } from '../../utils/logger';
import { getGlobalProfiler } from '../../utils/performanceProfiler';

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
}

/**
 * Confidence-based routing for cascade verification logic
 * 
 * Routing Rules (CardMint CTO Strategy):
 * - ≥90%: Skip verification (~70% of cards, high-confidence path)
 * - 70-89%: Optional verification (~20% of cards, medium-confidence)  
 * - <70% OR high-value: Required verification + review flagging
 * - Special handling: holo, vintage, first edition always verify
 */
export class ConfidenceRouter {
  // Thresholds from existing CardMatcher - maintaining consistency
  private readonly SKIP_VERIFY_THRESHOLD = 0.90;     // High confidence, skip verifier
  private readonly VERIFY_OPTIONAL_THRESHOLD = 0.70;  // Medium confidence, selective verify
  private readonly HIGH_VALUE_THRESHOLD = 10000;      // $100 in cents
  
  // Special card type thresholds
  private readonly HOLO_VERIFY_THRESHOLD = 0.85;      // Lower threshold for holo cards
  private readonly VINTAGE_VERIFY_THRESHOLD = 0.80;   // Lower threshold for vintage
  private readonly FIRST_ED_VERIFY_THRESHOLD = 0.85;  // Lower threshold for 1st edition

  constructor() {
    logger.debug('ConfidenceRouter initialized with cascade thresholds');
  }

  /**
   * Main routing decision method
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

      logger.debug(`Routing decision for "${inferenceResult.card_title}": ${result.decision} (${result.reason})`);
      return result;

    } catch (error) {
      profiler?.endStage('confidence_routing', { error: String(error) });
      logger.error('Confidence routing failed:', error);
      
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

      logger.info(`Batch routing: ${skipCount} skip, ${optionalCount} optional, ${requiredCount} required (${((optionalCount + requiredCount) / results.length * 100).toFixed(1)}% verification rate)`);
      
      return routingResults;

    } catch (error) {
      profiler?.endStage('batch_routing', { error: String(error) });
      logger.error('Batch routing failed:', error);
      
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
}