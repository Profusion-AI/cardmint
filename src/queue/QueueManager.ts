/* TODO: Review and add specific port type imports from @core/* */
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { CardStatus } from '../types';
import { CardRepository } from '../storage/CardRepository';
import { ports } from '../app/wiring';
import { ImageProcessor } from '../processing/ImageProcessor';

const logger = createLogger('queue');

export class QueueManager {
  private captureQueue?: Queue;
  private processingQueue?: Queue;
  private workers: Worker[] = [];
  private queueEvents?: QueueEvents;
  private imageProcessor?: ImageProcessor;
  private cardRepository?: CardRepository;
  
  async initialize(): Promise<void> {
    try {
      // Debug: Check config availability
      logger.debug('Config check:', {
        processing: config.processing,
        retryAttempts: config.processing?.retryAttempts,
        retryDelayMs: config.processing?.retryDelayMs
      });
      
      // BullMQ needs its own Redis connection with specific settings
      const connection = {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        maxRetriesPerRequest: null, // Required by BullMQ
      };
      
      // Use fallback values if config is not available
      const retryAttempts = config.processing?.retryAttempts || 3;
      const retryDelayMs = config.processing?.retryDelayMs || 1000;
      
      this.captureQueue = new Queue('capture', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
          attempts: retryAttempts,
          backoff: {
            type: 'exponential',
            delay: retryDelayMs,
          },
        },
      });
      
