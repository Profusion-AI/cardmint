/**
 * Performance Profiler for VLM Pipeline Optimization
 * 
 * Single-source timing spine for CardMint pipeline.
 * Provides pure data API with optional logging.
 * Optimized for Prometheus export and production monitoring.
 */

import { performance } from 'node:perf_hooks';

export type StageName =
  | 'capture'
  | 'preprocess' 
  | 'file_read'
  | 'base64_encode'
  | 'network_request'
  | 'vlm_infer'
  | 'json_parse'
  | 'postprocess'
  | 'verify'
  | 'persist'
  | 'total'; // total is derived, not timed directly

export interface StageMetadata {
  [key: string]: unknown;
}

export interface ProfileStage {
  name: StageName | (string & {}); // allow custom names but encourage StageName
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: StageMetadata;
}

export interface CardInfo {
  fileName: string;
  fileSize: number;
  dimensions?: { width: number; height: number };
}

export interface ProfileResult {
  runId: string;
  totalDuration: number;
  stages: ProfileStage[];
  timestamp: number;
  cardInfo?: CardInfo;
}

export class PerformanceProfiler {
  private runId: string;
  private stages = new Map<string, ProfileStage>();
  private cardInfo?: CardInfo;
  private finalized = false;
  private cached?: ProfileResult;
  
