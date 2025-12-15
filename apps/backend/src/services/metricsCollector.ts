/**
 * MetricsCollector - Tracks operational metrics for /metrics endpoint
 * Keeps backward-compatible JSON format (no Prometheus text breaking change)
 */

interface Histogram {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export class MetricsCollector {
  private jobsProcessed = 0;
  private jobsFailed = 0;
  private retriesTotal = 0;
  private inferenceLatencies: number[] = [];
  private readonly maxHistogramSamples = 1000;
  // Path A (OpenAI) specific metrics
  private aLaneRetries = 0;
  private aLaneRetrySuccess = 0;
  private fallbacksToLmStudio = 0;
  private pathAFailures = 0;
  private queueDepthCurrent = 0;
  // Shadow lane metrics
  private shadowLaneEnabled = true; // Default enabled, auto-gates based on queue depth
  // Image processing (Stage 1 & 2) metrics
  private imageProcessingSuccessTotal = 0;
  private imageProcessingFailureTotal = 0;
  private imageProcessingLatencies: number[] = [];
  private imageProcessingImageSizes: number[] = [];

  recordJobProcessed(): void {
    this.jobsProcessed++;
  }

  recordJobFailed(): void {
    this.jobsFailed++;
  }

  recordRetry(): void {
    this.retriesTotal++;
  }

  recordInferenceLatency(ms: number): void {
    this.inferenceLatencies.push(ms);
    // Keep only recent samples to avoid unbounded memory growth
    if (this.inferenceLatencies.length > this.maxHistogramSamples) {
      this.inferenceLatencies.shift();
    }
  }

  recordALaneRetry(): void {
    this.aLaneRetries++;
  }

  recordALaneRetrySuccess(): void {
    this.aLaneRetrySuccess++;
  }

  recordFallbackToLmStudio(): void {
    this.fallbacksToLmStudio++;
  }

  recordPathAFailure(): void {
    this.pathAFailures++;
  }

  setQueueDepth(depth: number): void {
    this.queueDepthCurrent = depth;
  }

  setShadowLaneEnabled(enabled: boolean): void {
    this.shadowLaneEnabled = enabled;
  }

  isShadowLaneEnabled(): boolean {
    return this.shadowLaneEnabled;
  }

  recordImageProcessingSuccess(latencyMs: number, imageSizeBytes?: number): void {
    this.imageProcessingSuccessTotal++;
    this.imageProcessingLatencies.push(latencyMs);
    if (imageSizeBytes !== undefined) {
      this.imageProcessingImageSizes.push(imageSizeBytes);
    }
    // Keep only recent samples to avoid unbounded memory growth
    if (this.imageProcessingLatencies.length > this.maxHistogramSamples) {
      this.imageProcessingLatencies.shift();
    }
    if (this.imageProcessingImageSizes.length > this.maxHistogramSamples) {
      this.imageProcessingImageSizes.shift();
    }
  }

  recordImageProcessingFailure(): void {
    this.imageProcessingFailureTotal++;
  }

  getMetrics() {
    return {
      counters: {
        jobs_processed_total: this.jobsProcessed,
        jobs_failed_total: this.jobsFailed,
        retries_total: this.retriesTotal,
        a_lane_retries_total: this.aLaneRetries,
        a_lane_retry_success_total: this.aLaneRetrySuccess,
        fallbacks_to_lmstudio_total: this.fallbacksToLmStudio,
        pathA_failures_total: this.pathAFailures,
        image_processing_success_total: this.imageProcessingSuccessTotal,
        image_processing_failure_total: this.imageProcessingFailureTotal,
      },
      gauges: {
        queue_depth_current: this.queueDepthCurrent,
        shadow_lane_enabled: this.shadowLaneEnabled ? 1 : 0,
      },
      histograms: {
        inference_latency_ms: this.computeHistogram(this.inferenceLatencies),
        image_processing_latency_ms: this.computeHistogram(this.imageProcessingLatencies),
        image_processing_size_kb: this.computeHistogram(
          this.imageProcessingImageSizes.map((b) => Math.round(b / 1024))
        ),
      },
    };
  }

  private computeHistogram(samples: number[]): Histogram {
    if (samples.length === 0) {
      return {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    return {
      count: sorted.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
    };
  }

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }
}
