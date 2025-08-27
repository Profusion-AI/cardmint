import dotenv from 'dotenv';

dotenv.config();

export interface ServerConfig {
  host: string;
  port: number;
  wsPort: number;
  environment: string;
}

export interface Config {
  server: ServerConfig;
  camera: {
    mockMode: boolean;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  database: {
    path: string;
  };
}

// Deterministic port configuration - no fallbacks, explicit env vars only
function getRequiredPort(envVar: string, description: string): number {
  const envPort = process.env[envVar];
  if (!envPort) {
    throw new Error(`Missing required environment variable: ${envVar} (${description})`);
  }
  
  const port = parseInt(envPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port value for ${envVar}: ${envPort} (${description})`);
  }
  
  return port;
}

export const config: Config = {
  server: {
    host: process.env.HOST || 'localhost',
    port: getRequiredPort('API_PORT', 'API server port'),
    wsPort: getRequiredPort('WS_PORT', 'WebSocket server port'),
    environment: process.env.NODE_ENV || 'development'
  },
  camera: {
    mockMode: process.env.CAMERA_MOCK_MODE === 'true' || process.env.NODE_ENV === 'development'
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD
  },
  database: {
    path: process.env.CARDMINT_DB_PATH || process.env.DB_PATH || './data/cardmint.db'
  }
};

// Runtime configuration display
if (process.env.NODE_ENV !== 'test') {
  const logger = {
    info: (msg: string, ...args: any[]) => console.log(`[CONFIG] ${msg}`, ...args)
  };
  
  logger.info('Configuration loaded:');
  logger.info(`  Server: ${config.server.host}:${config.server.port}`);
  logger.info(`  WebSocket: ${config.server.host}:${config.server.wsPort}`);
  logger.info(`  Environment: ${config.server.environment}`);
  logger.info(`  Camera Mock: ${config.camera.mockMode}`);
  logger.info(`  Database: ${config.database.path}`);
  logger.info(`  Redis: ${config.redis.host}:${config.redis.port}`);
}

// Export individual configurations for specific modules
export const serverConfig = config.server;
export const cameraConfig = config.camera;
export const redisConfig = config.redis;
export const databaseConfig = config.database;