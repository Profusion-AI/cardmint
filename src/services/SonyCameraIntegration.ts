import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs/promises';

const logger = createLogger('sony-camera');

export interface CaptureResult {
  success: boolean;
  imagePath?: string;
  captureTimeMs?: number;
  error?: string;
  timestamp: Date;
}

export interface CameraStatus {
  connected: boolean;
  lastCapture?: Date;
  totalCaptures: number;
  failedCaptures: number;
  averageCaptureTime?: number;
}

export interface HealthCheckResult {
  passed: number;
  total: number;
  healthy: boolean;
  details: string;
}

export class SonyCameraIntegration extends EventEmitter {
  private scriptPath: string;
  private connected: boolean = false;
  private capturing: boolean = false;
  private captureQueue: Array<(result: CaptureResult) => void> = [];
  private stats = {
    totalCaptures: 0,
    failedCaptures: 0,
    captureTimes: [] as number[],
  };

  constructor() {
    super();
    const cardmintRoot = path.resolve(__dirname, '../..');
    this.scriptPath = path.join(cardmintRoot, 'scripts', 'sony-camera-controller.sh');
    
    logger.info('Sony Camera Integration initialized', { 
      scriptPath: this.scriptPath 
    });
  }

  /**
   * Initialize the camera integration
   */
  async initialize(): Promise<boolean> {
    try {
      // Verify the script exists and is executable
      const stats = await fs.stat(this.scriptPath);
      if (!stats.isFile()) {
        logger.error('Camera controller script not found or not a file');
        return false;
      }

      // Perform health check
      const healthResult = await this.healthCheck();
      if (!healthResult.healthy) {
        logger.error('Camera health check failed', healthResult);
        return false;
      }

      logger.info('Sony camera integration initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize camera integration:', error);
      return false;
    }
  }

