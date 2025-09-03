/**
 * Folder-based image source for passive card scanning
 * 
 * Watches a directory for new image files and processes them one-by-one.
 * Ideal for passive scanning mode where camera SDK saves files directly.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';

// Platform-agnostic image source interface
export interface ImageSource {
  next(): Promise<{ imagePath: string; metadata?: any }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

// Configuration for folder watching
export interface FolderSourceConfig {
  watchPath: string;
  filePattern: RegExp;
  processedPath?: string;    // Move processed files here
  errorPath?: string;        // Move failed files here
  maxRetries?: number;       // Retry failed files
  debounceMs?: number;       // Wait for file writes to complete
  preserveOrder?: boolean;   // Process files in chronological order
}

// Image file entry with metadata
interface ImageEntry {
  path: string;
  filename: string;
  timestamp: Date;
  size: number;
  retries: number;
}

export class FolderImageSource extends EventEmitter implements ImageSource {
  private readonly config: Required<FolderSourceConfig>;
  private watcher?: FSWatcher;
  private queue: ImageEntry[] = [];
  private processing = false;
  private running = false;
  
  // Default supported image formats
  private static readonly DEFAULT_PATTERN = /\.(jpg|jpeg|png|tiff|bmp)$/i;
  
  constructor(config: FolderSourceConfig) {
    super();
    
    this.config = {
      filePattern: config.filePattern || FolderImageSource.DEFAULT_PATTERN,
      processedPath: config.processedPath || path.join(config.watchPath, 'processed'),
      errorPath: config.errorPath || path.join(config.watchPath, 'errors'),
      maxRetries: config.maxRetries || 3,
      debounceMs: config.debounceMs || 500,
      preserveOrder: config.preserveOrder ?? true,
      ...config,
    };
  }
  
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    
    try {
      // Ensure directories exist
      await this.ensureDirectories();
      
      // Scan for existing files first
      await this.scanExistingFiles();
      
      // Start filesystem watcher
      this.watcher = chokidar.watch(this.config.watchPath, {
        ignored: [
          this.config.processedPath,
          this.config.errorPath,
          /[\/\\]\./,  // Hidden files
        ],
        persistent: true,
        ignoreInitial: true, // We already scanned existing files
        awaitWriteFinish: {
          stabilityThreshold: this.config.debounceMs,
          pollInterval: 100,
        },
      });
      
      // Handle new files
      this.watcher.on('add', (filePath: string) => {
        if (this.config.filePattern.test(filePath)) {
          this.addToQueue(filePath);
        }
      });
      
      this.watcher.on('error', (error) => {
        this.emit('error', new Error(`Folder watcher error: ${error.message}`));
      });
      
      this.running = true;
      this.emit('started');
      
    } catch (error) {
      throw new Error(`Failed to start folder source: ${error}`);
    }
  }
  
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    
    this.running = false;
    
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    
    // Clear queue
    this.queue = [];
    this.processing = false;
    
    this.emit('stopped');
  }
  
  isRunning(): boolean {
    return this.running;
  }
  
  async next(): Promise<{ imagePath: string; metadata?: any }> {
    if (!this.running) {
      throw new Error('Image source is not running');
    }
    
    // Wait for next image in queue
    while (this.queue.length === 0) {
      await this.waitForImage();
    }
    
    const entry = this.queue.shift()!;
    
    try {
      // Validate file still exists and is readable
      const stats = await fs.stat(entry.path);
      
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${entry.path}`);
      }
      
      // Double-check file is complete (size hasn't changed)
      if (stats.size !== entry.size) {
        throw new Error(`File size changed during processing: ${entry.path}`);
      }
      
      return {
        imagePath: entry.path,
        metadata: {
          filename: entry.filename,
          timestamp: entry.timestamp,
          size: entry.size,
          queuePosition: this.queue.length,
        },
      };
      
    } catch (error) {
      // Handle failed files
      await this.handleFailedFile(entry, error as Error);
      
      // Try next file in queue
      if (this.queue.length > 0) {
        return this.next();
      }
      
      throw new Error(`No valid images available: ${error}`);
    }
  }
  
  // Move processed file to processed directory
  async markProcessed(imagePath: string): Promise<void> {
    try {
      const filename = path.basename(imagePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const processedPath = path.join(this.config.processedPath, `${timestamp}_${filename}`);
      
      await fs.rename(imagePath, processedPath);
      this.emit('processed', { originalPath: imagePath, processedPath });
      
    } catch (error) {
      this.emit('error', new Error(`Failed to mark file as processed: ${error}`));
    }
  }
  
  // Move failed file to error directory
  async markFailed(imagePath: string, error: Error): Promise<void> {
    try {
      const filename = path.basename(imagePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const errorPath = path.join(this.config.errorPath, `${timestamp}_${filename}`);
      
      await fs.rename(imagePath, errorPath);
      
      // Write error log alongside the file
      const errorLogPath = `${errorPath}.error.txt`;
      await fs.writeFile(errorLogPath, `${error.message}\n${error.stack || ''}`);
      
      this.emit('failed', { originalPath: imagePath, errorPath, error: error.message });
      
    } catch (moveError) {
      this.emit('error', new Error(`Failed to mark file as failed: ${moveError}`));
    }
  }
  
  // Get queue status for monitoring
  getStatus(): {
    running: boolean;
    queueLength: number;
    oldestFile?: string;
    newestFile?: string;
  } {
    return {
      running: this.running,
      queueLength: this.queue.length,
      oldestFile: this.queue[0]?.filename,
      newestFile: this.queue[this.queue.length - 1]?.filename,
    };
  }
  
  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.config.watchPath, { recursive: true });
    await fs.mkdir(this.config.processedPath, { recursive: true });
    await fs.mkdir(this.config.errorPath, { recursive: true });
  }
  
  private async scanExistingFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.watchPath);
      
      for (const file of files) {
        const filePath = path.join(this.config.watchPath, file);
        
        try {
          const stats = await fs.stat(filePath);
          
          if (stats.isFile() && this.config.filePattern.test(file)) {
            await this.addToQueue(filePath);
          }
        } catch (error) {
          // Skip files we can't read
          continue;
        }
      }
      
      if (this.queue.length > 0) {
        this.emit('existing-files', this.queue.length);
      }
      
    } catch (error) {
      this.emit('error', new Error(`Failed to scan existing files: ${error}`));
    }
  }
  
  private async addToQueue(filePath: string): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      const filename = path.basename(filePath);
      
      const entry: ImageEntry = {
        path: filePath,
        filename,
        timestamp: stats.mtime,
        size: stats.size,
        retries: 0,
      };
      
      this.queue.push(entry);
      
      // Sort by timestamp if preserving order
      if (this.config.preserveOrder) {
        this.queue.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      }
      
      this.emit('file-added', { filename, queueLength: this.queue.length });
      
    } catch (error) {
      this.emit('error', new Error(`Failed to add file to queue: ${filePath} - ${error}`));
    }
  }
  
  private async waitForImage(): Promise<void> {
    return new Promise((resolve) => {
      // Check every 100ms for new images
      const checkInterval = setInterval(() => {
        if (this.queue.length > 0 || !this.running) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      
      // Also resolve immediately if a file is added
      this.once('file-added', () => {
        clearInterval(checkInterval);
        resolve();
      });
    });
  }
  
  private async handleFailedFile(entry: ImageEntry, error: Error): Promise<void> {
    entry.retries++;
    
    if (entry.retries <= this.config.maxRetries) {
      // Retry the file
      this.queue.unshift(entry); // Add back to front for immediate retry
      this.emit('retry', { filename: entry.filename, attempt: entry.retries });
    } else {
      // Move to error directory
      await this.markFailed(entry.path, error);
    }
  }
}

// Utility function to create a basic folder source
export function createFolderSource(watchPath: string, options?: Partial<FolderSourceConfig>): FolderImageSource {
  return new FolderImageSource({
    watchPath,
    ...options,
  });
}

// Event types for TypeScript
declare interface FolderImageSource {
  on(event: 'started', listener: () => void): this;
  on(event: 'stopped', listener: () => void): this;
  on(event: 'file-added', listener: (data: { filename: string; queueLength: number }) => void): this;
  on(event: 'processed', listener: (data: { originalPath: string; processedPath: string }) => void): this;
  on(event: 'failed', listener: (data: { originalPath: string; errorPath: string; error: string }) => void): this;
  on(event: 'retry', listener: (data: { filename: string; attempt: number }) => void): this;
  on(event: 'existing-files', listener: (count: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}