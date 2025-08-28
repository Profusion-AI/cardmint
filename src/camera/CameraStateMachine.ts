/**
 * Camera State Machine - Manages camera states and transitions
 * Created to resolve TypeScript import errors
 */

export enum CameraState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  INITIALIZING = 'initializing',
  READY = 'ready',
  CAPTURING = 'capturing',
  PROCESSING = 'processing',
  ERROR = 'error'
}

export interface CameraPath {
  inputPath: string;
  outputPath: string;
  metadata?: Record<string, any>;
}

export interface CaptureResult {
  success: boolean;
  path?: string;
  metadata?: Record<string, any>;
  error?: string;
  timestamp: Date;
}

export interface CameraConfig {
  shutterSpeed?: string;
  iso?: number;
  aperture?: string;
  driveMode?: string;
  imageFormat?: string;
  autoFocus?: boolean;
}

export interface StateTransition {
  from: CameraState;
  to: CameraState;
  trigger?: string;
  timestamp: Date;
}

export interface CameraStateMachine {
  currentState: CameraState;
  transition(to: CameraState, trigger?: string): boolean;
  canTransition(to: CameraState): boolean;
  getValidTransitions(): CameraState[];
  onStateChange(callback: (transition: StateTransition) => void): void;
  reset(): void;
}

/**
 * Basic Camera State Machine implementation
 */
export class BasicCameraStateMachine implements CameraStateMachine {
  private _currentState: CameraState = CameraState.DISCONNECTED;
  private _callbacks: Array<(transition: StateTransition) => void> = [];

  get currentState(): CameraState {
    return this._currentState;
  }

  private validTransitions: Record<CameraState, CameraState[]> = {
    [CameraState.DISCONNECTED]: [CameraState.CONNECTING],
    [CameraState.CONNECTING]: [CameraState.CONNECTED, CameraState.ERROR, CameraState.DISCONNECTED],
    [CameraState.CONNECTED]: [CameraState.INITIALIZING, CameraState.DISCONNECTED, CameraState.ERROR],
    [CameraState.INITIALIZING]: [CameraState.READY, CameraState.ERROR, CameraState.CONNECTED],
    [CameraState.READY]: [CameraState.CAPTURING, CameraState.DISCONNECTED, CameraState.ERROR],
    [CameraState.CAPTURING]: [CameraState.PROCESSING, CameraState.READY, CameraState.ERROR],
    [CameraState.PROCESSING]: [CameraState.READY, CameraState.ERROR],
    [CameraState.ERROR]: [CameraState.DISCONNECTED, CameraState.CONNECTING]
  };

  transition(to: CameraState, trigger?: string): boolean {
    if (!this.canTransition(to)) {
      return false;
    }

    const transition: StateTransition = {
      from: this._currentState,
      to: to,
      trigger,
      timestamp: new Date()
    };

    this._currentState = to;
    
    // Notify callbacks
    this._callbacks.forEach(callback => callback(transition));
    
    return true;
  }

  canTransition(to: CameraState): boolean {
    const validStates = this.validTransitions[this._currentState] || [];
    return validStates.includes(to);
  }

  getValidTransitions(): CameraState[] {
    return this.validTransitions[this._currentState] || [];
  }

  onStateChange(callback: (transition: StateTransition) => void): void {
    this._callbacks.push(callback);
  }

  reset(): void {
    this._currentState = CameraState.DISCONNECTED;
    this._callbacks = [];
  }
}

/**
 * Factory function to create a camera state machine
 */
export function createCameraStateMachine(): CameraStateMachine {
  return new BasicCameraStateMachine();
}