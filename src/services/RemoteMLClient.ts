/**
 * RemoteMLClient - Enhanced client for distributed ML processing on M4 Mac
 * 
 * This client handles communication with the remote ML service running on
 * the M4 MacBook Pro, including retry logic, fallback mechanisms, and
 * performance monitoring.
 */

import { createLogger } from '../utils/logger';
import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { createHash } from 'crypto';
import { getDistributedConfig, DistributedConfig, ProcessingMode, getProcessingMode } from '../config/distributed';
import { MLPrediction, MLServiceStatus, MLServiceHealth } from '../ml/MLServiceClient';
import { EventEmitter } from 'events';
import { qwenScanner } from './QwenScannerService';

const logger = createLogger('remote-ml-client');

export enum FallbackMode {
  DEFER = 'defer',  // Queue for later processing (default)
  OCR = 'ocr',      // Fall back to local OCR (legacy, slow)
  NONE = 'none'     // Fail immediately
}

export interface RemoteMLRequest {
  id: string;
  imagePath: string;
  imageBuffer?: Buffer;
  idempotencyKey?: string;  // Content-based hash for deduplication
  metadata?: Record<string, any>;
  priority?: 'low' | 'normal' | 'high';
}

export interface RemoteMLResponse extends MLPrediction {
  processingNode: string;
  networkLatencyMs: number;
  totalLatencyMs: number;
  cached?: boolean;
  idempotencyKey?: string;
}

export interface DeferredResult {
  status: 'deferred';
  requestId: string;
  reason: string;
  retryAfter?: number;
  deferredAt: Date;
}

export interface RemoteMLMetrics {
  requestsTotal: number;
  requestsSuccessful: number;
  requestsFailed: number;
  requestsDeferred: number;
  requests429: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  lastError?: string;
  lastErrorTime?: Date;
  last429Time?: Date;
}

export interface BatchProcessingResult {
  results: RemoteMLResponse[];
  failures: Array<{ id: string; error: string }>;
  totalTimeMs: number;
  averageTimeMs: number;
}

export class RemoteMLClient extends EventEmitter {
  private readonly client: AxiosInstance;
  private readonly config: DistributedConfig;
  private readonly fallbackMode: FallbackMode;
  private isHealthy: boolean = false;
  private lastHealthCheck: number = 0;
  private readonly healthCheckInterval: number = 30000; // 30 seconds
  private metrics: RemoteMLMetrics;
  private latencyHistory: number[] = [];
  private readonly maxLatencyHistory: number = 1000;
  private consecutiveFailures: number = 0;
  private readonly maxConsecutiveFailures: number = 3;
  private circuitBreakerOpen: boolean = false;
  private circuitBreakerOpenUntil: number = 0;

