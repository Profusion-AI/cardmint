import * as path from 'path';
import * as fs from 'fs/promises';
import * as chokidar from 'chokidar';
import { createLogger } from '../utils/logger';
import { normalizeHeic, isHeicFilename } from '../utils/heic-normalizer';
// Avoid importing QueueManager; use a minimal interface for queue dependency
type QueueLike = {
  addProcessingJob?: (data: any, priority?: number) => Promise<any>;
};
// Lazy-load CardRepository to avoid pulling it into fast-build graph
let _cardRepo: any;
async function getCardRepo() {
  if (!_cardRepo) {
    const modPath = '../storage/' + 'CardRepository';
    const mod: any = await import(modPath);
    _cardRepo = new mod.CardRepository();
  }
  return _cardRepo;
}
import { CardStatus } from '../types';

const logger = createLogger('production-capture-watcher');

export interface WatcherConfig {
  watchDirectory: string;
  processedTrackingFile: string;
  filePattern: RegExp;
  stabilityThreshold: number; // ms to wait for file write to complete
  pollInterval: number;
  allowHeic: boolean;
  heicPreserveOriginal: boolean;
  heicQuality: number;
  heicMaxDimPx?: number;
}

export interface ProcessedFile {
  path: string;
  processedAt: Date;
  cardId: string;
  fileSize: number;
}

export class ProductionCaptureWatcher {
  private watcher?: chokidar.FSWatcher;
  private isWatching: boolean = false;
  private processedFiles: Map<string, ProcessedFile> = new Map();
  private config: WatcherConfig;

  constructor(
    private readonly queueManager: QueueLike,
    private readonly cardRepository: any,
    config?: Partial<WatcherConfig>
  ) {
    // Default configuration optimized for production Sony camera captures
    this.config = {
      watchDirectory: path.resolve('./data/inventory_images'),
      processedTrackingFile: path.resolve('./data/processed_captures.json'),
      // Accept Sony camera format AND test files: card_* OR test_* OR e2e_* files
      filePattern: /^(card_\d{8}_\d{6}(?:_\d{3})?(?:-[0-9a-f]{4})?|test_\w+|e2e_\w+)\.jpe?g$/i,
      stabilityThreshold: 150, // Atomic rename with tmpfs allows aggressive threshold
      pollInterval: 100,
      allowHeic: process.env.ALLOW_HEIC === '1' || process.env.ALLOW_HEIC === 'true',
      heicPreserveOriginal: process.env.HEIC_PRESERVE_ORIGINAL === '1' || process.env.HEIC_PRESERVE_ORIGINAL === 'true',
      heicQuality: parseInt(process.env.HEIC_NORMALIZE_QUALITY || '90', 10),
      heicMaxDimPx: process.env.HEIC_MAX_DIM_PX ? parseInt(process.env.HEIC_MAX_DIM_PX, 10) : undefined,
      ...config,
    };

    logger.info('Production Capture Watcher initialized', {
      watchDirectory: this.config.watchDirectory,
      filePattern: this.config.filePattern.source,
      stabilityThreshold: this.config.stabilityThreshold,
    });
  }

