/**
 * Distributed Integration Service
 * 
 * Orchestrates the complete Fedora ⇄ Mac ⇄ Fedora pipeline
 * Integrates with existing CardMint services while adding distributed processing
 */

import { DistributedRouter, WorkItem } from './DistributedRouter';
import { createCardStorage } from '../storage/DistributedCardStorage';
import { QwenScannerService } from './QwenScannerService';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { createHybridConfig } from '../config/distributedV2';
import { CardRepository } from '../storage/CardRepository';
import path from 'path';
import fs from 'fs/promises';

export interface InboxWatcherConfig {
  inbox_path: string;
  watch_patterns: string[];
  processing_delay_ms: number;
  batch_collection_timeout_ms: number;
}

export interface DistributedPipelineStats {
  total_processed: number;
  cards_per_minute: number;
  avg_processing_time_ms: number;
  verification_rate: number;
  error_rate: number;
  mac_health: boolean;
  queue_depth: number;
}

export class DistributedIntegration {
  private router: DistributedRouter;
  private storage: any; // CardStorage interface
  private qwenScanner: QwenScannerService;
  private cardRepository: CardRepository;
  private isRunning = false;
  private config: any;

  // Stats tracking
  private startTime = Date.now();
  private processedCount = 0;
  private lastProcessedTime = Date.now();

  constructor() {
    // Get hybrid configuration (V1/V2 compatible)
    this.config = createHybridConfig().getActiveConfig();
    
    // Initialize services
    this.router = new DistributedRouter(this.config.router);
    this.storage = createCardStorage(this.config.storage);
    this.qwenScanner = new QwenScannerService();
    this.cardRepository = new CardRepository();

    // Setup metrics
    this.setupMetrics();

    logger.info('DistributedIntegration initialized', { 
      config_version: createHybridConfig().shouldUseV2() ? 'v2' : 'v1_compat',
      mac_endpoint: this.config.router.mac_endpoint 
    });
  }

  /**
   * Start the complete distributed pipeline
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Distributed pipeline already running');
      return;
    }

    try {
      logger.info('Starting distributed CardMint pipeline...');
      
      // Start distributed router
      await this.router.start();
      
      // Start inbox watcher
      this.startInboxWatcher();
      
      // Start health monitoring
      this.startHealthMonitoring();
      
      this.isRunning = true;
      
      logger.info('Distributed CardMint pipeline started successfully');
      
    } catch (error) {
      logger.error('Failed to start distributed pipeline:', error);
      throw error;
    }
  }

  /**
   * Process a single card through the distributed pipeline
   */
  async processSingleCard(imagePath: string, options: {
    priority?: 'normal' | 'high' | 'critical';
    value_tier?: 'common' | 'rare' | 'holo' | 'vintage' | 'high_value';
    hint?: { set?: string; num?: string };
  } = {}): Promise<string> {
    
    const workItem: WorkItem = {
      id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      path: imagePath,
      priority: options.priority || 'normal',
      value_tier: options.value_tier || 'common',
      hint: options.hint,
      created_at: new Date(),
      retries: 0
    };

    logger.info(`Processing single card: ${path.basename(imagePath)}`, {
      work_id: workItem.id,
      priority: workItem.priority,
      value_tier: workItem.value_tier
    });

    // Enqueue for distributed processing
    await this.router.enqueue(workItem);

    // Track metrics
    metrics.incrementCounter('distributed_cards_enqueued', {
      priority: workItem.priority,
      tier: workItem.value_tier
    });

    return workItem.id;
  }

