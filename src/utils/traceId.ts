import { randomBytes } from 'crypto';

/**
 * Trace ID utilities for following requests through the system
 * Format: 8-character hex string for readability in logs
 */

export class TraceId {
  private static current?: string;
  
  /**
   * Generate a new trace ID
   */
  static generate(): string {
    return randomBytes(4).toString('hex');
  }
  
  /**
   * Set current trace ID for this async context
   */
  static set(traceId: string): void {
    TraceId.current = traceId;
  }
  
  /**
   * Get current trace ID
   */
  static get(): string | undefined {
    return TraceId.current;
  }
  
  /**
   * Run function with a specific trace ID
   */
  static async with<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = TraceId.current;
    TraceId.set(traceId);
    try {
      return await fn();
    } finally {
      TraceId.current = previous;
    }
  }
  
  /**
   * Run function with a new generated trace ID
   */
  static async withNew<T>(fn: () => Promise<T>): Promise<T> {
    return TraceId.with(TraceId.generate(), fn);
  }
}

/**
 * Card processing trace - follows a card from capture to database
 */
export interface CardTrace {
  traceId: string;
  cardId?: string;
  fileName?: string;
  stages: {
    capture?: { startedAt: Date; completedAt?: Date; durationMs?: number };
    detection?: { startedAt: Date; completedAt?: Date; durationMs?: number };
    processing?: { startedAt: Date; completedAt?: Date; durationMs?: number };
    ml?: { startedAt: Date; completedAt?: Date; durationMs?: number };
    database?: { startedAt: Date; completedAt?: Date; durationMs?: number };
  };
  errors: Array<{
    stage: string;
    error: string;
    timestamp: Date;
  }>;
  metadata?: Record<string, any>;
}

export class CardTracer {
  private traces = new Map<string, CardTrace>();
  
  /**
   * Start a new card trace
   */
  startTrace(fileName: string): string {
    const traceId = TraceId.generate();
    
    this.traces.set(traceId, {
      traceId,
      fileName,
      stages: {},
      errors: [],
      metadata: {}
    });
    
    return traceId;
  }
  
  /**
   * Mark start of a processing stage
   */
  startStage(traceId: string, stage: keyof CardTrace['stages']): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.stages[stage] = { startedAt: new Date() };
    }
  }
  
  /**
   * Mark completion of a processing stage
   */
  completeStage(traceId: string, stage: keyof CardTrace['stages']): void {
    const trace = this.traces.get(traceId);
    if (trace && trace.stages[stage]) {
      const stageInfo = trace.stages[stage]!;
      stageInfo.completedAt = new Date();
      stageInfo.durationMs = stageInfo.completedAt.getTime() - stageInfo.startedAt.getTime();
    }
  }
  
  /**
   * Add error to trace
   */
  addError(traceId: string, stage: string, error: string): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.errors.push({
        stage,
        error,
        timestamp: new Date()
      });
    }
  }
  
  /**
   * Set card ID when it becomes available
   */
  setCardId(traceId: string, cardId: string): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.cardId = cardId;
    }
  }
  
  /**
   * Add metadata to trace
   */
  addMetadata(traceId: string, key: string, value: any): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      if (!trace.metadata) trace.metadata = {};
      trace.metadata[key] = value;
    }
  }
  
  /**
   * Get trace information
   */
  getTrace(traceId: string): CardTrace | undefined {
    return this.traces.get(traceId);
  }
  
  /**
   * Complete trace and return summary
   */
  completeTrace(traceId: string): CardTrace | undefined {
    const trace = this.traces.get(traceId);
    if (trace) {
      // Calculate total duration
      const stages = Object.values(trace.stages);
      const durations = stages
        .filter(s => s.durationMs !== undefined)
        .map(s => s.durationMs!);
      
      if (durations.length > 0) {
        trace.metadata = trace.metadata || {};
        trace.metadata.totalDurationMs = durations.reduce((sum, d) => sum + d, 0);
      }
      
      // Remove from active traces after 5 minutes (cleanup)
      setTimeout(() => {
        this.traces.delete(traceId);
      }, 5 * 60 * 1000);
    }
    
    return trace;
  }
  
  /**
   * Get all active traces (for debugging)
   */
  getActiveTraces(): CardTrace[] {
    return Array.from(this.traces.values());
  }
}

// Global card tracer instance
export const cardTracer = new CardTracer();