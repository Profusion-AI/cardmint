import dotenv from 'dotenv';
import { createLogger } from './utils/logger';
import { CardMintServer } from './server';
import { initializeDatabase } from './storage/database';
import { MetricsCollector } from './utils/metrics';
import { gracefulShutdown } from './utils/shutdown';
import { migrateToWalOrLog } from './lib/db/migrateToWal';
import { config } from './config';
import { NoopQueueManager, NoopMetricsCollector } from './utils/e2e-stubs';
import { FileQueueManager } from './queue/FileQueueManager';
import { SonyCameraIntegration } from './services/SonyCameraIntegration';
import { ProductionCaptureWatcher } from './services/ProductionCaptureWatcher';
import { CameraInputIntegration } from './services/CameraInputIntegration';
import { ControllerService } from './services/ControllerService';
import { InputBus } from './services/input-bus';

dotenv.config();
const logger = createLogger('main');

async function main() {
  logger.info('Starting CardMint System...');
  
  try {
    logger.info('Initializing database connection...');
    await initializeDatabase();
    
    logger.info('Enabling WAL mode for concurrent access...');
    await migrateToWalOrLog(config.database.path);
    
    const e2eNoRedis = process.env.E2E_NO_REDIS === 'true';
    if (!e2eNoRedis) {
      logger.info('Initializing Redis connection...');
      const modPath = './storage/' + 'redis';
      const mod: any = await import(modPath);
      await mod.initializeRedis();
    } else {
      logger.warn('E2E_NO_REDIS enabled: skipping Redis initialization');
    }
    
    let queueManager: any;
    if (e2eNoRedis) {
      logger.info('Starting FileQueueManager for E2E mode...');
      queueManager = new FileQueueManager('./data/queue');
      await queueManager.initialize();
    } else {
      logger.info('Starting queue manager...');
      const modPath = './queue/' + 'QueueManager';
      const mod: any = await import(modPath);
      queueManager = new mod.QueueManager();
      await queueManager.initialize();
    }
    
    let metrics: any;
    if (e2eNoRedis) {
      metrics = new NoopMetricsCollector();
      await metrics.start();
    } else {
      logger.info('Initializing metrics collector...');
      metrics = new MetricsCollector();
      await metrics.start();
    }
    
    logger.info('Initializing Phase 3 hybrid quick-scan architecture...');
    // CardRepository will be lazily loaded inside services when needed
    const cardRepository: any = undefined;
    
    // Initialize Sony Camera Integration (Production Ready)
    logger.info('Initializing Sony Camera Integration...');
    let cameraIntegration: SonyCameraIntegration | undefined;
    let captureWatcher: ProductionCaptureWatcher | undefined;
    let controllerService: ControllerService | undefined;
    let inputBus: InputBus | undefined;
    let cameraInputIntegration: CameraInputIntegration | undefined;

    // Start production capture watcher regardless of camera status
    // This ensures files placed in the directory are always discovered
    try {
      captureWatcher = new ProductionCaptureWatcher(queueManager, cardRepository);
      await captureWatcher.start();
      logger.info('Production capture watcher started monitoring ./data/inventory_images/');
    } catch (error) {
      logger.error('Failed to start production capture watcher:', error);
    }

    try {
      // Initialize Sony camera integration
      cameraIntegration = new SonyCameraIntegration();
      const cameraReady = await cameraIntegration.initialize();
      
      if (cameraReady) {
        logger.info('Sony camera integration initialized successfully');
        
        // Connect camera during startup
        const connected = await cameraIntegration.connect();
        if (connected) {
          logger.info('Sony camera connected during startup');
        } else {
          logger.warn('Sony camera not connected during startup - will retry on first capture');
        }
        
        // Initialize input bus for keyboard/controller events
        inputBus = new InputBus();
        logger.info('Input bus initialized for telemetry tracking');
        
        // Initialize camera-input bridge
        cameraInputIntegration = new CameraInputIntegration(cameraIntegration, inputBus);
        logger.info('Camera-input integration bridge established');
        
        // Initialize controller service with camera integration
        controllerService = new ControllerService(cameraIntegration);
        logger.info('Controller service initialized with camera triggers');
        
        // Set up event forwarding for monitoring
        cameraIntegration.on('captureResult', (result) => {
          logger.info('Camera capture completed', {
            success: result.success,
            captureTimeMs: result.captureTimeMs,
            imagePath: result.imagePath,
            error: result.error,
          });
        });
        
        cameraInputIntegration.on('captureTriggered', (event) => {
          logger.info(`Capture triggered by ${event.triggeredBy}`, {
            success: event.captureResult.success,
            processingTime: event.processingTime,
          });
        });
        
        logger.info('Sony Camera System fully operational');
        
      } else {
        logger.warn('Sony camera initialization failed - running without camera integration');
        cameraIntegration = undefined;
      }
      
    } catch (error) {
      logger.error('Failed to initialize Sony camera integration:', error);
      logger.warn('Continuing without camera integration - captures will use simulation mode');
      cameraIntegration = undefined;
    }
    
    // Phase 3: Enable IntegratedScannerService for E2E processing pipeline
    let integratedScanner: any = undefined;
    if (e2eNoRedis) {
      logger.info('Starting IntegratedScannerService for E2E processing...');
      const modPath = './services/' + 'IntegratedScannerService';
      const mod: any = await import(modPath);
      integratedScanner = mod.integratedScanner; // Use singleton instance
      
      // Connect queue to scanner for processing jobs
      queueManager.on('processJob', async (job: any) => {
        try {
          if (job.imagePath && integratedScanner) {
            logger.info(`Processing image via IntegratedScannerService: ${job.imagePath}`);
            const result = await integratedScanner.processCard(job.imagePath);
            if (result) {
              await queueManager.completeJob(job.id, result);
              logger.info(`Job ${job.id} completed successfully: ${result.name}`);
            } else {
              await queueManager.failJob(job.id, 'IntegratedScannerService returned null');
            }
          } else {
            await queueManager.failJob(job.id, 'Missing imagePath or scanner service');
          }
        } catch (error) {
          logger.error(`Job ${job.id} processing failed:`, error);
          await queueManager.failJob(job.id, error.message);
        }
      });
      
      logger.info('IntegratedScannerService connected to FileQueueManager');
    } else {
      logger.info('IntegratedScannerService not started (Redis mode uses different pipeline)');
    }
    
    // Optionally enable distributed pipeline when explicitly requested
    const enableDistributed = process.env.ENABLE_DISTRIBUTED === 'true';
    let distributedPipeline: any = undefined;
    if (enableDistributed) {
      logger.info('Starting DistributedIntegration (Complete Pipeline)...');
      // Use non-literal to prevent TS from type-checking the module in fast-build
      const modPath = './services/' + 'DistributedIntegration';
      const mod: any = await import(modPath);
      distributedPipeline = new mod.DistributedIntegration();
      await distributedPipeline.start();
    } else {
      logger.info('Distributed pipeline disabled (ENABLE_DISTRIBUTED!=true)');
    }
    
    logger.info('Phase 3 hybrid pipeline ready with all components integrated');
    
    logger.info('Starting CardMint server...');
    const server = new CardMintServer(queueManager, metrics, cameraIntegration);
    await server.start();
    
    // Enhanced graceful shutdown with camera cleanup
    const shutdownHandler = async () => {
      logger.info('Shutting down CardMint system...');
      
      // Cleanup camera services first
      if (controllerService) {
        logger.info('Shutting down controller service...');
        await controllerService.cleanup();
      }
      
      if (cameraInputIntegration) {
        logger.info('Cleaning up camera-input integration...');
        await cameraInputIntegration.cleanup();
      }
      
      if (captureWatcher) {
        logger.info('Stopping capture watcher...');
        await captureWatcher.cleanup();
      }
      
      if (cameraIntegration) {
        logger.info('Cleaning up Sony camera integration...');
        await cameraIntegration.cleanup();
      }
      
      if (integratedScanner) {
        logger.info('Cleaning up IntegratedScannerService...');
        // IntegratedScannerService is a singleton, no explicit cleanup needed
      }
      
      // Standard system shutdown
      await gracefulShutdown(server, queueManager, distributedPipeline);
    };
    
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
    
    logger.info('CardMint System is running successfully');
    logger.info(`API: http://${config.server.host}:${config.server.port}`);
    logger.info(`WebSocket: ws://${config.server.host}:${config.server.wsPort}`);
    logger.info(`Metrics: http://localhost:${process.env.METRICS_PORT || 9090}/metrics`);
    
  } catch (error) {
    logger.error(`Failed to start CardMint System: ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(`Unhandled error in main: ${error}`);
  process.exit(1);
});