  /**
   * Start watching for new camera captures
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      logger.warn('Production capture watcher is already running');
      return;
    }

    try {
      // Ensure watch directory exists
      await fs.mkdir(this.config.watchDirectory, { recursive: true });
      
      // Load previously processed files
      await this.loadProcessedFiles();

      // Initialize file watcher with production-optimized settings
      // Use a glob to avoid accidentally ignoring the root directory
      const pattern = this.config.allowHeic ? '*.{jpg,jpeg,heic}' : '*.{jpg,jpeg}';
      const watchGlob = path.join(this.config.watchDirectory, pattern);
      this.watcher = chokidar.watch(watchGlob, {
        persistent: true,
        ignoreInitial: false, // Process existing files on startup
        awaitWriteFinish: {
          stabilityThreshold: this.config.stabilityThreshold,
          pollInterval: this.config.pollInterval
        },
        usePolling: true, // More reliable inside containers/sandboxes
        interval: 300, // Polling interval for changes
        ignorePermissionErrors: true,
        depth: 1, // Only watch immediate directory, not subdirectories
      });

      // Handle new files
      this.watcher.on('add', async (filePath: string) => {
        await this.handleNewCapture(filePath);
      });

      // Debug: log all watcher events for diagnosis
      this.watcher.on('all', (event: string, p: string) => {
        logger.debug('Watcher event', { event, path: p });
      });

      // Handle file changes (in case of overwriting)
      this.watcher.on('change', async (filePath: string) => {
        await this.handleNewCapture(filePath);
      });

      // Handle errors
      this.watcher.on('error', (error: any) => {
        logger.error('File watcher error:', error);
      });

      // Handle watcher ready
      this.watcher.on('ready', () => {
        logger.info(`Production capture watcher started, monitoring: ${watchGlob}`);
        logger.info(`Loaded ${this.processedFiles.size} previously processed files`);
      });

      this.isWatching = true;
      
    } catch (error) {
      logger.error('Failed to start production capture watcher:', error);
      throw error;
    }
  }

  /**
   * Stop watching for captures
   */
  async stop(): Promise<void> {
    if (!this.isWatching) {
      return;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    // Save processed files state
    await this.saveProcessedFiles();

    this.isWatching = false;
    logger.info('Production capture watcher stopped');
  }

  /**
   * Load previously processed files from disk
   */
  private async loadProcessedFiles(): Promise<void> {
    try {
      const data = await fs.readFile(this.config.processedTrackingFile, 'utf8');
      const processedData = JSON.parse(data);
      
      // Convert to Map with Date objects
      for (const [filePath, fileData] of Object.entries(processedData as Record<string, any>)) {
        this.processedFiles.set(filePath, {
          ...fileData,
          processedAt: new Date(fileData.processedAt),
        });
      }
      
      logger.info(`Loaded ${this.processedFiles.size} processed files from disk`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.info('No processed files tracking file found, starting fresh');
      } else {
        logger.error('Failed to load processed files:', error);
      }
    }
  }

  /**
   * Save processed files state to disk
   */
  private async saveProcessedFiles(): Promise<void> {
    try {
      // Convert Map to plain object for JSON serialization
      const processedData: Record<string, ProcessedFile> = {};
      
      for (const [filePath, fileData] of this.processedFiles) {
        processedData[filePath] = fileData;
      }
      
      const dataDir = path.dirname(this.config.processedTrackingFile);
      await fs.mkdir(dataDir, { recursive: true });
      
      await fs.writeFile(
        this.config.processedTrackingFile,
        JSON.stringify(processedData, null, 2)
      );
      
      logger.debug(`Saved ${this.processedFiles.size} processed files to disk`);
      
    } catch (error) {
      logger.error('Failed to save processed files:', error);
    }
  }

  /**
   * Handle a new capture file detected by the watcher
   */
  private async handleNewCapture(filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    const absolutePath = path.resolve(filePath);
    
    // Skip if already processed
    if (this.processedFiles.has(absolutePath)) {
      logger.debug(`Skipping already processed file: ${filename}`);
      return;
    }

    logger.info(`New production capture detected: ${filename}`);
    const startTime = Date.now();

    try {
      // HEIC normalize-on-ingest (Strategy A), guarded by env flag
      // (Codex-CTO) HEIC normalize-on-ingest stub path (guarded by ALLOW_HEIC)
      if (this.config.allowHeic && isHeicFilename(filename)) {
        logger.info('HEIC detected — normalizing to JPEG', { filename });
        const jpegTarget = absolutePath.replace(/\.(heic|heif)$/i, '.jpg');
        const tmpTarget = `${jpegTarget}.tmp`;
        try {
          const inputBuf = await fs.readFile(absolutePath);
          const { jpegBuffer, info } = await normalizeHeic(inputBuf, {
            quality: this.config.heicQuality,
            maxDimPx: this.config.heicMaxDimPx,
            preserveMetadata: true,
          });
          await fs.writeFile(tmpTarget, jpegBuffer);
          await fs.rename(tmpTarget, jpegTarget);
          logger.info('HEIC normalized to JPEG', {
            method: info.method,
            sizeBytes: info.sizeBytes,
            originalSizeBytes: info.originalSizeBytes,
            jpegFilename: path.basename(jpegTarget),
          });
          if (!this.config.heicPreserveOriginal) {
            await fs.unlink(absolutePath).catch(() => {});
          }
          // The watcher will pick up the new .jpg and process it
          return;
        } catch (e: any) {
          logger.error('HEIC normalization failed; leaving file unprocessed', { error: e?.message || String(e) });
          return;
        }
      }
      // Verify file exists and get stats
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        logger.warn(`Not a file: ${absolutePath}`);
        return;
      }

      // Additional file validation
      if (stats.size < 1024) { // Files smaller than 1KB are likely incomplete
        logger.warn(`File too small (${stats.size} bytes), skipping: ${filename}`);
        return;
      }

      // Extract timestamp from filename (card_YYYYMMDD_HHMMSS(_mmm)?(-xxxx)?.jpg)
      const timestampMatch = filename.match(/card_(\d{8})_(\d{6})(?:_\d{3})?(?:-[0-9a-f]{4})?\.jpe?g$/i);
      let captureTimestamp: Date;
      
      if (timestampMatch) {
        const dateStr = timestampMatch[1]; // 20250827
        const timeStr = timestampMatch[2]; // 153045
        
        const year = parseInt(dateStr.substring(0, 4));
        const month = parseInt(dateStr.substring(4, 6)) - 1; // Month is 0-indexed
        const day = parseInt(dateStr.substring(6, 8));
        const hour = parseInt(timeStr.substring(0, 2));
        const minute = parseInt(timeStr.substring(2, 4));
        const second = parseInt(timeStr.substring(4, 6));
        
        captureTimestamp = new Date(year, month, day, hour, minute, second);
      } else {
        captureTimestamp = stats.birthtime || stats.mtime || new Date();
      }

      // Create card record in database
      const repo = this.cardRepository || await getCardRepo();
      const card = await repo.createCard({
        imageUrl: absolutePath,
        status: CardStatus.QUEUED,
        metadata: {
          captureTimestamp,
          fileSize: stats.size,
          watcherProcessedAt: new Date(),
          source: 'production_camera',
        } as any
      });

      logger.info(`Created card record: ${card.id} for ${filename}`);

      // Read image data for processing queue
      const imageData = await fs.readFile(absolutePath);

      // Add to ML processing queue
      const job = this.queueManager.addProcessingJob ? await this.queueManager.addProcessingJob({
        cardId: card.id,
        imageData: imageData,
        imagePath: absolutePath,
        type: 'production_capture',
        settings: {
          ocrEnabled: true,
          generateThumbnail: true,
          enhanceImage: true,
          mlProcessing: true,
          highPriority: true, // Production captures get priority
        }
      }) : { id: 'simulated' } as any;

      // Mark as processed
      const processedFile: ProcessedFile = {
        path: absolutePath,
        processedAt: new Date(),
        cardId: card.id,
        fileSize: stats.size,
      };
      
      this.processedFiles.set(absolutePath, processedFile);

      // Save processed files state (non-blocking)
      setImmediate(() => this.saveProcessedFiles());

      const processingTime = Date.now() - startTime;
      logger.info(`Queued production capture for processing`, {
        filename,
        cardId: card.id,
        jobId: job.id,
        processingTime: `${processingTime}ms`,
        fileSize: `${(stats.size / 1024 / 1024).toFixed(2)}MB`,
        captureTimestamp: captureTimestamp.toISOString(),
      });

      // Emit event for monitoring/telemetry
      (process as any).emit('cardmint:capture:queued', {
        filename,
        cardId: card.id,
        jobId: job.id,
        processingTime,
        fileSize: stats.size,
        imagePath: absolutePath,
      });

    } catch (error) {
      logger.error(`Failed to process production capture ${filename}:`, error);
      
      // Emit error event for monitoring
      (process as any).emit('cardmint:capture:error', {
        filename,
        error: error.message,
        imagePath: absolutePath,
      });
      
      // Don't mark as processed so it can be retried on restart
    }
  }

