import { EventEmitter } from 'events';
import { CameraStateMachine, CameraState, CameraPath, CaptureResult } from './CameraStateMachine';
import { CapturePresets, PresetType, PresetConfig } from './CapturePresets';
import { createLogger } from '../utils/logger';
import { MetricsCollector } from '../utils/metrics';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createLogger('camera-service');

export interface CaptureOptions {
  preset: PresetType | 'custom';
  customConfig?: PresetConfig;
  outputDir?: string;
  generateSidecar?: boolean;
  runId?: string;
}

export interface CaptureSession {
  runId: string;
  preset: string;
  startTime: number;
  endTime?: number;
  captures: CaptureResult[];
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

export class CameraService extends EventEmitter {
  private stateMachine: CameraStateMachine;
  private presets: CapturePresets;
  private metrics?: MetricsCollector;
  private activeSessions: Map<string, CaptureSession>;
  private successCount = 0;
  private failureCount = 0;
  private lastCaptureLatency = 0;
  
  constructor(metrics?: MetricsCollector) {
    super();
    this.stateMachine = new CameraStateMachine();
    this.presets = new CapturePresets();
    this.metrics = metrics;
    this.activeSessions = new Map();
    
    this.setupEventHandlers();
  }
  
  private setupEventHandlers(): void {
    this.stateMachine.on('stateChange', ({ from, to }) => {
      logger.debug(`Camera state: ${from} → ${to}`);
      this.metrics?.recordGauge('camera_state', this.mapStateToMetric(to));
    });
    
    this.stateMachine.on('fallback', ({ path }) => {
      logger.warn(`Camera using fallback: ${path}`);
      this.metrics?.incrementCounter('camera_fallback_usage', { path });
    });
    
    this.stateMachine.on('captureComplete', (result: CaptureResult) => {
      this.lastCaptureLatency = result.metadata.captureTime;
      this.metrics?.recordHistogram('capture_latency_ms', result.metadata.captureTime);
      this.successCount++;
      this.updateSuccessRatio();
    });
  }
  
  async initialize(): Promise<boolean> {
    try {
      const startTime = Date.now();
      const initialized = await this.stateMachine.initialize();
      
      if (initialized) {
        const initLatency = Date.now() - startTime;
        logger.info(`Camera service initialized in ${initLatency}ms`);
        this.metrics?.recordHistogram('camera_init_latency_ms', initLatency);
        
        // Record camera path metric
        const path = this.stateMachine.getCameraPath();
        this.metrics?.recordGauge('camera_path_active', 1, { path });
        
        return true;
      }
      
      logger.error('Failed to initialize camera service');
      return false;
      
    } catch (error) {
      logger.error('Camera initialization error:', error);
      this.metrics?.incrementCounter('camera_init_failures');
      return false;
    }
  }
  
  async capture(options: CaptureOptions): Promise<CaptureSession | null> {
    const runId = options.runId || this.generateRunId();
    const outputDir = options.outputDir || `/data/cardmint/${runId}`;
    
    try {
      // Create session
      const session: CaptureSession = {
        runId,
        preset: options.preset,
        startTime: Date.now(),
        captures: [],
        status: 'running',
      };
      
      this.activeSessions.set(runId, session);
      this.emit('sessionStart', session);
      
      // Get preset configuration
      let presetConfig: PresetConfig | undefined;
      if (options.preset === 'custom' && options.customConfig) {
        presetConfig = options.customConfig;
      } else if (options.preset !== 'custom') {
        presetConfig = this.presets.getPreset(options.preset as PresetType);
      }
      
      if (!presetConfig) {
        throw new Error(`Invalid preset: ${options.preset}`);
      }
      
      // Ensure output directory exists
      await this.ensureOutputDirectory(outputDir);
      
      // Configure camera with preset
      const configSuccess = await this.stateMachine.configure(
        this.presets.generateCaptureSequence(presetConfig)[0]
      );
      
      if (!configSuccess) {
        throw new Error('Failed to configure camera');
      }
      
      // Execute capture sequence based on preset
      const captures = await this.executeCaptureSequence(presetConfig, outputDir);
      
      session.captures = captures;
      session.endTime = Date.now();
      session.status = 'completed';
      
      // Generate sidecar metadata if requested
      if (options.generateSidecar) {
        await this.generateSidecarFiles(session, outputDir);
      }
      
      // Update metrics
      const totalTime = session.endTime - session.startTime;
      this.metrics?.recordHistogram('capture_session_duration_ms', totalTime);
      this.metrics?.incrementCounter('capture_sessions_completed');
      
      this.emit('sessionComplete', session);
      logger.info(`Capture session ${runId} completed in ${totalTime}ms`);
      
      return session;
      
    } catch (error) {
      logger.error(`Capture session ${runId} failed:`, error);
      
      const session = this.activeSessions.get(runId);
      if (session) {
        session.status = 'failed';
        session.error = error instanceof Error ? error.message : 'Unknown error';
        session.endTime = Date.now();
      }
      
      this.failureCount++;
      this.updateSuccessRatio();
      this.metrics?.incrementCounter('capture_sessions_failed');
      
      this.emit('sessionFailed', { runId, error });
      return null;
      
    } finally {
      // Cleanup session after a delay
      setTimeout(() => {
        this.activeSessions.delete(runId);
      }, 60000);
    }
  }
  
