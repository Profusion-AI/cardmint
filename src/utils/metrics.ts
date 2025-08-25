import http from 'http';
import { config } from '../config';
import { PerformanceMetrics } from '../types';
import { createLogger } from './logger';

const logger = createLogger('metrics');

export class MetricsCollector {
  private server?: http.Server;
  private metrics: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private gaugeCallbacks: Map<string, () => number> = new Map();
  
  async start(): Promise<void> {
    if (!config.performance.enableMetrics) {
      logger.info('Metrics collection disabled');
      return;
    }
    
    this.setupMetricsServer();
    this.startCollecting();
    
    logger.info(`Metrics server started on port ${config.monitoring.metricsPort}`);
  }
  
  private setupMetricsServer(): void {
    this.server = http.createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(this.formatPrometheusMetrics());
      } else if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    this.server.listen(config.monitoring.metricsPort);
  }
  
  private startCollecting(): void {
    setInterval(() => {
      this.collectSystemMetrics();
    }, 5000);
  }
  
  private collectSystemMetrics(): void {
    const memUsage = process.memoryUsage();
    this.metrics.set('process_memory_heap_used_bytes', memUsage.heapUsed);
    this.metrics.set('process_memory_heap_total_bytes', memUsage.heapTotal);
    this.metrics.set('process_memory_rss_bytes', memUsage.rss);
    this.metrics.set('process_memory_external_bytes', memUsage.external);
    
    const cpuUsage = process.cpuUsage();
    this.metrics.set('process_cpu_user_seconds', cpuUsage.user / 1000000);
    this.metrics.set('process_cpu_system_seconds', cpuUsage.system / 1000000);
    
    this.metrics.set('process_uptime_seconds', process.uptime());
  }
  
  recordCapture(latencyMs: number): void {
    this.recordHistogram('capture_latency_milliseconds', latencyMs);
    this.increment('captures_total');
  }
  
  recordProcessing(latencyMs: number): void {
    this.recordHistogram('processing_latency_milliseconds', latencyMs);
    this.increment('processed_total');
  }
  
  recordOCR(latencyMs: number, confidence: number): void {
    this.recordHistogram('ocr_latency_milliseconds', latencyMs);
    this.recordHistogram('ocr_confidence', confidence * 100);
  }
  
  recordError(errorType: string): void {
    this.increment(`errors_total_${errorType}`);
  }
  
  recordQueueDepth(queueName: string, depth: number): void {
    this.metrics.set(`queue_depth_${queueName}`, depth);
  }
  
  increment(metric: string, value = 1): void {
    const current = this.metrics.get(metric) || 0;
    this.metrics.set(metric, current + value);
  }
  
  incrementCounter(metric: string, labels?: Record<string, string>): void {
    const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
    const fullMetric = `${metric}${labelStr}`;
    const current = this.metrics.get(fullMetric) || 0;
    this.metrics.set(fullMetric, current + 1);
  }
  
  gauge(metric: string, value: number): void {
    this.metrics.set(metric, value);
  }
  
  recordGauge(metric: string, value: number, labels?: Record<string, string>): void {
    const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
    const fullMetric = `${metric}${labelStr}`;
    this.metrics.set(fullMetric, value);
  }
  
  recordHistogram(metric: string, value: number): void {
    this.recordHistogramPrivate(metric, value);
  }
  
  registerGauge(name: string, help: string, callback: () => number): void {
    this.gaugeCallbacks.set(name, callback);
  }
  
  registerCounter(name: string, help: string): void {
    this.metrics.set(name, 0);
  }
  
  registerHistogram(name: string, help: string, buckets?: number[]): void {
    this.histograms.set(name, []);
  }
  
  observeHistogram(name: string, value: number): void {
    this.recordHistogram(name, value);
  }
  
  private recordHistogramPrivate(name: string, value: number): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, []);
    }
    
    const values = this.histograms.get(name)!;
    values.push(value);
    
    // Keep only last 1000 values
    if (values.length > 1000) {
      values.shift();
    }
  }
  
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }
  
  private formatPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Add metadata
    lines.push('# HELP cardmint_info CardMint system information');
    lines.push('# TYPE cardmint_info gauge');
    lines.push(`cardmint_info{version="1.0.0",node_version="${process.version}"} 1`);
    
    // Add counters and gauges
    for (const [name, value] of this.metrics) {
      const metricName = `cardmint_${name}`;
      lines.push(`# HELP ${metricName} ${name.replace(/_/g, ' ')}`);
      lines.push(`# TYPE ${metricName} ${name.includes('total') ? 'counter' : 'gauge'}`);
      lines.push(`${metricName} ${value}`);
    }
    
    // Add registered gauges
    for (const [name, callback] of this.gaugeCallbacks) {
      try {
        const value = callback();
        const metricName = `cardmint_${name}`;
        lines.push(`# HELP ${metricName} ${name.replace(/_/g, ' ')}`);
        lines.push(`# TYPE ${metricName} gauge`);
        lines.push(`${metricName} ${value}`);
      } catch (error) {
        logger.warn(`Failed to get value for gauge ${name}:`, error);
      }
    }
    
    // Add histograms
    for (const [name, values] of this.histograms) {
      if (values.length === 0) continue;
      
      const metricName = `cardmint_${name}`;
      const sum = values.reduce((a, b) => a + b, 0);
      const count = values.length;
      
      lines.push(`# HELP ${metricName} ${name.replace(/_/g, ' ')}`);
      lines.push(`# TYPE ${metricName} histogram`);
      
      // Add percentiles
      lines.push(`${metricName}{quantile="0.5"} ${this.calculatePercentile(values, 50)}`);
      lines.push(`${metricName}{quantile="0.9"} ${this.calculatePercentile(values, 90)}`);
      lines.push(`${metricName}{quantile="0.95"} ${this.calculatePercentile(values, 95)}`);
      lines.push(`${metricName}{quantile="0.99"} ${this.calculatePercentile(values, 99)}`);
      lines.push(`${metricName}_sum ${sum}`);
      lines.push(`${metricName}_count ${count}`);
    }
    
    return lines.join('\\n');
  }
  
  getPerformanceMetrics(): PerformanceMetrics {
    const captureLatencies = this.histograms.get('capture_latency_milliseconds') || [];
    const processingLatencies = this.histograms.get('processing_latency_milliseconds') || [];
    const ocrLatencies = this.histograms.get('ocr_latency_milliseconds') || [];
    
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      captureLatencyMs: this.calculatePercentile(captureLatencies, 95),
      processingLatencyMs: this.calculatePercentile(processingLatencies, 95),
      ocrLatencyMs: this.calculatePercentile(ocrLatencies, 95),
      totalLatencyMs: this.calculatePercentile(
        [...captureLatencies, ...processingLatencies, ...ocrLatencies],
        95
      ),
      queueDepth: this.metrics.get('queue_depth_processing') || 0,
      throughputPerMinute: (this.metrics.get('captures_total') || 0) / (process.uptime() / 60),
      memoryUsageMb: memUsage.heapUsed / 1024 / 1024,
      cpuUsagePercent: ((cpuUsage.user + cpuUsage.system) / 1000000 / process.uptime()) * 100,
    };
  }
  
  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}

// Singleton instance for global use
export const metrics = new MetricsCollector();