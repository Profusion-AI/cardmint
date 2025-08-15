import { createLogger } from './logger';
import { config } from '../config';
import { PerformanceMetrics } from '../types';
import http from 'http';

const logger = createLogger('metrics');

interface MetricValue {
  value: number | (() => number);
  labels?: Record<string, string>;
  help?: string;
  type?: 'counter' | 'gauge' | 'histogram';
}

export class EnhancedMetricsCollector {
  private server?: http.Server;
  private metrics: Map<string, MetricValue> = new Map();
  private histograms: Map<string, { values: number[], buckets?: number[] }> = new Map();
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, () => number> = new Map();
  
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
    this.metrics.set('process_memory_heap_used_bytes', { 
      value: memUsage.heapUsed,
      type: 'gauge',
      help: 'Process heap memory used in bytes'
    });
    this.metrics.set('process_memory_heap_total_bytes', {
      value: memUsage.heapTotal,
      type: 'gauge',
      help: 'Process total heap memory in bytes'
    });
    this.metrics.set('process_memory_rss_bytes', {
      value: memUsage.rss,
      type: 'gauge',
      help: 'Process resident set size in bytes'
    });
    
    const cpuUsage = process.cpuUsage();
    this.metrics.set('process_cpu_user_seconds', {
      value: cpuUsage.user / 1000000,
      type: 'counter',
      help: 'Process CPU user time in seconds'
    });
    this.metrics.set('process_cpu_system_seconds', {
      value: cpuUsage.system / 1000000,
      type: 'counter',
      help: 'Process CPU system time in seconds'
    });
    
