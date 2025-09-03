/**
 * Phase 6.2 ROI Runtime Execution Engine
 * 
 * Provides Budget management and LazyRoiRunner for tier-based progressive
 * ROI evaluation with ≤50ms budget enforcement and early termination.
 */

import { 
  RoiTier, 
  RoiSpec, 
  TemplateVariation, 
  ImageFeatures, 
  CandidateScore, 
  EvaluationThresholds, 
  DEFAULT_THRESHOLDS,
  DEFAULT_BUDGET_MS,
  AbsoluteCoordinate,
  PercentageCoordinate,
} from './types';
import { Image, ImageIO } from '../platform/imageio/sharp';
import { getClock, TimeBudget } from '../platform/clock/perf';
import { createROILogger } from '../platform/logger/pino';

const logger = createROILogger('runtime');

// Worker pool configuration based on platform
export interface WorkerPoolConfig {
  maxWorkers: number;
  platform: 'fedora-hp' | 'mac-m4' | 'pi5' | 'generic';
  enableOptimizations: boolean;
}

// ROI scoring result for individual ROIs
export interface ROIScore {
  roiId: string;
  confidence: number;
  technique: 'ocr' | 'zncc' | 'pattern' | 'edge' | 'histogram';
  processingMs: number;
  scale: number; // 1.0 or 0.5 for pyramid optimization
}

// Batch scoring result for a tier
export interface TierScoreResult {
  tier: RoiTier;
  scores: Map<string, number>;
  totalMs: number;
  roiCount: number;
  cacheHits: number;
}

// Budget management class with microsecond precision
export class Budget {
  private readonly startTime: number;
  private spent = 0;
  private readonly clock = getClock();
  
  constructor(private readonly totalMs: number) {
    this.startTime = this.clock.now();
  }
  
  take(ms: number): void {
    this.spent += ms;
  }
  
  get remains(): number {
    return Math.max(0, this.totalMs - this.spent);
  }
  
  get msUsed(): number {
    return this.spent;
  }
  
  get msTotal(): number {
    return this.totalMs;
  }
  
  get isExhausted(): boolean {
    return this.spent >= this.totalMs;
  }
  
  get elapsedReal(): number {
    return this.clock.now() - this.startTime;
  }
  
  // Safety check for runaway operations
  checkRealTime(): boolean {
    const realElapsed = this.elapsedReal;
    if (realElapsed > this.totalMs * 2) {
      logger.warn({
        budgetMs: this.totalMs,
        spentMs: this.spent,
        realElapsedMs: realElapsed,
      }, 'Real time significantly exceeds budget - possible performance issue');
      return false;
    }
    return true;
  }
  
  // Create a sub-budget for a specific operation
  allocate(ms: number): Budget {
    const available = Math.min(ms, this.remains);
    this.take(available);
    return new Budget(available);
  }
}

// Lazy ROI runner with tier-based evaluation
export class LazyRoiRunner {
  private readonly tiers: RoiTier[];
  private readonly thresholds: EvaluationThresholds;
  private scoreCache = new Map<string, ROIScore>();
  private coordCache = new Map<string, AbsoluteCoordinate>();
  
  constructor(
    private readonly imageIO: ImageIO,
    options: {
      tiers?: RoiTier[];
      thresholds?: Partial<EvaluationThresholds>;
      enableCaching?: boolean;
    } = {}
  ) {
    this.tiers = options.tiers || ["CRITICAL", "STANDARD", "DETAILED", "OPTIONAL"];
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }
  