  /**
   * Process a batch of cards from directory
   */
  async processBatch(directoryPath: string, options: {
    pattern?: string;
    max_files?: number;
    default_tier?: string;
  } = {}): Promise<string[]> {
    
    const batchStart = Date.now();
    const pattern = options.pattern || '*.{jpg,jpeg,png,webp}';
    const maxFiles = options.max_files || 100;

    try {
      logger.info(`Starting batch processing: ${directoryPath}`);
      
      // Get list of image files
      const files = await this.getImageFiles(directoryPath, pattern);
      const filesToProcess = files.slice(0, maxFiles);
      
      // Create work items
      const workItems: WorkItem[] = filesToProcess.map((file, index) => ({
        id: `batch_${Date.now()}_${index.toString().padStart(3, '0')}`,
        path: file,
        priority: 'normal',
        value_tier: (options.default_tier as any) || this.detectValueTier(file),
        created_at: new Date(),
        retries: 0
      }));

      // Enqueue all work items
      const enqueuePromises = workItems.map(item => this.router.enqueue(item));
      await Promise.all(enqueuePromises);

      const batchTime = Date.now() - batchStart;
      
      logger.info(`Batch enqueued: ${workItems.length} files in ${batchTime}ms`);
      
      metrics.recordHistogram('distributed_batch_enqueue_ms', batchTime);
      metrics.incrementCounter('distributed_batches_processed');

      return workItems.map(item => item.id);

    } catch (error) {
      logger.error('Batch processing failed:', error);
      metrics.recordError('distributed_batch_failed');
      throw error;
    }
  }

  /**
   * Get pipeline statistics
   */
  async getStats(): Promise<DistributedPipelineStats> {
    const routerStats = this.router.getStatistics();
    const storageStats = await this.storage.getStats();
    const runtime = Date.now() - this.startTime;
    const runtimeMinutes = runtime / 60000;

    return {
      total_processed: routerStats.total_processed,
      cards_per_minute: runtimeMinutes > 0 ? routerStats.total_processed / runtimeMinutes : 0,
      avg_processing_time_ms: routerStats.average_latency_ms,
      verification_rate: routerStats.verification_rate,
      error_rate: 0, // TODO: Calculate from metrics
      mac_health: await this.checkMacHealth(),
      queue_depth: metrics.getPerformanceMetrics().queueDepth || 0
    };
  }

  /**
   * Integration with existing QwenScannerService for compatibility
   */
  async scanWithQwen(imagePath: string): Promise<any> {
    try {
      // Use existing QwenScannerService as fallback/comparison
      const qwenResult = await this.qwenScanner.processImage(imagePath);
      
      // Also process through distributed pipeline for comparison
      const distributedId = await this.processSingleCard(imagePath, {
        value_tier: 'common', // Default for compatibility
        priority: 'normal'
      });

      return {
        qwen_result: qwenResult,
        distributed_id: distributedId,
        processing_mode: 'hybrid'
      };

    } catch (error) {
      logger.error('Qwen integration failed:', error);
      throw error;
    }
  }

  /**
   * Migration helper - gradually move from V1 to V2 processing
   */
  async migrateProcessing(imagePath: string): Promise<any> {
    const migration = createHybridConfig().migration;
    
    if (migration.shadow_mode) {
      // Run both V1 and V2, compare results
      const [v1Result, v2Id] = await Promise.all([
        this.qwenScanner.processImage(imagePath),
        this.processSingleCard(imagePath)
      ]);

      // Log comparison for analysis
      logger.info('Shadow mode comparison', {
        v1_confidence: v1Result.confidence,
        v2_work_id: v2Id,
        image: path.basename(imagePath)
      });

      return { mode: 'shadow', v1: v1Result, v2: v2Id };
    }

    // Use active configuration
    if (createHybridConfig().shouldUseV2()) {
      return {
        mode: 'v2_distributed',
        work_id: await this.processSingleCard(imagePath)
      };
    } else {
      return {
        mode: 'v1_qwen',
        result: await this.qwenScanner.processImage(imagePath)
      };
    }
  }

  // Private methods
  private setupMetrics(): void {
    // Register distributed-specific metrics
    metrics.registerGauge('distributed_pipeline_health', 'Overall pipeline health score', () => {
      // Calculate composite health score (0-1)
      return this.calculateHealthScore();
    });

    metrics.registerGauge('mac_endpoint_latency', 'Mac endpoint response time', () => {
      // This would be updated by health checks
      return this.getLastMacLatency();
    });

    metrics.registerCounter('distributed_processing_total', 'Total cards processed through distributed pipeline');
  }

