import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { SonyCameraIntegration, CaptureResult } from './SonyCameraIntegration';
import { InputBus } from './input-bus';
import { InputEvent } from '../schemas/input';

const logger = createLogger('camera-input-integration');

export interface CameraCaptureEvent {
  triggeredBy: 'keyboard' | 'controller';
  inputEvent: InputEvent;
  captureResult: CaptureResult;
  processingTime: number;
}

export class CameraInputIntegration extends EventEmitter {
  private lastCaptureTime: number = 0;
  private readonly CAPTURE_DEBOUNCE_MS = 300; // Debounce between keyboard and controller
  private captureStats = {
    total: 0,
    successful: 0,
    failed: 0,
    keyboardTriggered: 0,
    controllerTriggered: 0,
    averageLatency: 0,
    latencies: [] as number[],
  };

  constructor(
    private cameraIntegration: SonyCameraIntegration,
    private inputBus: InputBus
  ) {
    super();
    this.setupInputListeners();
    logger.info('Camera-Input integration initialized');
  }

  /**
   * Setup listeners for input bus events
   */
  private setupInputListeners(): void {
    // Listen for capture actions from both keyboard and controller
    this.inputBus.on('capture', this.handleCaptureInput.bind(this));
    
    // Listen for camera events to update statistics
    this.cameraIntegration.on('captureResult', this.handleCameraResult.bind(this));
    this.cameraIntegration.on('connected', () => {
      logger.info('Sony camera connected - input capture enabled');
      this.emit('cameraReady');
    });
    
    this.cameraIntegration.on('disconnected', () => {
      logger.warn('Sony camera disconnected - input capture disabled');
      this.emit('cameraUnavailable');
    });

    logger.info('Input bus listeners configured for camera integration');
  }

  /**
   * Handle capture input events from keyboard or controller
   */
  private async handleCaptureInput(inputEvent: InputEvent): Promise<void> {
    const now = Date.now();
    const processingStart = Date.now();
    
    // Enhanced debouncing - consider both timing and source
    if (now - this.lastCaptureTime < this.CAPTURE_DEBOUNCE_MS) {
      logger.debug(`Capture input debounced: ${inputEvent.source} (${now - this.lastCaptureTime}ms since last)`);
      return;
    }
    
    this.lastCaptureTime = now;
    
    logger.info(`Processing capture input from ${inputEvent.source}`, {
      action: inputEvent.action,
      source: inputEvent.source,
      sequence: inputEvent.seq,
      cycleId: inputEvent.cycleId,
    });

    // Check camera availability
    if (!this.cameraIntegration.isConnected()) {
      logger.warn(`Camera not connected for ${inputEvent.source} capture, attempting connection...`);
      
      const connected = await this.cameraIntegration.connect();
      if (!connected) {
        logger.error(`Failed to connect camera for ${inputEvent.source} input`);
        this.emit('captureError', {
          triggeredBy: inputEvent.source,
          inputEvent,
          error: 'Camera connection failed',
          processingTime: Date.now() - processingStart,
        });
        return;
      }
    }

    try {
      // Update statistics
      this.captureStats.total++;
      if (inputEvent.source === 'keyboard') {
        this.captureStats.keyboardTriggered++;
      } else if (inputEvent.source === 'controller') {
        this.captureStats.controllerTriggered++;
      }

      // Trigger camera capture
      let captureResult: CaptureResult;
      
      if (this.cameraIntegration.isCapturing()) {
        // Queue the capture if camera is busy
        logger.debug('Camera busy, queueing capture request');
        captureResult = await this.cameraIntegration.queueCapture();
      } else {
        // Direct capture
        captureResult = await this.cameraIntegration.captureImage();
      }

      const processingTime = Date.now() - processingStart;
      
      // Update latency statistics
      if (captureResult.captureTimeMs) {
        this.captureStats.latencies.push(captureResult.captureTimeMs);
        
        // Keep only last 100 captures for averaging
        if (this.captureStats.latencies.length > 100) {
          this.captureStats.latencies = this.captureStats.latencies.slice(-100);
        }
        
        this.captureStats.averageLatency = 
          this.captureStats.latencies.reduce((sum, lat) => sum + lat, 0) / this.captureStats.latencies.length;
      }

      // Update success/failure counts
      if (captureResult.success) {
        this.captureStats.successful++;
      } else {
        this.captureStats.failed++;
      }

      // Create comprehensive capture event
      const cameraCaptureEvent: CameraCaptureEvent = {
        triggeredBy: inputEvent.source as 'keyboard' | 'controller',
        inputEvent,
        captureResult,
        processingTime,
      };

      // Emit events
      this.emit('captureTriggered', cameraCaptureEvent);
      
      if (captureResult.success) {
        this.emit('captureSuccess', cameraCaptureEvent);
        logger.info(`${inputEvent.source} triggered capture successful`, {
          imagePath: captureResult.imagePath,
          captureTimeMs: captureResult.captureTimeMs,
          processingTime,
          totalCaptures: this.captureStats.total,
        });
      } else {
        this.emit('captureFailure', cameraCaptureEvent);
        logger.error(`${inputEvent.source} triggered capture failed`, {
          error: captureResult.error,
          processingTime,
          totalFailures: this.captureStats.failed,
        });
      }

    } catch (error) {
      this.captureStats.failed++;
      const processingTime = Date.now() - processingStart;
      
      logger.error(`Camera integration error for ${inputEvent.source} input:`, error);
      
      this.emit('captureError', {
        triggeredBy: inputEvent.source,
        inputEvent,
        error: error.message,
        processingTime,
      });
    }
  }