      this.processingQueue = new Queue('processing', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
          attempts: retryAttempts,
          backoff: {
            type: 'exponential',
            delay: retryDelayMs,
          },
        },
      });
      
      this.queueEvents = new QueueEvents('processing', { connection });
      
      // (Codex-CTO) Use the full processing pipeline (ML + OCR), not the low-level image adapter
      this.imageProcessor = new ImageProcessor();
      this.cardRepository = new CardRepository();
      
      await this.startWorkers();
      
      this.setupEventListeners();
      
      logger.info('Queue manager initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize queue manager:', error);
      throw error;
    }
  }
  
  private async startWorkers(): Promise<void> {
    const workerCount = config.processing?.maxWorkers || 2;
    
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        'processing',
        async (job: Job) => {
          return await this.processJob(job);
        },
        {
          connection: {
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
            db: config.redis.db,
            maxRetriesPerRequest: null,
          },
          concurrency: config.processing?.workerConcurrency || 3,
          limiter: {
            max: 100,
            duration: 60000,
          },
        }
      );
      
      worker.on('completed', (job) => {
        logger.debug(`Job ${job.id} completed`);
      });
      
      worker.on('failed', (job, err) => {
        logger.error(`Job ${job?.id} failed:`, err);
      });
      
      worker.on('error', (err) => {
        logger.error('Worker error:', err);
      });
      
      this.workers.push(worker);
    }
    
    logger.info(`Started ${workerCount} processing workers`);
  }
  
  private async processJob(job: Job): Promise<any> {
    const startTime = Date.now();
    
    try {
      logger.debug(`Processing job ${job.id} with data:`, job.data);
      
      const { cardId, imageData } = job.data;
      
      await this.cardRepository!.updateStatus(cardId, CardStatus.PROCESSING);
      
      const result = await this.imageProcessor!.process({
        cardId,
        imageData,
        settings: job.data.settings || {},
      });
      
      await this.cardRepository!.updateCard(cardId, {
        status: CardStatus.PROCESSED,
        processedAt: new Date(),
        ocrData: result.ocrData,
        metadata: result.metadata,
      });
      
      const processingTime = Date.now() - startTime;
      logger.info(`Job ${job.id} processed in ${processingTime}ms`);
      
      return {
        success: true,
        cardId,
        processingTime,
        result,
      };
      
    } catch (error) {
      logger.error(`Failed to process job ${job.id}:`, error);
      
      const { cardId } = job.data;
      if (cardId) {
        await this.cardRepository!.updateStatus(
          cardId,
          job.attemptsMade >= (config.processing?.retryAttempts || 3)
            ? CardStatus.FAILED
            : CardStatus.RETRYING,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
      
      throw error;
    }
  }
  
  private setupEventListeners(): void {
    if (!this.queueEvents) return;
    
    this.queueEvents.on('waiting', ({ jobId }) => {
      logger.debug(`Job ${jobId} is waiting`);
    });
    
    this.queueEvents.on('active', ({ jobId, prev }) => {
      logger.debug(`Job ${jobId} is active, previous status: ${prev}`);
    });
    
    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      logger.debug(`Job ${jobId} completed with result:`, returnvalue);
    });
    
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error(`Job ${jobId} failed:`, failedReason);
    });
  }
  
  async addCaptureJob(data: any, priority = 0): Promise<Job> {
    if (!this.captureQueue) {
      throw new Error('Capture queue not initialized');
    }
    
    const job = await this.captureQueue.add('capture', data, {
      priority,
      delay: 0,
    });
    
    logger.debug(`Added capture job ${job.id}`);
    return job;
  }
  
  async addProcessingJob(data: any, priority = 0): Promise<Job> {
    if (!this.processingQueue) {
      throw new Error('Processing queue not initialized');
    }
    
    const job = await this.processingQueue.add('process', data, {
      priority,
      delay: 0,
    });
    
    logger.debug(`Added processing job ${job.id}`);
    return job;
  }
  
  async getQueueStatus(): Promise<{
    capture: { waiting: number; active: number; completed: number; failed: number };
    processing: { waiting: number; active: number; completed: number; failed: number };
  }> {
    const captureStatus = this.captureQueue
      ? await this.captureQueue.getJobCounts()
      : { waiting: 0, active: 0, completed: 0, failed: 0 };
      
    const processingStatus = this.processingQueue
      ? await this.processingQueue.getJobCounts()
      : { waiting: 0, active: 0, completed: 0, failed: 0 };
    
    // Ensure all required fields are present
    const captureCounts = {
      waiting: captureStatus.waiting || 0,
      active: captureStatus.active || 0,
      completed: captureStatus.completed || 0,
      failed: captureStatus.failed || 0,
    };
    
    const processingCounts = {
      waiting: processingStatus.waiting || 0,
      active: processingStatus.active || 0,
      completed: processingStatus.completed || 0,
      failed: processingStatus.failed || 0,
    };
    
    return {
      capture: captureCounts,
      processing: processingCounts,
    };
  }
  
  /**
   * Pause all queues to stop accepting new jobs
   */
  async pause(): Promise<void> {
    logger.info('Pausing all queues...');
    
    const pausePromises = [];
    if (this.captureQueue) {
      pausePromises.push(this.captureQueue.pause());
    }
    if (this.processingQueue) {
      pausePromises.push(this.processingQueue.pause());
    }
    
    await Promise.all(pausePromises);
    logger.info('All queues paused');
  }

  /**
   * Wait for all active jobs to complete
   */
  async drain(): Promise<void> {
    logger.info('Draining all queues (waiting for active jobs to complete)...');
    
    const drainPromises = [];
    if (this.captureQueue) {
      drainPromises.push(this.captureQueue.drain());
    }
    if (this.processingQueue) {
      drainPromises.push(this.processingQueue.drain());
    }
    
    // Also wait for workers to complete their current jobs
    const workerPromises = this.workers.map(async (worker) => {
      // Wait for worker to finish current job (if any)
      return new Promise<void>((resolve) => {
        if (worker.isRunning()) {
          worker.once('completed', () => resolve());
          worker.once('failed', () => resolve());
          // Timeout after 10 seconds
          setTimeout(() => resolve(), 10000);
        } else {
          resolve();
        }
      });
    });
    
    await Promise.all([...drainPromises, ...workerPromises]);
    logger.info('All queues drained and workers completed');
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down queue manager...');
    
    await Promise.all(this.workers.map((worker) => worker.close()));
    
    if (this.queueEvents) {
      await this.queueEvents.close();
    }
    
    if (this.captureQueue) {
      await this.captureQueue.close();
    }
    
    if (this.processingQueue) {
      await this.processingQueue.close();
    }
    
    logger.info('Queue manager shut down successfully');
  }
}
