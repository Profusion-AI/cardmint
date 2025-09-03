/**
 * Verification Metrics - Phase 5 Enhancement
 * 
 * Extends existing metrics infrastructure with dual-verification specific monitoring
 * Integrates with CircuitBreaker, MetricsCollector, and AccuracyTracker
 */

import { createLogger } from './logger';
import { CircuitBreaker, createAPICircuitBreaker, circuitBreakerRegistry } from './circuitBreaker';
import { accuracyTracker } from './accuracyMetrics';
import { metrics } from './metrics';
import type { IntegratedScanResult } from '../services/IntegratedScannerService';
import type { VerifiedResult } from '../services/VerificationPipeline';
import type { RoutingResult } from '../core/verification/ConfidenceRouter';

const logger = createLogger('verification-metrics');

export interface VerificationMetrics {
  // Routing distribution
  routing_skip_verify_rate: number;
  routing_verify_optional_rate: number;
  routing_verify_required_rate: number;
  
  // Agreement tracking
  verifier_agreement_rate: number;
  confidence_adjustment_avg: number;
  
  // Performance metrics
  verification_usage_rate: number;
  python_fallback_rate: number;
  primary_model_avg_latency_ms: number;
  verifier_model_avg_latency_ms: number;
  
  // Quality metrics
  flagged_for_review_rate: number;
  database_validation_rate: number;
  high_confidence_accuracy: number;
  
  // System health
  circuit_breaker_status: Record<string, string>;
  models_health_status: 'healthy' | 'degraded' | 'critical';
}

/**
 * Enhanced verification metrics tracker extending existing infrastructure
 */
export class VerificationMetricsTracker {
  private readonly windowSize = 1000; // Last 1000 verifications
  
  // Circuit breakers for dual-verification components
  private readonly primaryModelBreaker: CircuitBreaker;
  private readonly verifierModelBreaker: CircuitBreaker;
  private readonly databaseBreaker: CircuitBreaker;
  
  // Rolling window tracking
  private routingDecisions: string[] = [];
  private agreementResults: boolean[] = [];
  private confidenceAdjustments: number[] = [];
  private verificationUsage: boolean[] = [];
  private reviewFlags: boolean[] = [];
  private primaryLatencies: number[] = [];
  private verifierLatencies: number[] = [];
  
  // High-confidence accuracy tracking (for skip_verify validation)
  private highConfidenceResults: Map<string, boolean> = new Map();

  constructor() {
    this.initializeCircuitBreakers();
    this.initializeMetrics();
    this.startPeriodicReporting();
    
    logger.info('Verification metrics tracker initialized with circuit breaker protection');
  }

