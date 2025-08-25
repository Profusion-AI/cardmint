import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// SLO Targets - Hard performance budgets
export const SLO_TARGETS = {
  e2e_p95_ms: 3000,        // 3.0s max end-to-end
  error_rate_max: 0.005,   // 0.5% error rate over 500 scans
  capture_budget_ms: 400,   // Sony camera
  preproc_budget_ms: 120,   // OpenCV resize/prep
  lmstudio_budget_ms: 500,  // ML inference
  db_budget_ms: 200        // SQLite + pricing
} as const;

// Zod schema for complete config validation
const ConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  
  server: z.object({
    port: z.number().int().min(1).max(65535).default(3000),
    wsPort: z.number().int().min(1).max(65535).default(3001),
    host: z.string().ip().or(z.literal('0.0.0.0')).or(z.literal('localhost')).default('0.0.0.0'),
  }),
  
  database: z.object({
    path: z.string().min(1).default('./data/cardmint.db'),
    poolMin: z.number().int().min(1).default(2),
    poolMax: z.number().int().min(1).default(20),
  }),
  
  redis: z.object({
    host: z.string().min(1).default('localhost'),
    port: z.number().int().min(1).max(65535).default(6379),
    password: z.string().optional(),
    db: z.number().int().min(0).default(0),
  }),
  
  camera: z.object({
    mode: z.enum(['USB', 'ETHERNET', 'SSH']).default('USB'),
    ip: z.string().ip().optional(),
    deviceId: z.string().optional(),
    fps: z.number().int().min(1).max(120).default(60),
    resolution: z.string().regex(/^\d+x\d+$/).default('1920x1080'),
    format: z.enum(['MJPG', 'H264', 'RAW']).default('MJPG'),
  }),
  
  processing: z.object({
    maxWorkers: z.number().int().min(1).max(100).default(20),
    workerConcurrency: z.number().int().min(1).max(10).default(3),
    jobTimeoutMs: z.number().int().min(1000).default(5000),
    retryAttempts: z.number().int().min(0).max(10).default(3),
    retryDelayMs: z.number().int().min(100).default(1000),
  }),
  
  // Critical: Remote ML Service Configuration
  remoteML: z.object({
    enabled: z.boolean().default(true),
    host: z.string().min(1).default('10.0.24.174'), // M4 Mac IP
    port: z.number().int().min(1).max(65535).default(1234), // LMStudio port
    protocol: z.enum(['http', 'https']).default('http'),
    timeout: z.number().int().min(1000).max(30000).default(7000), // 7s max
    retryAttempts: z.number().int().min(1).max(10).default(5),
    retryDelay: z.number().int().min(100).max(5000).default(300),
    fallbackMode: z.enum(['defer', 'ocr', 'none']).default('defer'),
    maxConcurrency: z.number().int().min(1).max(5).default(1),
  }),
  
  // Circuit Breaker Settings
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).max(20).default(5),
    resetTimeoutMs: z.number().int().min(5000).max(300000).default(30000), // 30s
    monitorWindowMs: z.number().int().min(10000).max(600000).default(60000), // 1min
  }),
  
  performance: z.object({
    useGpu: z.boolean().default(true),
    gpuDeviceId: z.number().int().min(0).default(0),
    enableProfiling: z.boolean().default(false),
    enableMetrics: z.boolean().default(true),
    cpuCores: z.string().regex(/^\d+(-\d+)?$/).default('2-7'),
    memoryLimitMb: z.number().int().min(512).default(2048),
  }),
  
  ocr: z.object({
    model: z.enum(['PaddleOCR', 'Tesseract']).default('PaddleOCR'),
    language: z.string().min(1).default('en'),
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
  }),
  
  monitoring: z.object({
    otelEnabled: z.boolean().default(true),
    otelEndpoint: z.string().url().default('http://localhost:4318'),
    metricsPort: z.number().int().min(1).max(65535).default(9091),
  }),
  
  // API Keys (validated as non-empty strings)
  apis: z.object({
    priceChartingKey: z.string().min(1).optional(),
    pokemonTcgKey: z.string().min(1).optional(),
  }),
});

export type ValidatedConfig = z.infer<typeof ConfigSchema>;

