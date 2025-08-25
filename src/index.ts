import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { CardMintServer } from './server';
import { initializeDatabase } from './storage/database';
import { initializeRedis } from './storage/redis';
import { QueueManager } from './queue/QueueManager';
import { MetricsCollector } from './utils/metrics';
import { IntegratedScannerService } from './services/IntegratedScannerService';
import { DistributedIntegration } from './services/DistributedIntegration';
import { CardRepository } from './storage/CardRepository';
import { gracefulShutdown } from './utils/shutdown';

dotenv.config();

async function main() {
  logger.info('Starting CardMint System...');
  
  try {
    logger.info('Initializing database connection...');
    await initializeDatabase();
    
    logger.info('Initializing Redis connection...');
    await initializeRedis();
    
    logger.info('Starting queue manager...');
    const queueManager = new QueueManager();
    await queueManager.initialize();
    
    logger.info('Initializing metrics collector...');
    const metrics = new MetricsCollector();
    await metrics.start();
    
    logger.info('Initializing Phase 3 hybrid quick-scan architecture...');
    const cardRepository = new CardRepository();
    
    // Phase 3: Use existing integrated services that combine all components
    logger.info('Starting IntegratedScannerService (Phase 4)...');
    const integratedScanner = new IntegratedScannerService();
    
    logger.info('Starting DistributedIntegration (Complete Pipeline)...');
    const distributedPipeline = new DistributedIntegration();
    await distributedPipeline.start();
    
    logger.info('Phase 3 hybrid pipeline ready with all components integrated');
    
    logger.info('Starting CardMint server...');
    const server = new CardMintServer(queueManager, metrics);
    await server.start();
    
    process.on('SIGTERM', () => gracefulShutdown(server, queueManager, distributedPipeline));
    process.on('SIGINT', () => gracefulShutdown(server, queueManager, distributedPipeline));
    
    logger.info('CardMint System is running successfully');
    logger.info(`API: http://localhost:${process.env.PORT || 3000}`);
    logger.info(`WebSocket: ws://localhost:${process.env.WS_PORT || 3001}`);
    logger.info(`Metrics: http://localhost:${process.env.METRICS_PORT || 9090}/metrics`);
    
  } catch (error) {
    logger.error(`Failed to start CardMint System: ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(`Unhandled error in main: ${error}`);
  process.exit(1);
});