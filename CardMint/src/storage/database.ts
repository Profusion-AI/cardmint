import { Pool, PoolConfig } from 'pg';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

let pool: Pool | null = null;

export async function initializeDatabase(): Promise<void> {
  const poolConfig: PoolConfig = {
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    min: config.database.poolMin,
    max: config.database.poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 30000,
  };
  
  try {
    pool = new Pool(poolConfig);
    
    pool.on('error', (err) => {
      logger.error('Unexpected database pool error:', err);
    });
    
    pool.on('connect', () => {
      logger.debug('New database client connected');
    });
    
    pool.on('acquire', () => {
      logger.debug('Database client acquired from pool');
    });
    
    pool.on('remove', () => {
      logger.debug('Database client removed from pool');
    });
    
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT NOW() as current_time');
      logger.info(`Database connected successfully at ${result.rows[0].current_time}`);
    } finally {
      client.release();
    }
    
    await createTables();
    
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  }
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database pool not initialized');
  }
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    logger.info('Closing database pool...');
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

async function createTables(): Promise<void> {
  const client = await getPool().connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        image_url VARCHAR(512) NOT NULL,
        thumbnail_url VARCHAR(512),
        status VARCHAR(32) NOT NULL DEFAULT 'captured',
        metadata JSONB DEFAULT '{}',
        ocr_data JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_captured_at ON cards(captured_at DESC);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_metadata ON cards USING GIN(metadata);
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS processing_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        error TEXT,
        result JSONB,
        CONSTRAINT fk_card FOREIGN KEY (card_id) REFERENCES cards(id)
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_priority ON processing_jobs(priority DESC, created_at);
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_metrics (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metric_name VARCHAR(128) NOT NULL,
        metric_value NUMERIC NOT NULL,
        labels JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_metrics_timestamp 
      ON performance_metrics USING BRIN(timestamp);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_metrics_name 
      ON performance_metrics(metric_name, timestamp DESC);
    `);
    
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_cards_updated_at') THEN
          CREATE TRIGGER update_cards_updated_at 
          BEFORE UPDATE ON cards 
          FOR EACH ROW 
          EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);
    
    await client.query('COMMIT');
    logger.info('Database tables created successfully');
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to create database tables:', error);
    throw error;
  } finally {
    client.release();
  }
}