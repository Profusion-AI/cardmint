import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { SonyCamera } from './SonyCamera';
import { performance } from 'perf_hooks';

const logger = createLogger('camera-state-machine');

export enum CameraState {
  IDLE = 'IDLE',
  DISCOVERING = 'DISCOVERING',
  OPENING_SESSION = 'OPENING_SESSION',
  SETTING_MODE = 'SETTING_MODE',
  CONFIGURING = 'CONFIGURING',
  READY = 'READY',
  CAPTURING = 'CAPTURING',
  DOWNLOADING = 'DOWNLOADING',
  ERROR = 'ERROR',
  FALLBACK = 'FALLBACK',
}

export enum CameraPath {
  SONY = 'sony',
  UVC = 'uvc',
  GPHOTO2 = 'gphoto2',
}

export interface CameraConfig {
  shutterSpeed?: string;
  iso?: number;
  aperture?: string;
  driveMode?: 'single' | 'continuous' | 'bracket';
  imageFormat?: 'JPEG' | 'RAW' | 'RAW+JPEG';
  autoFocus?: boolean;
}

export interface CaptureResult {
  path: string;
  metadata: {
    captureTime: number;
    exposure: string;
    iso: number;
    aperture: string;
    lens?: string;
    cameraPath: CameraPath;
    stateTransitions: string[];
  };
}

interface StateTransition {
  from: CameraState;
  to: CameraState;
  timestamp: number;
  duration?: number;
}

export class CameraStateMachine extends EventEmitter {
  private state: CameraState = CameraState.IDLE;
  private camera?: SonyCamera;
  private cameraPath: CameraPath = CameraPath.SONY;
  private stateHistory: StateTransition[] = [];
  private watchdogTimer?: NodeJS.Timeout;
  private readonly OPERATION_TIMEOUT_MS = 1200;
  private readonly MAX_RETRY_ATTEMPTS = 2;
  private retryCount = 0;
  private fallbackProviders: Map<CameraPath, () => Promise<boolean>>;
  
  constructor() {
    super();
    this.fallbackProviders = new Map([
      [CameraPath.UVC, this.initUVCCamera.bind(this)],
      [CameraPath.GPHOTO2, this.initGPhoto2Camera.bind(this)],
    ]);
  }
  
  async initialize(): Promise<boolean> {
    try {
      logger.info('Initializing camera state machine');
      
      // Try Sony SDK first
      if (await this.initSonyCamera()) {
        this.cameraPath = CameraPath.SONY;
        this.emit('initialized', { path: this.cameraPath });
        return true;
      }
      
      // Fallback sequence
      logger.warn('Sony SDK initialization failed, trying fallbacks');
      for (const [path, initFn] of this.fallbackProviders) {
        if (await initFn()) {
          this.cameraPath = path;
          this.setState(CameraState.FALLBACK);
          this.emit('fallback', { path });
          logger.info(`Using fallback camera path: ${path}`);
          return true;
        }
      }
      
      this.setState(CameraState.ERROR);
      return false;
      
    } catch (error) {
      logger.error('Failed to initialize camera:', error);
      this.setState(CameraState.ERROR);
      return false;
    }
  }
  
  private async initSonyCamera(): Promise<boolean> {
    try {
      this.setState(CameraState.DISCOVERING);
      this.startWatchdog('Discovery');
      
      this.camera = new SonyCamera({
        type: 'USB',
        autoReconnect: true,
        liveViewQuality: 'high',
      });
      
      this.setState(CameraState.OPENING_SESSION);
      const connected = await this.withTimeout(
        this.camera.connect(),
        this.OPERATION_TIMEOUT_MS,
        'Open session timeout'
      );
      
      if (!connected) {
        throw new Error('Failed to connect to Sony camera');
      }
      
      this.setState(CameraState.SETTING_MODE);
      await this.withTimeout(
        this.camera.setProperty('DriveMode', 'Single'),
        this.OPERATION_TIMEOUT_MS,
        'Set mode timeout'
      );
      
      // Drain any pending data
      await this.flushCameraEndpoints();
      
      this.setState(CameraState.READY);
      this.clearWatchdog();
      
      logger.info('Sony camera initialized successfully');
      return true;
      
    } catch (error) {
      logger.error('Sony camera initialization failed:', error);
      this.clearWatchdog();
      
      if (this.camera) {
        await this.camera.disconnect().catch(() => {});
        this.camera = undefined;
      }
      
      return false;
    }
  }
  
  private async initUVCCamera(): Promise<boolean> {
    try {
      logger.info('Initializing UVC camera fallback');
      // Implementation would use V4L2 bindings
      // For now, return false to continue to next fallback
      return false;
    } catch (error) {
      logger.error('UVC initialization failed:', error);
      return false;
    }
  }
  
