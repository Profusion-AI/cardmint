/**
 * Hardware-Aware Feature Extraction Pipeline
 * 
 * Implements fast image feature extraction optimized for Pokemon card analysis.
 * All probes designed to run <10ms on Fedora HP with caching support.
 */

import { Image, ImageIO, SharpImageIO } from '../platform/imageio/sharp';
import { ImageFeatures } from './types';
import { getClock, TimeBudget } from '../platform/clock/perf';
import { createROILogger } from '../platform/logger/pino';

const logger = createROILogger('features');

// Feature extraction configuration
export interface FeatureConfig {
  enableCaching: boolean;
  maxCacheSize: number;
  budgetMs: number;
  fastMode: boolean; // Skip expensive features for Pi 5
}

// Individual feature extraction result
export interface FeatureResult {
  name: string;
  value: number;
  confidence: number;
  processingMs: number;
  fromCache: boolean;
}

// Cache entry for feature results
interface CacheEntry {
  features: ImageFeatures;
  timestamp: number;
  imageHash: string;
}

export class FeatureExtractor {
  private readonly imageIO: ImageIO;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly config: FeatureConfig;
  
  constructor(options: Partial<FeatureConfig> = {}) {
    this.imageIO = new SharpImageIO();
    this.config = {
      enableCaching: true,
      maxCacheSize: 1000,
      budgetMs: 10,
      fastMode: false,
      ...options,
    };
  }
  
  async extractFeatures(image: Image): Promise<ImageFeatures> {
    const startTime = getClock().now();
    const budget = new TimeBudget(this.config.budgetMs);
    
    try {
      // Generate image hash for caching
      const imageHash = this.generateImageHash(image);
      
      // Check cache first
      if (this.config.enableCaching) {
        const cached = this.cache.get(imageHash);
        if (cached && this.isValidCacheEntry(cached)) {
          logger.trace({ imageHash }, 'Features retrieved from cache');
          return cached.features;
        }
      }
      
      // Extract features with budget management
      const features = await this.extractFeaturesInternal(image, budget);
      
      // Cache the results
      if (this.config.enableCaching) {
        this.cacheFeatures(imageHash, features);
      }
      
      const totalMs = getClock().now() - startTime;
      logger.debug({
        aspectRatio: features.aspectRatio,
        borderColor: features.borderColor,
        ruleBoxBand: features.ruleBoxBand,
        processingMs: totalMs,
      }, 'Feature extraction complete');
      
      return features;
      
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : String(error),
        processingMs: getClock().now() - startTime,
      }, 'Feature extraction failed');
      