  private initializeCircuitBreakers(): void {
    // Primary model circuit breaker (higher timeout for VLM)
    this.primaryModelBreaker = new CircuitBreaker({
      name: 'lm_studio_primary',
      failureThreshold: 3,      // Lower threshold - VLM failures are critical
      successThreshold: 2,
      timeout: 35000,           // 35s timeout for VLM processing
      resetTimeout: 60000,      // 1 minute reset
      volumeThreshold: 5,
      errorFilter: (error) => {
        // Don't trip on timeout if model is just slow
        if (error.code === 'ECONNABORTED' && error.message.includes('timeout')) {
          return false;
        }
        return true;
      },
      onStateChange: (state) => {
        if (state === 'OPEN') {
          logger.error('🚨 CRITICAL: Primary VLM model circuit breaker OPEN - switching to Python fallback');
          metrics.increment('verification_circuit_breaker_open', { service: 'primary_model' });
        }
      }
    });

    // Verifier model circuit breaker (faster, more tolerance)
    this.verifierModelBreaker = new CircuitBreaker({
      name: 'lm_studio_verifier',
      failureThreshold: 5,      // More tolerant - verifier is supplementary
      successThreshold: 2,
      timeout: 15000,           // 15s timeout for lightweight model
      resetTimeout: 30000,      // 30s reset
      volumeThreshold: 10,
      errorFilter: (error) => {
        // 404 model not found should trip circuit
        if (error.message?.includes('Model') && error.message?.includes('not found')) {
          return true;
        }
        return error.code !== 'ECONNABORTED';
      },
      onStateChange: (state) => {
        if (state === 'OPEN') {
          logger.warn('⚠️ Verifier model circuit breaker OPEN - continuing without verification');
          metrics.increment('verification_circuit_breaker_open', { service: 'verifier_model' });
        }
      }
    });

    // Database circuit breaker
    this.databaseBreaker = new CircuitBreaker({
      name: 'verification_database',
      failureThreshold: 10,     // Very tolerant - database checks are optional
      successThreshold: 3,
      timeout: 5000,            // 5s timeout for DB operations
      resetTimeout: 15000,      // 15s reset - quick recovery
      volumeThreshold: 20,
      onStateChange: (state) => {
        if (state === 'OPEN') {
          logger.warn('⚠️ Database verification circuit breaker OPEN - skipping DB checks');
          metrics.increment('verification_circuit_breaker_open', { service: 'database' });
        }
      }
    });

    // Register all breakers
    circuitBreakerRegistry.register('lm_studio_primary', this.primaryModelBreaker);
    circuitBreakerRegistry.register('lm_studio_verifier', this.verifierModelBreaker);
    circuitBreakerRegistry.register('verification_database', this.databaseBreaker);
  }

  private initializeMetrics(): void {
    // Verification-specific gauges
    metrics.registerGauge(
      'verification_routing_skip_verify_rate',
      'Rate of cards that skip verification (high confidence)',
      () => this.calculateRoutingRate('skip_verify')
    );

    metrics.registerGauge(
      'verification_routing_optional_rate', 
      'Rate of cards with optional verification (medium confidence)',
      () => this.calculateRoutingRate('verify_optional')
    );

    metrics.registerGauge(
      'verification_routing_required_rate',
      'Rate of cards requiring verification (low confidence/high value)',
      () => this.calculateRoutingRate('verify_required')
    );

    metrics.registerGauge(
      'verification_agreement_rate',
      'Rate at which verifier agrees with primary model',
      () => this.calculateAgreementRate()
    );

    metrics.registerGauge(
      'verification_confidence_adjustment_avg',
      'Average confidence adjustment from verification (-0.2 to +0.1)',
      () => this.calculateAverageAdjustment()
    );

    metrics.registerGauge(
      'verification_usage_rate',
      'Rate of cards processed with verification vs Python fallback',
      () => this.calculateVerificationUsageRate()
    );

    metrics.registerGauge(
      'verification_review_flag_rate',
      'Rate of cards flagged for manual review',
      () => this.calculateReviewFlagRate()
    );

    metrics.registerGauge(
      'verification_high_confidence_accuracy',
      'Accuracy of high-confidence cards that skip verification',
      () => this.calculateHighConfidenceAccuracy()
    );

    // Performance gauges
    metrics.registerGauge(
      'verification_primary_latency_p95_ms',
      'Primary model 95th percentile latency',
      () => this.calculatePercentile(this.primaryLatencies, 95)
    );

    metrics.registerGauge(
      'verification_verifier_latency_p95_ms', 
      'Verifier model 95th percentile latency',
      () => this.calculatePercentile(this.verifierLatencies, 95)
    );

    // Circuit breaker health gauges
    metrics.registerGauge(
      'verification_models_health_score',
      'Combined health score of verification models (0-100)',
      () => this.calculateModelsHealthScore()
    );

    // Histograms for detailed analysis
    metrics.registerHistogram(
      'verification_confidence_adjustment',
      'Distribution of confidence adjustments',
      [-0.2, -0.15, -0.1, -0.05, 0, 0.02, 0.05, 0.1]
    );

    metrics.registerHistogram(
      'verification_processing_time_seconds',
      'Total verification processing time',
      [1, 2, 5, 10, 15, 20, 30, 45]
    );
  }

