/**
 * LocalFirstPipeline - Integration point for Local-First recognition
 * Handles the orchestration between local matching and ML fallback
 */

import * as path from 'path';
import { createLogger } from '../../utils/logger';
import { DatabaseQueryService } from '../../services/db/DatabaseQueryService';
import { PriceChartingLookupService } from '../../services/valuation/PriceChartingLookupService';
import { LocalMatchingService, LocalMatchingResult } from '../../services/local-matching/LocalMatchingService';
import { LocalMode, LocalMatchMetrics } from '../../services/local-matching/types';

const logger = createLogger('LocalFirstPipeline');

export interface LocalFirstResult {
  // Core results
  local_match: LocalMatchingResult;
  needs_ml_fallback: boolean;
  
  // Pipeline metadata  
  scan_id: string;
  mode: LocalMode;
  processing_time_ms: number;
  
  // Metrics for observability
  metrics: LocalMatchMetrics;
  
  // Next actions
  recommended_action: 'approve' | 'ml_fallback' | 'reject' | 'manual_review';
  confidence_threshold_met: boolean;
}

export interface LocalFirstConfig {
  enabled: boolean;
  mode: LocalMode;
  min_confidence: number;
  fallback_threshold: number; // Minimum confidence for ML fallback consideration
  max_processing_time_ms: number;
  enable_metrics: boolean;
}

export class LocalFirstPipeline {
  private dbService: DatabaseQueryService;
  private priceService: PriceChartingLookupService;
  private localMatcher: LocalMatchingService;
  
  private readonly config: LocalFirstConfig;
  private initialized = false;

  constructor() {
    this.config = {
      enabled: process.env.LOCAL_FIRST_MATCH === 'true',
      mode: (process.env.LOCAL_MODE as LocalMode) || LocalMode.HYBRID,
      min_confidence: parseFloat(process.env.LOCAL_MATCH_MIN_CONF || '0.85'),
      fallback_threshold: 0.3, // Allow ML fallback for low but not zero confidence
      max_processing_time_ms: 5000, // Fail fast if local matching is too slow
      enable_metrics: process.env.ENABLE_METRICS === 'true'
    };
    
    // Initialize services
    this.dbService = new DatabaseQueryService();
    this.priceService = new PriceChartingLookupService();
    this.localMatcher = new LocalMatchingService(this.dbService, this.priceService);
    
    logger.info('LocalFirstPipeline initialized with config:', this.config);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    if (!this.config.enabled) {
      logger.info('Local-First matching is disabled');
      this.initialized = true;
      return;
    }
    
    logger.info('Initializing Local-First pipeline...');
    
    try {
      await this.localMatcher.initialize();
      this.initialized = true;
      logger.info('Local-First pipeline initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Local-First pipeline:', error);
      throw error;
    }
  }

  async process(imagePath: string, imageBuffer?: Buffer, scanId?: string): Promise<LocalFirstResult> {
    const startTime = Date.now();
    const finalScanId = scanId || this.generateScanId();
    
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Skip processing if disabled
    if (!this.config.enabled) {
      return this.createDisabledResult(finalScanId, startTime);
    }
    
    try {
      logger.debug(`Processing local-first match for scan ${finalScanId}: ${imagePath}`);
      
      // Perform local matching with timeout
      const localMatch = await Promise.race([
        this.localMatcher.match(imagePath, imageBuffer),
        this.createTimeoutPromise()
      ]) as LocalMatchingResult;
      
      // Analyze results and make routing decision
      const result = this.analyzeAndRoute(localMatch, finalScanId, startTime);
      
      // Log metrics if enabled
      if (this.config.enable_metrics) {
        this.logMetrics(result.metrics);
      }
      
      logger.debug(`Local-first processing completed for ${finalScanId}:`, {
        confidence: result.local_match.confidence,
        decision: result.local_match.decision,
        needs_ml: result.needs_ml_fallback,
        time_ms: result.processing_time_ms
      });
      
      return result;
      
    } catch (error) {
      logger.error(`Error in local-first processing for ${finalScanId}:`, error);
      return this.createErrorResult(finalScanId, startTime, error);
    }
  }

