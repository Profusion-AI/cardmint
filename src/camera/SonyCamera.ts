import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { CameraDevice, CameraCapabilities } from '../types';

const logger = createLogger('sony-camera');

// Load the native binding
let nativeBinding: any;

try {
  nativeBinding = require('./build/Release/sony_camera_binding.node');
  logger.info('Native Sony camera binding loaded successfully');
} catch (error) {
  // Try from src/camera directory
  try {
    nativeBinding = require('../../src/camera/build/Release/sony_camera_binding.node');
    logger.info('Native Sony camera binding loaded from src/camera');
  } catch (error2) {
    logger.warn('Native Sony camera binding not found, using mock implementation');
    // Mock implementation for development
    nativeBinding = {
      SonyCamera: class {
        connect() { return true; }
        disconnect() { return true; }
        captureImage() { return Promise.resolve('/tmp/mock-image.jpg'); }
        getProperty() { return null; }
        setProperty() { return true; }
        getDeviceInfo() { return { model: 'Mock Camera', connected: false }; }
        listDevices() { return []; }
      }
    };
  }
}

export interface SonyCameraOptions {
  type: 'USB' | 'ETHERNET' | 'SSH';
  deviceId?: string;
  ip?: string;
  autoReconnect?: boolean;
}

export interface CaptureOptions {
  format?: 'JPEG' | 'RAW' | 'HEIF';
  quality?: number;
  metadata?: boolean;
}

export class SonyCamera extends EventEmitter {
  private nativeCamera: any;
  private connected = false;
  private options: SonyCameraOptions;
  private reconnectTimer?: NodeJS.Timeout;
  
  constructor(options: SonyCameraOptions) {
    super();
    this.options = options;
    this.nativeCamera = new nativeBinding.SonyCamera();
    logger.info('Sony camera instance created', options);
  }
  
  async connect(): Promise<boolean> {
    try {
      logger.info('Connecting to Sony camera...', this.options);
      
      const result = await this.nativeCamera.connect({
        type: this.options.type,
        deviceId: this.options.deviceId,
        ip: this.options.ip,
      });
      
      if (result) {
        this.connected = true;
        this.emit('connected');
        logger.info('Successfully connected to Sony camera');
        
        if (this.options.autoReconnect) {
          this.setupAutoReconnect();
        }
      } else {
        logger.error('Failed to connect to Sony camera');
      }
      
      return result;
    } catch (error) {
      logger.error('Error connecting to camera:', error);
      throw error;
    }
  }
  
  async disconnect(): Promise<boolean> {
    try {
      if (this.reconnectTimer) {
        clearInterval(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      
      
      const result = await this.nativeCamera.disconnect();
      
      if (result) {
        this.connected = false;
        this.emit('disconnected');
        logger.info('Disconnected from Sony camera');
      }
      
      return result;
    } catch (error) {
      logger.error('Error disconnecting from camera:', error);
      throw error;
    }
  }
  
  async captureImage(options?: CaptureOptions): Promise<string> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      logger.debug('Capturing image with options:', options);
      
      const startTime = Date.now();
      // The native binding returns a Promise
      const imagePath = await this.nativeCamera.captureImage();
      const captureTime = Date.now() - startTime;
      
      logger.info(`Image captured in ${captureTime}ms: ${imagePath}`);
      
      this.emit('imageCaptured', {
        path: imagePath,
        captureTime,
        options,
      });
      
      return imagePath;
    } catch (error) {
      logger.error('Error capturing image:', error);
      this.emit('error', error);
      throw error;
    }
  }
  
  
  async getProperty(propertyName: string): Promise<any> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    return this.nativeCamera.getProperty(propertyName);
  }
  
  async setProperty(propertyName: string, value: any): Promise<boolean> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    const result = this.nativeCamera.setProperty(propertyName, String(value));
    
    if (result) {
      this.emit('propertyChanged', { property: propertyName, value });
    }
    
    return result;
  }
  
  getDeviceInfo(): CameraDevice {
    const info = this.nativeCamera.getDeviceInfo();
    
    return {
      id: this.options.deviceId || 'unknown',
      name: info.model || 'Unknown Camera',
      type: this.options.type,
      status: info.connected ? 'connected' : 'disconnected',
      capabilities: this.getCapabilities(),
    };
  }
  
  static async listAvailableDevices(): Promise<CameraDevice[]> {
    try {
      const camera = new nativeBinding.SonyCamera();
      const devices = camera.listDevices();
      
      return devices.map((device: any) => ({
        id: device.id,
        name: device.name,
        type: device.type,
        status: 'disconnected',
        capabilities: {
          resolutions: ['1920x1080', '3840x2160', '6000x4000'],
          formats: ['JPEG', 'RAW', 'HEIF'],
          maxFps: 60,
          hasAutoFocus: true,
          hasExposureControl: true,
        },
      }));
    } catch (error) {
      logger.error('Error listing devices:', error);
      return [];
    }
  }
  
  private getCapabilities(): CameraCapabilities {
    // This would be populated from the actual camera
    return {
      resolutions: ['1920x1080', '3840x2160', '6000x4000'],
      formats: ['JPEG', 'RAW', 'HEIF'],
      maxFps: 60,
      hasAutoFocus: true,
      hasExposureControl: true,
    };
  }
  
  private setupAutoReconnect(): void {
    this.reconnectTimer = setInterval(async () => {
      if (!this.connected) {
        logger.info('Attempting to reconnect to camera...');
        try {
          await this.connect();
        } catch (error) {
          logger.error('Reconnection failed:', error);
        }
      }
    }, 5000);
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
}