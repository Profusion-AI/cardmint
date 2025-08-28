/**
 * FileQueueManager - Simple file-based queue for E2E mode
 * 
 * This manager provides queue functionality without Redis dependency,
 * using local files to maintain processing state and job queues.
 * Designed for standalone operation and testing environments.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';

const logger = createLogger('file-queue-manager');

export interface QueueJob {
  id: string;
  type: string;
  cardId?: string;
  imageData?: Buffer;
  imagePath?: string;
  settings?: Record<string, any>;
  priority: number;
  createdAt: Date;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  processingStarted?: Date;
  processingCompleted?: Date;
}

export interface QueueMetrics {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalProcessed: number;
}

export class FileQueueManager extends EventEmitter {
  private readonly queueDir: string;
  private readonly jobsFile: string;
  private readonly metricsFile: string;
  
  private jobs: Map<string, QueueJob> = new Map();
  private processing: Set<string> = new Set();
  private isRunning: boolean = false;
  private processingInterval?: NodeJS.Timeout;
  
  private metrics: QueueMetrics = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    totalProcessed: 0
  };

  constructor(queueDir: string = './data/queue') {
    super();
    
    this.queueDir = path.resolve(queueDir);
    this.jobsFile = path.join(this.queueDir, 'jobs.json');
    this.metricsFile = path.join(this.queueDir, 'metrics.json');
    
    logger.info('FileQueueManager initialized', {
      queueDir: this.queueDir,
      jobsFile: this.jobsFile
    });
  }

  /**
   * Initialize the queue manager
   */
  async initialize(): Promise<void> {
    try {
      // Ensure queue directory exists
      await fs.mkdir(this.queueDir, { recursive: true });
      
      // Load existing jobs and metrics
      await this.loadState();
      
      // Start processing loop
      await this.start();
      
      logger.info('FileQueueManager initialized successfully', {
        existingJobs: this.jobs.size,
        metrics: this.metrics
      });
      
    } catch (error) {
      logger.error('Failed to initialize FileQueueManager:', error);
      throw error;
    }
  }

  /**
   * Start the processing loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('FileQueueManager is already running');
      return;
    }

    this.isRunning = true;
    
    // Process jobs every 2 seconds
    this.processingInterval = setInterval(() => {
      this.processJobs().catch(error => {
        logger.error('Error in job processing loop:', error);
      });
    }, 2000);
    
    logger.info('FileQueueManager processing loop started');
  }

  /**
   * Stop the processing loop
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }
    
    // Save current state
    await this.saveState();
    
    logger.info('FileQueueManager stopped');
  }

  /**
   * Add a processing job to the queue
   */
  async addProcessingJob(data: {
    cardId?: string;
    imageData?: Buffer;
    imagePath?: string;
    type?: string;
    settings?: Record<string, any>;
  }, priority: number = 5): Promise<QueueJob> {
    
    const job: QueueJob = {
      id: this.generateJobId(),
      type: data.type || 'card_processing',
      cardId: data.cardId,
      imageData: data.imageData,
      imagePath: data.imagePath,
      settings: data.settings,
      priority,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3
    };

    this.jobs.set(job.id, job);
    this.updateMetrics();
    
    // Save state after adding job
    await this.saveState();
    
    logger.info(`Job added to queue: ${job.id}`, {
      type: job.type,
      priority: job.priority,
      cardId: job.cardId,
      imagePath: job.imagePath
    });
    
    this.emit('jobAdded', job);
    
    return job;
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): QueueJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get pending jobs (sorted by priority and creation time)
   */
  getPendingJobs(): QueueJob[] {
    return Array.from(this.jobs.values())
      .filter(job => !job.processingCompleted && !this.processing.has(job.id))
      .filter(job => job.attempts < job.maxAttempts)
      .sort((a, b) => {
        // Higher priority first, then older jobs first
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  /**
   * Get queue metrics
   */
  getMetrics(): QueueMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    const pendingJobs = this.getPendingJobs();
    
    if (pendingJobs.length === 0) {
      return;
    }

    // Process one job at a time to avoid overwhelming the system
    const job = pendingJobs[0];
    
    if (this.processing.has(job.id)) {
      return;
    }

    try {
      await this.processJob(job);
    } catch (error) {
      logger.error(`Failed to process job ${job.id}:`, error);
      
      job.attempts++;
      job.lastError = error.message;
      
      if (job.attempts >= job.maxAttempts) {
        logger.error(`Job ${job.id} failed after ${job.maxAttempts} attempts`);
        this.emit('jobFailed', job, error);
      }
      
      await this.saveState();
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: QueueJob): Promise<void> {
    this.processing.add(job.id);
    job.processingStarted = new Date();
    job.attempts++;
    
    logger.info(`Processing job ${job.id} (attempt ${job.attempts}/${job.maxAttempts})`);
    
    try {
      // Emit job for external processing
      // The actual processing is handled by listeners to this event
      const startTime = Date.now();
      
      this.emit('processJob', job);
      
      // For now, simulate processing completion
      // In real implementation, this would be set by the processor
      await new Promise(resolve => setTimeout(resolve, 100));
      
      job.processingCompleted = new Date();
      this.processing.delete(job.id);
      
      const processingTime = Date.now() - startTime;
      
      logger.info(`Job ${job.id} completed successfully`, {
        processingTime: `${processingTime}ms`,
        type: job.type,
        cardId: job.cardId
      });
      
      this.updateMetrics();
      await this.saveState();
      
      this.emit('jobCompleted', job);
      
    } catch (error) {
      this.processing.delete(job.id);
      throw error;
    }
  }

  /**
   * Mark job as completed (called by external processor)
   */
  async completeJob(jobId: string, result?: any): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn(`Attempted to complete non-existent job: ${jobId}`);
      return;
    }

    job.processingCompleted = new Date();
    this.processing.delete(jobId);
    
    logger.info(`Job ${jobId} marked as completed`);
    
    this.updateMetrics();
    await this.saveState();
    
    this.emit('jobCompleted', job, result);
  }

  /**
   * Mark job as failed (called by external processor)
   */
  async failJob(jobId: string, error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn(`Attempted to fail non-existent job: ${jobId}`);
      return;
    }

    job.lastError = error;
    job.attempts = job.maxAttempts; // Mark as permanently failed
    this.processing.delete(jobId);
    
    logger.error(`Job ${jobId} marked as failed: ${error}`);
    
    this.updateMetrics();
    await this.saveState();
    
    this.emit('jobFailed', job, new Error(error));
  }

  /**
   * Load state from disk
   */
  private async loadState(): Promise<void> {
    try {
      // Load jobs
      const jobsData = await fs.readFile(this.jobsFile, 'utf8');
      const jobsArray = JSON.parse(jobsData);
      
      this.jobs.clear();
      for (const jobData of jobsArray) {
        // Convert date strings back to Date objects
        const job: QueueJob = {
          ...jobData,
          createdAt: new Date(jobData.createdAt),
          processingStarted: jobData.processingStarted ? new Date(jobData.processingStarted) : undefined,
          processingCompleted: jobData.processingCompleted ? new Date(jobData.processingCompleted) : undefined,
          // Convert Buffer data back to Buffer
          imageData: jobData.imageData ? Buffer.from(jobData.imageData, 'base64') : undefined
        };
        this.jobs.set(job.id, job);
      }
      
      logger.info(`Loaded ${this.jobs.size} jobs from disk`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('No existing jobs file found, starting with empty queue');
      } else {
        logger.error('Failed to load jobs from disk:', error);
      }
    }

    try {
      // Load metrics
      const metricsData = await fs.readFile(this.metricsFile, 'utf8');
      this.metrics = JSON.parse(metricsData);
      
      logger.info('Loaded metrics from disk:', this.metrics);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('No existing metrics file found, starting with default metrics');
      } else {
        logger.error('Failed to load metrics from disk:', error);
      }
    }
    
    // Update metrics based on current job state
    this.updateMetrics();
  }

  /**
   * Save state to disk
   */
  private async saveState(): Promise<void> {
    try {
      // Convert jobs to serializable format
      const jobsArray = Array.from(this.jobs.values()).map(job => ({
        ...job,
        // Convert Buffer to base64 for JSON serialization
        imageData: job.imageData ? job.imageData.toString('base64') : undefined
      }));
      
      await fs.writeFile(this.jobsFile, JSON.stringify(jobsArray, null, 2));
      await fs.writeFile(this.metricsFile, JSON.stringify(this.metrics, null, 2));
      
      logger.debug(`Saved ${jobsArray.length} jobs and metrics to disk`);
      
    } catch (error) {
      logger.error('Failed to save state to disk:', error);
    }
  }

  /**
   * Update metrics based on current job state
   */
  private updateMetrics(): void {
    const jobs = Array.from(this.jobs.values());
    
    this.metrics.pending = jobs.filter(job => 
      !job.processingCompleted && !this.processing.has(job.id) && job.attempts < job.maxAttempts
    ).length;
    
    this.metrics.processing = this.processing.size;
    
    this.metrics.completed = jobs.filter(job => 
      job.processingCompleted && job.attempts < job.maxAttempts
    ).length;
    
    this.metrics.failed = jobs.filter(job => 
      job.attempts >= job.maxAttempts && !job.processingCompleted
    ).length;
    
    this.metrics.totalProcessed = this.metrics.completed + this.metrics.failed;
  }

  /**
   * Generate unique job ID
   */
  private generateJobId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `job_${timestamp}_${random}`;
  }

  /**
   * Cleanup old completed jobs (optional maintenance)
   */
  async cleanupOldJobs(olderThanHours: number = 24): Promise<number> {
    const cutoffTime = new Date(Date.now() - (olderThanHours * 60 * 60 * 1000));
    let removedCount = 0;
    
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.processingCompleted && job.processingCompleted < cutoffTime) {
        this.jobs.delete(jobId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      await this.saveState();
      this.updateMetrics();
      
      logger.info(`Cleaned up ${removedCount} old completed jobs`);
    }
    
    return removedCount;
  }

  /**
   * Get status summary
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      totalJobs: this.jobs.size,
      processing: this.processing.size,
      metrics: this.getMetrics(),
      queueDir: this.queueDir
    };
  }
}