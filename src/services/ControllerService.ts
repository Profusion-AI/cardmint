import fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { SonyCameraIntegration, CaptureResult } from './SonyCameraIntegration';

const execAsync = promisify(exec);
const logger = createLogger('controller');

export interface ControllerEvent {
  button: string;
  code: number;
  value: number;
  timestamp: Date;
}

export interface ControllerState {
  isConnected: boolean;
  devicePath?: string;
  byIdPath?: string;
  grabbedProcess?: ChildProcess;
  buttonStates: Map<number, boolean>;
}

export class ControllerService extends EventEmitter {
  private state: ControllerState = {
    isConnected: false,
    buttonStates: new Map()
  };
  private joystickProcess?: ChildProcess;
  private connecting = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY = 1000; // Start with 1 second
  private reconnectTimer?: NodeJS.Timeout;
  private detectionTimer?: NodeJS.Timeout;
  private lastConnectionInfo?: any; // Store detection info for reconnection
  
  // Sony camera integration
  private cameraIntegration?: SonyCameraIntegration;
  private lastCaptureTime: number = 0;
  private readonly CAPTURE_DEBOUNCE_MS = 500; // Prevent rapid-fire captures

  // Button mapping for 8BitDo Ultimate 2C across keyboard and joystick interfaces
  private readonly BUTTON_MAP: Record<number, { name: string; symbol: string; action: string }> = {
    30: { name: 'A', symbol: 'A', action: 'approve' },        // KEY_A
    48: { name: 'B', symbol: 'B', action: 'reject' },         // KEY_B  
    45: { name: 'X', symbol: 'X', action: 'capture' },        // KEY_X
    21: { name: 'Y', symbol: 'Y', action: 'edit' },           // KEY_Y
    16: { name: 'LB', symbol: 'LB', action: 'modifier_left' }, // KEY_Q (mapped to LB)
    18: { name: 'RB', symbol: 'RB', action: 'modifier_right' }, // KEY_E (mapped to RB)
    103: { name: 'UP', symbol: '↑', action: 'navigate_up' },    // KEY_UP (D-pad)
    108: { name: 'DOWN', symbol: '↓', action: 'navigate_down' }, // KEY_DOWN
    105: { name: 'LEFT', symbol: '←', action: 'navigate_left' }, // KEY_LEFT
    106: { name: 'RIGHT', symbol: '→', action: 'navigate_right' }, // KEY_RIGHT
    // Joystick interface button codes (BTN_SOUTH=304, BTN_EAST=305, BTN_NORTH=307, BTN_WEST=308)
    304: { name: 'A', symbol: 'A', action: 'approve' },        // BTN_SOUTH
    305: { name: 'B', symbol: 'B', action: 'reject' },         // BTN_EAST
    307: { name: 'X', symbol: 'X', action: 'capture' },        // BTN_NORTH (some firmwares map X here)
    308: { name: 'Y', symbol: 'Y', action: 'edit' },           // BTN_WEST
  };

  constructor(cameraIntegration?: SonyCameraIntegration) {
    super();
    this.cameraIntegration = cameraIntegration;
    this.setupControllerDetection();
    
    if (this.cameraIntegration) {
      this.setupCameraEventHandlers();
      logger.info('Controller service initialized with Sony camera integration');
    }
  }

  /**
   * Setup camera event handlers for controller integration
   */
  private setupCameraEventHandlers(): void {
    if (!this.cameraIntegration) return;
    
    this.cameraIntegration.on('captureResult', (result: CaptureResult) => {
      this.emit('cameraCapture', result);
      
      if (result.success) {
        logger.info(`Controller triggered capture successful: ${result.imagePath} (${result.captureTimeMs}ms)`);
      } else {
        logger.error(`Controller triggered capture failed: ${result.error}`);
      }
    });
    
    this.cameraIntegration.on('connected', () => {
      logger.info('Sony camera connected - controller capture enabled');
      this.emit('cameraConnected');
    });
    
    this.cameraIntegration.on('disconnected', () => {
      logger.warn('Sony camera disconnected - controller capture disabled');
      this.emit('cameraDisconnected');
    });
    
    this.cameraIntegration.on('error', (error) => {
      logger.error('Camera integration error:', error);
      this.emit('cameraError', error);
    });
  }

