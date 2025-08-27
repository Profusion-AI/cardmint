import fs from 'fs/promises';
import path from 'path';
import WebSocket from 'ws';
import { createLogger } from '../utils/logger';
import { SonyCameraIntegration } from '../services/SonyCameraIntegration';
import { WebSocketServer } from './websocket';
import { ControllerIntegration } from '../services/ControllerIntegration';

const logger = createLogger('camera-ws');

export class CameraWebSocketHandler {
  private camera?: SonyCameraIntegration;
  private controllerIntegration?: ControllerIntegration;
  
  constructor(
    private wsServer: WebSocketServer, 
    camera?: SonyCameraIntegration
  ) {
    this.camera = camera;
    this.setupControllerIntegration();
  }
  
  private setupControllerIntegration(): void {
    logger.info('Setting up controller integration for passive capture');
    
    this.controllerIntegration = new ControllerIntegration({
      webSocket: this.wsServer,
      camera: this.camera // Pass the camera to the controller integration
    });
    
    logger.info('Controller integration initialized');
  }
  
  async handleCameraMessage(action: string, ws: WebSocket): Promise<void> {
    try {
      switch (action) {
        case 'connect':
          await this.connectCamera(ws);
          break;
          
        case 'disconnect':
          await this.disconnectCamera(ws);
          break;
          
        case 'capture':
          await this.captureImage(ws);
          break;
          
        case 'getLatestCapture':
          await this.getLatestCapture(ws);
          break;
          
        case 'getStatus':
          await this.getStatus(ws);
          break;
          
        case 'getProperties':
          await this.getProperties(ws);
          break;
          
        case 'getControllerStatus':
          await this.getControllerStatus(ws);
          break;
          
        default:
          this.sendMessage(ws, {
            type: 'error',
            message: `Unknown action: ${action}`
          });
      }
    } catch (error: any) {
      logger.error('Camera action error:', error);
      this.sendMessage(ws, {
        type: 'error',
        message: error.message || 'Camera operation failed'
      });
    }
  }
  
  private async connectCamera(ws: WebSocket): Promise<void> {
    if (this.camera && this.camera.isConnected()) {
      this.sendMessage(ws, {
        type: 'connected',
        model: 'Sony ZV-E10M2'
      });
      return;
    }
    
    // If no camera integration was provided, we can't connect
    if (!this.camera) {
      throw new Error('No camera integration available');
    }
    
    const connected = await this.camera.connect();
    
    if (connected) {
      this.sendMessage(ws, {
        type: 'connected',
        model: 'Sony ZV-E10M2' // Use known model name
      });
      
      // Send initial properties
      await this.getProperties(ws);
      
      // Camera is already configured in controller integration during construction
    } else {
      throw new Error('Failed to connect to camera');
    }
  }
  
  private async disconnectCamera(ws: WebSocket): Promise<void> {
    if (this.camera) {
      await this.camera.disconnect();
      // Don't set camera to undefined - it's managed by the main system
      
      this.sendMessage(ws, {
        type: 'disconnected'
      });
    }
  }
  
  private async captureImage(ws: WebSocket): Promise<void> {
    if (!this.camera || !this.camera.isConnected()) {
      throw new Error('Camera not connected');
    }
    
    const result = await this.camera.captureImage();
    
    if (result.success) {
      this.sendMessage(ws, {
        type: 'imageCaptured',
        imagePath: result.imagePath,
        captureTime: result.captureTimeMs
      });
    } else {
      throw new Error(result.error || 'Capture failed');
    }
  }
  
  private async getLatestCapture(ws: WebSocket): Promise<void> {
    // Get the most recent capture from the captures directory
    try {
      const capturesDir = path.join(process.cwd(), 'captures');
      const files = await fs.readdir(capturesDir);
      
      // Find the most recent JPG file
      const jpgFiles = files
        .filter(file => file.toLowerCase().endsWith('.jpg'))
        .map(file => ({
          name: file,
          path: path.join(capturesDir, file),
          stats: fs.stat(path.join(capturesDir, file))
        }));
      
      if (jpgFiles.length > 0) {
        const stats = await Promise.all(jpgFiles.map(f => f.stats));
        const latestFile = jpgFiles
          .map((file, index) => ({ ...file, mtime: stats[index].mtime }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0];
        
        this.sendMessage(ws, {
          type: 'imageCaptured',
          imagePath: `/captures/${latestFile.name}`,
          captureTime: 0 // Unknown for existing files
        });
      } else {
        this.sendMessage(ws, {
          type: 'error',
          message: 'No captures found'
        });
      }
    } catch (error: any) {
      logger.error('Error getting latest capture:', error);
      throw error;
    }
  }
  
  private async getStatus(ws: WebSocket): Promise<void> {
    const isConnected = this.camera && this.camera.isConnected();
    
    if (isConnected) {
      this.sendMessage(ws, {
        type: 'connected',
        model: 'Sony ZV-E10M2'
      });
      await this.getProperties(ws);
    } else {
      this.sendMessage(ws, {
        type: 'disconnected'
      });
    }
  }
  
  private async getProperties(ws: WebSocket): Promise<void> {
    if (!this.camera || !this.camera.isConnected()) {
      return;
    }
    
    // SonyCameraIntegration doesn't expose property methods yet
    // Send default values for now
    this.sendMessage(ws, {
      type: 'properties',
      iso: 'Auto',
      aperture: 'f/2.8',
      shutter: '1/125'
    });
  }
  
  private async getControllerStatus(ws: WebSocket): Promise<void> {
    if (!this.controllerIntegration) {
      this.sendMessage(ws, {
        type: 'controller_unavailable'
      });
      return;
    }

    const isConnected = this.controllerIntegration.isControllerConnected();
    const state = this.controllerIntegration.getControllerState();
    
    this.sendMessage(ws, {
      type: 'controller_status',
      connected: isConnected,
      state: {
        devicePath: state.devicePath,
        byIdPath: state.byIdPath,
        isGrabbed: !!state.grabbedProcess
      }
    });
  }
  
  private sendMessage(ws: WebSocket, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
  
  async cleanup(): Promise<void> {
    if (this.camera && this.camera.isConnected()) {
      await this.camera.disconnect();
    }
    
    if (this.controllerIntegration) {
      await this.controllerIntegration.shutdown();
    }
  }
}