// Parse and validate configuration from environment
function parseConfigFromEnv(): ValidatedConfig {
  const rawConfig = {
    env: process.env.NODE_ENV,
    
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      wsPort: parseInt(process.env.WS_PORT || '3001', 10),
      host: process.env.HOST || '0.0.0.0',
    },
    
    database: {
      path: process.env.DB_PATH || './data/cardmint.db',
      poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
      poolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),
    },
    
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || '0', 10),
    },
    
    camera: {
      mode: process.env.CAMERA_MODE || 'USB',
      ip: process.env.CAMERA_IP || undefined,
      deviceId: process.env.CAMERA_DEVICE_ID || undefined,
      fps: parseInt(process.env.CAMERA_FPS || '60', 10),
      resolution: process.env.CAMERA_RESOLUTION || '1920x1080',
      format: process.env.CAMERA_FORMAT || 'MJPG',
    },
    
    processing: {
      maxWorkers: parseInt(process.env.MAX_WORKERS || '20', 10),
      workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '3', 10),
      jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS || '5000', 10),
      retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3', 10),
      retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000', 10),
    },
    
    // Remote ML Configuration
    remoteML: {
      enabled: process.env.REMOTE_ML_ENABLED === 'true',
      host: process.env.REMOTE_ML_HOST || '10.0.24.174',
      port: parseInt(process.env.REMOTE_ML_PORT || '1234', 10), // Correct LMStudio port
      protocol: process.env.REMOTE_ML_PROTOCOL || 'http',
      timeout: parseInt(process.env.REMOTE_ML_TIMEOUT || '7000', 10),
      retryAttempts: parseInt(process.env.REMOTE_ML_RETRY_ATTEMPTS || '5', 10),
      retryDelay: parseInt(process.env.REMOTE_ML_RETRY_DELAY || '300', 10),
      fallbackMode: process.env.ML_FALLBACK_MODE || 'defer',
      maxConcurrency: parseInt(process.env.MAX_CONCURRENT_ML_REQUESTS || '1', 10),
    },
    
    circuitBreaker: {
      failureThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5', 10),
      resetTimeoutMs: parseInt(process.env.CIRCUIT_BREAKER_RESET_MS || '30000', 10),
      monitorWindowMs: parseInt(process.env.CIRCUIT_BREAKER_WINDOW_MS || '60000', 10),
    },
    
    performance: {
      useGpu: process.env.USE_GPU === 'true',
      gpuDeviceId: parseInt(process.env.GPU_DEVICE_ID || '0', 10),
      enableProfiling: process.env.ENABLE_PROFILING === 'true',
      enableMetrics: process.env.ENABLE_METRICS === 'true',
      cpuCores: process.env.CPU_CORES || '2-7',
      memoryLimitMb: parseInt(process.env.MEMORY_LIMIT_MB || '2048', 10),
    },
    
    ocr: {
      model: process.env.OCR_MODEL || 'PaddleOCR',
      language: process.env.OCR_LANG || 'en',
      confidenceThreshold: parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.7'),
    },
    
    monitoring: {
      otelEnabled: process.env.OTEL_ENABLED === 'true',
      otelEndpoint: process.env.OTEL_ENDPOINT || 'http://localhost:4318',
      metricsPort: parseInt(process.env.METRICS_PORT || '9091', 10),
    },
    
    apis: {
      priceChartingKey: process.env.PRICECHARTING_API_KEY,
      pokemonTcgKey: process.env.POKEMONTCG_API_KEY,
    },
  };

  return ConfigSchema.parse(rawConfig);
}

// Validate and export the configuration
export const validatedConfig = parseConfigFromEnv();

// Export individual sections for backwards compatibility
export const config = {
  ...validatedConfig,
  isDevelopment: validatedConfig.env === 'development',
  isProduction: validatedConfig.env === 'production',
  // Legacy structure for existing code
  server: validatedConfig.server,
  database: validatedConfig.database,
  redis: validatedConfig.redis,
  camera: validatedConfig.camera,
  processing: validatedConfig.processing,
  performance: validatedConfig.performance,
  ocr: validatedConfig.ocr,
  monitoring: validatedConfig.monitoring,
};

export type Config = typeof config;