  async run(
    template: TemplateVariation,
    image: Image,
    features: ImageFeatures,
    budget: Budget
  ): Promise<CandidateScore> {
    const clock = getClock();
    const startTime = clock.now();
    
    const used: string[] = [];
    const perRoi: Record<string, number> = {};
    let fused = 0;
    let highestTier: RoiTier = "CRITICAL";
    
    logger.debug({
      templateId: template.id,
      budgetMs: budget.msTotal,
      imageSize: `${image.width}x${image.height}`,
    }, 'Starting lazy ROI evaluation');
    
    try {
      // Process each tier progressively
      for (const tier of this.tiers) {
        if (budget.isExhausted || !budget.checkRealTime()) {
          logger.warn({
            tier,
            budgetUsed: budget.msUsed,
            budgetRemaining: budget.remains,
          }, 'Budget exhausted, stopping evaluation');
          break;
        }
        
        // Get ROIs for this tier with condition filtering
        const tierROIs = this.getROIsForTier(template, tier, features);
        
        if (tierROIs.length === 0) {
          logger.trace({ tier, templateId: template.id }, 'No ROIs for tier, skipping');
          continue;
        }
        
        // Score ROIs for this tier
        const tierBudget = budget.allocate(Math.min(budget.remains, 20)); // Max 20ms per tier
        const tierResult = await this.scoreROIsTier(tierROIs, image, tierBudget);
        
        highestTier = tier;
        
        // Update results
        for (const [roiId, score] of tierResult.scores) {
          perRoi[roiId] = score;
          used.push(roiId);
        }
        
        // Compute fused score
        fused = this.fuseScores(tierResult.scores, this.computeQualityWeights(image, tierROIs, features));
        
        logger.debug({
          tier,
          roiCount: tierROIs.length,
          fusedScore: fused,
          tierMs: tierResult.totalMs,
          budgetRemaining: budget.remains,
        }, 'Tier evaluation complete');
        
        // Early termination conditions
        if (fused >= this.thresholds.accept) {
          logger.info({
            templateId: template.id,
            fusedScore: fused,
            tier,
            acceptThreshold: this.thresholds.accept,
          }, 'Early termination: confidence threshold reached');
          break;
        }
        
        if (fused >= this.thresholds.tryNextTier && budget.remains > 5) {
          // Continue to next tier
          continue;
        }
        
        if (fused < this.thresholds.tryNextTier) {
          logger.debug({
            fusedScore: fused,
            threshold: this.thresholds.tryNextTier,
          }, 'Score too low, stopping evaluation');
          break;
        }
      }
      
      const totalMs = clock.now() - startTime;
      
      const result: CandidateScore = {
        templateId: template.id,
        fused,
        usedRois: used,
        perRoi,
        msSpent: totalMs,
        tier: highestTier,
      };
      
      logger.info({
        templateId: template.id,
        fusedScore: fused,
        roiCount: used.length,
        highestTier,
        totalMs,
      }, 'ROI evaluation complete');
      
      return result;
      
    } catch (error) {
      logger.error({
        templateId: template.id,
        error: error instanceof Error ? error.message : String(error),
        budgetUsed: budget.msUsed,
      }, 'ROI evaluation failed');
      
      // Return minimal result for error recovery
      return {
        templateId: template.id,
        fused: 0,
        usedRois: used,
        perRoi,
        msSpent: clock.now() - startTime,
        tier: highestTier,
      };
    }
  }
  
  private getROIsForTier(
    template: TemplateVariation,
    tier: RoiTier,
    features: ImageFeatures
  ): RoiSpec[] {
    const allROIs = [
      ...template.coreROIs.rois,
      ...template.eraSpecificROIs.rois,
    ];
    
    return allROIs.filter(roi => {
      // Filter by tier
      if (roi.tier !== tier) return false;
      
      // Apply condition filter
      if (roi.condition && !roi.condition(features)) {
        logger.trace({ roiId: roi.id, tier }, 'ROI filtered out by condition');
        return false;
      }
      
      return true;
    });
  }
  