  constructor(config?: DistributedConfig) {
    super();
    
    this.config = config || getDistributedConfig();
    this.fallbackMode = (process.env.ML_FALLBACK_MODE as FallbackMode) || FallbackMode.DEFER;
    this.metrics = this.initializeMetrics();
    
    // Create axios instance with optimized settings
    this.client = axios.create({
      baseURL: `${this.config.remote.protocol}://${this.config.remote.host}:${this.config.remote.port}`,
      timeout: 7000, // 7 second timeout as recommended
      headers: {
        'Accept': 'application/json',
        ...(this.config.remote.apiKey && { 'X-API-Key': this.config.remote.apiKey }),
      },
      // Connection pooling for better performance
      httpAgent: new http.Agent({ 
        keepAlive: true,
        maxSockets: 1, // Single connection to avoid overwhelming Mac
        keepAliveMsecs: 3000,
      }),
      httpsAgent: new https.Agent({ 
        keepAlive: true,
        maxSockets: 1,
        keepAliveMsecs: 3000,
      }),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    logger.info('Remote ML Client initialized', {
      endpoint: `${this.config.remote.protocol}://${this.config.remote.host}:${this.config.remote.port}`,
      mode: getProcessingMode(),
      fallbackMode: this.fallbackMode,
      timeout: '7s',
    });

    // Start health check loop
    this.startHealthCheckLoop();
  }

  private initializeMetrics(): RemoteMLMetrics {
    return {
      requestsTotal: 0,
      requestsSuccessful: 0,
      requestsFailed: 0,
      requestsDeferred: 0,
      requests429: 0,
      averageLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
    };
  }

  private async startHealthCheckLoop(): Promise<void> {
    // Initial health check
    await this.checkHealth();
    
    // Periodic health checks
    setInterval(async () => {
      await this.checkHealth();
    }, this.healthCheckInterval);
  }

  /**
   * Check if the remote ML service is healthy
   */
  public async checkHealth(force: boolean = false): Promise<boolean> {
    const now = Date.now();
    
    // Check circuit breaker first
    if (this.circuitBreakerOpen && now < this.circuitBreakerOpenUntil) {
      logger.debug('Circuit breaker is open, skipping health check');
      return false;
    }
    
    // Use cached health status unless forced or expired
    if (!force && this.lastHealthCheck && (now - this.lastHealthCheck) < this.healthCheckInterval) {
      return this.isHealthy;
    }

    try {
      const response = await this.client.get<MLServiceHealth>('/status', {
        timeout: 5000, // Shorter timeout for health checks
      });
      
      const health = response.data;
      this.isHealthy = health.status === 'healthy' && health.ensemble_ready;
      this.lastHealthCheck = now;
      
      if (this.isHealthy) {
        logger.debug('Remote ML service is healthy', {
          models: health.models_loaded,
          uptime: health.uptime_seconds,
        });
        this.emit('health', { healthy: true, details: health });
      } else {
        logger.warn('Remote ML service is unhealthy', health);
        this.emit('health', { healthy: false, details: health });
      }
    } catch (error) {
      this.isHealthy = false;
      this.lastHealthCheck = now;
      
      if (axios.isAxiosError(error)) {
        logger.error('Remote ML health check failed', {
          status: error.response?.status,
          message: error.message,
        });
      }
      
      this.emit('health', { healthy: false, error });
    }

    return this.isHealthy;
  }

  /**
   * Process a single card image with the remote ML service
   */
  public async recognizeCard(request: RemoteMLRequest): Promise<RemoteMLResponse | null> {
    const startTime = Date.now();
    this.metrics.requestsTotal++;

    // Use Qwen scanner if configured
    if (this.config.useQwenScanner) {
      return this.recognizeWithQwen(request);
    }

    try {
      // Check health first (unless in shadow mode where we don't want to block)
      if (!this.config.monitoring.shadowMode && !await this.checkHealth()) {
        throw new Error('Remote ML service is not healthy');
      }

      // Prepare the request
      const formData = await this.prepareFormData(request);
      
      // Make the request with retry logic
      const response = await this.requestWithRetry(
        () => this.client.post<MLPrediction>('/identify', formData, {
          headers: formData.getHeaders(),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }),
        request.id
      );

      const networkLatency = Date.now() - startTime;
      this.recordLatency(networkLatency);
      
      const result: RemoteMLResponse = {
        ...response.data,
        processingNode: `${this.config.remote.host}:${this.config.remote.port}`,
        networkLatencyMs: networkLatency,
        totalLatencyMs: networkLatency + (response.data.inference_time_ms || 0),
      };

      this.metrics.requestsSuccessful++;
      
      logger.info('Remote ML recognition successful', {
        id: request.id,
        card: result.card_name,
        confidence: result.confidence,
        latency: `${result.totalLatencyMs}ms`,
      });

      this.emit('recognition', result);
      return result;

    } catch (error) {
      this.metrics.requestsFailed++;
      this.handleError(error, request.id);
      
      // Check if we should fallback
      if (this.config.fallback.enabled) {
        logger.warn(`Falling back to local processing for ${request.id}`);
        this.metrics.requestsFallback++;
        this.emit('fallback', { requestId: request.id, error });
        return null; // Indicates fallback should be used
      }
      
      throw error;
    }
  }

  /**
   * Process multiple cards in a batch
   */
  public async processBatch(requests: RemoteMLRequest[]): Promise<BatchProcessingResult> {
    const startTime = Date.now();
    const results: RemoteMLResponse[] = [];
    const failures: Array<{ id: string; error: string }> = [];

    logger.info(`Processing batch of ${requests.length} cards`);

    // Process in chunks to avoid overwhelming the remote service
    const chunkSize = this.config.transfer.batchSize;
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize);
      
      // Process chunk in parallel
      const chunkPromises = chunk.map(async (request) => {
        try {
          const result = await this.recognizeCard(request);
          if (result) {
            results.push(result);
          } else {
            failures.push({ id: request.id, error: 'Fallback triggered' });
          }
        } catch (error) {
          failures.push({
            id: request.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      await Promise.all(chunkPromises);
      
      // Small delay between chunks to avoid overwhelming the service
      if (i + chunkSize < requests.length) {
        await this.sleep(100);
      }
    }

    const totalTime = Date.now() - startTime;
    
    const batchResult: BatchProcessingResult = {
      results,
      failures,
      totalTimeMs: totalTime,
      averageTimeMs: totalTime / requests.length,
    };

    logger.info('Batch processing complete', {
      total: requests.length,
      successful: results.length,
      failed: failures.length,
      totalTime: `${totalTime}ms`,
      averageTime: `${batchResult.averageTimeMs.toFixed(2)}ms`,
    });

    this.emit('batch', batchResult);
    return batchResult;
  }

  /**
   * Prepare form data for the request
   */
  private async prepareFormData(request: RemoteMLRequest): Promise<FormData> {
    const formData = new FormData();
    
    // Add image data
    if (request.imageBuffer) {
      formData.append('image', request.imageBuffer, {
        filename: path.basename(request.imagePath),
        contentType: 'image/jpeg',
      });
    } else {
      const imageBuffer = await fs.readFile(request.imagePath);
      formData.append('image', imageBuffer, {
        filename: path.basename(request.imagePath),
        contentType: 'image/jpeg',
      });
    }

    // Add metadata if provided
    if (request.metadata) {
      formData.append('metadata', JSON.stringify(request.metadata));
    }

    // Add priority if specified
    if (request.priority) {
      formData.append('priority', request.priority);
    }

    // Add request ID for tracking
    formData.append('request_id', request.id);

    return formData;
  }

  /**
   * Recognize a card using the Qwen2.5-VL scanner
   */
  private async recognizeWithQwen(request: RemoteMLRequest): Promise<RemoteMLResponse | null> {
    const startTime = Date.now();
    
    try {
      // Check if Qwen scanner is available
      const isAvailable = await qwenScanner.isAvailable();
      if (!isAvailable) {
        logger.error('Qwen scanner is not available');
        this.metrics.requestsFailed++;
        return null;
      }

      // Process the card
      const result = await qwenScanner.processCard(request.imagePath);
      
      if (!result) {
        logger.error('Qwen scanner returned no result');
        this.metrics.requestsFailed++;
        return null;
      }

      const totalLatency = Date.now() - startTime;
      
      // Convert Qwen result to RemoteMLResponse format
      const response: RemoteMLResponse = {
        card_name: result.name,
        set_name: result.set_name,
        card_number: result.number,
        rarity: result.rarity,
        confidence: result.confidence / 100, // Convert percentage to decimal
        inference_time_ms: result.processing_time_ms || totalLatency,
        metadata: {
          hp: result.hp,
          type: result.type,
          stage: result.stage,
          variants: result.variant_flags,
          language: result.language,
          year: result.year,
        },
        processingNode: 'qwen-scanner@10.0.24.174:1234',
        networkLatencyMs: 0, // Local processing
        totalLatencyMs: totalLatency,
        idempotencyKey: request.idempotencyKey,
      };

      this.metrics.requestsSuccessful++;
      this.recordLatency(totalLatency);
      
      logger.info('Qwen scanner recognition successful', {
        id: request.id,
        card: response.card_name,
        confidence: response.confidence,
        latency: totalLatency,
      });

      return response;
      
    } catch (error) {
      logger.error('Qwen scanner recognition failed:', error);
      this.metrics.requestsFailed++;
      return null;
    }
  }

  /**
   * Make a request with retry logic
   */
  private async requestWithRetry<T>(
    requestFn: () => Promise<{ data: T }>,
    requestId: string
  ): Promise<{ data: T }> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < this.config.remote.retryAttempts; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on client errors (4xx)
        if (axios.isAxiosError(error) && error.response?.status && error.response.status >= 400 && error.response.status < 500) {
          throw error;
        }
        
        // Log retry attempt
        logger.warn(`Request ${requestId} failed, attempt ${attempt + 1}/${this.config.remote.retryAttempts}`, {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        
        // Wait before retrying (exponential backoff)
        if (attempt < this.config.remote.retryAttempts - 1) {
          const delay = Math.min(
            this.config.remote.retryDelay * Math.pow(2, attempt),
            10000 // Max 10 seconds
          );
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError || new Error('All retry attempts failed');
  }

  /**
   * Record latency for metrics
   */
  private recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs);
    
    // Keep history size limited
    if (this.latencyHistory.length > this.maxLatencyHistory) {
      this.latencyHistory.shift();
    }
    
    // Update metrics
    this.updateLatencyMetrics();
  }

  /**
   * Update latency metrics
   */
  private updateLatencyMetrics(): void {
    if (this.latencyHistory.length === 0) return;
    
    const sorted = [...this.latencyHistory].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    
    this.metrics.averageLatencyMs = sum / sorted.length;
    this.metrics.p95LatencyMs = sorted[Math.floor(sorted.length * 0.95)] || 0;
    this.metrics.p99LatencyMs = sorted[Math.floor(sorted.length * 0.99)] || 0;
  }

  /**
   * Handle errors and update metrics
   */
  private handleError(error: any, requestId: string): void {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    this.metrics.lastError = errorMessage;
    this.metrics.lastErrorTime = new Date();
    
    logger.error(`Remote ML request ${requestId} failed`, {
      error: errorMessage,
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    
    this.emit('error', { requestId, error });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current metrics
   */
  public getMetrics(): RemoteMLMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = this.initializeMetrics();
    this.latencyHistory = [];
  }

  /**
   * Check if remote ML is available
   */
  public isAvailable(): boolean {
    return this.config.enabled && this.isHealthy;
  }

  /**
   * Shutdown the client
   */
  public async shutdown(): Promise<void> {
    logger.info('Shutting down Remote ML Client');
    this.removeAllListeners();
  }
}

// Singleton instance
let remoteMLClient: RemoteMLClient | null = null;

/**
 * Get or create the Remote ML Client instance
 */
export function getRemoteMLClient(): RemoteMLClient {
  if (!remoteMLClient) {
    remoteMLClient = new RemoteMLClient();
  }
  return remoteMLClient;
}

// Export for testing
export const _testing = {
  RemoteMLClient,
  getRemoteMLClient,
};