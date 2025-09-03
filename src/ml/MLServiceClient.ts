/* TODO: Review and add specific port type imports from @core/* */
/**
 * MLServiceClient - TypeScript client for the Python ML Ensemble Service
 * Bridges the CardMint system with the advanced card recognition ensemble
 * Provides graceful fallback to OCR-only mode if ML service is unavailable
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { createLogger } from '../utils/logger';
import { ports } from '../app/wiring';

const logger = createLogger('ml-service-client');

export interface MLPrediction {
  card_id: string;
  card_name: string;
  set_name: string;
  card_number: string;
  rarity: string;
  confidence: number;
  ensemble_confidence: number;
  inference_time_ms: number;
  active_models: string[];
  cached: boolean;
  timestamp: string;
}

export interface MLServiceStatus {
  active_models: string[];
  available_models: string[];
  resource_usage: {
    ram_mb: number;
    ram_limit_mb: number;
    cpu_percent: number;
    device: string;
    device_type: string;
    has_ipex: boolean;
  };
  can_enable_heavy_models: boolean;
}

export interface MLServiceHealth {
  status: string;
  ensemble_ready: boolean;
  redis_connected: boolean;
  models_loaded: string[];
  uptime_seconds: number;
}

export class MLServiceClient {
  private readonly client: AxiosInstance;
  private isHealthy: boolean = false;
  private lastHealthCheck: number = 0;
  private readonly healthCheckInterval: number = 30000; // 30 seconds
  private readonly timeout: number = 5000; // 5 second timeout
  private readonly retryAttempts: number = 3;
  private readonly retryDelay: number = 1000; // 1 second

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json',
      },
    });
    logger.info('ML Service Client initialized', { baseUrl });
    this.checkHealth();
  }

  /**
   * Check if the ML service is healthy and available
   */
  async checkHealth(): Promise<boolean> {
    const now = Date.now();
    
    // Cache health status for 30 seconds
    if (this.lastHealthCheck && (now - this.lastHealthCheck) < this.healthCheckInterval) {
      return this.isHealthy;
    }

    try {
      const response = await this.client.get<MLServiceHealth>('/');
      const health = response.data;
      this.isHealthy = health.ensemble_ready;
      this.lastHealthCheck = now;
      
      if (this.isHealthy) {
        logger.debug('ML service is healthy', { 
          models: health.models_loaded,
          uptime: health.uptime_seconds 
        });
      }
    } catch (error) {
      this.isHealthy = false;
      if (axios.isAxiosError(error)) {
        logger.warn('ML service health check failed', { 
          status: error.response?.status,
          message: error.message 
        });
      } else {
        logger.error('ML service unreachable', error);
      }
    }

    return this.isHealthy;
  }

  /**
   * Recognize a card using the ML ensemble
   * @param imagePath Path to the card image file
   * @param enableCache Whether to use cached predictions
   * @returns ML prediction result or null if service unavailable
   */
  async recognizeCard(
    imagePath: string, 
    enableCache: boolean = true
  ): Promise<MLPrediction | null> {
    // Check service health first
    if (!(await this.checkHealth())) {
      logger.warn('ML service not available, falling back to OCR');
      return null;
    }

    let lastError: Error | null = null;

    // Retry logic for resilience
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        // Read the image file
        const imageBuffer = await fs.readFile(imagePath);
        
        // Create form data for multipart upload
        const formData = new FormData();
        formData.append('file', imageBuffer, {
          filename: path.basename(imagePath),
          contentType: 'image/jpeg',
        });

        // Call the ML ensemble API
        const response = await this.client.post<MLPrediction>(
          `/api/recognize/lightweight?enable_cache=${enableCache}`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
            },
          }
        );

        const prediction = response.data;
        
        logger.info('ML recognition successful', {
          card: prediction.card_name,
          confidence: prediction.ensemble_confidence,
          time: prediction.inference_time_ms,
          cached: prediction.cached,
        });

        return prediction;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          lastError = new Error(`ML service returned ${error.response?.status || 'error'}`);
          logger.warn(`ML recognition attempt ${attempt} failed`, { 
            status: error.response?.status,
            message: error.message
          });
        } else {
          lastError = error as Error;
          logger.error(`ML recognition attempt ${attempt} error`, error);
        }
      }

      // Wait before retry
      if (attempt < this.retryAttempts) {
        await this.delay(this.retryDelay * attempt);
      }
    }

    // All retries failed
    logger.error('ML recognition failed after all retries', lastError);
    this.isHealthy = false; // Mark service as unhealthy
    return null;
  }

  /**
   * Recognize a card from image buffer
   * @param imageBuffer Image data as Buffer
   * @param filename Optional filename for the image
   * @param enableCache Whether to use cached predictions
   * @returns ML prediction result or null if service unavailable
   */
  async recognizeCardFromBuffer(
    imageBuffer: Buffer,
    filename: string = 'card.jpg',
    enableCache: boolean = true
  ): Promise<MLPrediction | null> {
    // Check service health first
    if (!(await this.checkHealth())) {
      logger.warn('ML service not available, falling back to OCR');
      return null;
    }

    try {
      // Create form data for multipart upload
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: filename,
        contentType: 'image/jpeg',
      });

      // Call the ML ensemble API
      const response = await this.client.post<MLPrediction>(
        `/api/recognize/lightweight?enable_cache=${enableCache}`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        }
      );

      const prediction = response.data;
      
      logger.info('ML buffer recognition successful', {
        card: prediction.card_name,
        confidence: prediction.ensemble_confidence,
        time: prediction.inference_time_ms,
      });

      return prediction;
    } catch (error) {
      logger.error('ML buffer recognition error', error);
      return null;
    }
  }

  /**
   * Get current status of ML models
   */
  async getModelStatus(): Promise<MLServiceStatus | null> {
    try {
      const response = await this.client.get<MLServiceStatus>('/api/models/status');
      const status = response.data;
      logger.debug('ML model status retrieved', status);
      return status;
    } catch (error) {
      logger.error('Failed to get model status', error);
      return null;
    }
  }

  /**
   * Enable heavy models if resources allow
   * @param modelType The model to enable (triplet_resnet or vit)
   */
  async enableModel(modelType: 'triplet_resnet' | 'vit'): Promise<boolean> {
    try {
      await this.client.post(`/api/models/enable/${modelType}`);
      logger.info(`Enabled model: ${modelType}`);
      return true;
    } catch (error) {
      logger.error(`Failed to enable model ${modelType}`, error);
      return false;
    }
  }

  /**
   * Clear the ML cache
   */
  async clearCache(): Promise<boolean> {
    try {
      const response = await this.client.delete<{success: boolean; cleared: number}>('/api/cache/clear');
      logger.info('ML cache cleared', { cleared: response.data.cleared });
      return true;
    } catch (error) {
      logger.error('Failed to clear ML cache', error);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<any> {
    try {
      const response = await this.client.get('/api/cache/stats');
      return response.data;
    } catch (error) {
      logger.error('Failed to get cache stats', error);
      return null;
    }
  }

  /**
   * Helper method to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Force a health check on next request
   */
  resetHealth(): void {
    this.lastHealthCheck = 0;
    this.isHealthy = false;
  }

  /**
   * Check if service is currently marked as healthy
   */
  isServiceHealthy(): boolean {
    return this.isHealthy;
  }
}

// Export singleton instance for convenience
// (Codex-CTO) Adapter wrapper to bridge existing call sites to LMStudio inference
export const mlServiceClient = {
  async recognizeCard(imagePath: string, _enableCache: boolean = true): Promise<MLPrediction | null> {
    try {
      const inf = await ports.infer.classify(imagePath, { timeout: 30000 });
      const status = await ports.infer.getStatus().catch(() => ({ model_name: 'unknown' } as any));
      const mapped: MLPrediction = {
        card_id: '',
        card_name: inf.card_title || '',
        set_name: inf.set_name || '',
        card_number: inf.identifier?.number || '',
        rarity: '',
        confidence: inf.confidence,
        ensemble_confidence: inf.confidence,
        inference_time_ms: inf.inference_time_ms,
        active_models: status?.model_name ? [status.model_name] : [],
        cached: false,
        timestamp: new Date().toISOString(),
      };
      logger.info('LM adapter recognizeCard mapped result', { card: mapped.card_name, conf: mapped.ensemble_confidence });
      return mapped;
    } catch (error) {
      logger.error('LM adapter recognizeCard failed', error);
      return null;
    }
  },
};

// Also export for testing and custom configurations
export default MLServiceClient;
