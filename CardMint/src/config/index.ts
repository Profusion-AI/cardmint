import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    wsPort: parseInt(process.env.WS_PORT || '3001', 10),
    host: process.env.HOST || '0.0.0.0',
  },
  
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'cardmint',
    user: process.env.DB_USER || 'cardmint',
    password: process.env.DB_PASSWORD || '',
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
};

export type Config = typeof config;