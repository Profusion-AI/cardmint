import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const logger = createLogger('signal-extractor');

export interface EdgeSignals {
  nickScore: number;           // Normalized 0-100, lower is better
  discontinuities: number;     // Count of edge breaks
  protrusions: number;         // Count of edge bumps
  edgeLengthRatio: number;    // Actual/expected edge length
}

export interface SurfaceSignals {
  scratchScore: number;        // Normalized 0-100, lower is better  
  scratchCount: number;        // Number of detected scratches
  scratchLengthHist: number[]; // Histogram of scratch lengths
  glossVariance: number;       // Variance in surface reflectivity
  microScratchDensity: number; // Density of fine scratches
}

export interface CenteringSignals {
  topOffset: number;          // Distance from top edge to border
  bottomOffset: number;       // Distance from bottom edge to border
  leftOffset: number;         // Distance from left edge to border
  rightOffset: number;        // Distance from right edge to border
  centeringScore: number;     // Overall centering score 0-100
}

export interface CornerSignals {
  topLeftSharpness: number;    // Corner curvature metric
  topRightSharpness: number;
  bottomLeftSharpness: number;
  bottomRightSharpness: number;
  averageSharpness: number;
  minSharpness: number;
}

export interface SignalExtractionResult {
  edges: EdgeSignals;
  surface: SurfaceSignals;
  centering: CenteringSignals;
  corners: CornerSignals;
  overallQuality: number;      // Composite score 0-100
  processingTimeMs: number;
}

export class SignalExtractor {
  private readonly EDGE_BAND_WIDTH = 20; // pixels
  private readonly CORNER_RADIUS = 30;   // pixels for corner analysis
  
  constructor() {
    logger.info('Signal extractor initialized');
  }
  
  async extractSignals(
    normalizedImagePath: string,
    sweepImages?: string[]
  ): Promise<SignalExtractionResult> {
    const startTime = Date.now();
    
    try {
      logger.debug(`Extracting signals from ${normalizedImagePath}`);
      
      // Extract edge signals
      const edges = await this.extractEdgeSignals(normalizedImagePath);
      
      // Extract surface signals (enhanced with sweep if available)
      const surface = sweepImages 
        ? await this.extractSurfaceSignalsWithSweep(normalizedImagePath, sweepImages)
        : await this.extractSurfaceSignals(normalizedImagePath);
      
      // Extract centering signals
      const centering = await this.extractCenteringSignals(normalizedImagePath);
      
      // Extract corner signals
      const corners = await this.extractCornerSignals(normalizedImagePath);
      
      // Calculate overall quality score
      const overallQuality = this.calculateOverallQuality(edges, surface, centering, corners);
      
      const processingTimeMs = Date.now() - startTime;
      
      logger.info(`Signals extracted in ${processingTimeMs}ms`);
      
      return {
        edges,
        surface,
        centering,
        corners,
        overallQuality,
        processingTimeMs,
      };
      
    } catch (error) {
      logger.error('Signal extraction failed:', error);
      throw error;
    }
  }
  
  private async extractEdgeSignals(imagePath: string): Promise<EdgeSignals> {
    // In production: Use OpenCV for edge analysis
    logger.debug('Extracting edge signals');
    
    // 1. Extract perimeter band (EDGE_BAND_WIDTH pixels wide)
    // 2. Run Canny edge detection on perimeter
    // 3. Analyze edge continuity
    // 4. Count discontinuities (gaps in edge)
    // 5. Count protrusions (bumps extending beyond expected line)
    // 6. Calculate total edge length vs expected
    
    // Mock implementation
    const discontinuities = 2;
    const protrusions = 1;
    const expectedEdgeLength = 2 * (1536 + 2144); // Perimeter of standard card
    const actualEdgeLength = expectedEdgeLength * 0.98; // Slight wear
    
    const nickScore = this.calculateNickScore(discontinuities, protrusions);
    
    return {
      nickScore,
      discontinuities,
      protrusions,
      edgeLengthRatio: actualEdgeLength / expectedEdgeLength,
    };
  }
  
