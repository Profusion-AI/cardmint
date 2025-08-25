import { closeDatabase } from '../storage/database';
import { closeRedis } from '../storage/redis';
import { createLogger } from './logger';

const logger = createLogger('shutdown');

let isShuttingDown = false;

export async function gracefulShutdown(server: any, queueManager: any, captureWatcher?: any): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }
  
  isShuttingDown = true;
  logger.info('Starting graceful shutdown...');
  
  const shutdownTimeout = setTimeout(() => {
    logger.error('Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, 30000);
  
  try {
    logger.info('Stopping capture watcher...');
    if (captureWatcher) {
      await captureWatcher.stop();
    }
    
    logger.info('Stopping server...');
    if (server) {
      await server.stop();
    }
    
    logger.info('Stopping queue manager...');
    if (queueManager) {
      await queueManager.shutdown();
    }
    
    logger.info('Closing database connections...');
    await closeDatabase();
    
    logger.info('Closing Redis connections...');
    await closeRedis();
    
    clearTimeout(shutdownTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}