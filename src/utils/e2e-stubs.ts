import { createLogger } from '../utils/logger';

const logger = createLogger('e2e-stubs');

// Minimal no-op QueueManager replacement for E2E_NO_REDIS mode
export class NoopQueueManager {
  async initialize(): Promise<void> {
    logger.info('E2E_NO_REDIS: Using NoopQueueManager');
  }
  async addProcessingJob(_data: any, _priority = 0): Promise<any> {
    logger.info('E2E_NO_REDIS: addProcessingJob (noop)');
    return { id: 'noop', data: _data };
  }
  async addCaptureJob(_data: any, _priority = 0): Promise<any> {
    logger.info('E2E_NO_REDIS: addCaptureJob (noop)');
    return { id: 'noop', data: _data };
  }
  async getQueueStatus(): Promise<{ capture: any; processing: any }> {
    return {
      capture: { waiting: 0, active: 0, completed: 0, failed: 0 },
      processing: { waiting: 0, active: 0, completed: 0, failed: 0 },
    };
  }
  async pause(): Promise<void> {}
  async drain(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

// Minimal metrics collector replacement
export class NoopMetricsCollector {
  async start(): Promise<void> {
    logger.info('E2E_NO_REDIS: Using NoopMetricsCollector');
  }
  recordCapture(_ms: number) {}
  recordError(_scope: string) {}
  recordTelemetry(_event?: any) {}
  getStats() { return { counters: {}, histograms: {} }; }
  getPerformanceMetrics() { return { captures: 0, processing: 0, errors: 0 }; }
}

