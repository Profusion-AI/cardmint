import { createLogger } from './utils/logger';
import { config } from './config';
import { QueueManager } from './queue/QueueManager';
import { MetricsCollector } from './utils/metrics';
import { WebSocketServer } from './api/websocket';
import { createAPIRouter } from './api/router';
import http from 'http';

const logger = createLogger('server');

export class CardMintServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private isRunning = false;
  
  constructor(
    private readonly queueManager: QueueManager,
    private readonly metrics: MetricsCollector
  ) {}
  
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Server is already running');
      return;
    }
    
    try {
      const apiRouter = createAPIRouter(this.queueManager, this.metrics);
      
      this.httpServer = http.createServer((req, res) => {
        apiRouter(req, res);
      });
      
      this.wsServer = new WebSocketServer(this.queueManager, this.metrics);
      await this.wsServer.start(config.server.wsPort);
      
      await new Promise<void>((resolve) => {
        this.httpServer!.listen(config.server.port, config.server.host, () => {
          resolve();
        });
      });
      
      this.isRunning = true;
      logger.info(`HTTP server listening on ${config.server.host}:${config.server.port}`);
      logger.info(`WebSocket server listening on ${config.server.host}:${config.server.wsPort}`);
      
    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    logger.info('Stopping server...');
    
    if (this.wsServer) {
      await this.wsServer.stop();
    }
    
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }
    
    this.isRunning = false;
    logger.info('Server stopped');
  }
  
  getStatus(): { running: boolean; uptime: number } {
    return {
      running: this.isRunning,
      uptime: process.uptime(),
    };
  }
}