  private async scoreROIsTier(
    rois: RoiSpec[],
    image: Image,
    budget: Budget
  ): Promise<TierScoreResult> {
    const scores = new Map<string, number>();
    const startTime = getClock().now();
    let cacheHits = 0;
    
    for (const roi of rois) {
      if (budget.isExhausted) {
        logger.debug({ roiId: roi.id }, 'Budget exhausted, skipping remaining ROIs');
        break;
      }
      
      try {
        // Check cache first
        const cacheKey = `${roi.id}:${image.width}x${image.height}`;
        const cached = this.scoreCache.get(cacheKey);
        
        if (cached && cached.confidence > 0) {
          scores.set(roi.id, cached.confidence);
          cacheHits++;
          budget.take(0.1); // Minimal cache access cost
          continue;
        }
        
        // Score the ROI
        const roiScore = await this.scoreROI(roi, image, budget.allocate(5)); // Max 5ms per ROI
        scores.set(roi.id, roiScore.confidence);
        
        // Cache the result
        this.scoreCache.set(cacheKey, roiScore);
        
        // Enforce cache size limit (LRU by clearing oldest entries)
        if (this.scoreCache.size > 1000) {
          const firstKey = this.scoreCache.keys().next().value;
          this.scoreCache.delete(firstKey);
        }
        
      } catch (error) {
        logger.warn({
          roiId: roi.id,
          error: error instanceof Error ? error.message : String(error),
        }, 'ROI scoring failed, using zero confidence');
        
        scores.set(roi.id, 0);
      }
    }
    
    const totalMs = getClock().now() - startTime;
    
    return {
      tier: rois[0]?.tier || "CRITICAL",
      scores,
      totalMs,
      roiCount: rois.length,
      cacheHits,
    };
  }
  
  private async scoreROI(roi: RoiSpec, image: Image, budget: Budget): Promise<ROIScore> {
    const startTime = getClock().now();
    
    try {
      // Convert percentage coordinates to absolute
      const absCoord = this.toAbsolute(roi.coords, image);
      
      // Extract ROI region (with pyramid optimization for certain roles)
      const useHalfScale = this.shouldUseHalfScale(roi.role);
      const scale = useHalfScale ? 0.5 : 1.0;
      
      let regionImage: Image;
      if (useHalfScale) {
        // Resize image first, then extract
        const scaled = await this.imageIO.resize(image, 
          Math.floor(image.width * 0.5), 
          Math.floor(image.height * 0.5)
        );
        const scaledCoord = {
          x: Math.floor(absCoord.x * 0.5),
          y: Math.floor(absCoord.y * 0.5),
          w: Math.floor(absCoord.w * 0.5),
          h: Math.floor(absCoord.h * 0.5),
        };
        regionImage = await this.imageIO.crop(scaled, scaledCoord.x, scaledCoord.y, scaledCoord.w, scaledCoord.h);
      } else {
        regionImage = await this.imageIO.crop(image, absCoord.x, absCoord.y, absCoord.w, absCoord.h);
      }
      
      // Score based on ROI role
      let confidence: number;
      let technique: ROIScore['technique'];
      
      switch (roi.role) {
        case 'text':
        case 'name_band':
          confidence = await this.scoreText(regionImage);
          technique = 'ocr';
          break;
        case 'symbol':
        case 'set_symbol':
          confidence = await this.scoreSymbol(regionImage);
          technique = 'zncc';
          break;
        case 'pattern':
        case 'rulebox':
          confidence = await this.scorePattern(regionImage);
          technique = 'pattern';
          break;
        case 'edge_logo':
        case 'art_border':
          confidence = await this.scoreEdges(regionImage);
          technique = 'edge';
          break;
        default:
          confidence = await this.scoreGeneric(regionImage);
          technique = 'histogram';
      }
      
      const processingMs = getClock().now() - startTime;
      budget.take(processingMs);
      
      return {
        roiId: roi.id,
        confidence: Math.max(0, Math.min(1, confidence)),
        technique,
        processingMs,
        scale,
      };
      
    } catch (error) {
      const processingMs = getClock().now() - startTime;
      budget.take(processingMs);
      
      logger.warn({
        roiId: roi.id,
        error: error instanceof Error ? error.message : String(error),
        processingMs,
      }, 'ROI scoring failed');
      
      return {
        roiId: roi.id,
        confidence: 0,
        technique: 'histogram',
        processingMs,
        scale: 1.0,
      };
    }
  }
  
