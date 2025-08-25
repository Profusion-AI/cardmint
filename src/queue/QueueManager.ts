/* TODO: Review and add specific port type imports from @core/* */
import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { CardStatus } from '../types';
import { CardRepository } from '../storage/CardRepository';
import { ports } from '../app/wiring';

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
      // BullMQ needs its own Redis connection with specific settings
      const connection = {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        maxRetriesPerRequest: null, // Required by BullMQ
      };
      
      this.captureQueue = new Queue('capture', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
          attempts: config.processing.retryAttempts,
          backoff: {
            type: 'exponential',
            delay: config.processing.retryDelayMs,
          },
        },
      });
      
      this.processingQueue = new Queue('processing', {
        connection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
          attempts: config.processing.retryAttempts,
          backoff: {
            type: 'exponential',
            delay: config.processing.retryDelayMs,
          },
        },
      });
      
      this.queueEvents = new QueueEvents('processing', { connection });
      
      this.imageProcessor = ports.image;
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
    const workerCount = config.processing.maxWorkers;
    
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
          concurrency: config.processing.workerConcurrency,
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
          job.attemptsMade >= config.processing.retryAttempts
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