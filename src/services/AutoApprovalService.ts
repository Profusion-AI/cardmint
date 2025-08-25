/**
 * Auto-Approval Service for High-Confidence Cards
 * 
 * Automatically approves cards meeting confidence thresholds without manual review.
 * Integrates with DistributedRouter for streamlined high-confidence processing.
 */

import { InferenceResult } from '../core/infer/InferencePort';
import { VerificationResult } from '../adapters/lmstudio/QwenVerifierInference';
import { Card, CardStatus } from '../types';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { CardRepository } from '../storage/CardRepository';
import { createCardStorage, CardStorage } from '../storage/DistributedCardStorage';
import { getStorageConfigV2 } from '../config/distributedV2';

export interface AutoApprovalConfig {
  enabled: boolean;
  thresholds: {
    // Confidence thresholds by card tier
    common: number;          // e.g., 0.92 = auto-approve 92%+ confidence commons
    rare: number;            // e.g., 0.95 = auto-approve 95%+ confidence rares  
    holo: number;            // e.g., 0.98 = auto-approve 98%+ confidence holos
    vintage: number;         // e.g., 0.99 = auto-approve 99%+ confidence vintage
    high_value: number;      // e.g., 1.0 = never auto-approve (always review)
  };
  
  // Additional safety checks
  require_database_match: boolean;     // Must have DB verification match
  max_auto_approvals_per_hour: number; // Rate limiting
  bypass_verification: boolean;        // Skip verification for auto-approved
  
  // Audit and logging
  log_all_decisions: boolean;
  store_approval_metadata: boolean;
}

export interface AutoApprovalDecision {
  decision: 'auto_approved' | 'requires_review' | 'rejected';
  reason: string;
  confidence_score: number;
  tier_threshold: number;
  database_validated: boolean;
  processing_time_ms: number;
  approval_id: string;
}

export interface AutoApprovalStats {
  total_processed: number;
  auto_approved_count: number;
  approval_rate: number;
  avg_confidence_approved: number;
  approvals_per_hour: number;
  rejected_count: number;
  review_required_count: number;
}

export class AutoApprovalService {
  private config: AutoApprovalConfig;
  private cardRepository: CardRepository;
  private cardStorage: CardStorage;
  
  // Statistics tracking
  private stats = {
    total_processed: 0,
    auto_approved: 0,
    requires_review: 0,
    rejected: 0,
    approval_confidences: [] as number[],
    last_hour_approvals: [] as Date[]
  };

  constructor(config?: Partial<AutoApprovalConfig>) {
    this.config = this.buildConfig(config);
    this.cardRepository = new CardRepository();
    this.cardStorage = createCardStorage(getStorageConfigV2());
    
    this.setupMetrics();
    
    logger.info('AutoApprovalService initialized', {
      enabled: this.config.enabled,
      thresholds: this.config.thresholds,
      bypass_verification: this.config.bypass_verification
    });
  }