  private async setupControllerDetection(): Promise<void> {
    logger.info('Setting up 8BitDo controller detection...');
    
    // Check if controller is already connected
    await this.detectController();
    
    // Set up periodic detection with adaptive timing
    this.scheduleNextDetection();
  }

  private scheduleNextDetection(): void {
    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
    }
    
    // Use shorter intervals when disconnected, longer when connected
    const interval = this.state.isConnected ? 10000 : 3000; // 10s connected, 3s disconnected
    
    this.detectionTimer = setTimeout(async () => {
      if (!this.connecting) {
        await this.detectController();
      }
      this.scheduleNextDetection();
    }, interval);
  }

  private async detectController(): Promise<void> {
    try {
      // Use the improved gamepad detection script
      const { stdout } = await execAsync('npm run gamepad:detect -- --match 8bitdo');
      
      if (stdout.includes('READY')) {
        const jsonMatch = stdout.match(/READY (.+)/);
        if (jsonMatch) {
          const info = JSON.parse(jsonMatch[1]);
          
          if (!this.connecting && !this.state.isConnected) {
            // Reset reconnect attempts on successful detection
            this.reconnectAttempts = 0;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = undefined;
            }
            
            // Store connection info for potential reconnection
            this.lastConnectionInfo = info;
            
            // Pass both joystick and keyboard info to connection handler
            await this.connectToController(info.byId, info.realEventPath || info.eventPath, info);
          } else if (this.state.isConnected && this.state.byIdPath !== info.byId) {
            // Device changed - reconnect
            logger.info('Controller device changed, reconnecting...');
            await this.disconnectController();
            this.lastConnectionInfo = info;
            await this.connectToController(info.byId, info.realEventPath || info.eventPath, info);
          } else {
            logger.debug('Controller already connecting/connected; skipping duplicate connect');
          }
        }
      } else {
        // No controller detected
        if (this.state.isConnected) {
          logger.warn('8BitDo controller disconnected');
          await this.disconnectController();
          
          // Start reconnection attempts
          this.scheduleReconnection();
        }
      }
    } catch (error) {
      logger.debug('Controller detection failed:', error);
      
      // If we were connected and detection fails, try to reconnect
      if (this.state.isConnected && this.lastConnectionInfo) {
        logger.warn('Detection failed but was previously connected, attempting reconnection...');
        await this.disconnectController();
        this.scheduleReconnection();
      }
    }
  }

  private scheduleReconnection(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      return;
    }
    
    this.reconnectAttempts++;
    
    // Exponential backoff: 1s, 2s, 4s, 8s, up to 30s max
    const delay = Math.min(this.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1), 30000);
    
    logger.info(`Scheduling controller reconnection attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      
      if (!this.state.isConnected && this.lastConnectionInfo) {
        logger.info(`Reconnection attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`);
        
        try {
          await this.connectToController(
            this.lastConnectionInfo.byId,
            this.lastConnectionInfo.realEventPath || this.lastConnectionInfo.eventPath,
            this.lastConnectionInfo
          );
          
          // Success - reset attempts
          this.reconnectAttempts = 0;
        } catch (error) {
          logger.warn(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
          
          // Schedule next attempt if not at max
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.scheduleReconnection();
          } else {
            logger.error('Maximum reconnection attempts reached, giving up automatic reconnection');
            this.reconnectAttempts = 0; // Reset for future manual retries
          }
        }
      }
    }, delay);
  }

  /**
   * Resolve the keyboard interface event device with multiple fallback strategies.
   * Uses detection info if available, otherwise employs multiple fallback methods.
   */
  private resolveKeyboardDevice(byIdPath: string, detectionInfo?: any): string {
    // Allow explicit override via env for rapid debugging
    const envEvent = process.env.CONTROLLER_KBD_EVENT;
    if (envEvent && fs.existsSync(envEvent)) {
      logger.info(`Using CONTROLLER_KBD_EVENT override: ${envEvent}`);
      return envEvent;
    }
    
    const envById = process.env.CONTROLLER_KBD_BYID;
    if (envById) {
      try {
        const link = fs.readlinkSync(envById);
        const real = path.resolve(path.dirname(envById), link);
        logger.info(`Using CONTROLLER_KBD_BYID override: ${envById} -> ${real}`);
        return real;
      } catch (e) {
        logger.warn('CONTROLLER_KBD_BYID override could not be resolved; falling back', e);
      }
    }

    // Strategy 1: Use detection info if available
    if (detectionInfo?.realKeyboardEventPath && fs.existsSync(detectionInfo.realKeyboardEventPath)) {
      logger.info(`Using keyboard device from detection: ${detectionInfo.realKeyboardEventPath}`);
      return detectionInfo.realKeyboardEventPath;
    }

    if (detectionInfo?.keyboardEventPath && fs.existsSync(detectionInfo.keyboardEventPath)) {
      logger.info(`Using keyboard device from detection (fallback): ${detectionInfo.keyboardEventPath}`);
      return detectionInfo.keyboardEventPath;
    }

    // Strategy 2: Try by-id sibling resolution
    try {
      const byIdDir = '/dev/input/by-id';
      const base = path.basename(byIdPath);
      const entries = fs.readdirSync(byIdDir);
      const stem = base.replace(/-event-joystick$/, '');
      
      // Try multiple keyboard interface patterns
      const patterns = [
        `${stem}-if01-event-kbd`,
        `${stem}-if02-event-kbd`, 
        `${stem}-event-kbd`,
      ];
      
      for (const pattern of patterns) {
        const kbdEntry = entries.find((f) => f === pattern);
        if (kbdEntry) {
          const full = path.join(byIdDir, kbdEntry);
          try {
            const link = fs.readlinkSync(full);
            const resolved = path.resolve(path.dirname(full), link);
            logger.info(`Resolved keyboard device via by-id pattern ${pattern}: ${resolved}`);
            return resolved;
          } catch (e) {
            logger.debug(`Failed to resolve ${full}:`, e);
          }
        }
      }
    } catch (e) {
      logger.debug('by-id directory scan failed:', e);
    }

    // Strategy 3: Parse /proc/bus/input/devices
    try {
      const content = fs.readFileSync('/proc/bus/input/devices', 'utf8');
      const blocks = content.split('\n\n');
      for (const block of blocks) {
        const lower = block.toLowerCase();
        if (lower.includes('8bitdo')) {
          // Look for keyboard interface with handlers
          const handlerMatch = block.match(/Handlers=([^\n]+)/i);
          if (handlerMatch && handlerMatch[1].includes('kbd')) {
            const eventMatch = handlerMatch[1].match(/event(\d+)/);
            if (eventMatch) {
              const dev = `/dev/input/event${eventMatch[1]}`;
              if (fs.existsSync(dev)) {
                logger.info(`Resolved keyboard device via /proc: ${dev}`);
                return dev;
              }
            }
          }
        }
      }
    } catch (e) {
      logger.warn('Parsing /proc/bus/input/devices failed:', e);
    }

    // Strategy 4: Probe likely event devices
    for (let i = 14; i <= 20; i++) {
      const candidate = `/dev/input/event${i}`;
      try {
        if (fs.existsSync(candidate)) {
          // Quick test to see if this responds to our button mappings
          logger.debug(`Testing candidate keyboard device: ${candidate}`);
          return candidate;
        }
      } catch (e) {
        // Ignore and continue
      }
    }

    // Final fallback
    logger.warn('All keyboard resolution strategies failed; falling back to /dev/input/event16');
    return '/dev/input/event16';
  }

  private async connectToController(byIdPath: string, devicePath: string, detectionInfo?: any): Promise<void> {
    if (this.state.isConnected && this.state.byIdPath === byIdPath) {
      return; // Already connected to this device
    }

    // Resolve the keyboard interface event device using enhanced detection
    const keyboardDevice = this.resolveKeyboardDevice(byIdPath, detectionInfo);
    logger.info(`Connecting to 8BitDo controller at ${keyboardDevice} (keyboard events for face buttons)`);
    
    if (detectionInfo) {
      logger.debug('Detection info:', {
        joystick: detectionInfo.realEventPath || detectionInfo.eventPath,
        keyboard: detectionInfo.realKeyboardEventPath || detectionInfo.keyboardEventPath,
        mode: detectionInfo.mode
      });
    }
    
    try {
      this.connecting = true;
      // Start exclusive grab mode for the controller
      const joystickDevice = detectionInfo?.realEventPath || detectionInfo?.eventPath;
      await this.startGrabMode(byIdPath, keyboardDevice, joystickDevice);
      
      this.state = {
        isConnected: true,
        devicePath: keyboardDevice, // Use keyboard device for state
        byIdPath,
        grabbedProcess: this.state.grabbedProcess,
        buttonStates: new Map()
      };
      
      this.emit('connected', {
        devicePath: keyboardDevice, // Emit keyboard device path
        byIdPath,
        controllerName: '8BitDo Ultimate 2C',
        detectionInfo
      });

      logger.info('8BitDo controller connected and grabbed for exclusive access');
      this.connecting = false;
    } catch (error) {
      logger.error('Failed to connect controller:', error);
      this.emit('error', error);
      this.connecting = false;
    }
  }

  private async startGrabMode(byIdPath: string, keyboardDevice: string, joystickDevice?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Kill any existing grab processes first
      const killCmd = 'pkill -f "gamepad-grab.py"; pkill -f "evtest.*if01-event-kbd"; pkill -f "evtest.*event[0-9]+"';
      exec(killCmd, () => {
        // Also ensure any previously tracked grabProcess is terminated
        if (this.state.grabbedProcess) {
          try { this.state.grabbedProcess.kill(); } catch {}
          this.state.grabbedProcess = undefined;
        }
        if (this.joystickProcess) {
          try { this.joystickProcess.kill(); } catch {}
          this.joystickProcess = undefined;
        }
        // Use resolved keyboard event device for X button (not joystick device)
        let args = ['--grab', keyboardDevice];
        let mode: 'grab' | 'shared' = 'grab';
        let grabProcess = spawn('evtest', args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let hasStarted = false;
        let busyDetected = false;
        
        grabProcess.stdout.on('data', (data) => {
          const output = data.toString();
          logger.debug('Controller output:', output.trim());
          
          // Look for evtest startup message
          if ((output.includes('Testing') || output.includes('Event')) && !hasStarted) {
            hasStarted = true;
            logger.info('Controller grabbed successfully with evtest');
            this.state.grabbedProcess = grabProcess;

            // Start reading input events
            this.startInputReading(grabProcess);
            // Additionally, start a non-grab listener on the joystick interface if available
            if (joystickDevice && joystickDevice !== keyboardDevice) {
              try {
                const jsProc = spawn('evtest', [joystickDevice], { stdio: ['ignore', 'pipe', 'pipe'] });
                this.joystickProcess = jsProc;
                jsProc.stdout.on('data', (d) => {
                  const out = d.toString();
                  if (out.includes('Event')) {
                    logger.debug(`evtest (joystick) event chunk: ${out.trim()}`);
                  }
                });
                jsProc.stderr.on('data', (d) => logger.warn('Controller evtest stderr (joystick):', d.toString().trim()));
                // Parse joystick events through same pipeline
                this.startInputReading(jsProc);
              } catch (e) {
                logger.warn('Failed to start joystick event listener:', e);
              }
            }
            resolve();
          }
          // Extra: in case device is already grabbed elsewhere, surface a clear warning
          if (output.includes('This device is grabbed by another process')) {
            logger.warn('Keyboard device already grabbed by another process; no events will stream');
            busyDetected = true;
          }
        });

        grabProcess.stderr.on('data', (data) => {
          const errorMsg = data.toString();
          logger.warn('Controller grab stderr:', errorMsg.trim());
          // Detect busy message on stderr as well
          if (errorMsg.toLowerCase().includes('grabbed by another process')) {
            logger.warn('Keyboard device already grabbed by another process (stderr)');
            busyDetected = true;
          }
        });

        grabProcess.on('exit', (code) => {
          if (code !== 0 && !hasStarted) {
            if (busyDetected && mode === 'grab') {
              // Fallback to shared mode (no --grab)
              logger.warn('Falling back to shared evtest mode (no exclusive grab)');
              args = [keyboardDevice];
              mode = 'shared';
              busyDetected = false;
              grabProcess = spawn('evtest', args, { stdio: ['ignore', 'pipe', 'pipe'] });

              grabProcess.stdout.on('data', (data) => {
                const output = data.toString();
                logger.debug('Controller output (shared):', output.trim());
                if ((output.includes('Testing') || output.includes('Event')) && !hasStarted) {
                  hasStarted = true;
                  logger.info('Controller listening in shared mode (evtest without grab)');
                  this.state.grabbedProcess = grabProcess;
                  this.startInputReading(grabProcess);
                  resolve();
                }
              });
              grabProcess.stderr.on('data', (data) => logger.warn('Controller evtest stderr (shared):', data.toString()));
              grabProcess.on('exit', () => {
                if (!hasStarted) {
                  reject(new Error('Controller evtest shared mode exited before start'));
                } else {
                  logger.info('Controller evtest shared mode ended');
                  this.disconnectController();
                }
              });
              return;
            }
            reject(new Error(`Controller grab process exited with code ${code}`));
          } else {
            logger.info('Controller grab process ended');
            this.disconnectController();
          }
        });

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!hasStarted) {
            grabProcess.kill();
            reject(new Error('Controller grab timeout'));
          }
        }, 10000);
      });
    });
  }

  private startInputReading(grabProcess: ChildProcess): void {
    if (!grabProcess.stdout) return;

    let eventBuffer = '';
    
    grabProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      eventBuffer += chunk;
      // Verbose debug to verify event flow end-to-end
      if (chunk.includes('Event:')) {
        logger.debug(`evtest event chunk: ${chunk.trim()}`);
      }
      
      // Process complete lines
      const lines = eventBuffer.split('\n');
      eventBuffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      lines.forEach(line => {
        this.processInputLine(line.trim());
      });
    });
  }

  private processInputLine(line: string): void {
    // evtest format: "Event: time 1661234567.123456, type 1 (EV_KEY), code 304 (BTN_SOUTH), value 1"
    // Allow 0/1/2 to include repeat events
    const evtestMatch = line.match(/type\s+1\s+\(EV_KEY\),\s+code\s+(\d+)\s+\([^)]+\),\s+value\s+([0-2])/);
    
    if (evtestMatch) {
      const [, codeStr, valueStr] = evtestMatch;
      const buttonCode = parseInt(codeStr);
      const value = parseInt(valueStr);
      
      if (this.BUTTON_MAP[buttonCode]) {
        const buttonInfo = this.BUTTON_MAP[buttonCode];
        const isPressed = value === 1;
        
        // Update button state
        this.state.buttonStates.set(buttonCode, isPressed);
        
        const event: ControllerEvent = {
          button: buttonInfo.name,
          code: buttonCode,
          value,
          timestamp: new Date()
        };

        // Emit the raw button event
        this.emit('buttonEvent', event);
        
        if (isPressed) {
          // Handle button press actions
          this.handleButtonPress(buttonInfo.action, event);
        }

        logger.debug(`Button ${buttonInfo.symbol} (${buttonInfo.name}): ${isPressed ? 'PRESSED' : 'RELEASED'}`);
      } else if (line.includes('(EV_KEY)')) {
        // Surface unmapped EV_KEY lines to help diagnose missing codes
        logger.debug(`Unmapped EV_KEY line: ${line}`);
      }
    }
  }

  private handleButtonPress(action: string, event: ControllerEvent): void {
    // Modifier keys mapped to keyboard codes (Q/E)
    const isLBPressed = this.state.buttonStates.get(16); // KEY_Q
    const isRBPressed = this.state.buttonStates.get(18); // KEY_E

    // Determine if this is a modified action
    const modifiedAction = isLBPressed ? `lb_${action}` : isRBPressed ? `rb_${action}` : action;
    
    // Handle camera capture action (X button - code 307)
    if (action === 'capture' && this.cameraIntegration) {
      this.handleCameraCapture(event);
    }
    
    // Emit high-level action events
    this.emit('action', {
      action: modifiedAction,
      originalAction: action,
      modifiers: {
        leftBumper: isLBPressed,
        rightBumper: isRBPressed
      },
      event
    });

    logger.info(`Controller action: ${modifiedAction} (button: ${event.button})`);
  }
  
  /**
   * Handle camera capture trigger from controller
   */
  private async handleCameraCapture(event: ControllerEvent): Promise<void> {
    const now = Date.now();
    
    // Debounce rapid button presses
    if (now - this.lastCaptureTime < this.CAPTURE_DEBOUNCE_MS) {
      logger.debug(`Camera capture debounced (${now - this.lastCaptureTime}ms since last capture)`);
      return;
    }
    
    this.lastCaptureTime = now;
    
    if (!this.cameraIntegration) {
      logger.error('Camera integration not available for capture');
      return;
    }
    
    if (!this.cameraIntegration.isConnected()) {
      logger.warn('Camera not connected, attempting to connect before capture...');
      const connected = await this.cameraIntegration.connect();
      if (!connected) {
        logger.error('Failed to connect camera for controller capture');
        this.emit('captureError', { 
          error: 'Camera not connected',
          triggeredBy: 'controller',
          buttonCode: event.code 
        });
        return;
      }
    }
    
    if (this.cameraIntegration.isCapturing()) {
      logger.debug('Camera is already capturing, queuing capture request');
      
      // Use queue capture to handle backpressure
      try {
        const result = await this.cameraIntegration.queueCapture();
        this.emit('captureQueued', {
          result,
          triggeredBy: 'controller',
          buttonCode: event.code,
          queueLength: this.cameraIntegration.getQueueLength()
        });
      } catch (error) {
        logger.error('Failed to queue camera capture:', error);
        this.emit('captureError', {
          error: error.message,
          triggeredBy: 'controller',
          buttonCode: event.code
        });
      }
    } else {
      // Direct capture
      logger.info(`Controller X button triggered camera capture (button code: ${event.code})`);
      
      try {
        const result = await this.cameraIntegration.captureImage();
        this.emit('captureTriggered', {
          result,
          triggeredBy: 'controller',
          buttonCode: event.code,
          triggerTime: event.timestamp
        });
      } catch (error) {
        logger.error('Controller camera capture failed:', error);
        this.emit('captureError', {
          error: error.message,
          triggeredBy: 'controller',
          buttonCode: event.code
        });
      }
    }
  }

  private async disconnectController(): Promise<void> {
    if (this.state.grabbedProcess) {
      this.state.grabbedProcess.kill();
      this.state.grabbedProcess = undefined;
    }
    if (this.joystickProcess) {
      try { this.joystickProcess.kill(); } catch {}
      this.joystickProcess = undefined;
    }

    const wasConnected = this.state.isConnected;
    this.state = {
      isConnected: false,
      buttonStates: new Map()
    };

    if (wasConnected) {
      this.emit('disconnected');
      logger.info('Controller disconnected');
    }
  }

  /**
   * Cleanup method to stop all timers and processes
   */
  async cleanup(): Promise<void> {
    logger.info('Cleaning up controller service...');
    
    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
      this.detectionTimer = undefined;
    }
    
    // Disconnect controller
    if (this.state.isConnected) {
      await this.disconnectController();
    }
    
    // Reset state
    this.reconnectAttempts = 0;
    this.connecting = false;
    this.lastConnectionInfo = undefined;
    
    logger.info('Controller service cleanup completed');
  }

  /**
   * Manual reconnection trigger (useful for testing or UI controls)
   */
  async triggerReconnection(): Promise<void> {
    logger.info('Manual reconnection triggered');
    
    // Cancel existing reconnection attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    // Reset attempts and try immediate detection
    this.reconnectAttempts = 0;
    await this.detectController();
  }

  public isConnected(): boolean {
    return this.state.isConnected;
  }

  public getState(): ControllerState {
    return { ...this.state };
  }

  public getButtonStates(): Map<number, boolean> {
    return new Map(this.state.buttonStates);
  }

  /**
   * Get camera status if camera integration is available
   */
  public getCameraStatus() {
    if (!this.cameraIntegration) {
      return { available: false };
    }
    
    return {
      available: true,
      connected: this.cameraIntegration.isConnected(),
      capturing: this.cameraIntegration.isCapturing(),
      queueLength: this.cameraIntegration.getQueueLength(),
      stats: this.cameraIntegration.getStatus(),
    };
  }
  
  /**
   * Trigger camera capture programmatically (for testing)
   */
  public async triggerCameraCapture(): Promise<CaptureResult | null> {
    if (!this.cameraIntegration) {
      logger.error('Camera integration not available');
      return null;
    }
    
    const mockEvent: ControllerEvent = {
      button: 'X',
      code: 307,
      value: 1,
      timestamp: new Date(),
    };
    
    await this.handleCameraCapture(mockEvent);
    return null; // Actual result will come through events
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down controller service');
    
    // Disconnect controller
    await this.disconnectController();
    
    // Cleanup camera integration if present
    if (this.cameraIntegration) {
      logger.info('Cleaning up camera integration...');
      await this.cameraIntegration.cleanup();
    }
    
    this.removeAllListeners();
    logger.info('Controller service shutdown complete');
  }
}