  /**
   * Manually reprocess a specific file (useful for debugging)
   */
  async reprocessFile(filename: string): Promise<void> {
    const filePath = path.resolve(this.config.watchDirectory, filename);
    
    // Remove from processed set to force reprocessing
    this.processedFiles.delete(filePath);
    
    logger.info(`Manually reprocessing file: ${filename}`);
    await this.handleNewCapture(filePath);
  }

  /**
   * Get current watcher status and statistics
   */
  getStatus(): {
    watching: boolean;
    watchDirectory: string;
    processedCount: number;
    config: WatcherConfig;
    recentFiles: ProcessedFile[];
  } {
    // Get 10 most recent processed files
    const sortedFiles = Array.from(this.processedFiles.values())
      .sort((a, b) => b.processedAt.getTime() - a.processedAt.getTime())
      .slice(0, 10);

    return {
      watching: this.isWatching,
      watchDirectory: this.config.watchDirectory,
      processedCount: this.processedFiles.size,
      config: this.config,
      recentFiles: sortedFiles,
    };
  }

  /**
   * Clear processed files history (use with caution)
   */
  async clearProcessedHistory(): Promise<void> {
    logger.warn('Clearing processed files history');
    
    this.processedFiles.clear();
    
    try {
      await fs.unlink(this.config.processedTrackingFile);
      logger.info('Processed files tracking file deleted');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to delete processed files tracking file:', error);
      }
    }
  }

  /**
   * Get list of unprocessed files in watch directory
   */
  async getUnprocessedFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.config.watchDirectory);
      const unprocessed: string[] = [];
      
      for (const filename of files) {
        const filePath = path.resolve(this.config.watchDirectory, filename);
        
        if (this.config.filePattern.test(filename) && !this.processedFiles.has(filePath)) {
          unprocessed.push(filename);
        }
      }
      
      return unprocessed;
    } catch (error) {
      logger.error('Failed to get unprocessed files:', error);
      return [];
    }
  }

  /**
   * Cleanup - stop watcher and save state
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up production capture watcher...');
    await this.stop();
    logger.info('Production capture watcher cleanup complete');
  }
}