  /**
   * Main approval decision engine
   */
  async evaluateForApproval(
    primaryResult: InferenceResult,
    verificationResult: VerificationResult | undefined,
    cardTier: 'common' | 'rare' | 'holo' | 'vintage' | 'high_value',
    imagePath: string
  ): Promise<AutoApprovalDecision> {
    
    const approvalStart = Date.now();
    const approvalId = `auto_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    try {
      this.stats.total_processed++;

      // Check if auto-approval is enabled
      if (!this.config.enabled) {
        return this.createDecision('requires_review', 'Auto-approval disabled', 
                                 primaryResult.confidence, 0, false, approvalId, approvalStart);
      }

      // Rate limiting check
      if (!this.checkRateLimit()) {
        metrics.incrementCounter('auto_approval_rate_limited');
        return this.createDecision('requires_review', 'Rate limit exceeded', 
                                 primaryResult.confidence, this.config.thresholds[cardTier], false, approvalId, approvalStart);
      }

      // Get tier threshold
      const threshold = this.config.thresholds[cardTier];
      
      // Confidence check
      if (primaryResult.confidence < threshold) {
        this.stats.requires_review++;
        return this.createDecision('requires_review', 
                                 `Confidence ${primaryResult.confidence.toFixed(3)} below ${cardTier} threshold ${threshold}`,
                                 primaryResult.confidence, threshold, false, approvalId, approvalStart);
      }

      // Database validation check (if required)
      let databaseValidated = true;
      if (this.config.require_database_match && verificationResult) {
        databaseValidated = verificationResult.database_matches.length > 0;
        
        if (!databaseValidated) {
          this.stats.requires_review++;
          return this.createDecision('requires_review', 'No database match found',
                                   primaryResult.confidence, threshold, false, approvalId, approvalStart);
        }
      }

      // Additional quality checks
      const qualityCheck = this.performQualityChecks(primaryResult, verificationResult);
      if (!qualityCheck.passed) {
        this.stats.requires_review++;
        return this.createDecision('requires_review', qualityCheck.reason,
                                 primaryResult.confidence, threshold, databaseValidated, approvalId, approvalStart);
      }

      // AUTO-APPROVAL GRANTED! 🎉
      this.stats.auto_approved++;
      this.stats.approval_confidences.push(primaryResult.confidence);
      this.stats.last_hour_approvals.push(new Date());

      // Store approved card
      await this.storeApprovedCard(primaryResult, verificationResult, cardTier, imagePath, approvalId);

      const decision = this.createDecision('auto_approved', 
                                         `High confidence ${cardTier} card auto-approved`,
                                         primaryResult.confidence, threshold, databaseValidated, approvalId, approvalStart);

      // Log approval for audit trail
      if (this.config.log_all_decisions) {
        logger.info('Card auto-approved', {
          approval_id: approvalId,
          card_name: primaryResult.card_title,
          confidence: primaryResult.confidence,
          tier: cardTier,
          threshold,
          database_validated: databaseValidated
        });
      }

      metrics.incrementCounter('cards_auto_approved', { tier: cardTier });
      
      return decision;

    } catch (error) {
      logger.error('Auto-approval evaluation failed:', error);
      metrics.recordError('auto_approval_evaluation_failed');
      
      return this.createDecision('requires_review', 'Evaluation error occurred',
                               primaryResult.confidence, 0, false, approvalId, approvalStart);
    }
  }

  /**
   * Check if card should bypass verification (high confidence)
   */
  shouldBypassVerification(
    primaryResult: InferenceResult, 
    cardTier: 'common' | 'rare' | 'holo' | 'vintage' | 'high_value'
  ): boolean {
    
    if (!this.config.enabled || !this.config.bypass_verification) {
      return false;
    }

    // Only bypass for common cards with very high confidence
    if (cardTier === 'common' && primaryResult.confidence >= this.config.thresholds.common + 0.05) {
      metrics.incrementCounter('verification_bypassed', { tier: cardTier });
      return true;
    }

    return false;
  }

  /**
   * Get current auto-approval statistics
   */
  getStatistics(): AutoApprovalStats {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Filter approvals from last hour
    const lastHourApprovals = this.stats.last_hour_approvals.filter(
      date => date.getTime() > oneHourAgo
    );

    const avgConfidence = this.stats.approval_confidences.length > 0
      ? this.stats.approval_confidences.reduce((a, b) => a + b, 0) / this.stats.approval_confidences.length
      : 0;

    return {
      total_processed: this.stats.total_processed,
      auto_approved_count: this.stats.auto_approved,
      approval_rate: this.stats.total_processed > 0 ? this.stats.auto_approved / this.stats.total_processed : 0,
      avg_confidence_approved: avgConfidence,
      approvals_per_hour: lastHourApprovals.length,
      rejected_count: this.stats.rejected,
      review_required_count: this.stats.requires_review
    };
  }

  /**
   * Update configuration (for runtime adjustments)
   */
  updateConfig(updates: Partial<AutoApprovalConfig>): void {
    this.config = { ...this.config, ...updates };
    
    logger.info('Auto-approval configuration updated', updates);
    metrics.incrementCounter('auto_approval_config_updated');
  }

  // Private helper methods
  private buildConfig(userConfig?: Partial<AutoApprovalConfig>): AutoApprovalConfig {
    const defaultConfig: AutoApprovalConfig = {
      enabled: process.env.AUTO_APPROVAL_ENABLED === 'true',
      thresholds: {
        common: parseFloat(process.env.AUTO_APPROVAL_COMMON_THRESHOLD || '0.92'),
        rare: parseFloat(process.env.AUTO_APPROVAL_RARE_THRESHOLD || '0.95'),
        holo: parseFloat(process.env.AUTO_APPROVAL_HOLO_THRESHOLD || '0.98'),
        vintage: parseFloat(process.env.AUTO_APPROVAL_VINTAGE_THRESHOLD || '0.99'),
        high_value: parseFloat(process.env.AUTO_APPROVAL_HIGH_VALUE_THRESHOLD || '1.0') // Never auto-approve by default
      },
      require_database_match: process.env.AUTO_APPROVAL_REQUIRE_DB_MATCH === 'true',
      max_auto_approvals_per_hour: parseInt(process.env.AUTO_APPROVAL_MAX_PER_HOUR || '100'),
      bypass_verification: process.env.AUTO_APPROVAL_BYPASS_VERIFICATION === 'true',
      log_all_decisions: process.env.AUTO_APPROVAL_LOG_ALL === 'true',
      store_approval_metadata: true
    };

    return { ...defaultConfig, ...userConfig };
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Clean old entries
    this.stats.last_hour_approvals = this.stats.last_hour_approvals.filter(
      date => date.getTime() > oneHourAgo
    );

    return this.stats.last_hour_approvals.length < this.config.max_auto_approvals_per_hour;
  }

  private performQualityChecks(
    primaryResult: InferenceResult, 
    verificationResult?: VerificationResult
  ): { passed: boolean; reason: string } {
    
    // Check for required fields
    if (!primaryResult.card_title || !primaryResult.set_name) {
      return { passed: false, reason: 'Missing required card information' };
    }

    // Check for verification conflicts
    if (verificationResult && !verificationResult.agrees_with_primary) {
      return { passed: false, reason: 'Verification disagrees with primary result' };
    }

    // Check for semantic flags that indicate issues
    if (verificationResult?.semantic_flags.includes('unclear_image')) {
      return { passed: false, reason: 'Image quality issues detected' };
    }

    return { passed: true, reason: 'All quality checks passed' };
  }

  private async storeApprovedCard(
    primaryResult: InferenceResult,
    verificationResult: VerificationResult | undefined,
    cardTier: string,
    imagePath: string,
    approvalId: string
  ): Promise<void> {
    
    const cardData: Partial<Card> = {
      imageUrl: imagePath,
      status: CardStatus.PROCESSED, // Auto-approved cards go straight to processed
      metadata: {
        cardName: primaryResult.card_title,
        cardSet: primaryResult.set_name,
        cardNumber: primaryResult.identifier?.number,
        runId: `auto_approved_${Date.now()}`,
        customFields: {
          processing_mode: 'auto_approved',
          approval_id: approvalId,
          primary_confidence: primaryResult.confidence,
          verifier_confidence: verificationResult?.verifier_confidence,
          confidence_adjustment: verificationResult?.confidence_adjustment,
          value_tier: cardTier,
          auto_approval_timestamp: new Date().toISOString(),
          verification_bypassed: this.config.bypass_verification,
          database_matches: verificationResult?.database_matches?.length || 0
        }
      },
      confidenceScore: primaryResult.confidence
    };

    await this.cardStorage.storeCard(cardData);
    
    logger.debug('Auto-approved card stored', { 
      approval_id: approvalId,
      card_name: primaryResult.card_title 
    });
  }

  private createDecision(
    decision: 'auto_approved' | 'requires_review' | 'rejected',
    reason: string,
    confidence: number,
    threshold: number,
    databaseValidated: boolean,
    approvalId: string,
    startTime: number
  ): AutoApprovalDecision {
    
    return {
      decision,
      reason,
      confidence_score: confidence,
      tier_threshold: threshold,
      database_validated: databaseValidated,
      processing_time_ms: Date.now() - startTime,
      approval_id: approvalId
    };
  }

  private setupMetrics(): void {
    metrics.registerGauge('auto_approval_rate', 'Current auto-approval rate', () => {
      const stats = this.getStatistics();
      return stats.approval_rate;
    });

    metrics.registerGauge('auto_approval_avg_confidence', 'Average confidence of auto-approved cards', () => {
      const stats = this.getStatistics();
      return stats.avg_confidence_approved;
    });

    metrics.registerGauge('auto_approvals_per_hour', 'Auto-approvals in last hour', () => {
      const stats = this.getStatistics();
      return stats.approvals_per_hour;
    });
  }
}

// Factory function for easy integration
export function createAutoApprovalService(config?: Partial<AutoApprovalConfig>): AutoApprovalService {
  return new AutoApprovalService(config);
}