    this.metrics.set('process_uptime_seconds', {
      value: process.uptime(),
      type: 'gauge',
      help: 'Process uptime in seconds'
    });
  }

  // Register a gauge metric with a callback function
  registerGauge(name: string, help: string, getValue: () => number): void {
    this.gauges.set(name, getValue);
    this.metrics.set(name, {
      value: getValue,
      type: 'gauge',
      help
    });
  }

  // Register a counter metric
  registerCounter(name: string, help: string): void {
    this.counters.set(name, 0);
    this.metrics.set(name, {
      value: 0,
      type: 'counter',
      help
    });
  }

  // Register a histogram metric with custom buckets
  registerHistogram(name: string, help: string, buckets?: number[]): void {
    this.histograms.set(name, { 
      values: [], 
      buckets: buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    });
    this.metrics.set(name, {
      value: 0,
      type: 'histogram',
      help
    });
  }

  // Increment a counter
  increment(name: string, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + 1);
    
    if (!this.metrics.has(name)) {
      this.registerCounter(name, `Counter for ${name}`);
    }
  }

  // Set a gauge value
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    this.metrics.set(key, {
      value,
      type: 'gauge',
      labels
    });
  }

  // Observe a value for a histogram
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    
    if (!this.histograms.has(key)) {
      this.histograms.set(key, { values: [], buckets: undefined });
    }
    
    const histogram = this.histograms.get(key)!;
    histogram.values.push(value);
    
    // Keep only last 10000 values to prevent memory leak
    if (histogram.values.length > 10000) {
      histogram.values = histogram.values.slice(-10000);
    }
  }

  private getMetricKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return `${name}{${labelStr}}`;
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private formatPrometheusMetrics(): string {
    const lines: string[] = [];
    
    // Add metadata
    lines.push('# HELP cardmint_info CardMint system information');
    lines.push('# TYPE cardmint_info gauge');
    lines.push(`cardmint_info{version="1.0.0",node_version="${process.version}"} 1`);
    
    // Add registered metrics
    const processedMetrics = new Set<string>();
    
    // Process gauges
    for (const [name, getValue] of this.gauges) {
      if (!processedMetrics.has(name)) {
        const metric = this.metrics.get(name);
        if (metric?.help) {
          lines.push(`# HELP ${name} ${metric.help}`);
          lines.push(`# TYPE ${name} gauge`);
        }
        lines.push(`${name} ${getValue()}`);
        processedMetrics.add(name);
      }
    }
    
    // Process counters
    for (const [key, value] of this.counters) {
      const baseName = key.split('{')[0];
      if (!processedMetrics.has(baseName)) {
        const metric = this.metrics.get(baseName);
        if (metric?.help) {
          lines.push(`# HELP ${baseName} ${metric.help}`);
          lines.push(`# TYPE ${baseName} counter`);
        }
        processedMetrics.add(baseName);
      }
      lines.push(`${key} ${value}`);
    }
    
    // Process regular metrics
    for (const [name, metric] of this.metrics) {
      if (processedMetrics.has(name)) continue;
      
      const metricName = name.startsWith('cardmint_') ? name : `cardmint_${name}`;
      
      if (metric.help) {
        lines.push(`# HELP ${metricName} ${metric.help}`);
        lines.push(`# TYPE ${metricName} ${metric.type || 'gauge'}`);
      }
      
      const value = typeof metric.value === 'function' ? metric.value() : metric.value;
      lines.push(`${metricName} ${value}`);
    }
    
    // Process histograms
    for (const [name, histogram] of this.histograms) {
      if (histogram.values.length === 0) continue;
      
      const metricName = name.startsWith('cardmint_') ? name : `cardmint_${name}`;
      const metric = this.metrics.get(name);
      
      if (metric?.help) {
        lines.push(`# HELP ${metricName} ${metric.help}`);
        lines.push(`# TYPE ${metricName} histogram`);
      }
      
      const sum = histogram.values.reduce((a, b) => a + b, 0);
      const count = histogram.values.length;
      
      // Add bucket counts if defined
      if (histogram.buckets) {
        for (const bucket of histogram.buckets) {
          const bucketCount = histogram.values.filter(v => v <= bucket).length;
          lines.push(`${metricName}_bucket{le="${bucket}"} ${bucketCount}`);
        }
        lines.push(`${metricName}_bucket{le="+Inf"} ${count}`);
      }
      
      // Add percentiles
      lines.push(`${metricName}{quantile="0.5"} ${this.calculatePercentile(histogram.values, 50)}`);
      lines.push(`${metricName}{quantile="0.9"} ${this.calculatePercentile(histogram.values, 90)}`);
      lines.push(`${metricName}{quantile="0.95"} ${this.calculatePercentile(histogram.values, 95)}`);
      lines.push(`${metricName}{quantile="0.99"} ${this.calculatePercentile(histogram.values, 99)}`);
      lines.push(`${metricName}_sum ${sum}`);
      lines.push(`${metricName}_count ${count}`);
    }
    
    return lines.join('\\n');
  }

  // Compatibility methods for existing code
  recordCapture(latencyMs: number): void {
    this.observeHistogram('capture_latency_milliseconds', latencyMs);
    this.increment('captures_total');
  }
  
  recordProcessing(latencyMs: number): void {
    this.observeHistogram('processing_latency_milliseconds', latencyMs);
    this.increment('processed_total');
  }
  
  recordOCR(latencyMs: number, confidence: number): void {
    this.observeHistogram('ocr_latency_milliseconds', latencyMs);
    this.observeHistogram('ocr_confidence', confidence * 100);
  }
  
  recordError(errorType: string): void {
    this.increment('errors_total', { type: errorType });
  }
  
  recordQueueDepth(queueName: string, depth: number): void {
    this.gauge(`queue_depth`, depth, { queue: queueName });
  }

  getPerformanceMetrics(): PerformanceMetrics {
    const captureLatencies = this.histograms.get('capture_latency_milliseconds')?.values || [];
    const processingLatencies = this.histograms.get('processing_latency_milliseconds')?.values || [];
    const ocrLatencies = this.histograms.get('ocr_latency_milliseconds')?.values || [];
    
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
      queueDepth: this.counters.get('queue_depth_processing') || 0,
      throughputPerMinute: (this.counters.get('captures_total') || 0) / (process.uptime() / 60),
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

// Export singleton instance
export const metrics = new EnhancedMetricsCollector();