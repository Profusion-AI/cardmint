import { metrics } from './metrics';
import { logger } from './logger';

export interface AccuracyMetrics {
  ocrAccuracy: number;
  apiMatchAccuracy: number;
  imageValidationAccuracy: number;
  overallPipelineAccuracy: number;
  manualReviewRate: number;
  highValueCardAccuracy: number;
  specialEditionAccuracy: number;
}

export class AccuracyTracker {
  private readonly windowSize = 1000; // Track last 1000 cards
  private readonly highValueThreshold = 10000; // $100 in cents
  
  private ocrResults: boolean[] = [];
  private apiMatches: boolean[] = [];
  private imageValidations: boolean[] = [];
  private pipelineResults: boolean[] = [];
  private manualReviews: boolean[] = [];
  private highValueResults: Map<string, boolean> = new Map();
  private specialEditionResults: Map<string, boolean> = new Map();

  constructor() {
    this.initializeMetrics();
    this.startPeriodicReporting();
  }

  private initializeMetrics(): void {
    // Register custom accuracy metrics
    metrics.registerGauge(
      'cardmint_accuracy_ocr_percent',
      'OCR accuracy percentage',
      () => this.calculateAccuracy(this.ocrResults) * 100
    );

    metrics.registerGauge(
      'cardmint_accuracy_api_match_percent',
      'API match accuracy percentage',
      () => this.calculateAccuracy(this.apiMatches) * 100
    );

    metrics.registerGauge(
      'cardmint_accuracy_image_validation_percent',
      'Image validation accuracy percentage',
      () => this.calculateAccuracy(this.imageValidations) * 100
    );

    metrics.registerGauge(
      'cardmint_accuracy_pipeline_percent',
      'Overall pipeline accuracy percentage (target: 99.9%)',
      () => this.calculateAccuracy(this.pipelineResults) * 100
    );

    metrics.registerGauge(
      'cardmint_manual_review_rate_percent',
      'Percentage of cards requiring manual review',
      () => this.calculateRate(this.manualReviews) * 100
    );

    metrics.registerGauge(
      'cardmint_high_value_accuracy_percent',
      'Accuracy for high-value cards (>$100)',
      () => this.calculateMapAccuracy(this.highValueResults) * 100
    );

    metrics.registerGauge(
      'cardmint_special_edition_accuracy_percent',
      'Accuracy for special edition cards',
      () => this.calculateMapAccuracy(this.specialEditionResults) * 100
    );

    // Register counters
    metrics.registerCounter(
      'cardmint_cards_processed_total',
      'Total number of cards processed'
    );

    metrics.registerCounter(
      'cardmint_cards_successful_total',
      'Total number of successfully processed cards'
    );

    metrics.registerCounter(
      'cardmint_cards_failed_total',
      'Total number of failed card processings'
    );

    metrics.registerCounter(
      'cardmint_cards_review_total',
      'Total number of cards sent for manual review'
    );

    // Register histograms for confidence scores
    metrics.registerHistogram(
      'cardmint_confidence_score',
      'Confidence score distribution',
      [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99, 1.0]
    );

    metrics.registerHistogram(
      'cardmint_processing_time_seconds',
      'Card processing time in seconds',
      [0.5, 1, 2, 5, 10, 15, 20, 30]
    );
  }

  recordCardProcessing(data: {
    ocrSuccess: boolean;
    ocrConfidence: number;
    apiMatchFound: boolean;
    apiMatchConfidence: number;
    imageValidated?: boolean;
    imageConfidence?: number;
    overallSuccess: boolean;
    overallConfidence: number;
    needsReview: boolean;
    isHighValue: boolean;
    isSpecialEdition: boolean;
    processingTimeMs: number;
    cardId: string;
  }): void {
    // Update rolling windows
    this.updateWindow(this.ocrResults, data.ocrSuccess);
    this.updateWindow(this.apiMatches, data.apiMatchFound);
    
    if (data.imageValidated !== undefined) {
      this.updateWindow(this.imageValidations, data.imageValidated);
    }
    
    this.updateWindow(this.pipelineResults, data.overallSuccess);
    this.updateWindow(this.manualReviews, data.needsReview);

    // Track high-value and special edition cards
    if (data.isHighValue) {
      this.highValueResults.set(data.cardId, data.overallSuccess);
      this.trimMap(this.highValueResults);
    }

    if (data.isSpecialEdition) {
      this.specialEditionResults.set(data.cardId, data.overallSuccess);
      this.trimMap(this.specialEditionResults);
    }

    // Update counters
    metrics.increment('cardmint_cards_processed_total');
    
    if (data.overallSuccess) {
      metrics.increment('cardmint_cards_successful_total');
    } else {
      metrics.increment('cardmint_cards_failed_total');
    }

    if (data.needsReview) {
      metrics.increment('cardmint_cards_review_total');
    }

    // Record confidence scores
    metrics.observeHistogram('cardmint_confidence_score', data.overallConfidence);
    
    // Record processing time
    metrics.observeHistogram('cardmint_processing_time_seconds', data.processingTimeMs / 1000);

    // Log if accuracy drops below threshold
    const currentAccuracy = this.calculateAccuracy(this.pipelineResults);
    if (currentAccuracy < 0.999 && this.pipelineResults.length >= 100) {
      logger.warn('Pipeline accuracy below 99.9% threshold', {
        currentAccuracy: (currentAccuracy * 100).toFixed(2) + '%',
        samplesAnalyzed: this.pipelineResults.length
      });

      // Trigger alert
      metrics.increment('cardmint_accuracy_alerts_total', { type: 'below_threshold' });
    }

    // Log confidence distribution
    if (this.pipelineResults.length % 100 === 0) {
      this.logAccuracyReport();
    }
  }