  private toAbsolute(coords: PercentageCoordinate, image: Image): AbsoluteCoordinate {
    const cacheKey = `${coords.x},${coords.y},${coords.w},${coords.h}:${image.width}x${image.height}`;
    const cached = this.coordCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }
    
    const absolute: AbsoluteCoordinate = {
      x: Math.floor(coords.x * image.width),
      y: Math.floor(coords.y * image.height),
      w: Math.floor(coords.w * image.width),
      h: Math.floor(coords.h * image.height),
    };
    
    // Cache with size limit
    if (this.coordCache.size > 500) {
      const firstKey = this.coordCache.keys().next().value;
      this.coordCache.delete(firstKey);
    }
    
    this.coordCache.set(cacheKey, absolute);
    return absolute;
  }
  
  private shouldUseHalfScale(role: RoiSpec['role']): boolean {
    // These roles can be scored accurately at 0.5x scale
    return ['symbol', 'set_symbol', 'edge_logo', 'art_border', 'pattern'].includes(role);
  }
  
  // Placeholder scoring methods (to be implemented with feature extraction pipeline)
  private async scoreText(image: Image): Promise<number> {
    // TODO: Implement OCR-based text scoring
    return 0.5;
  }
  
  private async scoreSymbol(image: Image): Promise<number> {
    // TODO: Implement ZNCC template matching
    return 0.5;
  }
  
  private async scorePattern(image: Image): Promise<number> {
    // TODO: Implement pattern recognition
    return 0.5;
  }
  
  private async scoreEdges(image: Image): Promise<number> {
    // TODO: Implement edge detection scoring
    return 0.5;
  }
  
  private async scoreGeneric(image: Image): Promise<number> {
    // TODO: Implement histogram-based scoring
    return 0.5;
  }
  
  private fuseScores(
    scores: Map<string, number>,
    weights: Map<string, number>
  ): number {
    if (scores.size === 0) return 0;
    
    let totalWeightedScore = 0;
    let totalWeight = 0;
    
    for (const [roiId, score] of scores) {
      const weight = weights.get(roiId) || 1.0;
      totalWeightedScore += score * weight;
      totalWeight += weight;
    }
    
    return totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
  }
  
  private computeQualityWeights(
    image: Image,
    rois: RoiSpec[],
    features: ImageFeatures
  ): Map<string, number> {
    const weights = new Map<string, number>();
    
    for (const roi of rois) {
      let weight = roi.weights.base;
      
      // Adjust weight based on image quality
      if (features.aspectRatio < 0.9 || features.aspectRatio > 1.1) {
        weight *= 0.9; // Penalize non-square aspect ratios slightly
      }
      
      if (features.borderColor === 'unknown') {
        weight *= 0.95; // Penalize unclear borders
      }
      
      // Apply maximum weight cap
      if (roi.weights.max !== undefined) {
        weight = Math.min(weight, roi.weights.max);
      }
      
      weights.set(roi.id, Math.max(0.1, weight)); // Minimum weight to avoid zeros
    }
    
    return weights;
  }
  
  // Clear caches for memory management
  clearCaches(): void {
    this.scoreCache.clear();
    this.coordCache.clear();
    logger.debug('ROI caches cleared');
  }
  
  // Get cache statistics
  getCacheStats(): {
    scoreCache: { size: number; hitRate?: number };
    coordCache: { size: number };
  } {
    return {
      scoreCache: { 
        size: this.scoreCache.size,
        // hitRate would need request counting to implement
      },
      coordCache: { 
        size: this.coordCache.size,
      },
    };
  }
}