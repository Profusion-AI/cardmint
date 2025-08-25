import WebSocket from 'ws';
import { createLogger } from '../utils/logger';
import { QueueManager } from '../queue/QueueManager';
import { MetricsCollector } from '../utils/metrics';
import { CameraWebSocketHandler } from './camera-websocket';

const logger = createLogger('websocket');

interface WSMessage {
  type: string;
  payload?: any;
  id?: string;
}

export class WebSocketServer {
  private wss?: WebSocket.Server;
  private clients: Map<string, WebSocket> = new Map();
  private cameraHandler?: CameraWebSocketHandler;
  
  constructor(
    private readonly queueManager: QueueManager,
    private readonly metrics: MetricsCollector
  ) {
    this.cameraHandler = new CameraWebSocketHandler(this);
  }
  
  async start(port: number): Promise<void> {
    this.wss = new WebSocket.Server({ port });
    
    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = this.generateClientId();
      this.clients.set(clientId, ws);
      
      logger.info(`WebSocket client connected: ${clientId}`);
      
      // Send welcome message
      this.sendMessage(ws, {
        type: 'connected',
        payload: { clientId, timestamp: new Date().toISOString() },
      });
      
      // Setup ping/pong for connection health
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000);
      
      ws.on('pong', () => {
        logger.debug(`Pong received from ${clientId}`);
      });
      
      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Handle camera actions
          if (message.action) {
            await this.cameraHandler?.handleCameraMessage(message.action, ws);
          } else {
            // Handle regular messages
            await this.handleMessage(clientId, message as WSMessage, ws);
          }
        } catch (error) {
          logger.error(`Error handling message from ${clientId}:`, error);
          this.sendError(ws, 'Invalid message format');
        }
      });
      
      ws.on('close', () => {
        logger.info(`WebSocket client disconnected: ${clientId}`);
        clearInterval(pingInterval);
        this.clients.delete(clientId);
      });
      
      ws.on('error', (error) => {
        logger.error(`WebSocket error for ${clientId}:`, error);
      });
    });
    
    logger.info(`WebSocket server listening on port ${port}`);
  }
  
  private async handleMessage(
    clientId: string,
    message: WSMessage,
    ws: WebSocket
  ): Promise<void> {
    logger.debug(`Message from ${clientId}:`, message);
    
    switch (message.type) {
      case 'ping':
        this.sendMessage(ws, {
          type: 'pong',
          id: message.id,
        });
        break;
        
      case 'subscribe':
        // Subscribe to specific events
        if (message.payload?.events) {
          // Implementation for event subscription
          this.sendMessage(ws, {
            type: 'subscribed',
            payload: { events: message.payload.events },
            id: message.id,
          });
        }
        break;
        
      case 'getQueueStatus':
        const status = await this.queueManager.getQueueStatus();
        this.sendMessage(ws, {
          type: 'queueStatus',
          payload: status,
          id: message.id,
        });
        break;
        
      case 'getMetrics':
        const metrics = this.metrics.getPerformanceMetrics();
        this.sendMessage(ws, {
          type: 'metrics',
          payload: metrics,
          id: message.id,
        });
        break;
        
      default:
        this.sendError(ws, `Unknown message type: ${message.type}`);
    }
  }
  
  private sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
  
  private sendError(ws: WebSocket, error: string): void {
    this.sendMessage(ws, {
      type: 'error',
      payload: { message: error },
    });
  }
  
  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }
  
  sendToClient(clientId: string, message: WSMessage): void {
    const ws = this.clients.get(clientId);
    if (ws) {
      this.sendMessage(ws, message);
    }
  }
  
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  async stop(): Promise<void> {
    // Cleanup camera handler
    if (this.cameraHandler) {
      await this.cameraHandler.cleanup();
    }
    
    if (this.wss) {
      // Close all client connections
      this.clients.forEach((ws) => {
        ws.close();
      });
      
      // Close the server
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      
      logger.info('WebSocket server stopped');
    }
  }
}