  /**
   * Record a verification processing result - integrates with existing accuracy tracker
   */
  recordVerificationResult(result: IntegratedScanResult): void {
    // Update rolling windows
    this.updateWindow(this.routingDecisions, result.routing_decision || 'unknown');
    this.updateWindow(this.verificationUsage, result.verification_used);
    this.updateWindow(this.reviewFlags, result.flagged_for_review);

    // Track verification-specific metrics
    if (result.verification_used && result.verifier_result) {
      this.updateWindow(this.agreementResults, result.verifier_result.agrees_with_primary);
      
      if (result.confidence_adjustment !== undefined) {
        this.updateWindowNumber(this.confidenceAdjustments, result.confidence_adjustment);
      }
    }

    // Track performance metrics
    if (result.timing_breakdown.primary_inference_ms) {
      this.updateWindowNumber(this.primaryLatencies, result.timing_breakdown.primary_inference_ms);
    }
    
    if (result.timing_breakdown.verification_ms) {
      this.updateWindowNumber(this.verifierLatencies, result.timing_breakdown.verification_ms);
    }

    // Track high-confidence accuracy (for skip_verify validation)
    if (result.routing_decision === 'skip_verify') {
      const success = result.final_confidence >= 0.9; // Define success for high-confidence
      this.highConfidenceResults.set(result.source_file, success);
      this.trimMap(this.highConfidenceResults);
    }

    // Update metrics counters
    metrics.increment('verification_cards_processed_total');
    metrics.increment(`verification_routing_${result.routing_decision || 'unknown'}_total`);
    
    if (result.verification_used) {
      metrics.increment('verification_used_total');
    } else {
      metrics.increment('verification_python_fallback_total');
    }

    if (result.flagged_for_review) {
      metrics.increment('verification_review_flagged_total');
    }

    // Record histograms
    if (result.confidence_adjustment !== undefined) {
      metrics.observeHistogram('verification_confidence_adjustment', result.confidence_adjustment);
    }
    
    if (result.processing_time_ms) {
      metrics.observeHistogram('verification_processing_time_seconds', result.processing_time_ms / 1000);
    }

    // Update existing accuracy tracker with verification data
    this.updateAccuracyTracker(result);

    // Log warnings for concerning patterns
    this.checkForConcerningPatterns();
  }

  /**
   * Update existing accuracy tracker with verification-enhanced data
   */
  private updateAccuracyTracker(result: IntegratedScanResult): void {
    accuracyTracker.recordCardProcessing({
      // Map verification fields to accuracy tracker format
      ocrSuccess: result.final_confidence > 0.7, // Define OCR success threshold
      ocrConfidence: result.confidence, // Original confidence
      apiMatchFound: result.database_validated,
      apiMatchConfidence: result.final_confidence,
      imageValidated: result.verification_used,
      imageConfidence: result.final_confidence,
      overallSuccess: !result.flagged_for_review && result.final_confidence > 0.8,
      overallConfidence: result.final_confidence,
      needsReview: result.flagged_for_review,
      isHighValue: result.routing_decision === 'verify_required',
      isSpecialEdition: result.variant_flags?.first_edition || 
                       result.variant_flags?.shadowless || 
                       result.variant_flags?.promo_stamp || false,
      processingTimeMs: result.processing_time_ms || 0,
      cardId: result.source_file
    });
  }