  private calculateNickScore(discontinuities: number, protrusions: number): number {
    // Scoring formula: penalize based on defect count and size
    const baseScore = 100;
    const discontinuityPenalty = discontinuities * 5;
    const protrusionPenalty = protrusions * 3;
    
    const score = Math.max(0, baseScore - discontinuityPenalty - protrusionPenalty);
    return score;
  }
  
  private async extractSurfaceSignals(imagePath: string): Promise<SurfaceSignals> {
    logger.debug('Extracting surface signals');
    
    // In production: Use classical CV for scratch detection
    // 1. Apply directional filters to detect linear features
    // 2. Use line segment detector
    // 3. Filter for scratch-like features
    // 4. Calculate density and length distribution
    
    // Mock implementation
    const scratchCount = 3;
    const scratchLengthHist = [5, 2, 1, 0, 0]; // Bins: [0-20px, 20-40px, 40-60px, 60-80px, 80+px]
    const glossVariance = 12.5;
    const microScratchDensity = 0.02; // scratches per square pixel
    
    const scratchScore = this.calculateScratchScore(scratchCount, scratchLengthHist);
    
    return {
      scratchScore,
      scratchCount,
      scratchLengthHist,
      glossVariance,
      microScratchDensity,
    };
  }
  
  private async extractSurfaceSignalsWithSweep(
    mainImage: string,
    sweepImages: string[]
  ): Promise<SurfaceSignals> {
    logger.debug(`Extracting surface signals with ${sweepImages.length} sweep images`);
    
    // Enhanced surface analysis using multiple lighting angles
    // 1. Calculate difference maps between sweep frames
    // 2. Identify areas with high variance (likely scratches/defects)
    // 3. Apply line segment detection on difference maps
    // 4. Aggregate scratch information across all angles
    
    const differenceMaps = await this.calculateDifferenceMaps(sweepImages);
    const scratchMap = await this.aggregateScratchMaps(differenceMaps);
    
    // Extract metrics from aggregate scratch map
    const scratchCount = 5; // More scratches detected with sweep
    const scratchLengthHist = [8, 4, 2, 1, 0];
    const glossVariance = 18.3; // Higher variance detected
    const microScratchDensity = 0.035;
    
    const scratchScore = this.calculateScratchScore(scratchCount, scratchLengthHist);
    
    return {
      scratchScore,
      scratchCount,
      scratchLengthHist,
      glossVariance,
      microScratchDensity,
    };
  }
  
  private async calculateDifferenceMaps(sweepImages: string[]): Promise<any[]> {
    // In production: Calculate pixel-wise differences between sweep frames
    const maps = [];
    
    for (let i = 1; i < sweepImages.length; i++) {
      // Difference between consecutive frames
      maps.push({ frame1: i - 1, frame2: i, difference: 'calculated' });
    }
    
    return maps;
  }
  
  private async aggregateScratchMaps(differenceMaps: any[]): Promise<any> {
    // In production: Combine difference maps to create aggregate scratch map
    return { aggregated: true, mapCount: differenceMaps.length };
  }
  
  private calculateScratchScore(count: number, lengthHist: number[]): number {
    const baseScore = 100;
    
    // Penalize based on scratch count
    const countPenalty = count * 3;
    
    // Penalize more for longer scratches
    let lengthPenalty = 0;
    for (let i = 0; i < lengthHist.length; i++) {
      lengthPenalty += lengthHist[i] * (i + 1) * 2;
    }
    
    const score = Math.max(0, baseScore - countPenalty - lengthPenalty);
    return score;
  }
  
