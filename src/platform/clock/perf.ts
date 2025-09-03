/**
 * Cross-platform high-resolution clock using performance.now()
 * 
 * Provides microsecond-precision timing for performance measurement
 * and Chrome tracing integration.
 */

export interface Clock {
  now(): number;
  nowMicros(): number;
  measure<T>(operation: () => T, name: string): { result: T; durationMs: number };
  measureAsync<T>(operation: () => Promise<T>, name: string): Promise<{ result: T; durationMs: number }>;
}

export interface TimeSpan {
  startMs: number;
  endMs: number;
  durationMs: number;
  name: string;
}

export class PerformanceClock implements Clock {
  private readonly startTime = performance.now();
  private measurements: TimeSpan[] = [];
  
  now(): number {
    return performance.now();
  }
  
  nowMicros(): number {
    return Math.floor(performance.now() * 1000);
  }
  
  measure<T>(operation: () => T, name: string): { result: T; durationMs: number } {
    const startTime = this.now();
    const result = operation();
    const endTime = this.now();
    const durationMs = endTime - startTime;
    
    this.measurements.push({
      startMs: startTime,
      endMs: endTime,
      durationMs,
      name,
    });
    
    return { result, durationMs };
  }
  
  async measureAsync<T>(operation: () => Promise<T>, name: string): Promise<{ result: T; durationMs: number }> {
    const startTime = this.now();
    const result = await operation();
    const endTime = this.now();
    const durationMs = endTime - startTime;
    
    this.measurements.push({
      startMs: startTime,
      endMs: endTime,
      durationMs,
      name,
    });
    
    return { result, durationMs };
  }
  
  // Get all measurements for analysis
  getMeasurements(): TimeSpan[] {
    return [...this.measurements];
  }
  
  // Clear measurement history
  clearMeasurements(): void {
    this.measurements = [];
  }
  
  // Get session duration since clock creation
  getSessionDurationMs(): number {
    return this.now() - this.startTime;
  }
  
  // Format duration for human readability
  formatDuration(ms: number): string {
    if (ms < 0.1) {
      return `${(ms * 1000).toFixed(1)}μs`;
    } else if (ms < 1) {
      return `${ms.toFixed(2)}ms`;
    } else if (ms < 1000) {
      return `${ms.toFixed(1)}ms`;
    } else {
      return `${(ms / 1000).toFixed(2)}s`;
    }
  }
  
  // Generate Chrome tracing events from measurements
  getChromeTraceEvents(processId: number = 1, threadId: number = 1): Array<{
    name: string;
    cat: string;
    ph: string;
    ts: number;
    dur: number;
    pid: number;
    tid: number;
  }> {
    return this.measurements.map((measurement) => ({
      name: measurement.name,
      cat: "roi",
      ph: "X", // Complete event
      ts: Math.floor(measurement.startMs * 1000), // Convert to microseconds
      dur: Math.floor(measurement.durationMs * 1000), // Convert to microseconds
      pid: processId,
      tid: threadId,
    }));
  }
  
  // Performance statistics
  getStats(filterByName?: string): {
    count: number;
    totalMs: number;
    avgMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  } {
    let measurements = this.measurements;
    
    if (filterByName) {
      measurements = measurements.filter(m => m.name.includes(filterByName));
    }
    
    if (measurements.length === 0) {
      return {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      };
    }
    
    const durations = measurements.map(m => m.durationMs).sort((a, b) => a - b);
    const total = durations.reduce((sum, d) => sum + d, 0);
    
    return {
      count: measurements.length,
      totalMs: total,
      avgMs: total / measurements.length,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      p50Ms: durations[Math.floor(durations.length * 0.5)],
      p95Ms: durations[Math.floor(durations.length * 0.95)],
      p99Ms: durations[Math.floor(durations.length * 0.99)],
    };
  }
}

// Singleton instance for global use
let globalClock: PerformanceClock | undefined;

export function getClock(): PerformanceClock {
  if (!globalClock) {
    globalClock = new PerformanceClock();
  }
  return globalClock;
}

// Utility functions for common timing patterns
export function time<T>(operation: () => T, name?: string): { result: T; durationMs: number } {
  return getClock().measure(operation, name || 'anonymous');
}

export async function timeAsync<T>(operation: () => Promise<T>, name?: string): Promise<{ result: T; durationMs: number }> {
  return getClock().measureAsync(operation, name || 'async-anonymous');
}

// Decorator for timing methods
export function timed(name?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const methodName = name || `${target.constructor.name}.${propertyKey}`;
    
    descriptor.value = function (...args: any[]) {
      return getClock().measure(() => originalMethod.apply(this, args), methodName);
    };
    
    return descriptor;
  };
}

// Async method timing decorator
export function timedAsync(name?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const methodName = name || `${target.constructor.name}.${propertyKey}`;
    
    descriptor.value = async function (...args: any[]) {
      return getClock().measureAsync(() => originalMethod.apply(this, args), methodName);
    };
    
    return descriptor;
  };
}

// Budget management with clock integration
export class TimeBudget {
  private readonly startTime: number;
  private spent = 0;
  
  constructor(private readonly totalMs: number, private readonly clock = getClock()) {
    this.startTime = clock.now();
  }
  
  take(ms: number): void {
    this.spent += ms;
  }
  
  get msUsed(): number {
    return this.spent;
  }
  
  get msRemaining(): number {
    return Math.max(0, this.totalMs - this.spent);
  }
  
  get msTotal(): number {
    return this.totalMs;
  }
  
  get isExhausted(): boolean {
    return this.spent >= this.totalMs;
  }
  
  get elapsedMs(): number {
    return this.clock.now() - this.startTime;
  }
  
  // Check if we have time for an estimated operation
  canAfford(estimatedMs: number): boolean {
    return (this.spent + estimatedMs) <= this.totalMs;
  }
  
  // Create a sub-budget from remaining time
  createSubBudget(ms: number): TimeBudget {
    const available = Math.min(ms, this.msRemaining);
    this.take(available);
    return new TimeBudget(available, this.clock);
  }
}