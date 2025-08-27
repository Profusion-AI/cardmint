import http from 'http';
import { createLogger } from './utils/logger';
import { config } from './config';
// Avoid importing QueueManager type to keep queue out of fast build
import { MetricsCollector } from './utils/metrics';
import { WebSocketServer } from './api/websocket';
import { createAPIRouter } from './api/router';
import { SonyCameraIntegration } from './services/SonyCameraIntegration';

const logger = createLogger('server');

export class CardMintServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private isRunning = false;
  private actualHttpPort?: number;
  
  constructor(
    private readonly queueManager: any,
    private readonly metrics: MetricsCollector,
    private readonly cameraIntegration?: SonyCameraIntegration
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
      
      this.wsServer = new WebSocketServer(this.queueManager, this.metrics, this.cameraIntegration);
      await this.wsServer.start(config.server.wsPort);

      await this.tryStartHttpOnPort(config.server.port, config.server.host);
      
      this.isRunning = true;
      const httpPort = this.actualHttpPort ?? config.server.port;
      logger.info(`HTTP server listening on ${config.server.host}:${httpPort}`);
      logger.info(`WebSocket server listening on ${config.server.host}:${config.server.wsPort}`);
      
    } catch (error) {
      logger.error('Failed to start server:', error);
      throw error;
    }
  }
  
  private async tryStartHttpOnPort(port: number, host: string): Promise<void> {
    const attemptListen = (p: number) => new Promise<void>((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        const apiRouter = createAPIRouter(this.queueManager, this.metrics);
        apiRouter(req, res);
      });
      const onError = (err: NodeJS.ErrnoException) => {
        this.httpServer?.removeListener('listening', onListening);
        this.httpServer?.removeListener('error', onError);
        reject(err);
      };
      const onListening = () => {
        this.httpServer?.removeListener('error', onError);
        this.actualHttpPort = p;
        resolve();
      };
      this.httpServer.on('error', onError);
      this.httpServer.on('listening', onListening);
      this.httpServer.listen(p, host);
    });
    
    try {
      await attemptListen(port);
      return;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') throw err;
      const fallbacks = [port + 1, port + 2, port + 3, 0]; // 0 = random
      for (const p of fallbacks) {
        try {
          await attemptListen(p);
          return;
        } catch (e: any) {
          if (e?.code === 'EADDRINUSE') continue;
          throw e;
        }
      }
      throw new Error('No available ports found for HTTP server');
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