  private async extractCenteringSignals(imagePath: string): Promise<CenteringSignals> {
    logger.debug('Extracting centering signals');
    
    // In production: Measure card position relative to image borders
    // After perspective rectification, measure uniform border widths
    
    // Mock implementation (in pixels)
    const topOffset = 15;
    const bottomOffset = 17;
    const leftOffset = 14;
    const rightOffset = 16;
    
    // Calculate centering score based on variance
    const targetOffset = 15;
    const offsets = [topOffset, bottomOffset, leftOffset, rightOffset];
    const variance = offsets.reduce((sum, offset) => {
      return sum + Math.pow(offset - targetOffset, 2);
    }, 0) / offsets.length;
    
    const centeringScore = Math.max(0, 100 - variance * 10);
    
    return {
      topOffset,
      bottomOffset,
      leftOffset,
      rightOffset,
      centeringScore,
    };
  }
  
  private async extractCornerSignals(imagePath: string): Promise<CornerSignals> {
    logger.debug('Extracting corner signals');
    
    // In production: Analyze corner regions for damage/wear
    // 1. Extract corner regions (CORNER_RADIUS x CORNER_RADIUS)
    // 2. Fit ideal corner curve
    // 3. Measure deviation from ideal
    // 4. Calculate curvature metrics
    
    // Mock implementation (0-100, 100 = perfect sharp corner)
    const topLeftSharpness = 95;
    const topRightSharpness = 92;
    const bottomLeftSharpness = 88;
    const bottomRightSharpness = 90;
    
    const corners = [topLeftSharpness, topRightSharpness, bottomLeftSharpness, bottomRightSharpness];
    const averageSharpness = corners.reduce((a, b) => a + b) / corners.length;
    const minSharpness = Math.min(...corners);
    
    return {
      topLeftSharpness,
      topRightSharpness,
      bottomLeftSharpness,
      bottomRightSharpness,
      averageSharpness,
      minSharpness,
    };
  }
  
  private calculateOverallQuality(
    edges: EdgeSignals,
    surface: SurfaceSignals,
    centering: CenteringSignals,
    corners: CornerSignals
  ): number {
    // Weighted average of all signals
    const weights = {
      edges: 0.25,
      surface: 0.35,
      centering: 0.15,
      corners: 0.25,
    };
    
    const edgeScore = edges.nickScore;
    const surfaceScore = surface.scratchScore;
    const centerScore = centering.centeringScore;
    const cornerScore = corners.averageSharpness;
    
    const weightedScore = 
      edgeScore * weights.edges +
      surfaceScore * weights.surface +
      centerScore * weights.centering +
      cornerScore * weights.corners;
    
    return Math.round(weightedScore);
  }
  
  async saveSignals(signals: SignalExtractionResult, outputPath: string): Promise<void> {
    await fs.writeFile(outputPath, JSON.stringify(signals, null, 2));
    logger.debug(`Signals saved to ${outputPath}`);
  }
  
  // Helper method for batch processing
  async extractSignalsBatch(
    imagePaths: string[],
    outputDir: string
  ): Promise<SignalExtractionResult[]> {
    const results: SignalExtractionResult[] = [];
    
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];
      const signals = await this.extractSignals(imagePath);
      
      const outputPath = path.join(outputDir, `signals_${i.toString().padStart(3, '0')}.json`);
      await this.saveSignals(signals, outputPath);
      
      results.push(signals);
    }
    
    return results;
  }
  
  // Analysis helper for comparing signals across multiple cards
  analyzeSignalDistribution(signalResults: SignalExtractionResult[]): {
    mean: Partial<SignalExtractionResult>;
    std: Partial<SignalExtractionResult>;
    percentiles: { p25: number; p50: number; p75: number; p95: number };
  } {
    // Calculate statistics across all signal results
    const overallQualities = signalResults.map(s => s.overallQuality);
    
    const mean = overallQualities.reduce((a, b) => a + b) / overallQualities.length;
    const variance = overallQualities.reduce((sum, q) => sum + Math.pow(q - mean, 2), 0) / overallQualities.length;
    const std = Math.sqrt(variance);
    
    const sorted = [...overallQualities].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    
    return {
      mean: { overallQuality: mean },
      std: { overallQuality: std },
      percentiles: { p25, p50, p75, p95 },
    };
  }
}