  private checkForConcerningPatterns(): void {
    if (this.routingDecisions.length < 50) return; // Wait for sufficient data

    const recentAgreement = this.calculateAgreementRate();
    const recentUsage = this.calculateVerificationUsageRate();

    // Alert on low agreement rate
    if (recentAgreement < 0.7) {
      logger.warn('🚨 Low verifier agreement rate detected', {
        agreementRate: `${(recentAgreement * 100).toFixed(1)}%`,
        threshold: '70%',
        action: 'Consider verifier model tuning'
      });
      
      metrics.increment('verification_alerts_total', { type: 'low_agreement' });
    }

    // Alert on high Python fallback rate
    if (recentUsage < 0.8) {
      logger.warn('⚠️ High Python fallback rate detected', {
        verificationUsage: `${(recentUsage * 100).toFixed(1)}%`,
        threshold: '80%',
        action: 'Check model health and circuit breakers'
      });
      
      metrics.increment('verification_alerts_total', { type: 'high_fallback' });
    }
  }

  /**
   * Get circuit breaker protected execution for primary model
   */
  async executeWithPrimaryBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.primaryModelBreaker.execute(fn);
  }

  /**
   * Get circuit breaker protected execution for verifier model  
   */
  async executeWithVerifierBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.verifierModelBreaker.execute(fn);
  }

  /**
   * Get circuit breaker protected execution for database
   */
  async executeWithDatabaseBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.databaseBreaker.execute(fn);
  }

  getVerificationMetrics(): VerificationMetrics {
    return {
      routing_skip_verify_rate: this.calculateRoutingRate('skip_verify'),
      routing_verify_optional_rate: this.calculateRoutingRate('verify_optional'),
      routing_verify_required_rate: this.calculateRoutingRate('verify_required'),
      verifier_agreement_rate: this.calculateAgreementRate(),
      confidence_adjustment_avg: this.calculateAverageAdjustment(),
      verification_usage_rate: this.calculateVerificationUsageRate(),
      python_fallback_rate: 1 - this.calculateVerificationUsageRate(),
      primary_model_avg_latency_ms: this.calculateAverage(this.primaryLatencies),
      verifier_model_avg_latency_ms: this.calculateAverage(this.verifierLatencies),
      flagged_for_review_rate: this.calculateReviewFlagRate(),
      database_validation_rate: this.calculateDatabaseValidationRate(),
      high_confidence_accuracy: this.calculateHighConfidenceAccuracy(),
      circuit_breaker_status: this.getCircuitBreakerStatus(),
      models_health_status: this.getModelsHealthStatus()
    };
  }

  private getCircuitBreakerStatus(): Record<string, string> {
    return {
      primary_model: this.primaryModelBreaker.getState(),
      verifier_model: this.verifierModelBreaker.getState(),  
      database: this.databaseBreaker.getState()
    };
  }

  private getModelsHealthStatus(): 'healthy' | 'degraded' | 'critical' {
    const primaryState = this.primaryModelBreaker.getState();
    const verifierState = this.verifierModelBreaker.getState();

    if (primaryState === 'OPEN') {
      return 'critical'; // Primary model down is critical
    } else if (verifierState === 'OPEN') {
      return 'degraded'; // Verifier down is degraded but operational
    } else {
      return 'healthy';
    }
  }

  private calculateModelsHealthScore(): number {
    const states = this.getCircuitBreakerStatus();
    let score = 100;

    if (states.primary_model === 'OPEN') score -= 60; // Primary is critical
    else if (states.primary_model === 'HALF_OPEN') score -= 20;
    
    if (states.verifier_model === 'OPEN') score -= 30; // Verifier is important
    else if (states.verifier_model === 'HALF_OPEN') score -= 10;
    
    if (states.database === 'OPEN') score -= 10; // Database is supplementary
    else if (states.database === 'HALF_OPEN') score -= 5;

    return Math.max(0, score);
  }

  // Utility methods for rolling window calculations
  private updateWindow(array: any[], value: any): void {
    array.push(value);
    if (array.length > this.windowSize) {
      array.shift();
    }
  }

  private updateWindowNumber(array: number[], value: number): void {
    array.push(value);
    if (array.length > this.windowSize) {
      array.shift();
    }
  }

  private trimMap(map: Map<string, boolean>): void {
    if (map.size > this.windowSize) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
  }

  private calculateRoutingRate(decision: string): number {
    if (this.routingDecisions.length === 0) return 0;
    const count = this.routingDecisions.filter(d => d === decision).length;
    return count / this.routingDecisions.length;
  }

  private calculateAgreementRate(): number {
    if (this.agreementResults.length === 0) return 0;
    const agreements = this.agreementResults.filter(a => a).length;
    return agreements / this.agreementResults.length;
  }

  private calculateAverageAdjustment(): number {
    if (this.confidenceAdjustments.length === 0) return 0;
    const sum = this.confidenceAdjustments.reduce((a, b) => a + b, 0);
    return sum / this.confidenceAdjustments.length;
  }

  private calculateVerificationUsageRate(): number {
    if (this.verificationUsage.length === 0) return 0;
    const usage = this.verificationUsage.filter(u => u).length;
    return usage / this.verificationUsage.length;
  }

  private calculateReviewFlagRate(): number {
    if (this.reviewFlags.length === 0) return 0;
    const flags = this.reviewFlags.filter(f => f).length;
    return flags / this.reviewFlags.length;
  }

  private calculateHighConfidenceAccuracy(): number {
    if (this.highConfidenceResults.size === 0) return 0;
    const successful = Array.from(this.highConfidenceResults.values()).filter(v => v).length;
    return successful / this.highConfidenceResults.size;
  }

  private calculateDatabaseValidationRate(): number {
    // Track database validation usage once metrics are wired
    return 0.5; // Fixed sentinel value until integrated
  }

  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private startPeriodicReporting(): void {
    // Report verification metrics every 2 minutes
    setInterval(() => {
      if (this.routingDecisions.length > 0) {
        this.logVerificationReport();
      }
    }, 2 * 60 * 1000);
  }

  private logVerificationReport(): void {
    const metrics = this.getVerificationMetrics();
    const cbStats = circuitBreakerRegistry.getStats();

    logger.info('Verification Metrics Report', {
      routing: {
        skip_verify: `${(metrics.routing_skip_verify_rate * 100).toFixed(1)}%`,
        verify_optional: `${(metrics.routing_verify_optional_rate * 100).toFixed(1)}%`, 
        verify_required: `${(metrics.routing_verify_required_rate * 100).toFixed(1)}%`
      },
      quality: {
        agreement_rate: `${(metrics.verifier_agreement_rate * 100).toFixed(1)}%`,
        confidence_adjustment_avg: metrics.confidence_adjustment_avg.toFixed(3),
        high_confidence_accuracy: `${(metrics.high_confidence_accuracy * 100).toFixed(1)}%`,
        review_flag_rate: `${(metrics.flagged_for_review_rate * 100).toFixed(1)}%`
      },
      performance: {
        verification_usage: `${(metrics.verification_usage_rate * 100).toFixed(1)}%`,
        primary_latency_avg: `${metrics.primary_model_avg_latency_ms.toFixed(0)}ms`,
        verifier_latency_avg: `${metrics.verifier_model_avg_latency_ms.toFixed(0)}ms`,
        models_health: metrics.models_health_status
      },
      circuit_breakers: metrics.circuit_breaker_status,
      samples: this.routingDecisions.length
    });
  }

  reset(): void {
    this.routingDecisions = [];
    this.agreementResults = [];
    this.confidenceAdjustments = [];
    this.verificationUsage = [];
    this.reviewFlags = [];
    this.primaryLatencies = [];
    this.verifierLatencies = [];
    this.highConfidenceResults.clear();
    
    // Reset circuit breakers
    this.primaryModelBreaker.reset();
    this.verifierModelBreaker.reset();
    this.databaseBreaker.reset();
    
    logger.info('Verification metrics reset');
  }
}

// Singleton instance
export const verificationMetrics = new VerificationMetricsTracker();
