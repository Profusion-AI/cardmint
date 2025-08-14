import { EventEmitter } from 'events';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);
const logger = createLogger('gphoto2-camera');

export interface GPhoto2CameraInfo {
  model: string;
  port: string;
  capabilities: string[];
}

export class GPhoto2Camera extends EventEmitter {
  private connected = false;
  private cameraInfo?: GPhoto2CameraInfo;
  
  constructor() {
    super();
    logger.info('GPhoto2 camera instance created');
  }
  
  async detectCamera(): Promise<GPhoto2CameraInfo | null> {
    try {
      logger.info('Detecting camera with gphoto2...');
      
      // Auto-detect camera
      const { stdout } = await execAsync('gphoto2 --auto-detect');
      const lines = stdout.split('\n');
      
      // Parse camera info from output
      for (const line of lines) {
        if (line.includes('Sony') || line.includes('ZV-E10')) {
          const parts = line.trim().split(/\s+/);
          const model = parts.slice(0, -1).join(' ');
          const port = parts[parts.length - 1];
          
          this.cameraInfo = {
            model,
            port,
            capabilities: [],
          };
          
          // Get camera abilities
          try {
            const { stdout: abilities } = await execAsync('gphoto2 --abilities');
            this.cameraInfo.capabilities = this.parseAbilities(abilities);
          } catch (error) {
            logger.warn('Could not get camera abilities:', error);
          }
          
          logger.info(`Camera detected: ${model} on ${port}`);
          return this.cameraInfo;
        }
      }
      
      logger.warn('No Sony camera detected');
      return null;
      
    } catch (error) {
      logger.error('Camera detection failed:', error);
      return null;
    }
  }
  
  private parseAbilities(output: string): string[] {
    const capabilities: string[] = [];
    
    if (output.includes('capture image')) capabilities.push('capture');
    if (output.includes('configuration')) capabilities.push('config');
    if (output.includes('trigger capture')) capabilities.push('trigger');
    if (output.includes('preview')) capabilities.push('preview');
    
    return capabilities;
  }
  
  async connect(): Promise<boolean> {
    try {
      const detected = await this.detectCamera();
      
      if (!detected) {
        logger.error('No camera detected for connection');
        return false;
      }
      
      // Test connection by getting camera summary
      const { stdout } = await execAsync('gphoto2 --summary');
      
      if (stdout.includes('Manufacturer') || stdout.includes('Model')) {
        this.connected = true;
        this.emit('connected', this.cameraInfo);
        logger.info('Successfully connected to camera');
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('Connection failed:', error);
      return false;
    }
  }
  
  async disconnect(): Promise<boolean> {
    this.connected = false;
    this.emit('disconnected');
    logger.info('Camera disconnected');
    return true;
  }
  
  async captureImage(outputPath?: string): Promise<string> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      const timestamp = Date.now();
      const filename = outputPath || `/tmp/capture_${timestamp}.jpg`;
      
      logger.info(`Capturing image to ${filename}`);
      
      // Capture and download image
      const startTime = Date.now();
      const { stdout, stderr } = await execAsync(
        `gphoto2 --capture-image-and-download --filename="${filename}" --force-overwrite`
      );
      
      const captureTime = Date.now() - startTime;
      
      // Check if file was created
      await fs.access(filename);
      
      logger.info(`Image captured successfully in ${captureTime}ms`);
      
      this.emit('imageCaptured', {
        path: filename,
        captureTime,
      });
      
      return filename;
      
    } catch (error) {
      logger.error('Capture failed:', error);
      throw error;
    }
  }
  
  async capturePreview(outputPath?: string): Promise<string> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      const timestamp = Date.now();
      const filename = outputPath || `/tmp/preview_${timestamp}.jpg`;
      
      logger.info('Capturing preview image');
      
      const { stdout } = await execAsync(
        `gphoto2 --capture-preview --filename="${filename}" --force-overwrite`
      );
      
      await fs.access(filename);
      
      logger.info('Preview captured successfully');
      return filename;
      
    } catch (error) {
      logger.error('Preview capture failed:', error);
      throw error;
    }
  }
  
  async setConfig(setting: string, value: string): Promise<boolean> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      logger.info(`Setting ${setting} to ${value}`);
      
      await execAsync(`gphoto2 --set-config ${setting}=${value}`);
      
      this.emit('configChanged', { setting, value });
      return true;
      
    } catch (error) {
      logger.error(`Failed to set ${setting}:`, error);
      return false;
    }
  }
  
  async getConfig(setting?: string): Promise<any> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      const cmd = setting 
        ? `gphoto2 --get-config ${setting}`
        : `gphoto2 --list-config`;
        
      const { stdout } = await execAsync(cmd);
      
      if (setting) {
        // Parse specific config value
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.startsWith('Current:')) {
            return line.replace('Current:', '').trim();
          }
        }
      }
      
      return stdout;
      
    } catch (error) {
      logger.error('Failed to get config:', error);
      return null;
    }
  }
  
  async listFiles(): Promise<string[]> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      const { stdout } = await execAsync('gphoto2 --list-files');
      
      const files: string[] = [];
      const lines = stdout.split('\n');
      
      for (const line of lines) {
        if (line.includes('#')) {
          const match = line.match(/#\d+\s+(\S+)/);
          if (match) {
            files.push(match[1]);
          }
        }
      }
      
      return files;
      
    } catch (error) {
      logger.error('Failed to list files:', error);
      return [];
    }
  }
  
  async downloadFile(cameraPath: string, localPath: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      logger.info(`Downloading ${cameraPath} to ${localPath}`);
      
      await execAsync(
        `gphoto2 --get-file ${cameraPath} --filename="${localPath}"`
      );
      
      logger.info('File downloaded successfully');
      
    } catch (error) {
      logger.error('Download failed:', error);
      throw error;
    }
  }
  
  async deleteFile(cameraPath: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      await execAsync(`gphoto2 --delete-file ${cameraPath}`);
      logger.info(`Deleted ${cameraPath} from camera`);
      
    } catch (error) {
      logger.error('Delete failed:', error);
      throw error;
    }
  }
  
  async triggerCapture(): Promise<void> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      logger.info('Triggering capture (no download)');
      await execAsync('gphoto2 --trigger-capture');
      
    } catch (error) {
      logger.error('Trigger failed:', error);
      throw error;
    }
  }
  
  async waitForEvent(timeout: number = 5000): Promise<string> {
    if (!this.connected) {
      throw new Error('Camera not connected');
    }
    
    try {
      const { stdout } = await execAsync(
        `gphoto2 --wait-event=${timeout}ms`
      );
      
      return stdout;
      
    } catch (error) {
      logger.error('Wait event failed:', error);
      return '';
    }
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  getCameraInfo(): GPhoto2CameraInfo | undefined {
    return this.cameraInfo;
  }
}