/**
 * Pino-based logger adapter for structured logging
 * 
 * Provides consistent logging interface across the ROI system
 * with performance-optimized structured logging.
 */

import pino, { Logger as PinoLogger } from 'pino';

// Platform-agnostic logger interface
export interface Logger {
  info(obj: any, msg?: string): void;
  warn(obj: any, msg?: string): void;
  error(obj: any, msg?: string): void;
  debug(obj: any, msg?: string): void;
  trace(obj: any, msg?: string): void;
  child(bindings: object): Logger;
  isLevelEnabled(level: string): boolean;
}

// ROI-specific log data interfaces
export interface ROILogData {
  roiId?: string;
  templateId?: string;
  familyId?: string;
  tier?: string;
  durationMs?: number;
  confidence?: number;
  budgetUsed?: number;
  budgetRemaining?: number;
}

export interface PerformanceLogData {
  operation: string;
  durationMs: number;
  memoryMB?: number;
  cacheHits?: number;
  cacheMisses?: number;
}

export interface DebugLogData {
  debugPath?: string;
  overlayGenerated?: boolean;
  explainGenerated?: boolean;
  traceGenerated?: boolean;
  lowConfidenceThreshold?: number;
}

export class PinoLogger implements Logger {
  private readonly logger: PinoLogger;
  
  constructor(options: {
    level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    name?: string;
    prettyPrint?: boolean;
    destination?: string;
  } = {}) {
    this.logger = pino({
      level: options.level || 'info',
      name: options.name || 'roi-system',
      ...(options.prettyPrint && process.env.NODE_ENV !== 'production' && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: true,
            ignore: 'pid,hostname',
          },
        },
      }),
      ...(options.destination && {
        transport: {
          target: 'pino/file',
          options: {
            destination: options.destination,
          },
        },
      }),
      base: {
        pid: process.pid,
        hostname: undefined, // Remove hostname for cleaner logs
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  
  info(obj: any, msg?: string): void {
    if (msg) {
      this.logger.info(obj, msg);
    } else {
      this.logger.info(obj);
    }
  }
  
  warn(obj: any, msg?: string): void {
    if (msg) {
      this.logger.warn(obj, msg);
    } else {
      this.logger.warn(obj);
    }
  }
  
  error(obj: any, msg?: string): void {
    if (msg) {
      this.logger.error(obj, msg);
    } else {
      this.logger.error(obj);
    }
  }
  
  debug(obj: any, msg?: string): void {
    if (msg) {
      this.logger.debug(obj, msg);
    } else {
      this.logger.debug(obj);
    }
  }
  
  trace(obj: any, msg?: string): void {
    if (msg) {
      this.logger.trace(obj, msg);
    } else {
      this.logger.trace(obj);
    }
  }
  
  child(bindings: object): Logger {
    return new PinoLogger({
      level: this.logger.level as any,
    });
  }
  
  isLevelEnabled(level: string): boolean {
    return this.logger.isLevelEnabled(level);
  }
  
  // ROI-specific logging methods
  logROIEvaluation(data: ROILogData & { result: 'success' | 'failed' | 'skipped' }): void {
    this.debug(data, `ROI evaluation ${data.result}: ${data.roiId}`);
  }
  
  logTemplateSelection(data: { 
    selectedTemplate: string; 
    confidence: number; 
    alternatives: string[]; 
    durationMs: number;
    features: Record<string, any>;
  }): void {
    this.info(data, `Template selected: ${data.selectedTemplate} (confidence: ${data.confidence.toFixed(3)})`);
  }
  
  logPerformanceMetrics(data: PerformanceLogData): void {
    if (data.durationMs > 100) { // Only log slow operations
      this.warn(data, `Slow operation detected: ${data.operation}`);
    } else {
      this.debug(data, `Performance: ${data.operation}`);
    }
  }
  
  logBudgetExhaustion(data: {
    budgetMs: number;
    usedMs: number;
    operation: string;
    tier: string;
  }): void {
    this.warn(data, `Budget exhausted during ${data.operation} at tier ${data.tier}`);
  }
  
  logLowConfidence(data: {
    confidence: number;
    threshold: number;
    templateId: string;
    debugGenerated: boolean;
  }): void {
    this.warn(data, `Low confidence result: ${data.confidence.toFixed(3)} < ${data.threshold}`);
  }
  
  logCachePerformance(data: {
    cacheType: 'coordinate' | 'crop' | 'probe';
    hitRate: number;
    totalRequests: number;
    memoryMB: number;
  }): void {
    this.debug(data, `Cache performance: ${data.cacheType}`);
  }
  
  logDebugOutput(data: DebugLogData): void {
    this.info(data, 'Debug output generated');
  }
  
  // Utility method for timing operations with automatic logging
  async logTimed<T>(
    operation: () => Promise<T>, 
    name: string, 
    context?: Record<string, any>
  ): Promise<T> {
    const startTime = process.hrtime.bigint();
    
    try {
      const result = await operation();
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1_000_000;
      
      this.logPerformanceMetrics({
        operation: name,
        durationMs,
        ...context,
      });
      
      return result;
    } catch (error) {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1_000_000;
      
      this.error({
        operation: name,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        ...context,
      }, `Operation failed: ${name}`);
      
      throw error;
    }
  }
}

// Singleton logger instance
let globalLogger: PinoLogger | undefined;

export function getLogger(name?: string): PinoLogger {
  if (!globalLogger) {
    globalLogger = new PinoLogger({
      name: name || 'roi-system',
      prettyPrint: process.env.NODE_ENV !== 'production',
      level: (process.env.LOG_LEVEL as any) || 'info',
    });
  }
  
  if (name && name !== 'roi-system') {
    return new PinoLogger({
      name,
      prettyPrint: process.env.NODE_ENV !== 'production',
      level: (process.env.LOG_LEVEL as any) || 'info',
    });
  }
  
  return globalLogger;
}

// Convenience functions for common logging patterns
export function createROILogger(component: string): PinoLogger {
  return getLogger(`roi-${component}`);
}

export function createPerformanceLogger(): PinoLogger {
  return getLogger('roi-performance');
}

export function createDebugLogger(): PinoLogger {
  return getLogger('roi-debug');
}