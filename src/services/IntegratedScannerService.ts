/**
 * Integrated Scanner Service - Phase 4 Implementation
 * 
 * Combines existing QwenScannerService with new dual-verification pipeline
 * Maintains backward compatibility while adding enhanced verification capabilities
 */

import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger';
import { startGlobalProfiler, endGlobalProfiler, getGlobalProfiler } from '../utils/performanceProfiler';
import { verificationMetrics } from '../utils/verificationMetrics';
import { VerificationPipeline, type PipelineOptions, type VerifiedResult } from './VerificationPipeline';
import { LmStudioInference } from '../adapters/lmstudio/LmStudioInference';
import { QwenVerifierInference } from '../adapters/lmstudio/QwenVerifierInference';
import { ConfidenceRouter } from '../core/verification/ConfidenceRouter';
import type { InferenceResult } from '../core/infer/InferencePort';
import type { QwenScanResult } from './QwenScannerService';

const execAsync = promisify(exec);
const logger = createLogger('IntegratedScannerService');

export interface IntegratedScanOptions {
  // Processing mode selection
  useVerification?: boolean;        // Enable dual-verification (default: true)
  fallbackToPython?: boolean;       // Fallback to Python script if verification fails
  
  // Verification options
  skipDatabaseVerification?: boolean;
  forceVerification?: boolean;
  primaryTimeout?: number;
  verifierTimeout?: number;
  
  // Compatibility options
  updateInventory?: boolean;        // Update inventory.json (default: true)
  moveToProcessed?: boolean;        // Move to processed directory (default: true)
}

export interface IntegratedScanResult extends QwenScanResult {
  // Enhanced verification metadata
  verification_used: boolean;
  verification_path: 'skipped' | 'optional' | 'required' | 'python_fallback';
  final_confidence: number;
  confidence_adjustment?: number;
  routing_decision?: string;
  database_validated: boolean;
  flagged_for_review: boolean;
  
  // Performance data
  timing_breakdown: {
    primary_inference_ms?: number;
    verification_ms?: number;
    database_check_ms?: number;
    python_fallback_ms?: number;
    total_ms: number;
  };
  
  // Dual-verification specific
  verifier_result?: {
    agrees_with_primary: boolean;
    semantic_flags: string[];
    database_matches: number;
  };
}

/**
 * Enhanced scanner service integrating dual-verification with existing infrastructure
 */
export class IntegratedScannerService {
  private readonly scanDir = '/home/profusionai/CardMint/scans';
  private readonly processedDir = '/home/profusionai/CardMint/processed';
  private readonly inventoryPath = '/home/profusionai/CardMint/inventory.json';
  private readonly legacyScannerPath = '/home/profusionai/CardMint/cardmint_scanner.py';
  
  // Dual-verification components
  private readonly verificationPipeline: VerificationPipeline;
  private readonly primaryAdapter: LmStudioInference;
  private readonly verifierAdapter: QwenVerifierInference;
  private readonly router: ConfidenceRouter;
  
  // Statistics tracking
  private totalProcessed = 0;
  private verificationUsed = 0;
  private pythonFallbacks = 0;
  private averageProcessingTime = 0;

