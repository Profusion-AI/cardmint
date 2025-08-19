/**
 * Gradual Rollout Controller for VLM Optimization
 * 
 * Manages percentage-based rollout with automatic rollback on performance degradation.
 */

import { getFeatureFlags } from './features';

export interface RolloutMetrics {
  averageProcessingTime: number;
  errorRate: number;
  memoryUsage: number;
  cpuUsage: number;
  successRate: number;
}

export interface RolloutConfig {
  stages: RolloutStage[];
  currentStage: number;
  startTime: Date;
  metrics: RolloutMetrics;
}

export interface RolloutStage {
  name: string;
  percentage: number;
  minDuration: number; // Hours before advancing
  successCriteria: RolloutMetrics;
  autoAdvance: boolean;
}

/**
 * Default rollout stages for VLM
 */
export const DEFAULT_ROLLOUT_STAGES: RolloutStage[] = [
  {
    name: 'Shadow Mode Testing',
    percentage: 0,
    minDuration: 24,
    successCriteria: {
      averageProcessingTime: 10000, // 10s max
      errorRate: 0.05, // 5% max errors
      memoryUsage: 7000, // 7GB max
      cpuUsage: 80, // 80% max
      successRate: 0.95 // 95% min success
    },
    autoAdvance: false
  },
  {
    name: 'Canary (1%)',
    percentage: 1,
    minDuration: 12,
    successCriteria: {
      averageProcessingTime: 5000,
      errorRate: 0.03,
      memoryUsage: 6000,
      cpuUsage: 70,
      successRate: 0.97
    },
    autoAdvance: true
  },
  {
    name: 'Early Adoption (5%)',
    percentage: 5,
    minDuration: 24,
    successCriteria: {
      averageProcessingTime: 4000,
      errorRate: 0.02,
      memoryUsage: 5500,
      cpuUsage: 65,
      successRate: 0.98
    },
    autoAdvance: true
  },
  {
    name: 'Expanded Testing (20%)',
    percentage: 20,
    minDuration: 48,
    successCriteria: {
      averageProcessingTime: 3000,
      errorRate: 0.01,
      memoryUsage: 5000,
      cpuUsage: 60,
      successRate: 0.99
    },
    autoAdvance: true
  },
  {
    name: 'Majority Rollout (50%)',
    percentage: 50,
    minDuration: 72,
    successCriteria: {
      averageProcessingTime: 2500,
      errorRate: 0.01,
      memoryUsage: 5000,
      cpuUsage: 60,
      successRate: 0.99
    },
    autoAdvance: false // Manual decision for full rollout
  },
  {
    name: 'Full Deployment (100%)',
    percentage: 100,
    minDuration: 0,
    successCriteria: {
      averageProcessingTime: 2000,
      errorRate: 0.01,
      memoryUsage: 5000,
      cpuUsage: 60,
      successRate: 0.99
    },
    autoAdvance: false
  }
];

export class RolloutController {
  private config: RolloutConfig;
  private metricsHistory: RolloutMetrics[] = [];
  
  constructor() {
    this.config = this.loadConfig();
  }
  
  /**
   * Load rollout configuration from storage or use defaults
   */
  private loadConfig(): RolloutConfig {
    // In production, load from Redis or database
    // For now, return defaults
    return {
      stages: DEFAULT_ROLLOUT_STAGES,
      currentStage: 0,
      startTime: new Date(),
      metrics: {
        averageProcessingTime: 0,
        errorRate: 0,
        memoryUsage: 0,
        cpuUsage: 0,
        successRate: 1
      }
    };
  }
  
