/**
 * DistributedImageProcessor - Enhanced image processor with remote ML support
 * 
 * This processor extends the base ImageProcessor to support distributed
 * processing with the M4 Mac ML service while maintaining backward
 * compatibility with local OCR processing.
 */

import { createLogger } from '../utils/logger';
import { OCRData, CardMetadata } from '../types';
import { ImageProcessor, ProcessingResult, ProcessingOptions } from './ImageProcessor';
import { getRemoteMLClient, RemoteMLClient, RemoteMLRequest, RemoteMLResponse } from '../services/RemoteMLClient';
import { getDistributedConfig, ProcessingMode, getProcessingMode, shouldUseRemoteML } from '../config/distributed';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('distributed-image-processor');

export interface DistributedProcessingResult extends ProcessingResult {
  remoteMLResponse?: RemoteMLResponse;
  processingNode?: string;
  networkLatencyMs?: number;
  totalLatencyMs?: number;
  usedRemote?: boolean;
  shadowModeComparison?: {
    local: ProcessingResult;
    remote: ProcessingResult;
    speedup: number;
    agreementScore: number;
  };
}

export interface DistributedProcessingOptions extends ProcessingOptions {
  requestId?: string;
  priority?: 'low' | 'normal' | 'high';
  forceLocal?: boolean;
  forceRemote?: boolean;
  enableShadowMode?: boolean;
}

export class DistributedImageProcessor extends ImageProcessor {
  private remoteMLClient: RemoteMLClient;
  private distributedConfig = getDistributedConfig();
  private processingMode = getProcessingMode();
  
  constructor() {
    super();
    this.remoteMLClient = getRemoteMLClient();
    
    // Subscribe to remote ML health events
    this.remoteMLClient.on('health', (status) => {
      logger.info('Remote ML health status changed', status);
    });
    
    this.remoteMLClient.on('fallback', (event) => {
      logger.warn('Remote ML fallback triggered', event);
    });
    
    logger.info('Distributed Image Processor initialized', {
      mode: this.processingMode,
      remoteEnabled: this.distributedConfig.enabled,
      shadowMode: this.distributedConfig.monitoring.shadowMode,
    });
  }
  
  /**
   * Process image with distributed ML support
   */
  async process(options: DistributedProcessingOptions): Promise<DistributedProcessingResult> {
    const startTime = Date.now();
    const requestId = options.requestId || uuidv4();
    
    logger.debug(`Processing image for card ${options.cardId} with request ${requestId}`, {
      mode: this.processingMode,
      forceLocal: options.forceLocal,
      forceRemote: options.forceRemote,
    });
    
    try {
      // Check if we should use shadow mode
      const shadowMode = options.enableShadowMode ?? this.distributedConfig.monitoring.shadowMode;
      
      if (shadowMode && this.remoteMLClient.isAvailable()) {
        return await this.processShadowMode(options, requestId);
      }
      
      // Determine processing strategy
      const useRemote = this.shouldUseRemote(options, requestId);
      
      if (useRemote) {
        return await this.processWithRemote(options, requestId);
      } else {
        return await this.processWithLocal(options);
      }
      
    } catch (error) {
      logger.error(`Failed to process image for card ${options.cardId}:`, error);
      
      // If remote failed and fallback is enabled, try local
      if (this.distributedConfig.fallback.enabled && !options.forceRemote) {
        logger.warn('Falling back to local processing after remote failure');
        return await this.processWithLocal(options);
      }
      
      throw error;
    }
  }
  
  /**
   * Determine if remote ML should be used for this request
   */
  private shouldUseRemote(options: DistributedProcessingOptions, requestId: string): boolean {
    // Check force flags first
    if (options.forceLocal) return false;
    if (options.forceRemote) return true;
    
    // Check if remote is available
    if (!this.remoteMLClient.isAvailable()) {
      logger.debug('Remote ML not available, using local processing');
      return false;
    }
    
    // Use configuration logic
    return shouldUseRemoteML(requestId, this.distributedConfig);
  }
  
