/**
 * Distributed Processing Configuration for M4 Mac Integration
 * 
 * This module manages the configuration for distributed ML processing
 * between the Fedora workstation (capture) and M4 MacBook Pro (ML inference)
 */

export interface DistributedConfig {
  enabled: boolean;
  remote: {
    host: string;
    port: number;
    protocol: 'http' | 'https';
    apiKey?: string;
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
  };
  transfer: {
    method: 'http' | 'filesystem' | 'hybrid';
    compression: boolean;
    maxConcurrent: number;
    batchSize: number;
  };
  fallback: {
    enabled: boolean;
    threshold: number; // Confidence threshold to trigger fallback
    maxLatency: number; // Max latency before fallback (ms)
  };
  monitoring: {
    shadowMode: boolean;
    logComparisons: boolean;
    metricsEnabled: boolean;
  };
  cache: {
    enabled: boolean;
    ttl: number; // Time to live in seconds
    maxSize: number; // Max cache size in MB
  };
}

/**
 * Get distributed processing configuration from environment
 */
export function getDistributedConfig(): DistributedConfig {
  return {
    enabled: process.env.REMOTE_ML_ENABLED === 'true',
    
    remote: {
      host: process.env.REMOTE_ML_HOST || 'localhost',
      port: parseInt(process.env.REMOTE_ML_PORT || '5000', 10),
      protocol: (process.env.REMOTE_ML_PROTOCOL || 'http') as 'http' | 'https',
      apiKey: process.env.REMOTE_ML_API_KEY,
      timeout: parseInt(process.env.REMOTE_ML_TIMEOUT || '10000', 10),
      retryAttempts: parseInt(process.env.REMOTE_ML_RETRY_ATTEMPTS || '3', 10),
      retryDelay: parseInt(process.env.REMOTE_ML_RETRY_DELAY || '1000', 10),
    },
    
    transfer: {
      method: (process.env.IMAGE_TRANSFER_METHOD || 'http') as any,
      compression: process.env.NETWORK_COMPRESSION === 'true',
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_ML_REQUESTS || '5', 10),
      batchSize: parseInt(process.env.ML_BATCH_SIZE || '10', 10),
    },
    
    fallback: {
      enabled: process.env.ML_FALLBACK_ENABLED !== 'false',
      threshold: parseFloat(process.env.ML_FALLBACK_THRESHOLD || '0.85'),
      maxLatency: parseInt(process.env.ML_MAX_LATENCY || '10000', 10),
    },
    
    monitoring: {
      shadowMode: process.env.ML_SHADOW_MODE === 'true',
      logComparisons: process.env.ML_LOG_COMPARISONS === 'true',
      metricsEnabled: process.env.ML_METRICS_ENABLED !== 'false',
    },
    
    cache: {
      enabled: process.env.ML_CACHE_ENABLED !== 'false',
      ttl: parseInt(process.env.ML_CACHE_TTL || '300', 10),
      maxSize: parseInt(process.env.LOCAL_CACHE_SIZE_MB || '500', 10),
    },
  };
}

/**
 * Processing mode determines how the system operates
 */
export enum ProcessingMode {
  LOCAL = 'local',        // Use only local OCR processing
  DISTRIBUTED = 'distributed', // Use only remote ML processing
  HYBRID = 'hybrid',      // Use both with intelligent routing
}

/**
 * Get the current processing mode
 */
export function getProcessingMode(): ProcessingMode {
  const mode = process.env.PROCESSING_MODE?.toLowerCase();
  
  if (mode === 'distributed') return ProcessingMode.DISTRIBUTED;
  if (mode === 'hybrid') return ProcessingMode.HYBRID;
  return ProcessingMode.LOCAL;
}

/**
 * Check if remote ML should be used for a specific request
 */
export function shouldUseRemoteML(
  requestId: string,
  config: DistributedConfig = getDistributedConfig()
): boolean {
  // Check if distributed processing is enabled
  if (!config.enabled) {
    return false;
  }
  
  const mode = getProcessingMode();
  
  // In local mode, never use remote
  if (mode === ProcessingMode.LOCAL) {
    return false;
  }
  
  // In distributed mode, always use remote (with fallback)
  if (mode === ProcessingMode.DISTRIBUTED) {
    return true;
  }
  
  // In hybrid mode, use intelligent routing
  // For now, use a simple hash-based distribution
  // This can be enhanced with more sophisticated routing logic
  const hash = requestId.split('').reduce((acc, char) => {
    return acc + char.charCodeAt(0);
  }, 0);
  
  // Route 70% of traffic to remote ML in hybrid mode
  const threshold = hash % 100;
  return threshold < 70;
}

/**
 * Log distributed configuration for monitoring
 */
export function logDistributedConfig(): void {
  const config = getDistributedConfig();
  const mode = getProcessingMode();
  
  console.log('[Distributed Configuration]', {
    mode,
    enabled: config.enabled,
    remote: {
      endpoint: `${config.remote.protocol}://${config.remote.host}:${config.remote.port}`,
      timeout: `${config.remote.timeout}ms`,
      retry: `${config.remote.retryAttempts} attempts`,
    },
    transfer: {
      method: config.transfer.method,
      compression: config.transfer.compression,
      concurrent: config.transfer.maxConcurrent,
    },
    fallback: config.fallback,
    monitoring: config.monitoring,
    cache: {
      enabled: config.cache.enabled,
      ttl: `${config.cache.ttl}s`,
      size: `${config.cache.maxSize}MB`,
    },
  });
}

// Export for testing
export const _testing = {
  getDistributedConfig,
  getProcessingMode,
  shouldUseRemoteML,
};