  /**
   * Check if current metrics meet rollback criteria
   */
  public shouldRollback(metrics: RolloutMetrics): boolean {
    const stage = this.config.stages[this.config.currentStage];
    const criteria = stage.successCriteria;
    
    // Check each metric against criteria
    const failures = [];
    
    if (metrics.averageProcessingTime > criteria.averageProcessingTime) {
      failures.push(`Processing time ${metrics.averageProcessingTime}ms > ${criteria.averageProcessingTime}ms`);
    }
    
    if (metrics.errorRate > criteria.errorRate) {
      failures.push(`Error rate ${(metrics.errorRate * 100).toFixed(1)}% > ${(criteria.errorRate * 100).toFixed(1)}%`);
    }
    
    if (metrics.memoryUsage > criteria.memoryUsage) {
      failures.push(`Memory usage ${metrics.memoryUsage}MB > ${criteria.memoryUsage}MB`);
    }
    
    if (metrics.cpuUsage > criteria.cpuUsage) {
      failures.push(`CPU usage ${metrics.cpuUsage}% > ${criteria.cpuUsage}%`);
    }
    
    if (metrics.successRate < criteria.successRate) {
      failures.push(`Success rate ${(metrics.successRate * 100).toFixed(1)}% < ${(criteria.successRate * 100).toFixed(1)}%`);
    }
    
    if (failures.length > 0) {
      console.error('[VLM Rollout] Rollback triggered:', failures);
      return true;
    }
    
    return false;
  }
  
  /**
   * Check if ready to advance to next stage
   */
  public canAdvance(): boolean {
    const stage = this.config.stages[this.config.currentStage];
    
    // Check minimum duration
    const hoursSinceStart = (Date.now() - this.config.startTime.getTime()) / (1000 * 60 * 60);
    if (hoursSinceStart < stage.minDuration) {
      console.log(`[VLM Rollout] Cannot advance: Only ${hoursSinceStart.toFixed(1)}h of ${stage.minDuration}h elapsed`);
      return false;
    }
    
    // Check if auto-advance is enabled
    if (!stage.autoAdvance) {
      console.log('[VLM Rollout] Manual advancement required for this stage');
      return false;
    }
    
    // Check if metrics meet success criteria
    if (this.shouldRollback(this.config.metrics)) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Advance to next rollout stage
   */
  public advance(): boolean {
    if (this.config.currentStage >= this.config.stages.length - 1) {
      console.log('[VLM Rollout] Already at final stage');
      return false;
    }
    
    if (!this.canAdvance()) {
      return false;
    }
    
    this.config.currentStage++;
    this.config.startTime = new Date();
    
    const newStage = this.config.stages[this.config.currentStage];
    console.log(`[VLM Rollout] Advanced to stage: ${newStage.name} (${newStage.percentage}%)`);
    
    // Update environment variable
    process.env.VLM_PERCENTAGE = newStage.percentage.toString();
    
    return true;
  }
  
  /**
   * Emergency rollback to previous stage or disable completely
   */
  public rollback(): void {
    if (this.config.currentStage > 0) {
      this.config.currentStage--;
      const stage = this.config.stages[this.config.currentStage];
      process.env.VLM_PERCENTAGE = stage.percentage.toString();
      console.warn(`[VLM Rollout] Rolled back to: ${stage.name} (${stage.percentage}%)`);
    } else {
      // Complete disable
      process.env.VLM_ENABLED = 'false';
      process.env.VLM_EMERGENCY_KILL = 'true';
      console.error('[VLM Rollout] Emergency shutdown - VLM disabled');
    }
  }
  
  /**
   * Update current metrics
   */
  public updateMetrics(metrics: Partial<RolloutMetrics>): void {
    this.config.metrics = {
      ...this.config.metrics,
      ...metrics
    };
    
    this.metricsHistory.push({ ...this.config.metrics });
    
    // Keep only last 100 entries
    if (this.metricsHistory.length > 100) {
      this.metricsHistory.shift();
    }
    
    // Check for automatic rollback
    if (this.shouldRollback(this.config.metrics)) {
      this.rollback();
    }
  }
  
  /**
   * Get current rollout status
   */
  public getStatus(): {
    stage: string;
    percentage: number;
    metrics: RolloutMetrics;
    canAdvance: boolean;
  } {
    const stage = this.config.stages[this.config.currentStage];
    return {
      stage: stage.name,
      percentage: stage.percentage,
      metrics: this.config.metrics,
      canAdvance: this.canAdvance()
    };
  }
}

// Singleton instance
export const rolloutController = new RolloutController();