  private async executeCaptureSequence(
    preset: PresetConfig,
    outputDir: string
  ): Promise<CaptureResult[]> {
    const captures: CaptureResult[] = [];
    const configs = this.presets.generateCaptureSequence(preset);
    
    for (let i = 0; i < preset.captureCount; i++) {
      // Apply configuration for this capture
      if (i < configs.length) {
        await this.stateMachine.configure(configs[i]);
      }
      
      // Capture based on preset type
      let result: CaptureResult | CaptureResult[] | null = null;
      
      if (preset.focusBracketing?.enabled) {
        result = await this.stateMachine.captureFocusBracket(
          preset.focusBracketing.steps
        );
      } else if (preset.exposureBracketing?.enabled) {
        result = await this.stateMachine.captureExposureBracket(
          preset.exposureBracketing.steps,
          preset.exposureBracketing.evStep
        );
      } else {
        result = await this.stateMachine.capture('single');
      }
      
      // Handle results
      if (Array.isArray(result)) {
        captures.push(...result);
      } else if (result) {
        captures.push(result);
      }
      
      // Delay between captures if specified
      if (preset.delayBetweenCapturesMs && i < preset.captureCount - 1) {
        await this.delay(preset.delayBetweenCapturesMs);
      }
    }
    
    // Move captured images to output directory
    for (let i = 0; i < captures.length; i++) {
      const capture = captures[i];
      const filename = `capture_${i.toString().padStart(3, '0')}.jpg`;
      const destPath = path.join(outputDir, 'raw', filename);
      
      await this.ensureOutputDirectory(path.dirname(destPath));
      await fs.rename(capture.path, destPath);
      capture.path = destPath;
    }
    
    return captures;
  }
  
  private async generateSidecarFiles(
    session: CaptureSession,
    outputDir: string
  ): Promise<void> {
    // Generate capture metadata JSON
    const captureMetadata = {
      runId: session.runId,
      preset: session.preset,
      timestamp: new Date(session.startTime).toISOString(),
      duration: session.endTime ? session.endTime - session.startTime : 0,
      captureCount: session.captures.length,
      cameraPath: this.stateMachine.getCameraPath(),
      captures: session.captures.map((c, i) => ({
        index: i,
        path: c.path,
        captureTime: c.metadata.captureTime,
        exposure: c.metadata.exposure,
        iso: c.metadata.iso,
        aperture: c.metadata.aperture,
        stateTransitions: c.metadata.stateTransitions,
      })),
    };
    
    const metadataPath = path.join(outputDir, 'meta', 'capture.json');
    await this.ensureOutputDirectory(path.dirname(metadataPath));
    await fs.writeFile(metadataPath, JSON.stringify(captureMetadata, null, 2));
    
    logger.debug(`Sidecar metadata written to ${metadataPath}`);
  }
  
  private async ensureOutputDirectory(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.error(`Failed to create directory ${dir}:`, error);
      throw error;
    }
  }
  
  private generateRunId(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').split('.')[0];
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}_${random}`;
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  private mapStateToMetric(state: CameraState): number {
    const stateMap: Record<CameraState, number> = {
      [CameraState.IDLE]: 0,
      [CameraState.DISCOVERING]: 1,
      [CameraState.OPENING_SESSION]: 2,
      [CameraState.SETTING_MODE]: 3,
      [CameraState.CONFIGURING]: 4,
      [CameraState.READY]: 5,
      [CameraState.CAPTURING]: 6,
      [CameraState.DOWNLOADING]: 7,
      [CameraState.ERROR]: -1,
      [CameraState.FALLBACK]: -2,
    };
    
    return stateMap[state] || 0;
  }
  
  private updateSuccessRatio(): void {
    const total = this.successCount + this.failureCount;
    if (total > 0) {
      const ratio = this.successCount / total;
      this.metrics?.recordGauge('capture_success_ratio', ratio);
    }
  }
  
  // Public API methods
  
  async captureWithPreset(preset: PresetType): Promise<CaptureSession | null> {
    return this.capture({ preset });
  }
  
  async captureCustom(config: PresetConfig): Promise<CaptureSession | null> {
    return this.capture({
      preset: 'custom',
      customConfig: config,
    });
  }
  
  getActiveSession(runId: string): CaptureSession | undefined {
    return this.activeSessions.get(runId);
  }
  
  getActiveSessions(): CaptureSession[] {
    return Array.from(this.activeSessions.values());
  }
  
  getCameraState(): CameraState {
    return this.stateMachine.getState();
  }
  
  getCameraPath(): CameraPath {
    return this.stateMachine.getCameraPath();
  }
  
  getHealthMetrics() {
    return {
      ...this.stateMachine.getHealthMetrics(),
      activeSessions: this.activeSessions.size,
      successCount: this.successCount,
      failureCount: this.failureCount,
      successRatio: this.successCount / (this.successCount + this.failureCount) || 0,
      lastCaptureLatency: this.lastCaptureLatency,
    };
  }
  
  async shutdown(): Promise<void> {
    logger.info('Shutting down camera service');
    
    // Cancel active sessions
    for (const [runId, session] of this.activeSessions) {
      if (session.status === 'running') {
        session.status = 'failed';
        session.error = 'Service shutdown';
        session.endTime = Date.now();
        this.emit('sessionCancelled', { runId });
      }
    }
    
    await this.stateMachine.shutdown();
    this.removeAllListeners();
  }
}