  private async createTimeoutPromise(): Promise<LocalMatchingResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Local matching exceeded ${this.config.max_processing_time_ms}ms timeout`));
      }, this.config.max_processing_time_ms);
    });
  }

  private analyzeAndRoute(localMatch: LocalMatchingResult, scanId: string, startTime: number): LocalFirstResult {
    const processingTime = Date.now() - startTime;
    const confidence = localMatch.confidence;
    
    // Determine if ML fallback is needed
    let needsMlFallback = false;
    let recommendedAction: LocalFirstResult['recommended_action'] = 'reject';
    
    switch (this.config.mode) {
      case LocalMode.LOCAL_ONLY:
        needsMlFallback = false;
        recommendedAction = confidence >= this.config.min_confidence ? 'approve' : 'reject';
        break;
        
      case LocalMode.ML_ONLY:
        needsMlFallback = true;
        recommendedAction = 'ml_fallback';
        break;
        
      case LocalMode.HYBRID:
      default:
        if (confidence >= this.config.min_confidence) {
          needsMlFallback = false;
          recommendedAction = 'approve';
        } else if (confidence >= this.config.fallback_threshold) {
          needsMlFallback = true;
          recommendedAction = 'ml_fallback';
        } else {
          needsMlFallback = false;
          recommendedAction = 'reject';
        }
        break;
    }
    
    // Override with manual review for edge cases
    if (confidence > 0.7 && confidence < this.config.min_confidence && localMatch.strategy_chain.length === 1) {
      recommendedAction = 'manual_review';
    }
    
    const metrics: LocalMatchMetrics = {
      scan_id: scanId,
      local_confidence: confidence,
      ml_used: false, // Will be updated if ML fallback occurs
      match_method: localMatch.strategy_chain.join('+'),
      latency_ms: processingTime,
      decision: localMatch.decision,
      strategy_chain: localMatch.strategy_chain,
      conf_scores: localMatch.conf_scores,
      mode: this.config.mode
    };
    
    return {
      local_match: localMatch,
      needs_ml_fallback: needsMlFallback,
      scan_id: scanId,
      mode: this.config.mode,
      processing_time_ms: processingTime,
      metrics,
      recommended_action: recommendedAction,
      confidence_threshold_met: confidence >= this.config.min_confidence
    };
  }

  private createDisabledResult(scanId: string, startTime: number): LocalFirstResult {
    const processingTime = Date.now() - startTime;
    
    const emptyMatch: LocalMatchingResult = {
      matched: false,
      confidence: 0,
      strategy_chain: [],
      conf_scores: {},
      processing_time_ms: processingTime,
      cached: false,
      decision: 'needs_ml',
      metadata: {
        fusion_method: 'disabled',
        strategies_used: 0,
        database_lookups: 0,
        price_lookups: 0
      }
    };
    
    const metrics: LocalMatchMetrics = {
      scan_id: scanId,
      local_confidence: 0,
      ml_used: true,
      match_method: 'disabled',
      latency_ms: processingTime,
      decision: 'needs_ml',
      strategy_chain: [],
      conf_scores: {},
      mode: this.config.mode
    };
    
    return {
      local_match: emptyMatch,
      needs_ml_fallback: true,
      scan_id: scanId,
      mode: this.config.mode,
      processing_time_ms: processingTime,
      metrics,
      recommended_action: 'ml_fallback',
      confidence_threshold_met: false
    };
  }

  private createErrorResult(scanId: string, startTime: number, error: any): LocalFirstResult {
    const processingTime = Date.now() - startTime;
    
    const errorMatch: LocalMatchingResult = {
      matched: false,
      confidence: 0,
      strategy_chain: [],
      conf_scores: {},
      processing_time_ms: processingTime,
      cached: false,
      decision: 'rejected',
      metadata: {
        fusion_method: 'error',
        strategies_used: 0,
        database_lookups: 0,
        price_lookups: 0
      }
    };
    
    const metrics: LocalMatchMetrics = {
      scan_id: scanId,
      local_confidence: 0,
      ml_used: false,
      match_method: 'error',
      latency_ms: processingTime,
      decision: 'rejected',
      strategy_chain: [],
      conf_scores: {},
      mode: this.config.mode
    };
    
    // Decide fallback strategy based on error type
    const shouldFallback = this.config.mode === LocalMode.HYBRID && 
                          !(error.message?.includes('timeout'));
    
    return {
      local_match: errorMatch,
      needs_ml_fallback: shouldFallback,
      scan_id: scanId,
      mode: this.config.mode,
      processing_time_ms: processingTime,
      metrics,
      recommended_action: shouldFallback ? 'ml_fallback' : 'reject',
      confidence_threshold_met: false
    };
  }

  private generateScanId(): string {
    return `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private logMetrics(metrics: LocalMatchMetrics): void {
    // Structured logging for metrics collection
    logger.info('Local-First Metrics', {
      scan_id: metrics.scan_id,
      confidence: metrics.local_confidence,
      latency_ms: metrics.latency_ms,
      decision: metrics.decision,
      mode: metrics.mode,
      strategies: metrics.strategy_chain.length,
      ml_fallback: metrics.ml_used
    });
  }

  // Utility method for testing and debugging
  async validateConfiguration(): Promise<{
    valid: boolean;
    issues: string[];
    services: {
      database: boolean;
      pricing: boolean;
      matching: boolean;
    };
  }> {
    const issues: string[] = [];
    const services = {
      database: false,
      pricing: false,
      matching: false
    };
    
    try {
      // Check database service
      if (this.dbService.isInitialized()) {
        services.database = true;
      } else {
        issues.push('Database service not initialized');
      }
      
      // Check price service
      if (this.priceService.isInitialized()) {
        services.pricing = true;
      } else {
        issues.push('Price service not initialized');
      }
      
      // Check matching service
      const matchingStats = this.localMatcher.getStats();
      if (matchingStats.initialized && matchingStats.matchers > 0) {
        services.matching = true;
      } else {
        issues.push('Local matching service not properly initialized');
      }
      
      // Check configuration values
      if (this.config.min_confidence < 0 || this.config.min_confidence > 1) {
        issues.push('Invalid min_confidence value (must be 0-1)');
      }
      
      if (this.config.fallback_threshold < 0 || this.config.fallback_threshold > 1) {
        issues.push('Invalid fallback_threshold value (must be 0-1)');
      }
      
    } catch (error) {
      issues.push(`Validation error: ${error}`);
    }
    
    return {
      valid: issues.length === 0,
      issues,
      services
    };
  }

  getConfig(): LocalFirstConfig {
    return { ...this.config };
  }

  getStats(): {
    initialized: boolean;
    enabled: boolean;
    mode: LocalMode;
    services: {
      database: boolean;
      pricing: boolean;
      matching: Record<string, any>;
    };
  } {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
      mode: this.config.mode,
      services: {
        database: this.dbService.isInitialized(),
        pricing: this.priceService.isInitialized(),
        matching: this.localMatcher.getStats()
      }
    };
  }
}
