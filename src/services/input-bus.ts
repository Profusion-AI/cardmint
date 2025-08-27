import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  InputAction,
  InputSource,
  InputEvent,
  TelemetryEvent,
  TelemetrySummary,
  validateInputEvent,
  validateTelemetryEvent,
  TELEMETRY_CSV_HEADER
} from '../schemas/input';

const logger = createLogger('input-bus');

/**
 * Production-first Input Bus
 * Minimal, deterministic event system for operator console
 * Focused on proving ≥20% throughput improvement for controller vs keyboard
 */
export class InputBus extends EventEmitter {
  private sequenceCounter = 0;
  private cycleId = `cycle_${Date.now()}`;
  private csvPath: string;
  private startTime = Date.now();

  constructor(csvPath = './data/input-telemetry.csv') {
    super();
    this.csvPath = csvPath;
    this.initializeTelemetryCSV();
    logger.info(`Input bus initialized, telemetry: ${csvPath}, cycle: ${this.cycleId}`);
  }

  private initializeTelemetryCSV(): void {
    // Ensure data directory exists
    const dir = dirname(this.csvPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      logger.info(`Created data directory: ${dir}`);
    }
    
    if (!existsSync(this.csvPath)) {
      const headers = TELEMETRY_CSV_HEADER + '\n';
      writeFileSync(this.csvPath, headers, 'utf8');
      logger.info(`Created telemetry CSV: ${this.csvPath}`);
    }
  }

  /**
   * Emit typed input event with validation
   * Core interface: emitInput({action, source, ts, seq})
   */
  public emitInput(event: Omit<InputEvent, 'seq'>): void {
    const seq = ++this.sequenceCounter;
    const validatedEvent: InputEvent = {
      ...event,
      seq,
      cycleId: event.cycleId || this.cycleId,
    };

    // Strict validation using shared schemas
    try {
      const parsed = validateInputEvent(validatedEvent);
      
      // Log telemetry immediately 
      this.recordTelemetry(parsed);
      
      // Emit to subscribers
      this.emit('input', parsed);
      this.emit(parsed.action, parsed);
      
      logger.debug(`Input: ${parsed.action} from ${parsed.source} [${parsed.seq}]`);
      
    } catch (error) {
      logger.error('Invalid input event:', error);
      const errorTelemetry: TelemetryEvent = {
        ts: event.ts,
        source: event.source,
        action: event.action,
        cardId: event.cardId || '',
        cycleId: event.cycleId || this.cycleId,
        latencyMs: 0,
        error: error instanceof Error ? error.message : 'validation_failed'
      };
      this.recordTelemetry(errorTelemetry);
    }
  }

  /**
   * Record telemetry to CSV for A/B testing analysis
   */
  private recordTelemetry(event: InputEvent | TelemetryEvent): void {
    const telemetry: TelemetryEvent = {
      ts: event.ts,
      source: event.source,
      action: event.action,
      cardId: event.cardId || '',
      cycleId: event.cycleId || this.cycleId,
      latencyMs: 'latencyMs' in event ? event.latencyMs : Date.now() - event.ts,
      error: 'error' in event ? event.error : '',
    };

    const csvRow = `${telemetry.ts},${telemetry.source},${telemetry.action},${telemetry.cardId},${telemetry.cycleId},${telemetry.latencyMs},"${telemetry.error}"\n`;
    
    try {
      writeFileSync(this.csvPath, csvRow, { flag: 'a', encoding: 'utf8' });
    } catch (error) {
      logger.error('Failed to write telemetry:', error);
    }
  }

  /**
   * Subscribe to specific action type
   */
  public onAction(action: InputAction, handler: (event: InputEvent) => void): void {
    this.on(action, handler);
  }

  /**
   * Subscribe to all input events
   */
  public onInput(handler: (event: InputEvent) => void): void {
    this.on('input', handler);
  }

