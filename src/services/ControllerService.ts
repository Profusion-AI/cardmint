import fs from 'fs';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

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

  // Button mapping for 8BitDo Ultimate 2C in DInput mode
  private readonly BUTTON_MAP = {
    304: { name: 'A', symbol: 'A', action: 'approve' },        // BTN_SOUTH
    305: { name: 'B', symbol: 'B', action: 'reject' },         // BTN_EAST  
    307: { name: 'X', symbol: 'X', action: 'capture' },        // BTN_NORTH
    308: { name: 'Y', symbol: 'Y', action: 'edit' },           // BTN_WEST
    310: { name: 'LB', symbol: 'LB', action: 'modifier_left' }, // BTN_TL
    311: { name: 'RB', symbol: 'RB', action: 'modifier_right' }, // BTN_TR
    103: { name: 'UP', symbol: '↑', action: 'navigate_up' },    // KEY_UP (D-pad)
    108: { name: 'DOWN', symbol: '↓', action: 'navigate_down' }, // KEY_DOWN
    105: { name: 'LEFT', symbol: '←', action: 'navigate_left' }, // KEY_LEFT
    106: { name: 'RIGHT', symbol: '→', action: 'navigate_right' }, // KEY_RIGHT
  };

  constructor() {
    super();
    this.setupControllerDetection();
  }

  private async setupControllerDetection(): Promise<void> {
    logger.info('Setting up 8BitDo controller detection...');
    
    // Check if controller is already connected
    await this.detectController();
    
    // Set up periodic detection (every 5 seconds when not connected)
    setInterval(() => {
      if (!this.state.isConnected) {
        this.detectController();
      }
    }, 5000);
  }

  private async detectController(): Promise<void> {
    try {
      // Use the existing gamepad detection script
      const { stdout } = await execAsync('npm run gamepad:detect -- --match 8bitdo');
      
      if (stdout.includes('READY')) {
        const jsonMatch = stdout.match(/READY (.+)/);
        if (jsonMatch) {
          const info = JSON.parse(jsonMatch[1]);
          await this.connectToController(info.byId, info.realEventPath || info.eventPath);
        }
      } else {
        if (this.state.isConnected) {
          logger.warn('8BitDo controller disconnected');
          await this.disconnectController();
        }
      }
    } catch (error) {
      logger.debug('Controller detection failed:', error);
    }
  }

  private async connectToController(byIdPath: string, devicePath: string): Promise<void> {
    if (this.state.isConnected && this.state.byIdPath === byIdPath) {
      return; // Already connected to this device
    }

    logger.info(`Connecting to 8BitDo controller at ${devicePath}`);
    
    try {
      // Start exclusive grab mode for the controller
      await this.startGrabMode(byIdPath);
      
      this.state = {
        isConnected: true,
        devicePath,
        byIdPath,
        grabbedProcess: this.state.grabbedProcess,
        buttonStates: new Map()
      };

      this.emit('connected', {
        devicePath,
        byIdPath,
        controllerName: '8BitDo Ultimate 2C'
      });

      logger.info('8BitDo controller connected and grabbed for exclusive access');
      
    } catch (error) {
      logger.error('Failed to connect controller:', error);
      this.emit('error', error);
    }
  }

  private async startGrabMode(byIdPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Kill any existing grab processes first
      exec('pkill -f "gamepad-grab.py"', () => {
        // Use evtest directly for now to avoid device busy issues
        const devicePath = '/dev/input/event29'; // From our earlier detection
        const grabProcess = spawn('evtest', ['--grab', devicePath], {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let hasStarted = false;
        
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
            resolve();
          }
        });

        grabProcess.stderr.on('data', (data) => {
          const errorMsg = data.toString();
          logger.warn('Controller grab stderr:', errorMsg);
        });

        grabProcess.on('exit', (code) => {
          if (code !== 0 && !hasStarted) {
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
      eventBuffer += data.toString();
      
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
    const evtestMatch = line.match(/type\s+1\s+\(EV_KEY\),\s+code\s+(\d+)\s+\([^)]+\),\s+value\s+([01])/);
    
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
      }
    }
  }

  private handleButtonPress(action: string, event: ControllerEvent): void {
    const isLBPressed = this.state.buttonStates.get(310); // LB modifier
    const isRBPressed = this.state.buttonStates.get(311); // RB modifier

    // Determine if this is a modified action
    const modifiedAction = isLBPressed ? `lb_${action}` : isRBPressed ? `rb_${action}` : action;
    
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

  private async disconnectController(): Promise<void> {
    if (this.state.grabbedProcess) {
      this.state.grabbedProcess.kill();
      this.state.grabbedProcess = undefined;
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

  public isConnected(): boolean {
    return this.state.isConnected;
  }

  public getState(): ControllerState {
    return { ...this.state };
  }

  public getButtonStates(): Map<number, boolean> {
    return new Map(this.state.buttonStates);
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down controller service');
    await this.disconnectController();
    this.removeAllListeners();
  }
}