import Redis from 'ioredis';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('redis');

let redisClient: Redis | null = null;
let pubClient: Redis | null = null;
let subClient: Redis | null = null;

export async function initializeRedis(): Promise<void> {
  const redisConfig = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
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
    const client = getRedisClient();
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    
    if (ttl || this.ttl) {
      await client.setex(this.prefix + key, ttl || this.ttl, serialized);
    } else {
      await client.set(this.prefix + key, serialized);
    }
  }
  
  async delete(key: string): Promise<void> {
    const client = getRedisClient();
    await client.del(this.prefix + key);
  }
  
  async exists(key: string): Promise<boolean> {
    const client = getRedisClient();
    const result = await client.exists(this.prefix + key);
    return result === 1;
  }
  
  async increment(key: string, amount = 1): Promise<number> {
    const client = getRedisClient();
    return await client.incrby(this.prefix + key, amount);
  }
}