  private startInboxWatcher(): void {
    // This would integrate with existing AsyncCaptureWatcher
    // For now, log that we're ready to receive files
    logger.info('Inbox watcher ready - awaiting captured images');
    
    // TODO: Integrate with existing capture watcher
    // const watcher = new AsyncCaptureWatcher({
    //   watchDir: '/home/profusionai/CardMint/captures',
    //   onFileDetected: async (filePath) => {
    //     await this.processSingleCard(filePath);
    //   }
    // });
  }

  private startHealthMonitoring(): void {
    // Health check every 30 seconds
    setInterval(async () => {
      try {
        const health = await this.checkMacHealth();
        metrics.recordGauge('mac_endpoint_health', health ? 1 : 0);
        
        if (!health) {
          logger.warn('Mac endpoint health check failed');
        }
        
      } catch (error) {
        logger.error('Health monitoring failed:', error);
        metrics.recordGauge('mac_endpoint_health', 0);
      }
    }, 30000);
  }

  private async checkMacHealth(): Promise<boolean> {
    try {
      // Use the router's health check method for consistency
      return await this.router.checkMacHealth();
    } catch (error) {
      logger.debug('Mac health check failed in DistributedIntegration:', error);
      return false;
    }
  }

  private calculateHealthScore(): number {
    // Simple health scoring - can be enhanced
    const stats = this.router.getStatistics();
    
    let score = 1.0;
    
    // Penalty for high error rates
    if (stats.verification_rate > 0.4) score -= 0.2;
    
    // Penalty for high latency
    if (stats.average_latency_ms > 200) score -= 0.3;
    
    // Mac health factor
    // if (!this.checkMacHealth()) score -= 0.5;
    
    return Math.max(0, score);
  }

  private getLastMacLatency(): number {
    // This would be updated by actual Mac calls
    return 0; // Default until latency metrics are integrated
  }

  private async getImageFiles(directory: string, pattern: string): Promise<string[]> {
    try {
      const files = await fs.readdir(directory);
      
      // Simple pattern matching - could use glob library
      const extensions = ['jpg', 'jpeg', 'png', 'webp'];
      const imageFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase().replace('.', '');
        return extensions.includes(ext);
      });

      return imageFiles.map(file => path.join(directory, file));
      
    } catch (error) {
      logger.error(`Failed to read directory ${directory}:`, error);
      return [];
    }
  }

  private detectValueTier(filePath: string): 'common' | 'rare' | 'holo' | 'vintage' | 'high_value' {
    const fileName = path.basename(filePath).toLowerCase();
    
    // Simple heuristics - could be enhanced with ML
    if (fileName.includes('holo') || fileName.includes('shiny')) return 'holo';
    if (fileName.includes('rare') || fileName.includes('ex') || fileName.includes('gx')) return 'rare';
    if (fileName.includes('vintage') || fileName.includes('1st') || fileName.includes('shadowless')) return 'vintage';
    if (fileName.includes('high') || fileName.includes('expensive')) return 'high_value';
    
    return 'common';
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.router) {
      await this.router.stop();
    }
    
    if (this.storage && 'close' in this.storage) {
      this.storage.close();
    }
    
    logger.info('Distributed pipeline stopped');
  }
}

// Factory function for easy initialization
export function createDistributedPipeline(): DistributedIntegration {
  return new DistributedIntegration();
}

// CLI-compatible interface for existing scripts
export async function processCardDistributed(imagePath: string, options?: any): Promise<string> {
  const pipeline = createDistributedPipeline();
  await pipeline.start();
  
  try {
    return await pipeline.processSingleCard(imagePath, options);
  } finally {
    await pipeline.stop();
  }
}