  /**
   * Get telemetry summary for throughput analysis
   * Fixed to properly parse and filter by cycleId
   */
  public getTelemetrySummary(cycleId?: string): TelemetrySummary {
    const targetCycleId = cycleId || this.cycleId;
    
    try {
      const csvData = readFileSync(this.csvPath, 'utf8');
      const rows = csvData.split('\n').slice(1).filter(row => row.trim());
      
      // Parse CSV with proper cycleId extraction
      const events = rows.map((row): any => {
        // Handle quoted error field - split by comma but preserve quotes
        const parts = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        if (parts.length < 6) return null;
        
        return {
          ts: parseInt(String(parts[0])),
          source: parts[1] as InputSource,
          action: parts[2] as InputAction,
          cardId: String(parts[3]),
          cycleId: String(parts[4]),
          latencyMs: parseFloat(String(parts[5])),
          error: parts[6] ? String(parts[6]).replace(/"/g, '') : '', // Remove quotes
        };
      }).filter((e: any) => e && e.cycleId === targetCycleId);

      const keyboardInputs = events.filter(e => e.source === 'keyboard').length;
      const controllerInputs = events.filter(e => e.source === 'controller').length;
      const totalInputs = events.length;
      const avgLatencyMs = events.length > 0 
        ? events.reduce((sum, e) => sum + e.latencyMs, 0) / events.length 
        : 0;
      
      const sessionDurationMs = Date.now() - this.startTime;
      const throughputPerMinute = totalInputs > 0 
        ? (totalInputs / sessionDurationMs) * 60000 
        : 0;

      return {
        totalInputs,
        keyboardInputs,
        controllerInputs,
        avgLatencyMs,
        sessionDurationMs,
        throughputPerMinute,
        cycleId: targetCycleId,
      };
    } catch (error) {
      logger.error('Failed to calculate telemetry summary:', error);
      return {
        totalInputs: 0,
        keyboardInputs: 0,
        controllerInputs: 0,
        avgLatencyMs: 0,
        sessionDurationMs: 0,
        throughputPerMinute: 0,
        cycleId: targetCycleId,
      };
    }
  }

  /**
   * Start new cycle for A/B testing
   */
  public startNewCycle(): string {
    this.cycleId = `cycle_${Date.now()}`;
    this.startTime = Date.now();
    this.sequenceCounter = 0;
    logger.info(`Started new test cycle: ${this.cycleId}`);
    return this.cycleId;
  }

  /**
   * Get current cycle ID
   */
  public getCurrentCycle(): string {
    return this.cycleId;
  }
}

// Global singleton for production use
export const inputBus = new InputBus();

/**
 * Keyboard Adapter - Minimal mappings only
 * X/Space = capture, A = approve, B/R = reject
 */
export class KeyboardAdapter {
  private readonly keyMappings = {
    'Space': 'capture' as const,
    'KeyX': 'capture' as const,
    'KeyA': 'approve' as const,
    'KeyB': 'reject' as const,
    'KeyR': 'reject' as const,
  };

  constructor(private bus: InputBus) {
    this.setupEventListeners();
    logger.info('Keyboard adapter initialized with minimal mappings');
  }

  private setupEventListeners(): void {
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : undefined;
    if (g && typeof g.addEventListener === 'function') {
      g.addEventListener('keydown', this.handleKeydown.bind(this));
    }
  }

  private handleKeydown(event: any): void {
    // Ignore key auto-repeat to avoid flooding actions when holding a key
    if ('repeat' in event && (event as any).repeat) {
      return;
    }
    if (event.preventDefault) event.preventDefault();
    if ((event as any).stopPropagation) (event as any).stopPropagation();
    const action = this.keyMappings[event.code as keyof typeof this.keyMappings];
    
    if (action) {
      event.preventDefault();
      
      this.bus.emitInput({
        action,
        source: 'keyboard',
        ts: Date.now(),
      });
    }
  }

  /**
   * Get available keyboard mappings for UI display
   */
  public getMappings(): Record<string, string> {
    return {
      'Space/X': 'Capture Card',
      'A': 'Approve Card',
      'B/R': 'Reject Card',
    };
  }
}

/**
 * Controller Adapter - Shim for future PS4 integration
 * Same interface as keyboard for A/B testing parity
 */
export class ControllerAdapter {
  private connected = false;
  
  constructor(private bus: InputBus) {
    logger.info('Controller adapter initialized (shim mode)');
  }

  /**
   * Simulate controller input (for testing)
   */
  public simulateInput(action: InputAction): void {
    this.bus.emitInput({
      action,
      source: 'controller',
      ts: Date.now(),
    });
  }

  /**
   * Check if controller is connected
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get controller status
   */
  public getStatus(): { connected: boolean; batteryLevel?: number } {
    return { connected: this.connected };
  }
}