  /**
   * Run camera controller script command
   */
  private async runScript(command: string, timeoutMs: number = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', [this.scriptPath, command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Script failed (code ${code}): ${stderr || stdout}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Connect to the Sony camera
   */
  async connect(): Promise<boolean> {
    if (this.connected) {
      logger.debug('Camera already connected');
      return true;
    }

    try {
      logger.info('Connecting to Sony camera...');
      await this.runScript('connect', 15000); // 15 second timeout for connection
      
      this.connected = true;
      this.emit('connected');
      logger.info('Camera connected successfully');
      return true;
    } catch (error) {
      logger.error('Failed to connect to camera:', error);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Disconnect from the Sony camera
   */
  async disconnect(): Promise<boolean> {
    if (!this.connected) {
      logger.debug('Camera already disconnected');
      return true;
    }

    try {
      logger.info('Disconnecting from Sony camera...');
      await this.runScript('disconnect', 10000);
      
      this.connected = false;
      this.emit('disconnected');
      logger.info('Camera disconnected successfully');
      return true;
    } catch (error) {
      logger.error('Failed to disconnect camera cleanly:', error);
      this.connected = false; // Force disconnect
      return false;
    }
  }

  /**
   * Capture a single image
   */
  async captureImage(): Promise<CaptureResult> {
    const startTime = Date.now();
    
    // Check if already capturing
    if (this.capturing) {
      const result: CaptureResult = {
        success: false,
        error: 'Camera is busy capturing another image',
        timestamp: new Date(),
      };
      this.emit('captureResult', result);
      return result;
    }

    // Check if connected
    if (!this.connected) {
      logger.warn('Attempting to capture without connection, trying to connect first...');
      const connected = await this.connect();
      if (!connected) {
        const result: CaptureResult = {
          success: false,
          error: 'Camera not connected and failed to connect',
          timestamp: new Date(),
        };
        this.emit('captureResult', result);
        return result;
      }
    }

    this.capturing = true;
    logger.info('Starting image capture...');

    try {
      const output = await this.runScript('capture', 8000); // 8 second timeout
      const captureTime = Date.now() - startTime;
      
      // Parse output format: SUCCESS:path:capture_ms or FAILED:reason:capture_ms
      const parts = output.split(':');
      
      if (parts[0] === 'SUCCESS' && parts.length >= 2) {
        const imagePath = parts[1];
        const scriptCaptureMs = parts.length >= 3 ? parseInt(parts[2]) || captureTime : captureTime;
        
        // Update statistics
        this.stats.totalCaptures++;
        this.stats.captureTimes.push(scriptCaptureMs);
        
        // Keep only last 100 capture times for average calculation
        if (this.stats.captureTimes.length > 100) {
          this.stats.captureTimes = this.stats.captureTimes.slice(-100);
        }

        const result: CaptureResult = {
          success: true,
          imagePath,
          captureTimeMs: scriptCaptureMs,
          timestamp: new Date(),
        };

        logger.info(`Image captured successfully in ${scriptCaptureMs}ms: ${imagePath}`);
        this.emit('captureResult', result);
        this.emit('imageCaptured', result);
        
        return result;
      } else {
        // Failed capture
        this.stats.failedCaptures++;
        const reason = parts.length > 1 ? parts[1] : 'Unknown failure';
        
        const result: CaptureResult = {
          success: false,
          error: reason,
          captureTimeMs: captureTime,
          timestamp: new Date(),
        };

        logger.error(`Image capture failed: ${reason} (${captureTime}ms)`);
        this.emit('captureResult', result);
        
        return result;
      }
    } catch (error) {
      const captureTime = Date.now() - startTime;
      this.stats.failedCaptures++;
      
      const result: CaptureResult = {
        success: false,
        error: error.message,
        captureTimeMs: captureTime,
        timestamp: new Date(),
      };

      logger.error(`Capture command failed: ${error.message} (${captureTime}ms)`);
      this.emit('captureResult', result);
      this.emit('error', error);
      
      return result;
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Queue a capture request (with backpressure handling)
   */
  async queueCapture(): Promise<CaptureResult> {
    return new Promise((resolve) => {
      if (this.captureQueue.length >= 10) {
        // Queue full, reject immediately
        const result: CaptureResult = {
          success: false,
          error: 'Capture queue is full (max 10 pending captures)',
          timestamp: new Date(),
        };
        resolve(result);
        return;
      }

      this.captureQueue.push(resolve);
      this.processNextCapture();
    });
  }

  /**
   * Process next capture in queue
   */
  private async processNextCapture(): Promise<void> {
    if (this.capturing || this.captureQueue.length === 0) {
      return;
    }

    const callback = this.captureQueue.shift();
    if (callback) {
      const result = await this.captureImage();
      callback(result);
      
      // Process next item in queue
      setImmediate(() => this.processNextCapture());
    }
  }

  /**
   * Get camera status and statistics
   */
  getStatus(): CameraStatus {
    const avgTime = this.stats.captureTimes.length > 0
      ? this.stats.captureTimes.reduce((sum, time) => sum + time, 0) / this.stats.captureTimes.length
      : undefined;

    return {
      connected: this.connected,
      totalCaptures: this.stats.totalCaptures,
      failedCaptures: this.stats.failedCaptures,
      averageCaptureTime: avgTime,
    };
  }

  /**
   * Perform comprehensive health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      logger.info('Performing camera health check...');
      const output = await this.runScript('health', 30000); // 30 second timeout
      
      // Parse output format: HEALTH_CHECK:passed:total
      const lines = output.split('\n');
      const healthLine = lines.find(line => line.startsWith('HEALTH_CHECK:'));
      
      if (healthLine) {
        const parts = healthLine.split(':');
        if (parts.length >= 3) {
          const passed = parseInt(parts[1]) || 0;
          const total = parseInt(parts[2]) || 0;
          const healthy = passed === total;
          
          const result: HealthCheckResult = {
            passed,
            total,
            healthy,
            details: output,
          };
          
          logger.info(`Health check result: ${passed}/${total} checks passed (${healthy ? 'HEALTHY' : 'UNHEALTHY'})`);
          return result;
        }
      }
      
      throw new Error('Invalid health check output format');
    } catch (error) {
      logger.error('Health check failed:', error);
      return {
        passed: 0,
        total: 5,
        healthy: false,
        details: error.message,
      };
    }
  }

  /**
   * List available cameras
   */
  async listCameras(): Promise<string[]> {
    try {
      const output = await this.runScript('list', 15000);
      const lines = output.split('\n');
      const cameras: string[] = [];
      
      for (const line of lines) {
        if (line.startsWith('DEVICE:')) {
          cameras.push(line.substring(7)); // Remove "DEVICE:" prefix
        }
      }
      
      return cameras;
    } catch (error) {
      logger.error('Failed to list cameras:', error);
      return [];
    }
  }

  /**
   * Check if camera is currently capturing
   */
  isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Check if camera is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get capture queue length
   */
  getQueueLength(): number {
    return this.captureQueue.length;
  }

  /**
   * Clear capture queue
   */
  clearQueue(): void {
    const queueLength = this.captureQueue.length;
    if (queueLength > 0) {
      logger.warn(`Clearing ${queueLength} queued captures`);
      
      // Reject all queued captures
      for (const callback of this.captureQueue) {
        callback({
          success: false,
          error: 'Capture queue cleared',
          timestamp: new Date(),
        });
      }
      
      this.captureQueue = [];
    }
  }

  /**
   * Cleanup - disconnect and clear queue
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Sony camera integration...');
    
    this.clearQueue();
    
    if (this.connected) {
      await this.disconnect();
    }
    
    logger.info('Camera integration cleanup complete');
  }
}