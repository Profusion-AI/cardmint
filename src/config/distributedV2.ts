/**
 * Enhanced Distributed Processing Configuration v2.0
 * 
 * Builds on existing distributed.ts with full Fedora ⇄ Mac ⇄ Fedora orchestration
 * Supports confidence-based routing, tool-calling verification, and SQLite storage
 */

import { DistributedRouterConfig, ConfidencePolicy } from '../services/DistributedRouter';
import { CardStorageConfig } from '../storage/DistributedCardStorage';
import { getDistributedConfig as getV1Config } from './distributed';

// Enhanced confidence policy tuned for CardMint production
const productionConfidencePolicy: ConfidencePolicy = {
  common: { 
    accept_threshold: 90,     // Accept 90%+ confidence  
    verify_threshold: 80      // Verify 80-89%
  },
  rare: { 
    accept_threshold: 92,     // Higher threshold for rare cards
    verify_threshold: 85
  },
  holo: { 
    always_verify: true,      // Always verify holographic cards
    accept_threshold: 95
  },
  vintage: { 
    always_verify: true,      // Always verify vintage cards (high value)
    accept_threshold: 95
  },
  high_value: { 
    always_verify: true,      // Always verify high-value cards ($100+)
    accept_threshold: 95
  }
};

// Grammar constraint for 0.5B verifier tool calling (exact from qwen05-toolcalling.md)
const grammarConstraint = `
root ::= function_call
function_call ::= "{" ws "\\"name\\":" ws "\\"verify_pokemon_card\\"" "," ws "\\"arguments\\":" ws arguments "}"
arguments ::= "{" ws "\\"card_name\\":" ws string ("," ws "\\"set_code\\":" ws string)? "}"
string ::= "\\"" ([^"]*) "\\""
ws ::= [ \\t\\n]*
`.trim();

/**
 * Get enhanced distributed router configuration
 * Compatible with existing V1 config but adds advanced features
 */
export function getDistributedRouterConfig(): DistributedRouterConfig {
  const v1Config = getV1Config();
  
  return {
    // Mac endpoint from V1 config
    mac_endpoint: `${v1Config.remote.protocol}://${v1Config.remote.host}:1234`, // LM Studio port
    
    // Batch processing - more aggressive than V1
    batch_size: parseInt(process.env.DISTRIBUTED_BATCH_SIZE || '32'),      
    max_concurrent: parseInt(process.env.DISTRIBUTED_MAX_CONCURRENT || '8'),
    
    // Enhanced retry policy
    retry_policy: {
      primary_retries: v1Config.remote.retryAttempts,
      verifier_retries: 2,                    // Faster retries for verifier
      backoff_base_ms: v1Config.remote.retryDelay
    },
    
    // Production-tuned confidence routing
    confidence_policy: productionConfidencePolicy,
    
    // Tool calling grammar for 0.5B model
    grammar_constraint: grammarConstraint
  };
}

/**
 * Get SQLite storage configuration with production optimizations
 */
export function getStorageConfigV2(): CardStorageConfig {
  return {
    database_path: process.env.DATABASE_PATH || './data/cardmint_production.db',
    enable_wal: true,               // WAL mode for better concurrency
    cache_size_mb: parseInt(process.env.DB_CACHE_SIZE_MB || '64'),
    enable_fts: process.env.DB_ENABLE_FTS !== 'false'  // Full-text search enabled by default
  };
}

/**
 * Performance targets aligned with CardMint goals
 */
export const performanceTargetsV2 = {
  // Per-card latency targets (95th percentile) - matching your specification
  capture_preprocess_ms: 15,      // Fedora: capture + preprocess
  primary_inference_ms: 70,       // Mac: 7B VLM inference (40-70ms target)
  routing_decision_ms: 1,         // Fedora: confidence routing
  verifier_toolcall_ms: 20,       // Mac: 0.5B tool call generation (12-20ms target)
  local_verification_ms: 8,       // Fedora: database lookup (1-8ms target)
  persistence_ms: 3,              // Fedora: store results
  
  // End-to-end targets - aggressive but achievable
  total_per_card_ms: 100,         // <100ms/card average (with 25% verification)
  throughput_cards_per_minute: 60, // Production target
  
  // Quality targets
  verification_rate_max: 0.30,    // Max 30% of cards need verification
  accuracy_target: 0.95,          // 95% accuracy target
  
  // Resource utilization
  mac_cpu_utilization_max: 0.80,  // Max 80% CPU on Mac
  fedora_memory_usage_mb: 512,    // Max 512MB memory on Fedora
  
  // Reliability
  uptime_target: 0.999,           // 99.9% uptime
  error_rate_max: 0.01            // Max 1% error rate
};

/**
 * Enhanced monitoring configuration
 */
export const monitoringConfigV2 = {
  // Health checks
  mac_health_check_interval_ms: 30000, // Check every 30s
  mac_health_timeout_ms: 5000,         // 5s timeout
  
  // Performance alerting
  latency_alert_multiplier: 1.5,       // Alert when p95 exceeds target by 50%
  error_rate_alert_threshold: 0.05,    // Alert at 5% error rate
  queue_depth_alert_threshold: 100,    // Alert when queue > 100 items
  
  // Database performance
  db_query_timeout_ms: 10000,          // 10s timeout for DB queries
  memory_alert_threshold_mb: 1024,     // Alert at 1GB memory usage
  
  // Verification monitoring
  verification_rate_alert_threshold: 0.35,  // Alert if verification rate > 35%
  confidence_distribution_tracking: true,   // Track confidence buckets
  disagreement_tracking: true,              // Track verifier disagreements
  
  // Mac model health
  model_warmup_on_start: true,              // Warm up models on startup
  model_ttl_monitoring: true,               // Monitor model evictions
  kv_cache_utilization_tracking: true       // Track KV cache efficiency
};