  /**
   * Handle camera results to update telemetry
   */
  private handleCameraResult(result: CaptureResult): void {
    // Additional telemetry logging for camera performance monitoring
    logger.debug('Camera capture result received', {
      success: result.success,
      captureTimeMs: result.captureTimeMs,
      imagePath: result.imagePath,
      error: result.error,
    });
    
    // Emit for external monitoring systems
    this.emit('cameraResult', result);
  }

  /**
   * Get current capture statistics
   */
  getStatistics(): {
    captures: {
      total: number;
      successful: number;
      failed: number;
      keyboardTriggered: number;
      controllerTriggered: number;
      averageLatency: number;
      latencies: number[];
    };
    camera: any;
    performance: {
      successRate: number;
      keyboardVsControllerRatio: number;
      averageE2ELatency: number;
    };
  } {
    const successRate = this.captureStats.total > 0 
      ? (this.captureStats.successful / this.captureStats.total) * 100 
      : 0;

    const keyboardVsControllerRatio = this.captureStats.controllerTriggered > 0
      ? this.captureStats.keyboardTriggered / this.captureStats.controllerTriggered
      : this.captureStats.keyboardTriggered;

    return {
      captures: { ...this.captureStats },
      camera: this.cameraIntegration.getStatus(),
      performance: {
        successRate,
        keyboardVsControllerRatio,
        averageE2ELatency: this.captureStats.averageLatency,
      },
    };
  }

  /**
   * Test camera integration with simulated input
   */
  async testCameraCapture(source: 'keyboard' | 'controller' = 'keyboard'): Promise<CaptureResult | null> {
    const testEvent: InputEvent = {
      action: 'capture',
      source,
      ts: Date.now(),
      seq: -1, // Test sequence
      cycleId: 'test_cycle',
    };

    logger.info(`Testing camera capture with simulated ${source} input`);
    
    try {
      await this.handleCaptureInput(testEvent);
      return null; // Result will come through events
    } catch (error) {
      logger.error('Camera capture test failed:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Reset capture statistics
   */
  resetStatistics(): void {
    this.captureStats = {
      total: 0,
      successful: 0,
      failed: 0,
      keyboardTriggered: 0,
      controllerTriggered: 0,
      averageLatency: 0,
      latencies: [],
    };
    
    logger.info('Capture statistics reset');
    this.emit('statisticsReset');
  }

  /**
   * Get A/B testing summary for keyboard vs controller performance
   */
  getABTestingSummary(): {
    keyboardCaptures: number;
    controllerCaptures: number;
    keyboardSuccessRate: number;
    controllerSuccessRate: number;
    avgKeyboardLatency: number;
    avgControllerLatency: number;
    recommendation: string;
  } {
    // This would require more detailed tracking, but provides the framework
    const keyboardSuccessRate = 100; // Placeholder - would need detailed tracking
    const controllerSuccessRate = 100; // Placeholder - would need detailed tracking
    
    let recommendation = 'Insufficient data';
    
    if (this.captureStats.keyboardTriggered > 10 && this.captureStats.controllerTriggered > 10) {
      if (controllerSuccessRate > keyboardSuccessRate + 5) {
        recommendation = 'Controller shows superior performance';
      } else if (keyboardSuccessRate > controllerSuccessRate + 5) {
        recommendation = 'Keyboard shows superior performance';
      } else {
        recommendation = 'Both input methods perform similarly';
      }
    }

    return {
      keyboardCaptures: this.captureStats.keyboardTriggered,
      controllerCaptures: this.captureStats.controllerTriggered,
      keyboardSuccessRate,
      controllerSuccessRate,
      avgKeyboardLatency: this.captureStats.averageLatency, // Simplified
      avgControllerLatency: this.captureStats.averageLatency, // Simplified
      recommendation,
    };
  }

  /**
   * Cleanup and disconnect
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up camera-input integration...');
    
    // Remove input bus listeners
    this.inputBus.removeAllListeners('capture');
    
    // Clean up camera integration
    await this.cameraIntegration.cleanup();
    
    this.removeAllListeners();
    logger.info('Camera-input integration cleanup complete');
  }
}