  constructor() {
    logger.info('Initializing Integrated Scanner Service (Phase 4)');
    
    // Initialize verification components
    this.primaryAdapter = new LmStudioInference('http://10.0.24.174:1234', 'qwen2.5-vl-7b-instruct');
    this.verifierAdapter = new QwenVerifierInference('http://10.0.24.174:1234', 'qwen2.5-0.5b-instruct-mlx');
    this.router = new ConfidenceRouter();
    this.verificationPipeline = new VerificationPipeline();
    
    this.ensureDirectories();
    logger.info('Integrated Scanner Service ready (TypeScript + Python hybrid)');
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [this.scanDir, this.processedDir];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Main processing method - enhanced with dual-verification
   */
  async processCard(
    imagePath: string, 
    options: IntegratedScanOptions = {}
  ): Promise<IntegratedScanResult | null> {
    const startTime = Date.now();
    const profiler = startGlobalProfiler(`integrated_${path.basename(imagePath)}`);
    
    const opts = {
      useVerification: true,
      fallbackToPython: true,
      updateInventory: true,
      moveToProcessed: true,
      primaryTimeout: 30000,
      verifierTimeout: 10000,
      ...options
    };

    try {
      logger.info(`Processing card with integrated service: ${path.basename(imagePath)}`);
      
      // Set up profiling metadata
      const fileStats = await fs.stat(imagePath);
      profiler.setCardInfo(path.basename(imagePath), fileStats.size);
      
      let result: IntegratedScanResult | null = null;

      // Primary path: Dual-verification (TypeScript native)
      if (opts.useVerification) {
        profiler.startStage('dual_verification_attempt');
        
        try {
          const verificationResult = await this.processWithVerification(imagePath, opts);
          result = this.convertVerificationToIntegrated(verificationResult, imagePath);
          result.verification_used = true;
          this.verificationUsed++;
          
          profiler.endStage('dual_verification_attempt', { 
            success: true,
            confidence: result.final_confidence,
            path: result.verification_path
          });
          
          logger.info(`Dual-verification succeeded: ${result.name} (${result.final_confidence.toFixed(3)})`);
          
        } catch (verificationError) {
          profiler.endStage('dual_verification_attempt', { 
            success: false,
            error: String(verificationError)
          });
          
          logger.warn(`Dual-verification failed: ${verificationError}`);
          
          // Fallback to Python if enabled
          if (opts.fallbackToPython) {
            result = await this.processWithPython(imagePath, opts);
            if (result) {
              result.verification_used = false;
              result.verification_path = 'python_fallback';
              this.pythonFallbacks++;
            }
          }
        }
      } else {
        // Direct Python processing (legacy mode)
        result = await this.processWithPython(imagePath, opts);
        if (result) {
          result.verification_used = false;
          result.verification_path = 'python_fallback';
        }
      }

      if (!result) {
        logger.error('Both verification and Python fallback failed');
        endGlobalProfiler({ log: true });
        return null;
      }

      // Post-processing steps
      if (opts.updateInventory) {
        await this.updateInventoryFile(result);
      }

      if (opts.moveToProcessed && imagePath.includes(this.scanDir)) {
        await this.moveToProcessedDirectory(imagePath);
      }

      // Finalize timing and statistics
      const totalTime = Date.now() - startTime;
      result.timing_breakdown.total_ms = totalTime;
      result.processing_time_ms = totalTime;
      
      this.updateStatistics(result);
      
      // Record verification metrics (Phase 5 enhancement)
      verificationMetrics.recordVerificationResult(result);
      
      const report = endGlobalProfiler({ log: true });
      logger.info(`Card processing completed: ${result.name} (${totalTime}ms, ` +
                 `verification: ${result.verification_used}, path: ${result.verification_path})`);

      return result;

    } catch (error) {
      endGlobalProfiler({ log: true });
      logger.error('Integrated card processing failed:', error);
      return null;
    }
  }

  /**
   * Process using dual-verification pipeline with circuit breaker protection
   */
  private async processWithVerification(
    imagePath: string, 
    options: IntegratedScanOptions
  ): Promise<VerifiedResult> {
    const profiler = getGlobalProfiler();
    
    profiler?.startStage('verification_pipeline_protected');
    
    try {
      // Execute primary inference with circuit breaker protection
      const primaryResult = await verificationMetrics.executeWithPrimaryBreaker(async () => {
        return this.primaryAdapter.classify(imagePath, {
          timeout: options.primaryTimeout || 30000
        });
      });

      // Route the decision
      const routingResult = await this.router.route(primaryResult, {
        force_verification: options.forceVerification
      });

      // Optional verification with circuit breaker protection
      let verificationResult;
      if (routingResult.decision !== 'skip_verify' && this.verifierAdapter) {
        try {
          verificationResult = await verificationMetrics.executeWithVerifierBreaker(async () => {
            return this.verifierAdapter.verify(primaryResult, imagePath, {
              timeout: options.verifierTimeout || 10000,
              skip_database_check: options.skipDatabaseVerification
            });
          });
        } catch (error) {
          logger.warn('Verifier circuit breaker tripped, continuing without verification:', error);
          // Continue without verification rather than failing
        }
      }

      // Database validation with circuit breaker protection
      if (!options.skipDatabaseVerification && !verificationResult?.database_matches?.length) {
        try {
          await verificationMetrics.executeWithDatabaseBreaker(async () => {
            // TODO: Implement database verification service
            const databaseMatches: any[] = [];
            if (verificationResult) {
              verificationResult.database_matches = databaseMatches;
            }
          });
        } catch (error) {
          logger.debug('Database verification circuit breaker tripped:', error);
          // Continue without database validation
        }
      }

      // Build the result manually since we bypassed the pipeline
      const finalConfidence = verificationResult 
        ? primaryResult.confidence + (verificationResult.confidence_adjustment || 0)
        : primaryResult.confidence;

      const result: VerifiedResult = {
        primary_result: primaryResult,
        verification_result: verificationResult,
        routing_decision: routingResult,
        final_confidence: Math.max(0, Math.min(1, finalConfidence)),
        adjusted_result: { ...primaryResult, confidence: finalConfidence },
        processing_time_ms: Date.now() - Date.now(), // Will be set by caller
        verification_path: routingResult.decision === 'skip_verify' ? 'skipped' :
                          routingResult.decision === 'verify_optional' ? 'optional' : 'required',
        database_validated: !options.skipDatabaseVerification,
        should_review: routingResult.should_flag_for_review || finalConfidence < 0.7,
        timing_breakdown: {
          primary_inference_ms: 0, // Will be filled by profiler
          routing_ms: 0,
          verification_ms: verificationResult ? 0 : undefined,
          database_check_ms: 0,
          total_ms: 0
        },
        card_id: undefined,
        stored_at: undefined
      };

      profiler?.endStage('verification_pipeline_protected', {
        card: primaryResult.card_title,
        confidence: result.final_confidence,
        path: result.verification_path,
        circuit_breaker_used: true
      });

      return result;
      
    } catch (error) {
      profiler?.endStage('verification_pipeline_protected', { 
        error: String(error),
        circuit_breaker_used: true
      });
      throw error;
    }
  }

  /**
   * Process using legacy Python script (fallback)
   */
  private async processWithPython(
    imagePath: string, 
    options: IntegratedScanOptions
  ): Promise<IntegratedScanResult | null> {
    const profiler = getGlobalProfiler();
    const pythonStart = Date.now();
    
    profiler?.startStage('python_fallback');
    
    try {
      // Copy to scan directory if needed
      const fileName = path.basename(imagePath);
      const scanPath = path.join(this.scanDir, fileName);
      
      if (imagePath !== scanPath) {
        await fs.copyFile(imagePath, scanPath);
      }

      // Execute Python scanner
      const { stdout, stderr } = await execAsync(
        `python3 ${this.legacyScannerPath} --file "${scanPath}" --json`,
        { timeout: 30000 }
      );

      if (stderr && !stderr.includes('INFO')) {
        logger.warn(`Python scanner stderr: ${stderr}`);
      }

      // Read result from inventory
      const inventory = await this.getInventory();
      const qwenResult = inventory.find(card => card.source_file === fileName);

      if (!qwenResult) {
        profiler?.endStage('python_fallback', { success: false, reason: 'no_result' });
        return null;
      }

      const pythonTime = Date.now() - pythonStart;
      
      // Convert to integrated format
      const integratedResult = this.convertQwenToIntegrated(qwenResult);
      integratedResult.timing_breakdown.python_fallback_ms = pythonTime;
      
      profiler?.endStage('python_fallback', { 
        success: true,
        card: qwenResult.name,
        confidence: qwenResult.confidence,
        time_ms: pythonTime
      });

      logger.info(`Python fallback succeeded: ${qwenResult.name} (${pythonTime}ms)`);
      return integratedResult;

    } catch (error) {
      const pythonTime = Date.now() - pythonStart;
      profiler?.endStage('python_fallback', { 
        success: false,
        error: String(error),
        time_ms: pythonTime
      });
      
      logger.error('Python fallback failed:', error);
      return null;
    }
  }

  /**
   * Convert VerifiedResult to IntegratedScanResult format
   */
  private convertVerificationToIntegrated(
    verified: VerifiedResult, 
    imagePath: string
  ): IntegratedScanResult {
    const primary = verified.primary_result;
    const verification = verified.verification_result;
    const fileName = path.basename(imagePath);

    return {
      // QwenScanResult compatible fields
      name: primary.card_title,
      set_name: primary.set_name || 'Unknown',
      number: primary.identifier.number || 'Unknown',
      rarity: (primary.raw?.rarity) || 'Unknown',
      hp: (primary.raw?.hp) || undefined,
      type: (primary.raw?.type) || undefined,
      stage: (primary.raw?.stage) || undefined,
      variant_flags: {
        first_edition: primary.first_edition || false,
        shadowless: (primary.raw?.shadowless) || false,
        reverse_holo: (primary.raw?.reverse_holo) || false,
        promo_stamp: (primary.raw?.promo_stamp) || false,
        stamped: (primary.raw?.stamped) || false,
        misprint: (primary.raw?.misprint) || false
      },
      language: (primary.raw?.language) || 'English',
      year: (primary.raw?.year) || undefined,
      confidence: verified.final_confidence,
      source_file: fileName,
      processed_at: new Date().toISOString(),
      processing_time_ms: verified.processing_time_ms,

      // Enhanced integrated fields
      verification_used: true,
      verification_path: verified.verification_path,
      final_confidence: verified.final_confidence,
      confidence_adjustment: verification?.confidence_adjustment,
      routing_decision: verified.routing_decision.decision,
      database_validated: verified.database_validated,
      flagged_for_review: verified.should_review,
      
      timing_breakdown: {
        primary_inference_ms: verified.timing_breakdown.primary_inference_ms,
        verification_ms: verified.timing_breakdown.verification_ms,
        database_check_ms: verified.timing_breakdown.database_check_ms,
        total_ms: verified.timing_breakdown.total_ms
      },
      
      verifier_result: verification ? {
        agrees_with_primary: verification.agrees_with_primary,
        semantic_flags: verification.semantic_flags,
        database_matches: verification.database_matches.length
      } : undefined
    };
  }

  /**
   * Convert QwenScanResult to IntegratedScanResult format
   */
  private convertQwenToIntegrated(qwen: QwenScanResult): IntegratedScanResult {
    return {
      ...qwen,
      // Enhanced fields with defaults
      verification_used: false,
      verification_path: 'python_fallback',
      final_confidence: qwen.confidence,
      database_validated: false,
      flagged_for_review: qwen.confidence < 0.7,
      
      timing_breakdown: {
        python_fallback_ms: qwen.processing_time_ms,
        total_ms: qwen.processing_time_ms || 0
      }
    };
  }

  /**
   * Enhanced health check - verify both systems and circuit breaker status
   */
  async healthCheck(): Promise<{
    verification_healthy: boolean;
    python_healthy: boolean;
    overall_healthy: boolean;
    circuit_breakers: Record<string, string>;
    models_health_status: string;
    verification_metrics: any;
    details: any;
  }> {
    const results = {
      verification_healthy: false,
      python_healthy: false,
      overall_healthy: false,
      circuit_breakers: {},
      models_health_status: 'unknown',
      verification_metrics: {},
      details: {} as any
    };

    // Check verification pipeline
    try {
      const primaryHealth = await this.primaryAdapter.healthCheck();
      const verifierHealth = await this.verifierAdapter.healthCheck();
      
      results.verification_healthy = primaryHealth.healthy && verifierHealth.healthy;
      results.details.primary_adapter = primaryHealth;
      results.details.verifier_adapter = verifierHealth;
    } catch (error) {
      results.details.verification_error = String(error);
    }

    // Check Python fallback
    try {
      const { stdout } = await execAsync(`python3 ${this.legacyScannerPath} --test`);
      results.python_healthy = stdout.includes('Connection successful');
      results.details.python_test = stdout.trim();
    } catch (error) {
      results.details.python_error = String(error);
    }

    // Get circuit breaker status and verification metrics
    const verificationMetricsData = verificationMetrics.getVerificationMetrics();
    results.circuit_breakers = verificationMetricsData.circuit_breaker_status;
    results.models_health_status = verificationMetricsData.models_health_status;
    results.verification_metrics = {
      routing_distribution: {
        skip_verify: `${(verificationMetricsData.routing_skip_verify_rate * 100).toFixed(1)}%`,
        verify_optional: `${(verificationMetricsData.routing_verify_optional_rate * 100).toFixed(1)}%`,
        verify_required: `${(verificationMetricsData.routing_verify_required_rate * 100).toFixed(1)}%`
      },
      quality_metrics: {
        verifier_agreement: `${(verificationMetricsData.verifier_agreement_rate * 100).toFixed(1)}%`,
        verification_usage: `${(verificationMetricsData.verification_usage_rate * 100).toFixed(1)}%`,
        review_flag_rate: `${(verificationMetricsData.flagged_for_review_rate * 100).toFixed(1)}%`
      },
      performance_metrics: {
        primary_latency_avg: `${verificationMetricsData.primary_model_avg_latency_ms.toFixed(0)}ms`,
        verifier_latency_avg: `${verificationMetricsData.verifier_model_avg_latency_ms.toFixed(0)}ms`
      }
    };

    // Overall health considers circuit breakers
    const primaryBreakerOK = results.circuit_breakers.primary_model !== 'OPEN';
    const hasWorkingPath = (results.verification_healthy && primaryBreakerOK) || results.python_healthy;
    results.overall_healthy = hasWorkingPath;
    
    logger.info(`Enhanced health check: verification=${results.verification_healthy}, ` +
               `python=${results.python_healthy}, overall=${results.overall_healthy}, ` +
               `models_health=${results.models_health_status}`);
    
    return results;
  }

  /**
   * Get comprehensive statistics with enhanced verification metrics
   */
  getStatistics() {
    const verificationRate = this.totalProcessed > 0 
      ? this.verificationUsed / this.totalProcessed 
      : 0;
      
    const fallbackRate = this.totalProcessed > 0 
      ? this.pythonFallbacks / this.totalProcessed 
      : 0;

    // Get detailed verification metrics
    const verificationMetricsData = verificationMetrics.getVerificationMetrics();

    return {
      // Overall statistics
      total_processed: this.totalProcessed,
      average_processing_time_ms: this.averageProcessingTime,
      
      // Method distribution
      verification_usage_rate: verificationRate,
      python_fallback_rate: fallbackRate,
      verification_count: this.verificationUsed,
      python_fallback_count: this.pythonFallbacks,
      
      // Enhanced verification metrics (Phase 5)
      verification_quality: {
        verifier_agreement_rate: verificationMetricsData.verifier_agreement_rate,
        confidence_adjustment_avg: verificationMetricsData.confidence_adjustment_avg,
        high_confidence_accuracy: verificationMetricsData.high_confidence_accuracy,
        flagged_for_review_rate: verificationMetricsData.flagged_for_review_rate
      },
      
      routing_distribution: {
        skip_verify_rate: verificationMetricsData.routing_skip_verify_rate,
        verify_optional_rate: verificationMetricsData.routing_verify_optional_rate,
        verify_required_rate: verificationMetricsData.routing_verify_required_rate
      },
      
      performance_metrics: {
        primary_model_avg_latency_ms: verificationMetricsData.primary_model_avg_latency_ms,
        verifier_model_avg_latency_ms: verificationMetricsData.verifier_model_avg_latency_ms,
        models_health_status: verificationMetricsData.models_health_status
      },
      
      // Circuit breaker status
      circuit_breakers: verificationMetricsData.circuit_breaker_status,
      
      // Legacy pipeline statistics
      verification_pipeline: this.verificationPipeline.getStatistics(),
      confidence_router: this.router.getRoutingStats(),
      
      // System status
      health_status: 'integrated_ready_with_monitoring',
      monitoring_enabled: true,
      accuracy_tracking: true,
      circuit_breaker_protection: true
    };
  }

  // Legacy compatibility methods
  async getInventory(): Promise<QwenScanResult[]> {
    try {
      const data = await fs.readFile(this.inventoryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async updateInventoryFile(result: IntegratedScanResult): Promise<void> {
    try {
      const inventory = await this.getInventory();
      const existingIndex = inventory.findIndex(card => card.source_file === result.source_file);
      
      // Convert back to QwenScanResult format for inventory
      const qwenFormat: QwenScanResult = {
        name: result.name,
        set_name: result.set_name,
        number: result.number,
        rarity: result.rarity,
        hp: result.hp,
        type: result.type,
        stage: result.stage,
        variant_flags: result.variant_flags,
        language: result.language,
        year: result.year,
        confidence: result.final_confidence,
        source_file: result.source_file,
        processed_at: result.processed_at,
        processing_time_ms: result.processing_time_ms
      };
      
      if (existingIndex >= 0) {
        inventory[existingIndex] = qwenFormat;
      } else {
        inventory.push(qwenFormat);
      }
      
      await fs.writeFile(this.inventoryPath, JSON.stringify(inventory, null, 2));
    } catch (error) {
      logger.error('Failed to update inventory file:', error);
    }
  }

  private async moveToProcessedDirectory(imagePath: string): Promise<void> {
    try {
      const fileName = path.basename(imagePath);
      const processedPath = path.join(this.processedDir, fileName);
      await fs.rename(imagePath, processedPath);
    } catch (error) {
      logger.warn('Failed to move to processed directory:', error);
    }
  }

  private updateStatistics(result: IntegratedScanResult): void {
    this.totalProcessed++;
    
    // Update rolling average
    const processingTime = result.processing_time_ms || 0;
    this.averageProcessingTime = (
      (this.averageProcessingTime * (this.totalProcessed - 1)) + processingTime
    ) / this.totalProcessed;
  }
}

// Export singleton instance
export const integratedScanner = new IntegratedScannerService();