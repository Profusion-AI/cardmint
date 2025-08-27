import { ControllerService } from './ControllerService';
import { SonyCameraIntegration } from './SonyCameraIntegration';
import { createLogger } from '../utils/logger';
import { WebSocketServer } from '../api/websocket';

const logger = createLogger('controller-integration');

export interface IntegrationConfig {
  camera?: SonyCameraIntegration;
  webSocket?: WebSocketServer;
  enableHapticFeedback?: boolean;
  controller?: ControllerService; // allow injection for testing
}

export class ControllerIntegration {
  private controller: ControllerService;
  private camera?: SonyCameraIntegration;
  private webSocket?: WebSocketServer;
  private config: IntegrationConfig;

  constructor(config: IntegrationConfig = {}) {
    this.config = config;
    this.camera = config.camera;
    this.webSocket = config.webSocket;
    // Allow injecting a controller instance for tests
    this.controller = config.controller ?? new ControllerService();
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Controller connection events
    this.controller.on('connected', (info) => {
      logger.info('Controller connected:', info);
      this.broadcastStatus('controller_connected', info);
    });

    this.controller.on('disconnected', () => {
      logger.warn('Controller disconnected');
      this.broadcastStatus('controller_disconnected', {});
    });

    // Button action events
    this.controller.on('action', async (actionEvent) => {
      await this.handleControllerAction(actionEvent);
    });

    this.controller.on('error', (error) => {
      logger.error('Controller error:', error);
      this.broadcastStatus('controller_error', { error: error.message });
    });

    // Raw button events for debugging
    this.controller.on('buttonEvent', (event) => {
      logger.debug('Button event:', event);
    });
  }

  private async handleControllerAction(actionEvent: any): Promise<void> {
    const { action, modifiers, event } = actionEvent;

    try {
      switch (action) {
        case 'capture':
          await this.handleCapture();
          break;

        case 'approve':
          await this.handleApprove();
          break;

        case 'reject':
          await this.handleReject();
          break;

        case 'edit':
          await this.handleEdit();
          break;

        case 'navigate_up':
          this.handleNavigation('up');
          break;

        case 'navigate_down':
          this.handleNavigation('down');
          break;

        case 'navigate_left':
          this.handleNavigation('left');
          break;

        case 'navigate_right':
          this.handleNavigation('right');
          break;

        // Modified actions (with LB/RB)
        case 'lb_capture':
          await this.handleQuickCapture();
          break;

        case 'lb_approve':
          await this.handleQuickApprove();
          break;

        case 'lb_reject':
          await this.handleQuickReject();
          break;

        case 'rb_capture':
          await this.handleBurstCapture();
          break;

        default:
          logger.debug(`Unhandled action: ${action}`);
      }
    } catch (error) {
      logger.error(`Error handling action ${action}:`, error);
      this.broadcastStatus('action_error', { action, error: error.message });
    }
  }

  private async handleCapture(): Promise<void> {
    logger.info('🎯 Controller capture triggered');
    
    if (!this.camera) {
      logger.warn('No camera configured for capture');
      this.broadcastStatus('capture_error', { message: 'Camera not available' });
      return;
    }

    try {
      const startTime = Date.now();
      
      // Connect camera if not connected
      if (!this.camera.isConnected()) {
        await this.camera.connect();
      }

      // Capture image using SonyCameraIntegration
      const result = await this.camera.captureImage();
      const captureTime = Date.now() - startTime;

      if (result.success) {
        logger.info(`📸 Image captured in ${result.captureTimeMs}ms: ${result.imagePath}`);

        // Broadcast success to dashboard
        this.broadcastStatus('capture_success', {
          imagePath: result.imagePath,
          captureTime: result.captureTimeMs || captureTime,
          timestamp: result.timestamp.toISOString(),
          triggeredBy: 'controller'
        });
      } else {
        logger.error(`Camera capture failed: ${result.error}`);
        this.broadcastStatus('capture_error', { 
          message: result.error || 'Capture failed',
          triggeredBy: 'controller' 
        });
      }

    } catch (error) {
      logger.error('Camera capture failed:', error);
      this.broadcastStatus('capture_error', { 
        message: error.message,
        triggeredBy: 'controller' 
      });
    }
  }

  private async handleApprove(): Promise<void> {
    logger.info('✅ Controller approve action');
    this.broadcastStatus('action_approve', { triggeredBy: 'controller' });
  }

  private async handleReject(): Promise<void> {
    logger.info('❌ Controller reject action');
    this.broadcastStatus('action_reject', { triggeredBy: 'controller' });
  }

  private async handleEdit(): Promise<void> {
    logger.info('✏️ Controller edit action');
    this.broadcastStatus('action_edit', { triggeredBy: 'controller' });
  }

  private handleNavigation(direction: string): void {
    logger.debug(`🧭 Controller navigation: ${direction}`);
    this.broadcastStatus('navigation', { direction, triggeredBy: 'controller' });
  }

  // Enhanced actions with modifiers
  private async handleQuickCapture(): Promise<void> {
    logger.info('⚡ Quick capture (LB+X)');
    await this.handleCapture();
    // Could add additional quick processing here
  }

  private async handleQuickApprove(): Promise<void> {
    logger.info('⚡ Quick approve (LB+A)');
    this.broadcastStatus('action_quick_approve', { triggeredBy: 'controller' });
  }

  private async handleQuickReject(): Promise<void> {
    logger.info('⚡ Quick reject (LB+B)');
    this.broadcastStatus('action_quick_reject', { triggeredBy: 'controller' });
  }

  private async handleBurstCapture(): Promise<void> {
    logger.info('📸📸📸 Burst capture mode (RB+X)');
    // Could implement burst capture in future
    await this.handleCapture();
  }

  private broadcastStatus(type: string, data: any): void {
    const message = {
      type,
      payload: {
        timestamp: new Date().toISOString(),
        ...data
      }
    };

    // Send to WebSocket clients
    if (this.webSocket) {
      this.webSocket.broadcast(message);
    }

    logger.debug('Broadcasting:', message);
  }

  public setCamera(camera: SonyCameraIntegration): void {
    this.camera = camera;
    logger.info('Camera configured for controller integration');
  }

  public setWebSocket(webSocket: WebSocketServer): void {
    this.webSocket = webSocket;
    logger.info('WebSocket configured for controller integration');
  }

  public isControllerConnected(): boolean {
    return this.controller.isConnected();
  }

  public getControllerState(): any {
    return this.controller.getState();
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down controller integration');
    await this.controller.shutdown();
  }
}
