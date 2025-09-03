/**
 * Isolated scan queue worker
 * This worker processes card scanning jobs independently from the main API server
 * Enables hot-reloading of API without interrupting active scans
 */

import { Worker, Job } from 'bullmq';
import { createLogger } from '../utils/logger';
import { config } from '../config';
import { CardRepository } from '../storage/CardRepository';
import { integratedScanner, type IntegratedScanOptions } from '../services/IntegratedScannerService';
import { CardStatus } from '../types';

const logger = createLogger('scan-worker');

let isShuttingDown = false;

interface ScanJobData {
  cardId: string;
  imageData?: string;
  type: 'capture' | 'process';
  priority?: number;
}

class ScanWorker {
  private worker?: Worker;
  private cardRepository: CardRepository;

  constructor() {
    this.cardRepository = new CardRepository();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing isolated scan worker...');

    // BullMQ connection
    const connection = {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      maxRetriesPerRequest: null,
    };

    // Create worker for processing queue
    this.worker = new Worker('processing', this.processJob.bind(this), {
      connection,
      concurrency: Math.min(config.processing.maxWorkers || 5, 3), // Limit worker concurrency
      removeOnComplete: 100,
      removeOnFail: 1000,
    });

    // Worker event handlers
    this.worker.on('ready', () => {
      logger.info('Scan worker ready and waiting for jobs');
    });

    this.worker.on('completed', (job: Job) => {
      logger.info(`Scan job completed: ${job.id} (${job.data.type})`);
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      logger.error(`Scan job failed: ${job?.id || 'unknown'} - ${err.message}`);
    });

    this.worker.on('error', (err: Error) => {
      logger.error('Worker error:', err);
    });

    // Graceful shutdown handling
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    logger.info('Scan worker initialized successfully');
  }

  private async processJob(job: Job<ScanJobData>): Promise<any> {
    if (isShuttingDown) {
      logger.warn(`Skipping job ${job.id} - worker is shutting down`);
      return;
    }

    const { cardId, imageData, type } = job.data;
    logger.info(`Processing scan job ${job.id} - Card: ${cardId}, Type: ${type}`);

    try {
      // Update job progress
      await job.updateProgress(10);

      // Update card status to processing
      await this.cardRepository.updateCardStatus(cardId, CardStatus.PROCESSING);
      await job.updateProgress(20);

      // Process based on job type
      let result;
      if (type === 'capture' || type === 'process') {
        // Use integrated scanner for processing
        const scanOptions: IntegratedScanOptions = {
          imageData,
          cardId,
          skipCache: false,
        };

        await job.updateProgress(30);
        result = await integratedScanner.processCard(scanOptions);
        await job.updateProgress(80);

        // Update card with results
        if (result) {
          await this.cardRepository.updateCard(cardId, {
            status: CardStatus.COMPLETED,
            processedAt: new Date(),
            metadata: result.metadata || {},
          });
        } else {
          await this.cardRepository.updateCardStatus(cardId, CardStatus.FAILED);
        }
      }

      await job.updateProgress(100);
      logger.info(`Scan job ${job.id} completed successfully`);
      
      return result;

    } catch (error) {
      logger.error(`Error processing scan job ${job.id}:`, error);
      
      // Update card status to failed
      await this.cardRepository.updateCardStatus(cardId, CardStatus.FAILED);
      
      throw error; // Re-throw for BullMQ retry handling
    }
  }

  private async shutdown(): Promise<void> {
    if (isShuttingDown) return;
    
    isShuttingDown = true;
    logger.info('Shutting down scan worker...');

    try {
      if (this.worker) {
        // Wait for current jobs to complete (up to 30 seconds)
        logger.info('Waiting for active scan jobs to complete...');
        await this.worker.close();
        logger.info('Scan worker closed successfully');
      }
    } catch (error) {
      logger.error('Error shutting down scan worker:', error);
    }

    process.exit(0);
  }
}

// Main execution
async function main() {
  try {
    logger.info('Starting isolated scan worker process...');
    
    const scanWorker = new ScanWorker();
    await scanWorker.initialize();
    
    logger.info('Scan worker is running and ready to process jobs');
    
  } catch (error) {
    logger.error('Failed to start scan worker:', error);
    process.exit(1);
  }
}

// Only run if this file is executed directly (not imported)
if (require.main === module) {
  main().catch((error) => {
    logger.error('Unhandled error in scan worker:', error);
    process.exit(1);
  });
}

export { ScanWorker };