      // Return minimal features for error recovery
      return this.getMinimalFeatures(image);
    }
  }
  
  private async extractFeaturesInternal(image: Image, budget: TimeBudget): Promise<ImageFeatures> {
    const features: Partial<ImageFeatures> = {};
    
    // Basic geometric features (always computed)
    features.aspectRatio = image.width / image.height;
    
    // Border color detection (fast, <1ms)
    if (!budget.isExhausted) {
      features.borderColor = await this.detectBorderColor(image, budget.createSubBudget(2));
    }
    
    // Rule box band detection (medium cost, ~2ms)
    if (!budget.isExhausted && !this.config.fastMode) {
      features.ruleBoxBand = await this.detectRuleBoxBand(image, budget.createSubBudget(3));
    }
    
    // Text density in top region (medium cost, ~2ms)
    if (!budget.isExhausted && !this.config.fastMode) {
      features.textDensityTop = await this.detectTextDensity(image, budget.createSubBudget(3));
    }
    
    // Edge logo detection (higher cost, ~3ms)
    if (!budget.isExhausted && !this.config.fastMode) {
      features.edgeLogoSignal = await this.detectEdgeLogos(image, budget.createSubBudget(4));
    }
    
    // Advanced pattern detection (only if budget allows)
    if (!budget.isExhausted && !this.config.fastMode) {
      features.deltaSymbolSignal = await this.detectDeltaSymbol(image, budget.createSubBudget(2));
      features.levelXToken = await this.detectLevelX(image, budget.createSubBudget(2));
      features.radiantPattern = await this.detectRadiantPattern(image, budget.createSubBudget(3));
      features.trainerPortraitBlob = await this.detectTrainerPortrait(image, budget.createSubBudget(2));
    }
    
    return features as ImageFeatures;
  }
  
  // Fast border color detection using edge samples
  private async detectBorderColor(image: Image, budget: TimeBudget): Promise<ImageFeatures['borderColor']> {
    const startTime = getClock().now();
    
    try {
      // Sample pixels from the border edges
      const edgeWidth = Math.min(10, Math.floor(image.width * 0.02));
      const edgeHeight = Math.min(10, Math.floor(image.height * 0.02));
      
      // Extract top edge
      const topEdge = await this.imageIO.crop(image, 0, 0, image.width, edgeHeight);
      const topStats = await (this.imageIO as SharpImageIO).getImageStats(topEdge);
      
      budget.take(getClock().now() - startTime);
      
      // Analyze color characteristics
      if (topStats.mean > 200) {
        return 'unknown'; // Too bright, unclear
      } else if (topStats.mean > 150) {
        return 'yellow'; // Likely yellow border
      } else {
        return 'grey'; // Likely grey/black border
      }
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Border color detection failed');
      return 'unknown';
    }
  }
  
  // Rule box detection using horizontal band analysis
  private async detectRuleBoxBand(image: Image, budget: TimeBudget): Promise<boolean> {
    const startTime = getClock().now();
    
    try {
      // Look for horizontal band in bottom third of image
      const searchStartY = Math.floor(image.height * 0.6);
      const searchHeight = Math.floor(image.height * 0.3);
      const bandRegion = await this.imageIO.crop(image, 0, searchStartY, image.width, searchHeight);
      
      // Convert to grayscale and analyze horizontal projections
      const histogram = await (this.imageIO as SharpImageIO).computeHistogram(bandRegion, 64);
      
      budget.take(getClock().now() - startTime);
      
      // Look for bimodal distribution (text on background)
      const peakCount = this.countHistogramPeaks(histogram);
      return peakCount >= 2;
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Rule box detection failed');
      return false;
    }
  }
  
  // Text density using corner detection as proxy
  private async detectTextDensity(image: Image, budget: TimeBudget): Promise<number> {
    const startTime = getClock().now();
    
    try {
      // Focus on name band area (top ~20% of card)
      const nameBandHeight = Math.floor(image.height * 0.2);
      const nameBand = await this.imageIO.crop(image, 0, 0, image.width, nameBandHeight);
      
      // Use image statistics as proxy for text complexity
      const stats = await (this.imageIO as SharpImageIO).getImageStats(nameBand);
      
      budget.take(getClock().now() - startTime);
      
      // High standard deviation indicates text/detail
      const textDensity = Math.min(1, stats.stddev / 50); // Normalize to 0-1
      return textDensity;
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Text density detection failed');
      return 0;
    }
  }
  
  // Edge logo detection in card margins
  private async detectEdgeLogos(image: Image, budget: TimeBudget): Promise<number> {
    const startTime = getClock().now();
    
    try {
      // Check left and right edges for logo patterns
      const edgeWidth = Math.floor(image.width * 0.1);
      const leftEdge = await this.imageIO.crop(image, 0, 0, edgeWidth, image.height);
      const rightEdge = await this.imageIO.crop(image, image.width - edgeWidth, 0, edgeWidth, image.height);
      
      // Analyze edge complexity
      const leftStats = await (this.imageIO as SharpImageIO).getImageStats(leftEdge);
      const rightStats = await (this.imageIO as SharpImageIO).getImageStats(rightEdge);
      
      budget.take(getClock().now() - startTime);
      
      // High variance in edges suggests logos/patterns
      const edgeComplexity = Math.max(leftStats.stddev, rightStats.stddev) / 100;
      return Math.min(1, edgeComplexity);
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Edge logo detection failed');
      return 0;
    }
  }
  
  // Delta Species symbol detection
  private async detectDeltaSymbol(image: Image, budget: TimeBudget): Promise<number> {
    const startTime = getClock().now();
    
    try {
      // Delta symbols typically appear in upper right area
      const symbolRegionW = Math.floor(image.width * 0.15);
      const symbolRegionH = Math.floor(image.height * 0.15);
      const symbolRegion = await this.imageIO.crop(image, 
        image.width - symbolRegionW, 0, symbolRegionW, symbolRegionH);
      
      const stats = await (this.imageIO as SharpImageIO).getImageStats(symbolRegion);
      
      budget.take(getClock().now() - startTime);
      
      // Delta symbols have distinctive triangular patterns
      // This is a simplified heuristic - could be improved with template matching
      const deltaLikelihood = stats.stddev > 30 ? 0.7 : 0.1;
      return deltaLikelihood;
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Delta symbol detection failed');
      return 0;
    }
  }
  
  // LV.X token detection
  private async detectLevelX(image: Image, budget: TimeBudget): Promise<boolean> {
    const startTime = getClock().now();
    
    try {
      // LV.X appears in the name area
      const nameRegionH = Math.floor(image.height * 0.15);
      const nameRegion = await this.imageIO.crop(image, 0, 0, image.width, nameRegionH);
      
      const histogram = await (this.imageIO as SharpImageIO).computeHistogram(nameRegion, 32);
      
      budget.take(getClock().now() - startTime);
      
      // LV.X has distinctive text patterns
      const complexityScore = this.calculateHistogramComplexity(histogram);
      return complexityScore > 0.6;
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'LV.X detection failed');
      return false;
    }
  }
  
  // Radiant pattern detection using frequency analysis
  private async detectRadiantPattern(image: Image, budget: TimeBudget): Promise<number> {
    const startTime = getClock().now();
    
    try {
      // Radiant cards have distinctive background patterns
      // Sample from the artwork area (center of card)
      const artworkX = Math.floor(image.width * 0.1);
      const artworkY = Math.floor(image.height * 0.25);
      const artworkW = Math.floor(image.width * 0.8);
      const artworkH = Math.floor(image.height * 0.4);
      const artworkRegion = await this.imageIO.crop(image, artworkX, artworkY, artworkW, artworkH);
      
      const stats = await (this.imageIO as SharpImageIO).getImageStats(artworkRegion);
      
      budget.take(getClock().now() - startTime);
      
      // Radiant patterns have high variance due to holographic effects
      const radiantScore = Math.min(1, stats.stddev / 60);
      return radiantScore;
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Radiant pattern detection failed');
      return 0;
    }
  }
  
  // Trainer portrait detection
  private async detectTrainerPortrait(image: Image, budget: TimeBudget): Promise<number> {
    const startTime = getClock().now();
    
    try {
      // Trainer portraits typically appear in right side of artwork
      const portraitX = Math.floor(image.width * 0.6);
      const portraitY = Math.floor(image.height * 0.2);
      const portraitW = Math.floor(image.width * 0.3);
      const portraitH = Math.floor(image.height * 0.4);
      const portraitRegion = await this.imageIO.crop(image, portraitX, portraitY, portraitW, portraitH);
      
      const histogram = await (this.imageIO as SharpImageIO).computeHistogram(portraitRegion, 64);
      
      budget.take(getClock().now() - startTime);
      
      // Faces typically have mid-tone color distributions
      const midToneRatio = this.calculateMidToneRatio(histogram);
      return Math.min(1, midToneRatio * 1.5); // Scale for better sensitivity
      
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Trainer portrait detection failed');
      return 0;
    }
  }
  
  // Utility methods for histogram analysis
  private countHistogramPeaks(histogram: number[], threshold = 0.1): number {
    const maxValue = Math.max(...histogram);
    const peakThreshold = maxValue * threshold;
    let peaks = 0;
    let inPeak = false;
    
    for (const value of histogram) {
      if (value > peakThreshold) {
        if (!inPeak) {
          peaks++;
          inPeak = true;
        }
      } else {
        inPeak = false;
      }
    }
    
    return peaks;
  }
  
  private calculateHistogramComplexity(histogram: number[]): number {
    if (histogram.length === 0) return 0;
    
    // Calculate entropy as measure of complexity
    const total = histogram.reduce((sum, val) => sum + val, 0);
    if (total === 0) return 0;
    
    let entropy = 0;
    for (const val of histogram) {
      if (val > 0) {
        const p = val / total;
        entropy -= p * Math.log2(p);
      }
    }
    
    // Normalize to 0-1 range
    const maxEntropy = Math.log2(histogram.length);
    return entropy / maxEntropy;
  }
  
  private calculateMidToneRatio(histogram: number[]): number {
    if (histogram.length === 0) return 0;
    
    const total = histogram.reduce((sum, val) => sum + val, 0);
    if (total === 0) return 0;
    
    // Focus on middle 50% of histogram (mid-tones)
    const start = Math.floor(histogram.length * 0.25);
    const end = Math.floor(histogram.length * 0.75);
    const midToneSum = histogram.slice(start, end).reduce((sum, val) => sum + val, 0);
    
    return midToneSum / total;
  }
  
  // Cache management methods
  private generateImageHash(image: Image): string {
    // Simple hash based on image dimensions and data sample
    const sampleSize = Math.min(1000, image.data.length);
    let hash = `${image.width}x${image.height}:`;
    
    for (let i = 0; i < sampleSize; i += 100) {
      hash += image.data[i].toString(16);
    }
    
    return hash;
  }
  
  private isValidCacheEntry(entry: CacheEntry): boolean {
    const maxAge = 5 * 60 * 1000; // 5 minutes
    return (Date.now() - entry.timestamp) < maxAge;
  }
  
  private cacheFeatures(imageHash: string, features: ImageFeatures): void {
    // Enforce cache size limit
    if (this.cache.size >= this.config.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(imageHash, {
      features,
      timestamp: Date.now(),
      imageHash,
    });
  }
  
  private getMinimalFeatures(image: Image): ImageFeatures {
    return {
      aspectRatio: image.width / image.height,
      borderColor: 'unknown',
      ruleBoxBand: false,
      textDensityTop: 0,
      edgeLogoSignal: 0,
      deltaSymbolSignal: 0,
      levelXToken: false,
      radiantPattern: 0,
      trainerPortraitBlob: 0,
    };
  }
  
  // Get cache statistics for monitoring
  getCacheStats(): {
    size: number;
    maxSize: number;
    hitRate?: number;
    oldestEntry?: number;
  } {
    let oldestTimestamp = Date.now();
    for (const entry of this.cache.values()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }
    
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize,
      oldestEntry: oldestTimestamp,
    };
  }
  
  // Clear cache for memory management
  clearCache(): void {
    this.cache.clear();
    logger.debug('Feature extraction cache cleared');
  }
}