  /**
   * Process with remote ML service
   */
  private async processWithRemote(
    options: DistributedProcessingOptions,
    requestId: string
  ): Promise<DistributedProcessingResult> {
    const startTime = Date.now();
    
    logger.info(`Processing ${options.cardId} with remote ML (${requestId})`);
    
    try {
      // Prepare image path
      let imagePath: string;
      let imageBuffer: Buffer | undefined;
      
      if (Buffer.isBuffer(options.imageData)) {
        imageBuffer = options.imageData;
        imagePath = path.join('/tmp/cardmint', `remote_${options.cardId}_${Date.now()}.jpg`);
        await fs.writeFile(imagePath, imageBuffer);
      } else {
        imagePath = options.imageData;
        // Read the file for remote transfer if needed
        if (this.distributedConfig.transfer.method === 'http') {
          imageBuffer = await fs.readFile(imagePath);
        }
      }
      
      // Create remote ML request
      const remoteRequest: RemoteMLRequest = {
        id: requestId,
        imagePath,
        imageBuffer,
        metadata: {
          cardId: options.cardId,
          capturedAt: new Date().toISOString(),
        },
        priority: options.priority,
      };
      
      // Call remote ML service
      const remoteResponse = await this.remoteMLClient.recognizeCard(remoteRequest);
      
      if (!remoteResponse) {
        // Remote failed, fallback was triggered
        logger.warn('Remote ML returned null, using fallback');
        return await this.processWithLocal(options);
      }
      
      // Convert remote response to our format
      const result: DistributedProcessingResult = {
        mlPrediction: {
          card_id: remoteResponse.card_id,
          card_name: remoteResponse.card_name,
          set_name: remoteResponse.set_name,
          card_number: remoteResponse.card_number,
          rarity: remoteResponse.rarity,
          confidence: remoteResponse.confidence,
          ensemble_confidence: remoteResponse.ensemble_confidence,
          inference_time_ms: remoteResponse.inference_time_ms,
          active_models: remoteResponse.active_models,
          cached: remoteResponse.cached,
          timestamp: remoteResponse.timestamp,
        },
        metadata: {
          cardName: remoteResponse.card_name,
          cardSet: remoteResponse.set_name,
          cardNumber: remoteResponse.card_number,
          rarity: remoteResponse.rarity,
          condition: 'Near Mint',
          language: 'English',
        },
        recognitionMethod: 'ml',
        combinedConfidence: remoteResponse.ensemble_confidence,
        remoteMLResponse: remoteResponse,
        processingNode: remoteResponse.processingNode,
        networkLatencyMs: remoteResponse.networkLatencyMs,
        totalLatencyMs: Date.now() - startTime,
        usedRemote: true,
      };
      
      // Clean up temp file if we created one
      if (Buffer.isBuffer(options.imageData)) {
        await fs.unlink(imagePath).catch(() => {});
      }
      
      logger.info(`Remote ML processing successful for ${options.cardId}`, {
        card: result.metadata?.cardName,
        confidence: result.combinedConfidence,
        latency: result.totalLatencyMs,
        node: result.processingNode,
      });
      
      return result;
      
    } catch (error) {
      logger.error('Remote ML processing failed', error);
      
      // Check if we should fallback
      if (this.distributedConfig.fallback.enabled && !options.forceRemote) {
        logger.warn('Falling back to local processing');
        return await this.processWithLocal(options);
      }
      
      throw error;
    }
  }
  
  /**
   * Process with local OCR/ML
   */
  private async processWithLocal(
    options: DistributedProcessingOptions
  ): Promise<DistributedProcessingResult> {
    logger.info(`Processing ${options.cardId} with local OCR/ML`);
    
    // Use parent class processing
    const localResult = await super.process(options);
    
    // Enhance with distributed metadata
    const result: DistributedProcessingResult = {
      ...localResult,
      usedRemote: false,
      processingNode: 'local',
    };
    
    return result;
  }
  
