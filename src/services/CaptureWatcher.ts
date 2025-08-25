import * as path from 'path';
import * as fs from 'fs/promises';
import * as chokidar from 'chokidar';
import { createLogger } from '../utils/logger';
import { QueueManager } from '../queue/QueueManager';
import { CardRepository } from '../storage/CardRepository';
import { CardStatus } from '../types';

const logger = createLogger('capture-watcher');

export class CaptureWatcher {
  private watcher?: chokidar.FSWatcher;
  private captureDir: string = '/home/profusionai/CardMint/captures';
  private processedFiles: Set<string> = new Set();
  private isWatching: boolean = false;

  constructor(
    private readonly queueManager: QueueManager,
    private readonly cardRepository: CardRepository
  ) {
    logger.info('CaptureWatcher initialized', { captureDir: this.captureDir });
  }

  /**
   * Start watching the capture directory for new images
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      logger.warn('CaptureWatcher is already running');
      return;
    }

    try {
      // Ensure capture directory exists
      await fs.access(this.captureDir);
      
      // Load existing files to avoid reprocessing
      await this.loadExistingFiles();

      // Initialize watcher
      this.watcher = chokidar.watch(this.captureDir, {
        persistent: true,
        ignoreInitial: false, // Process existing files on startup
        awaitWriteFinish: {
          stabilityThreshold: 500, // Wait 500ms for file to finish writing
          pollInterval: 100
        },
        ignored: (filePath: string) => {
          // Only watch for JPG files matching DSC pattern
          const basename = path.basename(filePath);
          return !basename.match(/^DSC\d{5}\.JPG$/i);
        }
      });

      // Handle new files
      this.watcher.on('add', async (filePath: string) => {
        await this.handleNewCapture(filePath);
      });

      // Handle errors
      this.watcher.on('error', (error: Error) => {
        logger.error('Watcher error:', error);
      });

      this.isWatching = true;
      logger.info(`Started watching ${this.captureDir} for new captures`);
      
    } catch (error) {
      logger.error('Failed to start CaptureWatcher:', error);
      throw error;
    }
  }

  /**
   * Stop watching the capture directory
   */
  async stop(): Promise<void> {
    if (!this.isWatching) {
      return;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    this.isWatching = false;
    logger.info('CaptureWatcher stopped');
  }

  /**
   * Load existing files to avoid reprocessing them
   */
  private async loadExistingFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.captureDir);
      const jpgFiles = files.filter(f => f.match(/^DSC\d{5}\.JPG$/i));
      
      // Check database for already processed files
      for (const file of jpgFiles) {
        const filePath = path.join(this.captureDir, file);
        const existingCard = await this.cardRepository.findByImagePath(filePath);
        
        if (existingCard) {
          this.processedFiles.add(filePath);
          logger.debug(`Marked as processed: ${file} (card ID: ${existingCard.id})`);
        }
      }
      
      logger.info(`Loaded ${this.processedFiles.size} already processed files`);
      
    } catch (error) {
      logger.error('Failed to load existing files:', error);
    }
  }

  /**
   * Handle a new capture file
   */
  private async handleNewCapture(filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    
    // Skip if already processed
    if (this.processedFiles.has(filePath)) {
      logger.debug(`Skipping already processed file: ${filename}`);
      return;
    }

    logger.info(`New capture detected: ${filename}`);
    const startTime = Date.now();

    try {
      // Verify file exists and is readable
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        logger.warn(`Not a file: ${filePath}`);
        return;
      }

      // Extract capture number from filename (DSC00001.JPG -> 1)
      const captureNumber = parseInt(filename.match(/DSC(\d{5})/)?.[1] || '0', 10);

      // Create card record in database
      const card = await this.cardRepository.createCard({
        imageUrl: filePath,
        status: CardStatus.QUEUED,
        metadata: {
          captureNumber,
          captureTimestamp: stats.birthtime,
          fileSize: stats.size,
          filename
        }
      });

      logger.info(`Created card record: ${card.id} for ${filename}`);

      // Read image data for processing
      const imageData = await fs.readFile(filePath);

      // Add to OCR processing queue
      const job = await this.queueManager.addProcessingJob({
        cardId: card.id,
        imageData: imageData,
        imagePath: filePath,
        type: 'ocr',
        settings: {
          ocrEnabled: true,
          generateThumbnail: true,
          enhanceImage: true
        }
      });

      // Mark as processed
      this.processedFiles.add(filePath);

      const queueTime = Date.now() - startTime;
      logger.info(`Queued OCR job ${job.id} for ${filename} (${queueTime}ms)`);

      // Log summary
      logger.info('Capture → OCR pipeline triggered', {
        filename,
        cardId: card.id,
        jobId: job.id,
        queueTime,
        fileSize: `${(stats.size / 1024 / 1024).toFixed(2)}MB`
      });

    } catch (error) {
      logger.error(`Failed to process capture ${filename}:`, error);
      // Don't mark as processed so it can be retried
    }
  }

  /**
   * Manually trigger processing of a specific file
   */
  async processFile(filename: string): Promise<void> {
    const filePath = path.join(this.captureDir, filename);
    
    // Remove from processed set to force reprocessing
    this.processedFiles.delete(filePath);
    
    await this.handleNewCapture(filePath);
  }

  /**
   * Get watcher status
   */
  getStatus(): {
    watching: boolean;
    captureDir: string;
    processedCount: number;
  } {
    return {
      watching: this.isWatching,
      captureDir: this.captureDir,
      processedCount: this.processedFiles.size
    };
  }
}