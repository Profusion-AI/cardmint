/**
 * Local Matching Metrics - Structured logging and performance tracking
 * Provides observability for Local-First recognition system
 */

import { createLogger } from './logger';
import { LocalMatchMetrics, LocalMode } from '../services/local-matching/types';

const logger = createLogger('LocalMatchingMetrics');

export interface MetricsSummary {
  total_matches: number;
  successful_matches: number;
  ml_fallback_count: number;
  avg_latency_ms: number;
  confidence_distribution: {
    high: number; // >= 0.8
    medium: number; // 0.5-0.8
    low: number; // < 0.5
  };
  strategy_usage: Record<string, number>;
  mode_distribution: Record<LocalMode, number>;
}

export class LocalMatchingMetricsCollector {
  private metrics: LocalMatchMetrics[] = [];
  private readonly maxMetrics: number;
  private readonly flushInterval: number;
  
  constructor(maxMetrics = 10000, flushIntervalMs = 300000) { // 5 minutes
    this.maxMetrics = maxMetrics;
    this.flushInterval = flushIntervalMs;
    
    // Set up periodic flush
    if (flushIntervalMs > 0) {
      setInterval(() => this.flush(), flushIntervalMs);
    }
    
    logger.info('LocalMatchingMetricsCollector initialized', {
      maxMetrics,
      flushIntervalMs
    });
  }

  recordMetric(metric: LocalMatchMetrics): void {
    this.metrics.push({
      ...metric,
      timestamp: Date.now()
    } as LocalMatchMetrics & {timestamp: number});
    
    // Immediate structured logging
    this.logMetricImmediate(metric);
    
    // Prevent memory growth
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-Math.floor(this.maxMetrics * 0.8));
    }
  }

  private logMetricImmediate(metric: LocalMatchMetrics): void {
    // Emit structured log for real-time monitoring
    logger.info('LocalMatch', {
      scan_id: metric.scan_id,
      confidence: metric.local_confidence,
      decision: metric.decision,
      ml_fallback: metric.ml_used,
      latency_ms: metric.latency_ms,
      method: metric.match_method,
      strategies: metric.strategy_chain.length,
      mode: metric.mode,
      // Individual strategy scores for debugging
      strategy_scores: Object.entries(metric.conf_scores)
        .map(([strategy, score]) => `${strategy}:${score.toFixed(3)}`)
        .join(',')
    });
  }

  getSummary(): MetricsSummary {
    if (this.metrics.length === 0) {
      return this.createEmptySummary();
    }
    
    const summary: MetricsSummary = {
      total_matches: this.metrics.length,
      successful_matches: 0,
      ml_fallback_count: 0,
      avg_latency_ms: 0,
      confidence_distribution: {
        high: 0,
        medium: 0,
        low: 0
      },
      strategy_usage: {},
      mode_distribution: {
        [LocalMode.HYBRID]: 0,
        [LocalMode.LOCAL_ONLY]: 0,
        [LocalMode.ML_ONLY]: 0
      }
    };
    
    let totalLatency = 0;
    
    for (const metric of this.metrics) {
      // Success counting
      if (metric.decision === 'auto_approved') {
        summary.successful_matches++;
      }
      
      // ML fallback counting
      if (metric.ml_used) {
        summary.ml_fallback_count++;
      }
      
      // Latency accumulation
      totalLatency += metric.latency_ms;
      
      // Confidence distribution
      if (metric.local_confidence >= 0.8) {
        summary.confidence_distribution.high++;
      } else if (metric.local_confidence >= 0.5) {
        summary.confidence_distribution.medium++;
      } else {
        summary.confidence_distribution.low++;
      }
      
      // Strategy usage tracking
      for (const strategy of metric.strategy_chain) {
        summary.strategy_usage[strategy] = (summary.strategy_usage[strategy] || 0) + 1;
      }
      
      // Mode distribution
      summary.mode_distribution[metric.mode]++;
    }
    
    summary.avg_latency_ms = totalLatency / this.metrics.length;
    
    return summary;
  }

  private createEmptySummary(): MetricsSummary {
    return {
      total_matches: 0,
      successful_matches: 0,
      ml_fallback_count: 0,
      avg_latency_ms: 0,
      confidence_distribution: { high: 0, medium: 0, low: 0 },
      strategy_usage: {},
      mode_distribution: {
        [LocalMode.HYBRID]: 0,
        [LocalMode.LOCAL_ONLY]: 0,
        [LocalMode.ML_ONLY]: 0
      }
    };
  }

  getRecentMetrics(limit = 100): LocalMatchMetrics[] {
    return this.metrics.slice(-limit);
  }

  getMetricsByTimeRange(startMs: number, endMs: number): LocalMatchMetrics[] {
    return this.metrics.filter(metric => {
      const timestamp = (metric as any).timestamp || 0;
      return timestamp >= startMs && timestamp <= endMs;
    });
  }

  exportMetrics(): {
    summary: MetricsSummary;
    raw_metrics: LocalMatchMetrics[];
    export_timestamp: number;
  } {
    return {
      summary: this.getSummary(),
      raw_metrics: [...this.metrics],
      export_timestamp: Date.now()
    };
  }

  flush(): void {
    if (this.metrics.length === 0) return;
    
    const summary = this.getSummary();
    
    logger.info('LocalMatchingMetrics Summary', {
      period_metrics: summary.total_matches,
      success_rate: (summary.successful_matches / summary.total_matches * 100).toFixed(1) + '%',
      ml_fallback_rate: (summary.ml_fallback_count / summary.total_matches * 100).toFixed(1) + '%',
      avg_latency_ms: Math.round(summary.avg_latency_ms),
      confidence_dist: summary.confidence_distribution,
      top_strategies: Object.entries(summary.strategy_usage)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([strategy, count]) => `${strategy}:${count}`)
        .join(',')
    });
    
    // Optional: Write to file or external monitoring system
    this.writeMetricsToFile(summary);
  }

  private async writeMetricsToFile(summary: MetricsSummary): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const dataRoot = process.env.DATA_ROOT || './data';
      const metricsDir = path.join(dataRoot, 'logs');
      const metricsFile = path.join(metricsDir, 'local-matching-metrics.json');
      
      // Ensure directory exists
      await fs.mkdir(metricsDir, { recursive: true });
      
      const metricsData = {
        timestamp: new Date().toISOString(),
        summary,
        recent_samples: this.getRecentMetrics(50)
      };
      
      await fs.writeFile(metricsFile, JSON.stringify(metricsData, null, 2));
      
    } catch (error) {
      logger.debug('Failed to write metrics file:', error);
    }
  }

  clear(): void {
    this.metrics = [];
    logger.info('LocalMatchingMetrics cleared');
  }

  getStats(): {
    metrics_count: number;
    memory_usage_mb: number;
    oldest_metric_age_ms: number;
  } {
    const oldestMetric = this.metrics[0] as any;
    const oldestTimestamp = oldestMetric?.timestamp || Date.now();
    
    return {
      metrics_count: this.metrics.length,
      memory_usage_mb: Math.round(JSON.stringify(this.metrics).length / 1024 / 1024 * 100) / 100,
      oldest_metric_age_ms: Date.now() - oldestTimestamp
    };
  }
}