  private updateWindow(array: boolean[], value: boolean): void {
    array.push(value);
    if (array.length > this.windowSize) {
      array.shift();
    }
  }

  private trimMap(map: Map<string, boolean>): void {
    if (map.size > this.windowSize) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
  }

  private calculateAccuracy(results: boolean[]): number {
    if (results.length === 0) return 0;
    const successful = results.filter(r => r).length;
    return successful / results.length;
  }

  private calculateRate(results: boolean[]): number {
    if (results.length === 0) return 0;
    const positive = results.filter(r => r).length;
    return positive / results.length;
  }

  private calculateMapAccuracy(map: Map<string, boolean>): number {
    if (map.size === 0) return 0;
    const successful = Array.from(map.values()).filter(v => v).length;
    return successful / map.size;
  }

  getAccuracyMetrics(): AccuracyMetrics {
    return {
      ocrAccuracy: this.calculateAccuracy(this.ocrResults),
      apiMatchAccuracy: this.calculateAccuracy(this.apiMatches),
      imageValidationAccuracy: this.calculateAccuracy(this.imageValidations),
      overallPipelineAccuracy: this.calculateAccuracy(this.pipelineResults),
      manualReviewRate: this.calculateRate(this.manualReviews),
      highValueCardAccuracy: this.calculateMapAccuracy(this.highValueResults),
      specialEditionAccuracy: this.calculateMapAccuracy(this.specialEditionResults)
    };
  }

  private logAccuracyReport(): void {
    const metrics = this.getAccuracyMetrics();
    
    logger.info('Accuracy Report', {
      ocrAccuracy: `${(metrics.ocrAccuracy * 100).toFixed(2)}%`,
      apiMatchAccuracy: `${(metrics.apiMatchAccuracy * 100).toFixed(2)}%`,
      imageValidationAccuracy: `${(metrics.imageValidationAccuracy * 100).toFixed(2)}%`,
      overallPipelineAccuracy: `${(metrics.overallPipelineAccuracy * 100).toFixed(2)}%`,
      manualReviewRate: `${(metrics.manualReviewRate * 100).toFixed(2)}%`,
      highValueCardAccuracy: `${(metrics.highValueCardAccuracy * 100).toFixed(2)}%`,
      specialEditionAccuracy: `${(metrics.specialEditionAccuracy * 100).toFixed(2)}%`,
      samplesAnalyzed: this.pipelineResults.length
    });

    // Check if we're meeting 99.9% target
    if (metrics.overallPipelineAccuracy >= 0.999) {
      logger.info('✅ Meeting 99.9% accuracy target!');
    } else {
      logger.warn('⚠️ Below 99.9% accuracy target', {
        target: '99.9%',
        current: `${(metrics.overallPipelineAccuracy * 100).toFixed(2)}%`,
        gap: `${((0.999 - metrics.overallPipelineAccuracy) * 100).toFixed(2)}%`
      });
    }
  }

  private startPeriodicReporting(): void {
    // Report every 5 minutes
    setInterval(() => {
      if (this.pipelineResults.length > 0) {
        this.logAccuracyReport();
      }
    }, 5 * 60 * 1000);
  }

  reset(): void {
    this.ocrResults = [];
    this.apiMatches = [];
    this.imageValidations = [];
    this.pipelineResults = [];
    this.manualReviews = [];
    this.highValueResults.clear();
    this.specialEditionResults.clear();
    logger.info('Accuracy metrics reset');
  }
}

// Singleton instance
export const accuracyTracker = new AccuracyTracker();

// Helper function to determine if accuracy target is met
export function isAccuracyTargetMet(): boolean {
  const metrics = accuracyTracker.getAccuracyMetrics();
  return metrics.overallPipelineAccuracy >= 0.999;
}

// Helper function to get accuracy status
export function getAccuracyStatus(): {
  status: 'healthy' | 'warning' | 'critical';
  message: string;
  metrics: AccuracyMetrics;
} {
  const metrics = accuracyTracker.getAccuracyMetrics();
  const accuracy = metrics.overallPipelineAccuracy;

  if (accuracy >= 0.999) {
    return {
      status: 'healthy',
      message: `Meeting 99.9% accuracy target (${(accuracy * 100).toFixed(2)}%)`,
      metrics
    };
  } else if (accuracy >= 0.95) {
    return {
      status: 'warning',
      message: `Below 99.9% target but operational (${(accuracy * 100).toFixed(2)}%)`,
      metrics
    };
  } else {
    return {
      status: 'critical',
      message: `Critical: Accuracy far below target (${(accuracy * 100).toFixed(2)}%)`,
      metrics
    };
  }
}