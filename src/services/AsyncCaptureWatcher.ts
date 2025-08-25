/**
 * AsyncCaptureWatcher - Non-blocking capture detection system
 * 
 * This watcher ensures Fedora NEVER blocks on capture detection.
 * It uses a fire-and-forget pattern with two-stage queuing to maintain
 * consistent sub-50ms detection times regardless of processing speed.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as chokidar from 'chokidar';
import { createLogger } from '../utils/logger';
import { QueueManager } from '../queue/QueueManager';

const logger = createLogger('async-capture-watcher');

export interface CaptureMetrics {
  capturesDetected: number;
  capturesQueued: number;
  capturesDropped: number;
  avgDetectionTimeMs: number;
  lastDetectionTimeMs: number;
  queueDepth: number;
  isDeferring: boolean;
}

export interface WatcherConfig {
  captureDir: string;
  watchPattern: RegExp;
  maxQueueDepth: number;
  enableDeduplication: boolean;
  preprocessImages: boolean;
  tempSuffix: string;
}

export class AsyncCaptureWatcher extends EventEmitter {
  private watcher?: chokidar.FSWatcher;
  private config: WatcherConfig;
  private isWatching: boolean = false;
  private processedHashes: Set<string> = new Set();
  private metrics: CaptureMetrics;
  private detectionTimes: number[] = [];
  private maxDetectionHistory: number = 100;
  
  constructor(
    private readonly queueManager: QueueManager,
    config?: Partial<WatcherConfig>
  ) {
    super();
    
    this.config = {
      captureDir: '/home/profusionai/CardMint/captures',
      watchPattern: /^DSC\d{5}\.JPG$/i,
      maxQueueDepth: 300, // Hard cap on ingestion queue
      enableDeduplication: true,
      preprocessImages: false, // Light preprocessing before queue
      tempSuffix: '.tmp',
      ...config
    };
    
    this.metrics = this.initializeMetrics();
    
    logger.info('AsyncCaptureWatcher initialized', {
      captureDir: this.config.captureDir,
      maxQueueDepth: this.config.maxQueueDepth,
      deduplication: this.config.enableDeduplication
    });
  }
  
  private initializeMetrics(): CaptureMetrics {
    return {
      capturesDetected: 0,
      capturesQueued: 0,
      capturesDropped: 0,
      avgDetectionTimeMs: 0,
      lastDetectionTimeMs: 0,
      queueDepth: 0,
      isDeferring: false
    };
  }
  
  /**
   * Start watching - completely non-blocking
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      logger.warn('AsyncCaptureWatcher is already running');
      return;
    }
    
    try {
      // Verify directory exists (this is the only blocking call at startup)
      await fs.access(this.config.captureDir);
      
      // Initialize watcher with optimized settings
      this.watcher = chokidar.watch(this.config.captureDir, {
        persistent: true,
        ignoreInitial: true, // Don't process existing files on startup
        awaitWriteFinish: false, // Don't wait - handle atomically with rename
        atomic: true, // Better handling of file moves
        ignored: (filePath: string) => {
          const basename = path.basename(filePath);
          // Ignore temp files and non-matching patterns
          return basename.endsWith(this.config.tempSuffix) || 
                 !basename.match(this.config.watchPattern);
        }
      });
      
      // Handle new files - COMPLETELY NON-BLOCKING
      this.watcher.on('add', (filePath: string) => {
        // Fire and forget - no await!
        setImmediate(() => this.handleNewCapture(filePath));
      });
      
      // Handle file moves (atomic writes from camera)
      this.watcher.on('change', (filePath: string) => {
        // Could be a rename from .tmp to final
        setImmediate(() => this.handleNewCapture(filePath));
      });
      
      // Handle errors
      this.watcher.on('error', (error: Error) => {
        logger.error('Watcher error:', error);
        this.emit('error', error);
      });
      
      this.isWatching = true;
      logger.info(`Started async watching ${this.config.captureDir}`);
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start AsyncCaptureWatcher:', error);
      throw error;
    }
  }
  
  /**
   * Handle new capture - NEVER BLOCKS
   */
  private async handleNewCapture(filePath: string): Promise<void> {
    const startTime = Date.now();
    const filename = path.basename(filePath);
    
    this.metrics.capturesDetected++;
    
    try {
      // Quick deduplication check if enabled
      if (this.config.enableDeduplication) {
        const hash = await this.computeQuickHash(filePath);
        if (!hash || this.processedHashes.has(hash)) {
          logger.debug(`Skipping duplicate: ${filename}`);
          return;
        }
        this.processedHashes.add(hash);
        
        // Keep hash set bounded
        if (this.processedHashes.size > 10000) {
          const toDelete = Array.from(this.processedHashes).slice(0, 5000);
          toDelete.forEach(h => this.processedHashes.delete(h));
        }
      }
      
      // Check queue depth for backpressure
      const queueDepth = await this.queueManager.getIngestionQueueDepth();
      this.metrics.queueDepth = queueDepth;
      
      if (queueDepth >= this.config.maxQueueDepth) {
        logger.warn(`Queue full (${queueDepth}/${this.config.maxQueueDepth}), dropping ${filename}`);
        this.metrics.capturesDropped++;
        this.metrics.isDeferring = true;
        this.emit('backpressure', { 
          filename, 
          queueDepth, 
          maxDepth: this.config.maxQueueDepth 
        });
        return;
      }
      
      // Queue for ingestion - MINIMAL DATA
      // Just the path and metadata, no file reading!
      const jobData = {
        filePath,
        filename,
        timestamp: Date.now(),
        captureNumber: this.extractCaptureNumber(filename),
        contentHash: this.config.enableDeduplication ? 
                     await this.computeQuickHash(filePath) : undefined
      };
      
      // Fire and forget the queue operation
      this.queueManager.addIngestionJob(jobData)
        .then(() => {
          this.metrics.capturesQueued++;
          this.metrics.isDeferring = false;
          logger.debug(`Queued ${filename} for ingestion`);
        })
        .catch(err => {
          logger.error(`Failed to queue ${filename}:`, err);
          this.metrics.capturesDropped++;
        });
      
      // Record detection time
      const detectionTime = Date.now() - startTime;
      this.recordDetectionTime(detectionTime);
      
      // Emit metrics for UI
      this.emit('capture', {
        filename,
        detectionTimeMs: detectionTime,
        queueDepth: queueDepth + 1,
        metrics: this.getMetrics()
      });
      
    } catch (error) {
      // Even errors don't block - just log and move on
      logger.error(`Error handling ${filename}:`, error);
      this.emit('error', { filename, error });
    }
  }
  
  /**
   * Compute a quick hash for deduplication (non-blocking)
   */
  private async computeQuickHash(filePath: string): Promise<string | null> {
    try {
      // Read just first 4KB for quick hash
      const buffer = Buffer.alloc(4096);
      const fd = await fs.open(filePath, 'r');
      await fd.read(buffer, 0, 4096, 0);
      await fd.close();
      
      return createHash('blake2b512')
        .update(buffer)
        .digest('hex')
        .substring(0, 16); // Just need uniqueness, not cryptographic security
    } catch (error) {
      logger.debug(`Could not hash ${filePath}:`, error);
      return null;
    }
  }
  
  /**
   * Extract capture number from filename
   */
  private extractCaptureNumber(filename: string): number {
    const match = filename.match(/DSC(\d{5})/);
    return match ? parseInt(match[1], 10) : 0;
  }
  
  /**
   * Record detection time for metrics
   */
  private recordDetectionTime(timeMs: number): void {
    this.detectionTimes.push(timeMs);
    if (this.detectionTimes.length > this.maxDetectionHistory) {
      this.detectionTimes.shift();
    }
    
    this.metrics.lastDetectionTimeMs = timeMs;
    this.metrics.avgDetectionTimeMs = 
      this.detectionTimes.reduce((a, b) => a + b, 0) / this.detectionTimes.length;
    
    // Warn if detection is getting slow
    if (timeMs > 50) {
      logger.warn(`Slow detection: ${timeMs}ms`);
    }
  }
  
  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (!this.isWatching) return;
    
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    
    this.isWatching = false;
    logger.info('AsyncCaptureWatcher stopped');
    this.emit('stopped');
  }
  
  /**
   * Get current metrics
   */
  getMetrics(): CaptureMetrics {
    return { ...this.metrics };
  }
  
  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = this.initializeMetrics();
    this.detectionTimes = [];
  }
  
  /**
   * Get watcher status
   */
  getStatus(): {
    watching: boolean;
    captureDir: string;
    metrics: CaptureMetrics;
    hashCacheSize: number;
  } {
    return {
      watching: this.isWatching,
      captureDir: this.config.captureDir,
      metrics: this.getMetrics(),
      hashCacheSize: this.processedHashes.size
    };
  }
  
  /**
   * Clear processed hashes (for testing or reset)
   */
  clearHashCache(): void {
    this.processedHashes.clear();
    logger.info('Cleared hash cache');
  }
}