/**
 * Integration with existing V1 system
 * This allows gradual migration from V1 to V2
 */
export interface MigrationConfig {
  enable_v2_router: boolean;          // Enable new distributed router
  v1_fallback: boolean;               // Fall back to V1 if V2 fails
  gradual_rollout_percentage: number; // Percentage of traffic to route to V2
  shadow_mode: boolean;               // Run V2 in shadow mode for comparison
}

export function getMigrationConfig(): MigrationConfig {
  return {
    enable_v2_router: process.env.ENABLE_V2_ROUTER === 'true',
    v1_fallback: process.env.V1_FALLBACK !== 'false', // Default to true
    gradual_rollout_percentage: parseInt(process.env.V2_ROLLOUT_PERCENTAGE || '0'),
    shadow_mode: process.env.V2_SHADOW_MODE === 'true'
  };
}

/**
 * Environment-specific configuration factory
 */
export function getEnvironmentConfig() {
  const env = process.env.NODE_ENV || 'development';
  const v1Config = getV1Config(); // Make v1Config available for overrides
  
  const baseConfig = {
    router: getDistributedRouterConfig(),
    storage: getStorageConfigV2(),
    performance: performanceTargetsV2,
    monitoring: monitoringConfigV2,
    migration: getMigrationConfig()
  };
  
  // Environment-specific overrides
  switch (env) {
    case 'development':
      return {
        ...baseConfig,
        router: {
          ...baseConfig.router,
          batch_size: 4,                              // Smaller batches
          max_concurrent: 2,                          // Less aggressive
          mac_endpoint: 'http://localhost:1234'       // Localhost for dev
        },
        storage: {
          ...baseConfig.storage,
          database_path: './data/cardmint_dev.db',
          cache_size_mb: 16
        },
        performance: {
          ...baseConfig.performance,
          total_per_card_ms: 200,                     // Relaxed targets for dev
          throughput_cards_per_minute: 30
        }
      };
      
    case 'test':
      return {
        ...baseConfig,
        router: {
          ...baseConfig.router,
          batch_size: 1,                              // Single item processing
          mac_endpoint: process.env.TEST_MAC_ENDPOINT || `${v1Config.remote.protocol}://${v1Config.remote.host}:1234` // Use real Mac endpoint even in test mode
        },
        storage: {
          ...baseConfig.storage,
          database_path: process.env.TEST_DATABASE_PATH || ':memory:',  // Allow override but default to in-memory
          enable_fts: false
        }
      };
      
    case 'production':
    default:
      return baseConfig;
  }
}

/**
 * Compatibility layer with existing V1 distributed config
 * This ensures we can use both systems simultaneously
 */
export function createHybridConfig() {
  const v1Config = getV1Config();
  const v2Config = getEnvironmentConfig();
  const migration = getMigrationConfig();
  
  return {
    // V1 compatibility
    v1: v1Config,
    
    // V2 enhanced features
    v2: v2Config,
    
    // Migration control
    migration,
    
    // Unified interface
    shouldUseV2: () => {
      if (!migration.enable_v2_router) return false;
      if (migration.gradual_rollout_percentage === 100) return true;
      if (migration.gradual_rollout_percentage === 0) return false;
      
      // Gradual rollout based on percentage
      return Math.random() * 100 < migration.gradual_rollout_percentage;
    },
    
    // Get active config based on migration settings
    getActiveConfig: () => {
      const shouldUseV2 = createHybridConfig().shouldUseV2();
      return shouldUseV2 ? v2Config : { 
        // Adapt V1 config to V2 interface for compatibility
        router: adaptV1ToV2Router(v1Config),
        storage: v2Config.storage, // Always use V2 storage (SQLite)
        performance: v2Config.performance,
        monitoring: v2Config.monitoring,
        migration
      };
    }
  };
}

/**
 * Adapter to convert V1 config to V2 router interface
 */
function adaptV1ToV2Router(v1Config: any): DistributedRouterConfig {
  return {
    mac_endpoint: `${v1Config.remote.protocol}://${v1Config.remote.host}:${v1Config.remote.port}`,
    batch_size: v1Config.transfer.batchSize,
    max_concurrent: v1Config.transfer.maxConcurrent,
    retry_policy: {
      primary_retries: v1Config.remote.retryAttempts,
      verifier_retries: 2,
      backoff_base_ms: v1Config.remote.retryDelay
    },
    confidence_policy: {
      // Default confidence policy for V1 compatibility
      common: { accept_threshold: 85, verify_threshold: 70 },
      rare: { accept_threshold: 90, verify_threshold: 80 },
      holo: { always_verify: true, accept_threshold: 95 },
      vintage: { always_verify: true, accept_threshold: 95 },
      high_value: { always_verify: true, accept_threshold: 95 }
    },
    grammar_constraint: grammarConstraint
  };
}

// Logging function for configuration visibility
export function logDistributedV2Config(): void {
  const config = getEnvironmentConfig();
  
  console.log('[Distributed V2 Configuration]', {
    router: {
      endpoint: config.router.mac_endpoint,
      batch_size: config.router.batch_size,
      max_concurrent: config.router.max_concurrent,
      confidence_policy: Object.keys(config.router.confidence_policy)
    },
    storage: {
      path: config.storage.database_path,
      wal: config.storage.enable_wal,
      cache_mb: config.storage.cache_size_mb,
      fts: config.storage.enable_fts
    },
    performance: {
      target_latency: `${config.performance.total_per_card_ms}ms`,
      throughput: `${config.performance.throughput_cards_per_minute}/min`,
      verification_rate: `<${config.performance.verification_rate_max * 100}%`
    },
    migration: config.migration
  });
}

export default getEnvironmentConfig;