  private async initGPhoto2Camera(): Promise<boolean> {
    try {
      logger.info('Initializing gPhoto2 camera fallback');
      // Implementation would use libgphoto2 bindings
      // For now, return false
      return false;
    } catch (error) {
      logger.error('gPhoto2 initialization failed:', error);
      return false;
    }
  }
  
  async configure(config: CameraConfig): Promise<boolean> {
    if (this.state !== CameraState.READY) {
      logger.error(`Cannot configure in state: ${this.state}`);
      return false;
    }
    
    try {
      this.setState(CameraState.CONFIGURING);
      this.startWatchdog('Configuration');
      
      if (this.camera && this.cameraPath === CameraPath.SONY) {
        const configOps = [];
        
        if (config.shutterSpeed) {
          configOps.push(this.camera.setProperty('ShutterSpeed', config.shutterSpeed));
        }
        if (config.iso !== undefined) {
          configOps.push(this.camera.setProperty('ISO', config.iso.toString()));
        }
        if (config.aperture) {
          configOps.push(this.camera.setProperty('Aperture', config.aperture));
        }
        if (config.driveMode) {
          configOps.push(this.camera.setProperty('DriveMode', config.driveMode));
        }
        if (config.imageFormat) {
          configOps.push(this.camera.setProperty('ImageFormat', config.imageFormat));
        }
        if (config.autoFocus !== undefined) {
          configOps.push(this.camera.setProperty('AutoFocus', config.autoFocus ? 'ON' : 'OFF'));
        }
        
        await this.withTimeout(
          Promise.all(configOps),
          this.OPERATION_TIMEOUT_MS * 2,
          'Configuration timeout'
        );
      }
      
      this.setState(CameraState.READY);
      this.clearWatchdog();
      return true;
      
    } catch (error) {
      logger.error('Configuration failed:', error);
      this.clearWatchdog();
      await this.handleError(error);
      return false;
    }
  }
  
  async capture(preset: 'single' | 'burst' | 'bracket' = 'single'): Promise<CaptureResult | null> {
    if (this.state !== CameraState.READY) {
      logger.error(`Cannot capture in state: ${this.state}`);
      return null;
    }
    
    const startTime = performance.now();
    const stateTransitions: string[] = [];
    
    try {
      this.setState(CameraState.CAPTURING);
      stateTransitions.push(`${CameraState.READY}→${CameraState.CAPTURING}`);
      this.startWatchdog('Capture');
      
      let imagePath: string;
      
      if (this.camera && this.cameraPath === CameraPath.SONY) {
        imagePath = await this.withTimeout(
          this.camera.captureImage(),
          this.OPERATION_TIMEOUT_MS,
          'Capture timeout'
        );
        
        this.setState(CameraState.DOWNLOADING);
        stateTransitions.push(`${CameraState.CAPTURING}→${CameraState.DOWNLOADING}`);
        
        // In real implementation, would download from camera
        // For now, imagePath is returned directly
      } else {
        // Fallback capture implementation
        imagePath = await this.captureFallback(preset);
      }
      
      this.setState(CameraState.READY);
      stateTransitions.push(`${CameraState.DOWNLOADING}→${CameraState.READY}`);
      this.clearWatchdog();
      
      const captureTime = performance.now() - startTime;
      
      const result: CaptureResult = {
        path: imagePath,
        metadata: {
          captureTime,
          exposure: await this.getExposureInfo(),
          iso: await this.getISO(),
          aperture: await this.getAperture(),
          cameraPath: this.cameraPath,
          stateTransitions,
        },
      };
      
      logger.info(`Capture completed in ${captureTime.toFixed(0)}ms via ${this.cameraPath}`);
      this.emit('captureComplete', result);
      
      return result;
      
    } catch (error) {
      logger.error('Capture failed:', error);
      this.clearWatchdog();
      await this.handleError(error);
      return null;
    }
  }
  
  async captureExposureBracket(steps: number = 5, evStep: number = 1): Promise<CaptureResult[]> {
    const results: CaptureResult[] = [];
    
    try {
      // Store original exposure
      const originalEV = await this.camera?.getProperty('ExposureCompensation');
      
      for (let i = 0; i < steps; i++) {
        const ev = (i - Math.floor(steps / 2)) * evStep;
        await this.camera?.setProperty('ExposureCompensation', ev.toString());
        
        const result = await this.capture('single');
        if (result) {
          results.push(result);
        }
      }
      
      // Restore original exposure
      if (originalEV) {
        await this.camera?.setProperty('ExposureCompensation', originalEV);
      }
      
      return results;
      
    } catch (error) {
      logger.error('Exposure bracket failed:', error);
      return results;
    }
  }
  
  async captureFocusBracket(steps: number = 5): Promise<CaptureResult[]> {
    const results: CaptureResult[] = [];
    
    try {
      for (let i = 0; i < steps; i++) {
        // Adjust focus position
        await this.camera?.setProperty('FocusPosition', i.toString());
        
        const result = await this.capture('single');
        if (result) {
          results.push(result);
        }
      }
      
      return results;
      
    } catch (error) {
      logger.error('Focus bracket failed:', error);
      return results;
    }
  }
  