// Global metrics collector instance
export const localMatchingMetrics = new LocalMatchingMetricsCollector();

// Convenience functions for common operations
export function recordLocalMatch(metric: LocalMatchMetrics): void {
  localMatchingMetrics.recordMetric(metric);
}

export function getLocalMatchingSummary(): MetricsSummary {
  return localMatchingMetrics.getSummary();
}

export function exportLocalMatchingData(): ReturnType<LocalMatchingMetricsCollector['exportMetrics']> {
  return localMatchingMetrics.exportMetrics();
}

// Performance monitoring helpers
export function createPerformanceLogger(operationName: string) {
  const startTime = Date.now();
  
  return {
    end: (metadata?: Record<string, any>) => {
      const latency = Date.now() - startTime;
      
      logger.debug(`Performance: ${operationName}`, {
        operation: operationName,
        latency_ms: latency,
        ...metadata
      });
      
      return latency;
    }
  };
}

// Health check for metrics system
export function getMetricsHealth(): {
  status: 'healthy' | 'warning' | 'error';
  issues: string[];
  stats: ReturnType<LocalMatchingMetricsCollector['getStats']>;
} {
  const issues: string[] = [];
  const stats = localMatchingMetrics.getStats();
  
  // Check for potential issues
  if (stats.memory_usage_mb > 100) {
    issues.push(`High memory usage: ${stats.memory_usage_mb}MB`);
  }
  
  if (stats.oldest_metric_age_ms > 24 * 60 * 60 * 1000) { // 24 hours
    issues.push(`Metrics not flushed in ${Math.round(stats.oldest_metric_age_ms / 60 / 60 / 1000)} hours`);
  }
  
  const status = issues.length === 0 ? 'healthy' : 
                 issues.length === 1 ? 'warning' : 'error';
  
  return {
    status,
    issues,
    stats
  };
}