  /**
   * Process in shadow mode (both local and remote)
   */
  private async processShadowMode(
    options: DistributedProcessingOptions,
    requestId: string
  ): Promise<DistributedProcessingResult> {
    logger.info(`Processing ${options.cardId} in SHADOW MODE`);
    
    const startTime = Date.now();
    
    // Run both in parallel
    const [localResult, remoteResult] = await Promise.allSettled([
      this.processWithLocal(options),
      this.processWithRemote(options, requestId),
    ]);
    
    // Extract results
    const local = localResult.status === 'fulfilled' ? localResult.value : null;
    const remote = remoteResult.status === 'fulfilled' ? remoteResult.value : null;
    
    // Calculate comparison metrics
    let speedup = 0;
    let agreementScore = 0;
    
    if (local && remote) {
      speedup = (local.totalLatencyMs || 1) / (remote.totalLatencyMs || 1);
      agreementScore = this.calculateAgreement(local, remote);
      
      // Log comparison
      if (this.distributedConfig.monitoring.logComparisons) {
        logger.info('Shadow mode comparison', {
          cardId: options.cardId,
          local: {
            method: local.recognitionMethod,
            confidence: local.combinedConfidence,
            latency: local.totalLatencyMs,
            card: local.metadata?.cardName,
          },
          remote: {
            method: remote.recognitionMethod,
            confidence: remote.combinedConfidence,
            latency: remote.totalLatencyMs,
            card: remote.metadata?.cardName,
          },
          speedup: speedup.toFixed(2),
          agreement: `${(agreementScore * 100).toFixed(1)}%`,
        });
      }
    }
    
    // Decide which result to use
    let primaryResult: DistributedProcessingResult;
    
    if (!remote || remoteResult.status === 'rejected') {
      // Remote failed, use local
      primaryResult = local || this.createErrorResult(options.cardId);
      logger.warn('Shadow mode: Remote failed, using local result');
    } else if (!local || localResult.status === 'rejected') {
      // Local failed, use remote
      primaryResult = remote;
      logger.warn('Shadow mode: Local failed, using remote result');
    } else {
      // Both succeeded, use the one with higher confidence
      const remoteConfidence = remote.combinedConfidence || 0;
      const localConfidence = local.combinedConfidence || 0;
      
      if (remoteConfidence >= localConfidence) {
        primaryResult = remote;
        logger.debug('Shadow mode: Using remote result (higher confidence)');
      } else {
        primaryResult = local;
        logger.debug('Shadow mode: Using local result (higher confidence)');
      }
    }
    
    // Add shadow mode comparison data
    if (local && remote) {
      primaryResult.shadowModeComparison = {
        local,
        remote,
        speedup,
        agreementScore,
      };
    }
    
    primaryResult.totalLatencyMs = Date.now() - startTime;
    
    return primaryResult;
  }
  
  /**
   * Calculate agreement between local and remote results
   */
  private calculateAgreement(
    local: DistributedProcessingResult,
    remote: DistributedProcessingResult
  ): number {
    let score = 0;
    let factors = 0;
    
    // Check card name agreement
    if (local.metadata?.cardName && remote.metadata?.cardName) {
      if (local.metadata.cardName.toLowerCase() === remote.metadata.cardName.toLowerCase()) {
        score += 1;
      }
      factors += 1;
    }
    
    // Check set agreement
    if (local.metadata?.cardSet && remote.metadata?.cardSet) {
      if (local.metadata.cardSet.toLowerCase() === remote.metadata.cardSet.toLowerCase()) {
        score += 0.5;
      }
      factors += 0.5;
    }
    
    // Check card number agreement
    if (local.metadata?.cardNumber && remote.metadata?.cardNumber) {
      if (local.metadata.cardNumber === remote.metadata.cardNumber) {
        score += 0.5;
      }
      factors += 0.5;
    }
    
    // Check confidence similarity (within 10%)
    const localConf = local.combinedConfidence || 0;
    const remoteConf = remote.combinedConfidence || 0;
    if (Math.abs(localConf - remoteConf) < 0.1) {
      score += 0.5;
    }
    factors += 0.5;
    
    return factors > 0 ? score / factors : 0;
  }
  
  /**
   * Create an error result
   */
  private createErrorResult(cardId: string): DistributedProcessingResult {
    return {
      metadata: {
        cardName: 'Processing Failed',
        cardSet: 'Unknown',
        cardNumber: '000',
        rarity: 'Unknown',
        condition: 'Unknown',
        language: 'Unknown',
      },
      recognitionMethod: 'ocr',
      combinedConfidence: 0,
      usedRemote: false,
      processingNode: 'error',
    };
  }
  
  /**
   * Get metrics from remote ML client
   */
  public getRemoteMetrics() {
    return this.remoteMLClient.getMetrics();
  }
  
  /**
   * Shutdown the processor
   */
  public async shutdown() {
    logger.info('Shutting down Distributed Image Processor');
    await this.remoteMLClient.shutdown();
  }
}

// Export singleton instance
let distributedProcessor: DistributedImageProcessor | null = null;

export function getDistributedProcessor(): DistributedImageProcessor {
  if (!distributedProcessor) {
    distributedProcessor = new DistributedImageProcessor();
  }
  return distributedProcessor;
}