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
    // Stop accepting new jobs first
    logger.info('Pausing queue manager (stopping new jobs)...');
    if (queueManager && typeof queueManager.pause === 'function') {
      await queueManager.pause();
    }
    
    // Stop server from accepting new connections
    logger.info('Stopping server...');
    if (server) {
      await server.stop();
    }
    
    // Stop capture watcher
    logger.info('Stopping capture watcher...');
    if (captureWatcher) {
      await captureWatcher.stop();
    }
    
    // Wait for all active jobs to complete
    logger.info('Draining queue manager (waiting for active jobs)...');
    if (queueManager && typeof queueManager.drain === 'function') {
      await queueManager.drain();
    }
    
    // Now shutdown queue manager completely
    logger.info('Shutting down queue manager...');
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