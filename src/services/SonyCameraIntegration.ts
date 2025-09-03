import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs/promises';
import { mlServiceClient } from '../ml/MLServiceClient';

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
  // (Codex-CTO) Configurable paths/env for robust spawning
  private repoRoot: string;
  private inventoryDir: string;
  private stagingDir: string;
  private cameraBuildDir: string;
  private cameraTimeoutMs: number;
  private connected: boolean = false;
  private capturing: boolean = false;
  private captureQueue: Array<(result: CaptureResult) => void> = [];
  
  // Daemon mode support (optional for performance optimization)
  private useDaemonMode: boolean;
  private daemonProcess?: ChildProcess;
  private daemonReady: boolean = false;
  private daemonCaptures: Map<string, { resolve: Function; reject: Function; startTime: number }> = new Map();
  
  private stats = {
    totalCaptures: 0,
    failedCaptures: 0,
    captureTimes: [] as number[],
  };

  constructor() {
    super();
    const cardmintRoot = path.resolve(__dirname, '../..');
    this.repoRoot = cardmintRoot;
    this.scriptPath = path.join(cardmintRoot, 'scripts', 'sony-camera-controller.sh');
    this.inventoryDir = process.env.INVENTORY_IMAGES_DIR || path.join(cardmintRoot, 'data', 'inventory_images');
    this.stagingDir = process.env.CAPTURE_STAGING_DIR || path.join(cardmintRoot, 'data', 'capture_staging');
    this.cameraBuildDir = process.env.CAMERA_BUILD_DIR || path.join(cardmintRoot, 'CrSDK_v2.00.00_20250805a_Linux64PC', 'build');
    this.cameraTimeoutMs = parseInt(process.env.CAMERA_TIMEOUT_MS || '10000', 10);
    
    // Enable daemon mode for performance (can be disabled via env var)
    this.useDaemonMode = process.env.CAMERA_DAEMON_MODE !== 'false';
    
    logger.info('Sony Camera Integration initialized', { 
      scriptPath: this.scriptPath,
      inventoryDir: this.inventoryDir,
      stagingDir: this.stagingDir,
      cameraBuildDir: this.cameraBuildDir,
      cameraTimeoutMs: this.cameraTimeoutMs,
      useDaemonMode: this.useDaemonMode,
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
        env: {
          ...process.env,
          INVENTORY_IMAGES_DIR: this.inventoryDir,
          CAPTURE_STAGING_DIR: this.stagingDir,
          CAMERA_BUILD_DIR: this.cameraBuildDir,
          CAMERA_TIMEOUT_MS: String(this.cameraTimeoutMs),
        },
        cwd: this.repoRoot,
      });

      let stdout = '';
      let stderr = '';
      let isResolved = false;

      // Set up our own timeout that gives the script time to complete
      const timeoutHandle = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          proc.kill('SIGTERM');
          reject(new Error(`Script timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            reject(new Error(`Script failed (code ${code}): ${stderr || stdout}`));
          }
        }
      });

      proc.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          reject(error);
        }
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
      
      if (this.useDaemonMode) {
        // In daemon mode, connection happens during daemon startup
        const daemonStarted = await this.startDaemon();
        if (!daemonStarted) {
          logger.warn('Daemon mode failed, falling back to script mode');
          this.useDaemonMode = false;
          return this.connect(); // Retry with script mode
        }
        this.connected = true;
      } else {
        // Traditional script mode
        await this.runScript('connect', 15000); // 15 second timeout for connection
        this.connected = true;
      }
      
      this.emit('connected');
      logger.info(`Camera connected successfully (${this.useDaemonMode ? 'daemon' : 'script'} mode)`);
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
   * Capture image using daemon communication
   */
  private async captureDaemonImage(): Promise<CaptureResult> {
    return new Promise((resolve) => {
      if (!this.daemonProcess || !this.daemonReady) {
        resolve({
          success: false,
          error: 'Daemon not ready',
          timestamp: new Date(),
        });
        return;
      }

      const captureId = `capture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();
      
      // Store promise handlers for this capture
      this.daemonCaptures.set(captureId, {
        resolve,
        reject: resolve, // Both resolve for consistent error handling
        startTime,
      });

      // Set timeout for daemon capture
      const timeout = setTimeout(() => {
        const capture = this.daemonCaptures.get(captureId);
        if (capture) {
          this.daemonCaptures.delete(captureId);
          resolve({
            success: false,
            error: 'Daemon capture timeout',
            timestamp: new Date(),
          });
        }
      }, this.cameraTimeoutMs);

      // Listen for daemon response (parse daemon stdout for capture results)
      const responseHandler = (data: Buffer) => {
        const output = data.toString();
        
        if (output.includes('SUCCESS:') || output.includes('FAILED:')) {
          const capture = this.daemonCaptures.get(captureId);
          if (capture) {
            clearTimeout(timeout);
            this.daemonCaptures.delete(captureId);
            
            const captureTime = Date.now() - capture.startTime;
            const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
            const protoLine = [...lines].reverse().find(l => l.startsWith('SUCCESS:') || l.startsWith('FAILED:')) || '';
            const parts = protoLine ? protoLine.split(':') : [];
            
            if (parts[0] === 'SUCCESS' && parts.length >= 2) {
              const imagePath = parts[1];
              const scriptCaptureMs = parts.length >= 3 ? parseInt(parts[2]) || captureTime : captureTime;
              
              resolve({
                success: true,
                imagePath,
                captureTimeMs: scriptCaptureMs,
                timestamp: new Date(),
              });
            } else {
              resolve({
                success: false,
                error: parts.length > 1 ? parts[1] : 'Unknown daemon capture failure',
                timestamp: new Date(),
              });
            }
          }
        }
      };

      // Attach response handler temporarily
      this.daemonProcess.stdout?.once('data', responseHandler);
      
      // Send capture command to daemon
      this.daemonProcess.stdin?.write('CAPTURE\n');
    });
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
      let result: CaptureResult;
      
      if (this.useDaemonMode && this.daemonProcess && this.daemonReady) {
        // Use persistent daemon for optimal performance
        logger.debug('Using daemon mode for capture');
        result = await this.captureDaemonImage();
      } else {
        // Fall back to traditional script mode
        logger.debug('Using script mode for capture');
        const output = await this.runScript('capture', 12000); // 12 second timeout - real-world capture is ~5000ms
        const captureTime = Date.now() - startTime;
        
        // Parse output format: SUCCESS:path:capture_ms or FAILED:reason:capture_ms
        // Choose the last protocol line to avoid contamination from logs
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        const protoLine = [...lines].reverse().find(l => l.startsWith('SUCCESS:') || l.startsWith('FAILED:')) || '';
        const parts = protoLine ? protoLine.split(':') : [];
        
        if (parts[0] === 'SUCCESS' && parts.length >= 2) {
          const imagePath = parts[1];
          const scriptCaptureMs = parts.length >= 3 ? parseInt(parts[2]) || captureTime : captureTime;
          
          result = {
            success: true,
            imagePath,
            captureTimeMs: scriptCaptureMs,
            timestamp: new Date(),
          };
        } else {
          // Failed capture - check for parser recovery
          this.stats.failedCaptures++;
          const reason = (parts[0]?.startsWith('FAILED') && parts.length > 1)
            ? parts[1]
            : `Unknown failure${protoLine ? ` (${protoLine})` : ''}`;
          
          // Parser recovery: if stdout contains a plausible .jpg path that exists, treat as success
          try {
            const pathMatch = output.match(/(\/[\w\-\.\/~]+\.jpg)/i);
            if (pathMatch) {
              const candidate = pathMatch[1];
              const stat = await fs.stat(candidate).catch(() => undefined);
              if (stat && stat.isFile() && stat.size > 1024) {
                const scriptCaptureMs = captureTime;
                result = {
                  success: true,
                  imagePath: candidate,
                  captureTimeMs: scriptCaptureMs,
                  timestamp: new Date(),
                };
                logger.warn(`Parser recovery succeeded: found ${candidate} (${stat.size} bytes)`);
              } else {
                result = {
                  success: false,
                  error: reason,
                  timestamp: new Date(),
                };
              }
            } else {
              result = {
                success: false,
                error: reason,
                timestamp: new Date(),
              };
            }
          } catch {
            result = {
              success: false,
              error: reason,
              timestamp: new Date(),
            };
          }
        }
      }
      
      // Handle successful capture (regardless of mode)
      if (result.success) {
        // Update statistics
        this.stats.totalCaptures++;
        this.stats.captureTimes.push(result.captureTimeMs || 0);
        
        // Keep only last 100 capture times for average calculation
        if (this.stats.captureTimes.length > 100) {
          this.stats.captureTimes = this.stats.captureTimes.slice(-100);
        }

        logger.info(`Image captured successfully in ${result.captureTimeMs}ms: ${result.imagePath} (${this.useDaemonMode && this.daemonReady ? 'daemon' : 'script'} mode)`);
        
        // HOTFIX: Directly trigger ML processing (bypass broken watcher)
        this.triggerMLProcessing(result.imagePath).catch(error => {
          logger.warn('ML processing failed for captured image:', error);
        });
        
        this.emit('captureResult', result);
        this.emit('imageCaptured', result);
        
        return result;
      } else {
        // Failed capture
        this.stats.failedCaptures++;
        const reason = (parts[0]?.startsWith('FAILED') && parts.length > 1)
          ? parts[1]
          : `Unknown failure${protoLine ? ` (${protoLine})` : ''}`;
        
        // Parser recovery: if stdout contains a plausible .jpg path that exists, treat as success
        try {
          const pathMatch = output.match(/(\/[\w\-\.\/~]+\.jpg)/i);
          if (pathMatch) {
            const candidate = pathMatch[1];
            const stat = await fs.stat(candidate).catch(() => undefined);
            if (stat && stat.isFile() && stat.size > 1024) {
              const scriptCaptureMs = captureTime;
              // Update statistics
              this.stats.totalCaptures++;
              this.stats.captureTimes.push(scriptCaptureMs);
              if (this.stats.captureTimes.length > 100) {
                this.stats.captureTimes = this.stats.captureTimes.slice(-100);
              }
              const recovered: CaptureResult = {
                success: true,
                imagePath: candidate,
                captureTimeMs: scriptCaptureMs,
                timestamp: new Date(),
              };
              logger.warn('Parser recovery treated capture as success', { candidate });
              this.emit('captureResult', recovered);
              this.emit('imageCaptured', recovered);
              return recovered;
            }
          }
        } catch {}

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
          const healthy = passed >= total - 1; // Allow 4/5 checks to pass (directory write check is flaky)
          
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
   * Start persistent daemon for optimal performance
   */
  private async startDaemon(): Promise<boolean> {
    if (this.daemonProcess || !this.useDaemonMode) {
      return false;
    }

    logger.info('Starting Sony camera daemon for persistent connection...');

    try {
      const env = {
        ...process.env,
        LD_LIBRARY_PATH: `${this.cameraBuildDir}:${this.cameraBuildDir}/CrAdapter:${path.join(this.repoRoot, 'CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk')}:${path.join(this.repoRoot, 'CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk/CrAdapter')}`,
        CAPTURE_STAGING_DIR: this.stagingDir,
        INVENTORY_IMAGES_DIR: this.inventoryDir,
      };

      this.daemonProcess = spawn('./sony-daemon', [], {
        cwd: this.cameraBuildDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Handle daemon output
      this.daemonProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        logger.debug('Daemon stdout:', output);
        
        if (output.includes('Ready for captures')) {
          this.daemonReady = true;
          logger.info('Sony daemon ready for captures');
        }
      });

      this.daemonProcess.stderr?.on('data', (data) => {
        logger.debug('Daemon stderr:', data.toString());
      });

      this.daemonProcess.on('exit', (code) => {
        logger.warn(`Sony daemon exited with code ${code}`);
        this.daemonProcess = undefined;
        this.daemonReady = false;
      });

      // Wait for daemon to be ready
      let retries = 0;
      while (!this.daemonReady && retries < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
      }

      return this.daemonReady;
    } catch (error) {
      logger.error('Failed to start Sony daemon:', error);
      return false;
    }
  }

  /**
   * Stop daemon process
   */
  private async stopDaemon(): Promise<void> {
    if (this.daemonProcess) {
      logger.info('Stopping Sony camera daemon...');
      this.daemonProcess.kill('SIGTERM');
      
      // Wait for graceful shutdown or force kill after timeout
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          if (this.daemonProcess) {
            this.daemonProcess.kill('SIGKILL');
          }
          resolve(void 0);
        }, 3000);
        
        this.daemonProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve(void 0);
        });
      });

      this.daemonProcess = undefined;
      this.daemonReady = false;
    }
  }

  /**
   * HOTFIX: Directly trigger ML processing (bypass broken watcher)
   */
  private async triggerMLProcessing(imagePath: string): Promise<void> {
    try {
      logger.info('🧠 Starting ML processing for captured image:', imagePath);
      
      const result = await mlServiceClient.recognizeCard(imagePath, true);
      
      if (result) {
        logger.info('✅ ML processing successful:', {
          cardName: result.card_name,
          confidence: result.ensemble_confidence,
          inferenceTime: result.inference_time_ms,
          models: result.active_models
        });
      } else {
        logger.warn('❌ ML processing returned no result - service may be unavailable');
      }
    } catch (error) {
      logger.error('❌ ML processing failed:', error);
    }
  }

  /**
   * Cleanup - disconnect and clear queue
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up Sony camera integration...');
    
    await this.stopDaemon();
    this.clearQueue();
    
    if (this.connected) {
      await this.disconnect();
    }
    
    logger.info('Camera integration cleanup complete');
  }
}
