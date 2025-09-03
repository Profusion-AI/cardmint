import Redis from 'ioredis';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('redis');
const E2E_NO_REDIS = process.env.E2E_NO_REDIS === 'true';

// In-memory fallback store for E2E_NO_REDIS mode
const memStores: Map<string, Map<string, string>> = new Map();

let redisClient: Redis | null = null;
let pubClient: Redis | null = null;
let subClient: Redis | null = null;

export async function initializeRedis(): Promise<void> {
  if (E2E_NO_REDIS) {
    logger.warn('E2E_NO_REDIS enabled: Redis will not be initialized (using in-memory cache)');
    return;
  }
  const redisConfig: any = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: (config as any).redis?.db ?? 0,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 2000);
      logger.warn(`Redis connection retry attempt ${times}, delay: ${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: null, // BullMQ requires this to be null
    enableReadyCheck: true,
    lazyConnect: false,
  };
  
  try {
    redisClient = new Redis(redisConfig);
    pubClient = new Redis(redisConfig);
    subClient = new Redis(redisConfig);
    
    redisClient.on('error', (error) => {
      logger.error('Redis client error:', error);
    });
    
    redisClient.on('connect', () => {
      logger.info('Redis client connected');
    });
    
    redisClient.on('ready', () => {
      logger.info('Redis client ready');
    });
    
    await redisClient.ping();
    logger.info('Redis connection established successfully');
    
  } catch (error) {
    logger.error('Failed to initialize Redis:', error);
    throw error;
  }
}

export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('Redis client not initialized');
  }
  return redisClient;
}

export function getPubClient(): Redis {
  if (!pubClient) {
    throw new Error('Redis pub client not initialized');
  }
  return pubClient;
}

export function getSubClient(): Redis {
  if (!subClient) {
    throw new Error('Redis sub client not initialized');
  }
  return subClient;
}

export async function closeRedis(): Promise<void> {
  logger.info('Closing Redis connections...');
  
  const clients = [redisClient, pubClient, subClient].filter(Boolean);
  
  await Promise.all(
    clients.map(async (client) => {
      if (client) {
        await client.quit();
      }
    })
  );
  
  redisClient = null;
  pubClient = null;
  subClient = null;
  
  logger.info('Redis connections closed');
}

export class RedisCache {
  private readonly prefix: string;
  private readonly ttl: number;
  
  constructor(prefix: string, ttlSeconds = 3600) {
    this.prefix = `cardmint:${prefix}:`;
    this.ttl = ttlSeconds;
  }
  
  async get<T>(key: string): Promise<T | null> {
    if (E2E_NO_REDIS) {
      const store = memStores.get(this.prefix);
      const value = store?.get(key) ?? null;
      if (!value) return null;
      try { return JSON.parse(value) as T; } catch { return value as unknown as T; }
    }
    const client = getRedisClient();
    const value = await client.get(this.prefix + key);
    
    if (!value) {
      return null;
    }
    
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (E2E_NO_REDIS) {
      let store = memStores.get(this.prefix);
      if (!store) { store = new Map(); memStores.set(this.prefix, store); }
      store.set(key, serialized);
      // TTL ignored in memory fallback
      return;
    }
    const client = getRedisClient();
    if (ttl || this.ttl) {
      await client.setex(this.prefix + key, ttl || this.ttl, serialized);
    } else {
      await client.set(this.prefix + key, serialized);
    }
  }
  
  async delete(key: string): Promise<void> {
    if (E2E_NO_REDIS) {
      memStores.get(this.prefix)?.delete(key);
      return;
    }
    const client = getRedisClient();
    await client.del(this.prefix + key);
  }
  
  async exists(key: string): Promise<boolean> {
    if (E2E_NO_REDIS) {
      return memStores.get(this.prefix)?.has(key) ?? false;
    }
    const client = getRedisClient();
    const result = await client.exists(this.prefix + key);
    return result === 1;
  }
  
  async increment(key: string, amount = 1): Promise<number> {
    if (E2E_NO_REDIS) {
      let store = memStores.get(this.prefix);
      if (!store) { store = new Map(); memStores.set(this.prefix, store); }
      const current = Number(store.get(key) || '0');
      const next = current + amount;
      store.set(key, String(next));
      return next;
    }
    const client = getRedisClient();
    return await client.incrby(this.prefix + key, amount);
  }
}