  constructor(runId?: string) {
    this.runId = runId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
  
  get id(): string {
    return this.runId;
  }
  
  /**
   * Start timing a pipeline stage (idempotent: restart resets start)
   */
  startStage(stageName: StageName | string, metadata?: StageMetadata): void {
    if (this.finalized) return;
    
    this.stages.set(String(stageName), {
      name: stageName as any,
      startTime: performance.now(),
      metadata: metadata ? { ...metadata } : undefined,
    });
  }
  
  /**
   * End timing a stage; returns duration ms (0 if missing). Merges metadata.
   */
  endStage(stageName: StageName | string, metadata?: StageMetadata): number {
    if (this.finalized) return 0;
    
    const stage = this.stages.get(String(stageName));
    if (!stage) return 0;
    
    const endTime = performance.now();
    stage.endTime = endTime;
    stage.duration = Math.max(0, endTime - stage.startTime);
    stage.metadata = stage.metadata ? { ...stage.metadata, ...metadata } : metadata;
    
    return stage.duration;
  }
  
  /**
   * Attach card context
   */
  setCardInfo(fileName: string, fileSize: number, dimensions?: CardInfo['dimensions']): void {
    if (this.finalized) return;
    this.cardInfo = { fileName, fileSize, dimensions };
  }
  
  /**
   * Returns shallow map of completed stage durations (no logging, no finalize)
   */
  getCurrentDurations(): Record<string, number> {
    const durations: Record<string, number> = {};
    for (const [name, stage] of this.stages) {
      if (stage.duration !== undefined) {
        durations[name] = stage.duration;
      }
    }
    return durations;
  }
  
  /**
   * Pure snapshot (no logging), marks finalized to prevent later mutation
   */
  snapshot(): ProfileResult {
    if (!this.finalized) {
      // Derive total only from completed stages
      const completedStages = [...this.stages.values()]
        .filter(s => s.duration !== undefined)
        .sort((a, b) => a.startTime - b.startTime);
      
      const totalDuration = completedStages.length > 0
        ? Math.max(...completedStages.map(s => s.endTime!)) - Math.min(...completedStages.map(s => s.startTime))
        : 0;

      this.cached = {
        runId: this.runId,
        totalDuration: Math.max(0, totalDuration),
        stages: completedStages.map(s => ({ ...s })), // copy
        timestamp: Date.now(),
        cardInfo: this.cardInfo ? { ...this.cardInfo } : undefined,
      };
      this.finalized = true;
    }
    return this.cached!;
  }
  
  /**
   * Legacy method for backwards compatibility - delegates to snapshot
   */
  generateReport(): ProfileResult {
    return this.snapshot();
  }
  
  /**
   * Optional pretty logger (does not mutate state). Safe after snapshot().
   */
  logReport(report?: ProfileResult, opts?: { eod?: Date }): void {
    const pr = report || this.snapshot();
    
    console.log(`\n📊 [${pr.runId}] Performance Report`);
    console.log(`🎯 Total Duration: ${pr.totalDuration.toFixed(1)}ms`);
    
    if (pr.cardInfo) {
      console.log(
        `📄 File: ${pr.cardInfo.fileName} (${(pr.cardInfo.fileSize / 1024).toFixed(1)}KB)${
          pr.cardInfo.dimensions ? `  📐 ${pr.cardInfo.dimensions.width}x${pr.cardInfo.dimensions.height}` : ''
        }`
      );
    }
    
    console.log('\n⏱️  Stage Breakdown:');
    let cumulative = 0;
    
    for (const stage of pr.stages) {
      const pct = pr.totalDuration > 0 
        ? ((stage.duration! / pr.totalDuration) * 100).toFixed(1) 
        : '0.0';
      cumulative += stage.duration ?? 0;
      
      console.log(
        `  ${stage.name.toString().padEnd(16)} ${(stage.duration ?? 0).toFixed(1).padStart(7)}ms (${pct.padStart(5)}%) cumulative: ${cumulative.toFixed(1)}ms`
      );
      
      if (stage.metadata && Object.keys(stage.metadata).length) {
        const metaStr = Object.entries(stage.metadata)
          .map(([k, v]) => `${k}:${String(v)}`)
          .join(', ');
        console.log(`    └─ ${metaStr}`);
      }
    }
    
    // Analysis
    console.log('\n🔍 Analysis:');
    if (pr.stages.length > 0) {
      const slowest = pr.stages.reduce((a, b) => 
        ((a.duration ?? 0) > (b.duration ?? 0) ? a : b)
      );
      console.log(`  Bottleneck: ${slowest.name} (${(slowest.duration ?? 0).toFixed(1)}ms)`);
    }
    
    const throughput = pr.totalDuration > 0 
      ? Math.round(3_600_000 / pr.totalDuration) 
      : 0;
    console.log(`  Theoretical Throughput: ${throughput} cards/hour`);
    
    const millisLeft = millisUntilEODTuesday(opts?.eod);
    const possible = throughput > 0 
      ? Math.round((millisLeft / 3_600_000) * throughput)
      : 0;
    console.log(`  Possible cards by Tuesday: ${possible} (target: 1000)\n`);
  }
  
  /**
   * Summary metrics for Prometheus export (no logging). Safe after snapshot().
   */
  summaryMetrics(report?: ProfileResult): Record<string, number> {
    const pr = report || this.snapshot();
    const metrics: Record<string, number> = {
      total_duration_ms: pr.totalDuration,
      throughput_cards_per_hour: pr.totalDuration > 0 
        ? Math.round(3_600_000 / pr.totalDuration) 
        : 0,
      stage_count: pr.stages.length,
    };
    
    for (const stage of pr.stages) {
      const key = `${String(stage.name).toLowerCase().replace(/\s+/g, '_')}_ms`;
      metrics[key] = stage.duration ?? 0;
    }
    
    return metrics;
  }
  
  /**
   * JSON export for offline analysis
   */
  toJSON(report?: ProfileResult): string {
    const pr = report || this.snapshot();
    return JSON.stringify(pr, null, 2);
  }
  
  /**
   * Legacy method for backwards compatibility
   */
  exportToJson(): string {
    return this.toJSON();
  }
  
  /**
   * Legacy method for backwards compatibility - delegates to summaryMetrics
   */
  getSummaryMetrics(): Record<string, number> {
    return this.summaryMetrics();
  }
}

/**
 * Compute millis until Tuesday 23:59:59.999 local (overrideable for tests)
 */
export function millisUntilEODTuesday(override?: Date): number {
  if (override) return Math.max(0, override.getTime() - Date.now());
  
  const now = new Date();
  const tuesday = new Date(now);
  // Next Tuesday (if today is Tue, use today's EOD)
  const delta = (2 - now.getDay() + 7) % 7;
  tuesday.setDate(now.getDate() + delta);
  tuesday.setHours(23, 59, 59, 999);
  return Math.max(0, tuesday.getTime() - now.getTime());
}

/**
 * Global instance helpers
 */
let globalProfiler: PerformanceProfiler | null = null;

export function startGlobalProfiler(runId?: string): PerformanceProfiler {
  globalProfiler = new PerformanceProfiler(runId);
  return globalProfiler;
}

export function getGlobalProfiler(): PerformanceProfiler | null {
  return globalProfiler;
}

export function endGlobalProfiler(opts?: { log?: boolean; eod?: Date }): ProfileResult | null {
  if (!globalProfiler) return null;
  
  const report = globalProfiler.snapshot();
  if (opts?.log) {
    globalProfiler.logReport(report, { eod: opts.eod });
  }
  
  globalProfiler = null;
  return report;
}