  private async captureFallback(preset: string): Promise<string> {
    // Placeholder for fallback capture
    logger.info(`Fallback capture via ${this.cameraPath}`);
    return `/tmp/fallback_${Date.now()}.jpg`;
  }
  
  private setState(newState: CameraState): void {
    const transition: StateTransition = {
      from: this.state,
      to: newState,
      timestamp: Date.now(),
    };
    
    if (this.stateHistory.length > 0) {
      const lastTransition = this.stateHistory[this.stateHistory.length - 1];
      lastTransition.duration = transition.timestamp - lastTransition.timestamp;
    }
    
    this.stateHistory.push(transition);
    this.state = newState;
    
    logger.debug(`State transition: ${transition.from} → ${transition.to}`);
    this.emit('stateChange', { from: transition.from, to: transition.to });
  }
  
  private startWatchdog(operation: string): void {
    this.clearWatchdog();
    
    this.watchdogTimer = setTimeout(() => {
      logger.error(`Watchdog timeout for operation: ${operation}`);
      this.handleTimeout(operation);
    }, this.OPERATION_TIMEOUT_MS);
  }
  
  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }
  
  private async handleTimeout(operation: string): Promise<void> {
    logger.error(`Operation timeout: ${operation}`);
    
    this.retryCount++;
    
    if (this.retryCount >= this.MAX_RETRY_ATTEMPTS) {
      logger.error('Max retries exceeded, switching to fallback');
      await this.switchToFallback();
    } else {
      logger.info(`Retrying operation (attempt ${this.retryCount}/${this.MAX_RETRY_ATTEMPTS})`);
      await this.reinitialize();
    }
  }
  
  private async handleError(error: any): Promise<void> {
    const errorCode = error.code || 'UNKNOWN';
    
    if (errorCode === 'EPIPE' || errorCode === 'ETIME') {
      await this.flushCameraEndpoints();
      await this.reinitialize();
    } else {
      this.setState(CameraState.ERROR);
    }
  }
  
  private async reinitialize(): Promise<void> {
    logger.info('Reinitializing camera connection');
    
    if (this.camera) {
      await this.camera.disconnect().catch(() => {});
    }
    
    await this.initialize();
  }
  
  private async switchToFallback(): Promise<void> {
    logger.info('Switching to fallback camera path');
    
    if (this.camera) {
      await this.camera.disconnect().catch(() => {});
      this.camera = undefined;
    }
    
    for (const [path, initFn] of this.fallbackProviders) {
      if (await initFn()) {
        this.cameraPath = path;
        this.setState(CameraState.FALLBACK);
        this.emit('fallback', { path });
        this.retryCount = 0;
        return;
      }
    }
    
    this.setState(CameraState.ERROR);
  }
  
  private async flushCameraEndpoints(): Promise<void> {
    // Flush any pending data from camera endpoints
    // This would interact with USB endpoints directly
    logger.debug('Flushing camera endpoints');
  }
  
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    
    return Promise.race([promise, timeoutPromise]);
  }
  
  private async getExposureInfo(): Promise<string> {
    if (this.camera && this.cameraPath === CameraPath.SONY) {
      const shutter = await this.camera.getProperty('ShutterSpeed');
      return shutter || '1/125';
    }
    return '1/60'; // Fallback fixed exposure
  }
  
  private async getISO(): Promise<number> {
    if (this.camera && this.cameraPath === CameraPath.SONY) {
      const iso = await this.camera.getProperty('ISO');
      return parseInt(iso) || 100;
    }
    return 400; // Fallback fixed ISO
  }
  
  private async getAperture(): Promise<string> {
    if (this.camera && this.cameraPath === CameraPath.SONY) {
      const aperture = await this.camera.getProperty('Aperture');
      return aperture || 'f/5.6';
    }
    return 'f/4.0'; // Fallback fixed aperture
  }
  
  async shutdown(): Promise<void> {
    logger.info('Shutting down camera state machine');
    
    this.clearWatchdog();
    
    if (this.camera) {
      await this.camera.disconnect().catch(() => {});
    }
    
    this.setState(CameraState.IDLE);
    this.removeAllListeners();
  }
  
  getState(): CameraState {
    return this.state;
  }
  
  getCameraPath(): CameraPath {
    return this.cameraPath;
  }
  
  getStateHistory(): StateTransition[] {
    return [...this.stateHistory];
  }
  
  getHealthMetrics() {
    return {
      state: this.state,
      cameraPath: this.cameraPath,
      retryCount: this.retryCount,
      stateHistory: this.stateHistory.slice(-10), // Last 10 transitions
      uptime: Date.now() - (this.stateHistory[0]?.timestamp || Date.now()),
    };
  }
}