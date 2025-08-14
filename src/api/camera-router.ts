import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { createLogger } from '../utils/logger';
import { CameraService } from '../camera/CameraService';
import { PresetType } from '../camera/CapturePresets';
import { CardRepository } from '../storage/CardRepository';
import { QueueManager } from '../queue/QueueManager';
import { CardStatus } from '../types';

const logger = createLogger('camera-router');

export class CameraRouter {
  private cameraService: CameraService;
  private cardRepository: CardRepository;
  
  constructor(
    private queueManager: QueueManager,
    cameraService?: CameraService
  ) {
    this.cameraService = cameraService || new CameraService();
    this.cardRepository = new CardRepository();
  }
  
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const { pathname } = parse(req.url || '', true);
    const method = req.method || 'GET';
    
    try {
      // Camera capture endpoint
      if (pathname === '/api/capture' && method === 'POST') {
        await this.handleCapture(req, res);
        return true;
        
      } else if (pathname === '/api/capture/presets' && method === 'GET') {
        await this.handleGetPresets(req, res);
        return true;
        
      } else if (pathname?.startsWith('/api/runs/') && method === 'GET') {
        await this.handleGetRun(req, res);
        return true;
        
      } else if (pathname?.startsWith('/api/process/') && pathname?.endsWith('/ocr') && method === 'POST') {
        await this.handleReprocessOCR(req, res);
        return true;
        
      } else if (pathname?.startsWith('/api/process/') && pathname?.endsWith('/signals') && method === 'POST') {
        await this.handleReprocessSignals(req, res);
        return true;
        
      } else if (pathname === '/api/camera/health' && method === 'GET') {
        await this.handleCameraHealth(req, res);
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('Camera API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }));
      return true;
    }
  }
  
  private async handleCapture(req: IncomingMessage, res: ServerResponse) {
    const body = await this.getRequestBody(req);
    const data = JSON.parse(body);
    
    // Validate preset
    const preset = data.preset || 'catalog';
    if (!['catalog', 'sweep', 'focus_stack', 'custom'].includes(preset)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid preset' }));
      return;
    }
    
    // Generate run ID
    const runId = this.generateRunId();
    
    // Create initial card records for tracking
    const card = await this.cardRepository.createCard({
      imageUrl: `/data/cardmint/${runId}/raw/capture_000.jpg`,
      status: CardStatus.CAPTURING,
      metadata: {
        preset,
        runId,
      },
    });
    
    // Start capture asynchronously
    this.executeCaptureAsync(runId, card.id, preset, data.options);
    
    // Return immediately with run ID
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      runId,
      cardId: card.id,
      status: 'accepted',
      message: 'Capture initiated',
    }));
  }
  
  private async executeCaptureAsync(
    runId: string,
    cardId: string,
    preset: string,
    options?: any
  ) {
    try {
      // Initialize camera if needed
      if (this.cameraService.getCameraState() === 'IDLE') {
        await this.cameraService.initialize();
      }
      
      // Execute capture
      const session = await this.cameraService.capture({
        preset: preset as PresetType,
        customConfig: options?.customConfig,
        outputDir: `/data/cardmint/${runId}`,
        generateSidecar: true,
        runId,
      });
      
      if (session) {
        // Update card status
        await this.cardRepository.updateCard(cardId, {
          status: CardStatus.QUEUED,
          metadata: {
            preset,
            runId,
            captureCount: session.captures.length,
            captureTime: session.endTime! - session.startTime,
          },
        });
        
        // Add to processing queue
        for (const capture of session.captures) {
          await this.queueManager.addProcessingJob({
            cardId,
            runId,
            imagePath: capture.path,
            metadata: capture.metadata,
          });
        }
        
        logger.info(`Capture session ${runId} queued for processing`);
        
      } else {
        await this.cardRepository.updateCard(cardId, {
          status: CardStatus.FAILED,
          error: 'Capture failed',
        });
      }
      
    } catch (error) {
      logger.error(`Capture session ${runId} failed:`, error);
      await this.cardRepository.updateCard(cardId, {
        status: CardStatus.FAILED,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  
  private async handleGetPresets(req: IncomingMessage, res: ServerResponse) {
    const presets = [
      {
        name: 'catalog',
        description: 'Single shot with diffuse lighting',
        captureCount: 1,
      },
      {
        name: 'sweep',
        description: '5-9 frames with tilt variations',
        captureCount: 7,
      },
      {
        name: 'focus_stack',
        description: '3-5 frames with focus bracketing',
        captureCount: 5,
      },
    ];
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(presets));
  }
  
  private async handleGetRun(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = parse(req.url || '', true);
    const runId = pathname?.split('/')[3];
    
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Run ID required' }));
      return;
    }
    
    // Get session from camera service
    const session = this.cameraService.getActiveSession(runId);
    
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runId: session.runId,
        status: session.status,
        preset: session.preset,
        captureCount: session.captures.length,
        startTime: session.startTime,
        endTime: session.endTime,
        error: session.error,
      }));
    } else {
      // Try to get from database
      const cards = await this.cardRepository.listCards({
        limit: 1,
      });
      
      const card = cards.find(c => c.metadata?.runId === runId);
      
      if (card) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          runId,
          status: card.status,
          cardId: card.id,
          metadata: card.metadata,
        }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run not found' }));
      }
    }
  }
  
  private async handleReprocessOCR(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = parse(req.url || '', true);
    const runId = pathname?.split('/')[3];
    
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Run ID required' }));
      return;
    }
    
    // Add OCR reprocessing job to queue
    await this.queueManager.addProcessingJob({
      runId,
      type: 'reprocess_ocr',
      priority: 5,
    });
    
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'accepted',
      message: 'OCR reprocessing queued',
    }));
  }
  
  private async handleReprocessSignals(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = parse(req.url || '', true);
    const runId = pathname?.split('/')[3];
    
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Run ID required' }));
      return;
    }
    
    // Add signal reprocessing job to queue
    await this.queueManager.addProcessingJob({
      runId,
      type: 'reprocess_signals',
      priority: 5,
    });
    
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'accepted',
      message: 'Signal extraction reprocessing queued',
    }));
  }
  
  private async handleCameraHealth(req: IncomingMessage, res: ServerResponse) {
    const health = this.cameraService.getHealthMetrics();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...health,
      initialized: health.state !== 'IDLE',
      ready: health.state === 'READY',
    }));
  }
  
  private getRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        resolve(body);
      });
      
      req.on('error', reject);
    });
  }
  
  private generateRunId(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').split('.')[0];
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}_${random}`;
  }
  
  async initialize(): Promise<void> {
    logger.info('Initializing camera router');
    await this.cameraService.initialize();
  }
  
  async shutdown(): Promise<void> {
    logger.info('Shutting down camera router');
    await this.cameraService.shutdown();
  }
}