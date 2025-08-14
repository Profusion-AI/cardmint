import { createLogger } from '../utils/logger';
import { SonyCamera } from '../camera/SonyCamera';
import { WebSocketServer } from './websocket';
import WebSocket from 'ws';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('camera-ws');

export class CameraWebSocketHandler {
  private camera?: SonyCamera;
  private liveViewInterval?: NodeJS.Timeout;
  
  constructor(private wsServer: WebSocketServer) {}
  
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
          
        case 'startLiveView':
          await this.startLiveView(ws);
          break;
          
        case 'stopLiveView':
          await this.stopLiveView(ws);
          break;
          
        case 'getStatus':
          await this.getStatus(ws);
          break;
          
        case 'getProperties':
          await this.getProperties(ws);
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
    
    this.camera = new SonyCamera({
      type: 'USB',
      deviceId: '054c:0ee9',
      autoReconnect: false
    });
    
    const connected = await this.camera.connect();
    
    if (connected) {
      const info = this.camera.getDeviceInfo();
      this.sendMessage(ws, {
        type: 'connected',
        model: info.name
      });
      
      // Send initial properties
      await this.getProperties(ws);
    } else {
      throw new Error('Failed to connect to camera');
    }
  }
  
  private async disconnectCamera(ws: WebSocket): Promise<void> {
    if (this.camera) {
      await this.stopLiveView(ws);
      await this.camera.disconnect();
      this.camera = undefined;
      
      this.sendMessage(ws, {
        type: 'disconnected'
      });
    }
  }
  
  private async captureImage(ws: WebSocket): Promise<void> {
    if (!this.camera || !this.camera.isConnected()) {
      throw new Error('Camera not connected');
    }
    
    const startTime = Date.now();
    const imagePath = await this.camera.captureImage();
    const captureTime = Date.now() - startTime;
    
    // For demo, we'll create a test image or send the path
    this.sendMessage(ws, {
      type: 'imageCaptured',
      imagePath: imagePath,
      captureTime: captureTime
    });
  }
  
  private async startLiveView(ws: WebSocket): Promise<void> {
    if (!this.camera || !this.camera.isConnected()) {
      throw new Error('Camera not connected');
    }
    
    // For demo purposes, we'll simulate live view with test frames
    // In production, this would connect to actual camera live view
    
    this.sendMessage(ws, {
      type: 'liveViewStarted'
    });
    
    // Simulate live view frames at 30fps
    let frameCounter = 0;
    this.liveViewInterval = setInterval(() => {
      // In production, this would send actual camera frames
      // For now, we'll send a simple frame counter
      frameCounter++;
      
      // Create a simple test frame (you could generate an actual image here)
      if (frameCounter % 30 === 0) { // Send update every second
        logger.debug(`Live view frame: ${frameCounter}`);
      }
      
      // In real implementation, you would send binary image data here:
      // ws.send(imageBuffer, { binary: true });
    }, 33); // ~30fps
  }
  
  private async stopLiveView(ws: WebSocket): Promise<void> {
    if (this.liveViewInterval) {
      clearInterval(this.liveViewInterval);
      this.liveViewInterval = undefined;
      
      this.sendMessage(ws, {
        type: 'liveViewStopped'
      });
    }
  }
  
  private async getStatus(ws: WebSocket): Promise<void> {
    const isConnected = this.camera && this.camera.isConnected();
    
    if (isConnected) {
      const info = this.camera!.getDeviceInfo();
      this.sendMessage(ws, {
        type: 'connected',
        model: info.name
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
    
    const iso = await this.camera.getProperty('iso');
    const aperture = await this.camera.getProperty('aperture');
    const shutter = await this.camera.getProperty('shutter');
    
    this.sendMessage(ws, {
      type: 'properties',
      iso: iso || '100',
      aperture: aperture || 'f/2.8',
      shutter: shutter || '1/125'
    });
  }
  
  private sendMessage(ws: WebSocket, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
  
  async cleanup(): Promise<void> {
    if (this.liveViewInterval) {
      clearInterval(this.liveViewInterval);
    }
    
    if (this.camera && this.camera.isConnected()) {
      await this.camera.disconnect();
    }
  }
}