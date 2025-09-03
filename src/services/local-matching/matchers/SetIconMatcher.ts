/**
 * SetIconMatcher - High-performance ZNCC template matching for set icons
 * Implements Zero-mean Normalized Cross-Correlation with multi-scale testing
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import { createCanvas, loadImage, Image } from 'canvas';
import { createLogger } from '../../../utils/logger';
import type { Matcher, MatchResult, MatchCandidate } from '../types';
import { roiRegistry } from '../ROIRegistry';
import { createPerformanceLogger } from '../../../utils/localMatchingMetrics';

const logger = createLogger('SetIconMatcher');

interface SetIconTemplate {
  setCode: string;
  rawImage: Image;
  contrastImage: Image;
  rawStats: ImageStats;
  contrastStats: ImageStats;
  scales: number[];
  nccThreshold: number;
}

interface ImageStats {
  mean: number;
  stdDev: number;
  width: number;
  height: number;
}

interface ZNCCResult {
  correlation: number;
  setCode: string;
  scale: number;
  templateType: 'raw' | 'contrast';
  location: { x: number; y: number };
}

interface SetIconManifest {
  [setCode: string]: {
    icon_path: string;
    contrast_path: string;
    scales: number[];
    ncc_threshold: number;
  };
}

export class SetIconMatcher implements Matcher {
  readonly name = 'set_icon' as const;
  
  private templates = new Map<string, SetIconTemplate>();
  private manifest: SetIconManifest | null = null;
  private initialized = false;
  private warmupComplete = false;

  constructor(
    private readonly dataRoot: string = process.env.DATA_ROOT || './data',
    private readonly earlyExitThreshold = parseFloat(process.env.ZNCC_EARLY_EXIT || '0.90'),
    private readonly defaultNccThreshold = parseFloat(process.env.SET_ICON_NCC_THRESH || '0.78')
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    const perfLogger = createPerformanceLogger('SetIconMatcher.initialize');
    
    try {
      logger.info('Initializing SetIconMatcher with ZNCC...');
      
      // Load manifest
      const manifestPath = path.join(this.dataRoot, 'set_icons', 'manifest.json');
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      this.manifest = JSON.parse(manifestData) as SetIconManifest;
      
      logger.info(`Loaded manifest with ${Object.keys(this.manifest).length} set icons`);
      
      // Preload all templates with stats computation
      await this.preloadTemplates();
      
      // Warm up with dummy inference
      if (process.env.OCR_WARMUP === 'true') {
        await this.warmUp();
      }
      
      this.initialized = true;
      const initTime = perfLogger.end({ templatesLoaded: this.templates.size });
      
      logger.info(`SetIconMatcher initialized successfully`, {
        templatesLoaded: this.templates.size,
        initTimeMs: initTime,
        earlyExitThreshold: this.earlyExitThreshold
      });
      
    } catch (error) {
      perfLogger.end({ error: true });
      logger.error('Failed to initialize SetIconMatcher:', error);
      throw error;
    }
  }

  private async preloadTemplates(): Promise<void> {
    if (!this.manifest) throw new Error('Manifest not loaded');
    
    const loadPromises = Object.entries(this.manifest).map(async ([setCode, config]) => {
      try {
        // Load raw and contrast images
        const rawImage = await loadImage(config.icon_path);
        const contrastImage = await loadImage(config.contrast_path);
        
        // Compute image statistics for ZNCC
        const rawStats = this.computeImageStats(rawImage);
        const contrastStats = this.computeImageStats(contrastImage);
        
        const template: SetIconTemplate = {
          setCode,
          rawImage,
          contrastImage,
          rawStats,
          contrastStats,
          scales: config.scales,
          nccThreshold: config.ncc_threshold
        };
        
        this.templates.set(setCode, template);
        
      } catch (error) {
        logger.warn(`Failed to load template for ${setCode}:`, error);
      }
    });
    
    await Promise.all(loadPromises);
  }

  private computeImageStats(image: Image): ImageStats {
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    const pixels = imageData.data;
    
    let sum = 0;
    let pixelCount = 0;
    
    // Convert to grayscale and compute mean
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      sum += gray;
      pixelCount++;
    }
    
    const mean = sum / pixelCount;
    
    // Compute standard deviation
    let variance = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      variance += Math.pow(gray - mean, 2);
    }
    
    const stdDev = Math.sqrt(variance / pixelCount);
    
    return {
      mean,
      stdDev,
      width: image.width,
      height: image.height
    };
  }

  private async warmUp(): Promise<void> {
    if (this.warmupComplete) return;
    
    try {
      logger.debug('Warming up SetIconMatcher...');
      
      // Create a dummy 64x64 test image
      const testCanvas = createCanvas(64, 64);
      const testCtx = testCanvas.getContext('2d');
      testCtx.fillStyle = '#888';
      testCtx.fillRect(0, 0, 64, 64);
      
      // Run dummy ZNCC to warm up the engine
      const testImage = testCanvas.toBuffer();
      await this.performTemplateMatching(testImage, []);
      
      this.warmupComplete = true;
      logger.debug('SetIconMatcher warmup completed');
      
    } catch (error) {
      logger.warn('SetIconMatcher warmup failed:', error);
      // Don't fail initialization for warmup issues
    }
  }

  async match(imagePath: string, imageBuffer?: Buffer): Promise<MatchResult> {
    if (!this.initialized) await this.initialize();
    
    const perfLogger = createPerformanceLogger('SetIconMatcher.match');
    const scanId = path.basename(imagePath, path.extname(imagePath));
    
    try {
      // Load target image
      const targetBuffer = imageBuffer || await fs.readFile(imagePath);
      
      // Try ROI-constrained search first for speed/recall
      try {
        const meta = await sharp(targetBuffer).metadata();
        const imgW = meta.width || 0;
        const imgH = meta.height || 0;
        if (imgW > 0 && imgH > 0) {
          const { rois } = await roiRegistry.getScaledROIs(imgW, imgH);
          const r = rois.set_icon;
          if (r.width > 0 && r.height > 0) {
            return await this.matchWithinROI(imagePath, targetBuffer, r);
          }
        }
      } catch (e) {
        logger.debug('ROI-constrained set icon search skipped:', e);
      }

      // Get hints from filename/context if available
      const hints = this.extractHints(imagePath);
      
      // Perform template matching with optional hint optimization
      const results = await this.performTemplateMatching(targetBuffer, hints);
      
      // Find best match
      const bestMatch = this.findBestMatch(results);
      
      const matchTime = perfLogger.end({
        templatesChecked: results.length,
        bestCorrelation: bestMatch?.correlation || 0,
        earlyExit: bestMatch?.correlation > this.earlyExitThreshold
      });
      
      if (bestMatch && bestMatch.correlation >= bestMatch.template.nccThreshold) {
        const candidate: MatchCandidate = {
          canonical_key: `${bestMatch.setCode}|*|*|*`, // Set identified, other parts TBD
          confidence: bestMatch.correlation,
          metadata: {
            set_code: bestMatch.setCode,
            correlation: bestMatch.correlation,
            scale: bestMatch.scale,
            template_type: bestMatch.templateType,
            early_exit: bestMatch.correlation > this.earlyExitThreshold,
            location: bestMatch.location
          }
        };
        
        return {
          matched: true,
          confidence: bestMatch.correlation,
          best_candidate: candidate,
          all_candidates: [candidate],
          processing_time_ms: matchTime,
          cached: false,
          metadata: {
            zncc_results: results.length,
            best_scale: bestMatch.scale,
            template_type: bestMatch.templateType
          }
        };
      }
      
      // No match found
      return {
        matched: false,
        confidence: bestMatch?.correlation || 0,
        processing_time_ms: matchTime,
        cached: false,
        metadata: {
          zncc_results: results.length,
          best_correlation: bestMatch?.correlation || 0,
          threshold: this.defaultNccThreshold
        }
      };
      
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      logger.error(`SetIconMatcher failed for ${scanId}:`, error);
      
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: String(error) }
      };
    }
  }

  /**
   * Match within a provided ROI rectangle to speed up ZNCC and improve recall.
   * The ROI should already be scaled to the image dimensions.
   */
  async matchWithinROI(
    imagePath: string,
    imageBuffer: Buffer | undefined,
    roi: { x: number; y: number; width: number; height: number }
  ): Promise<MatchResult> {
    if (!this.initialized) await this.initialize();

    const perfLogger = createPerformanceLogger('SetIconMatcher.matchWithinROI');
    const scanId = path.basename(imagePath, path.extname(imagePath));
    try {
      // Load image buffer
      const fullBuffer = imageBuffer || await fs.readFile(imagePath);

      // Crop to ROI using sharp
      const roiBuffer = await sharp(fullBuffer)
        .extract({
          left: Math.max(0, Math.round(roi.x)),
          top: Math.max(0, Math.round(roi.y)),
          width: Math.max(1, Math.round(roi.width)),
          height: Math.max(1, Math.round(roi.height)),
        })
        .png()
        .toBuffer();

      // Run template matching within ROI
      const results = await this.performTemplateMatching(roiBuffer, []);
      const bestMatch = this.findBestMatch(results);

      const matchTime = perfLogger.end({
        templatesChecked: results.length,
        bestCorrelation: bestMatch?.correlation || 0,
        earlyExit: bestMatch?.correlation > this.earlyExitThreshold,
        roi: `${roi.x},${roi.y},${roi.width}x${roi.height}`
      });

      if (bestMatch && bestMatch.correlation >= bestMatch.template.nccThreshold) {
        const candidate: MatchCandidate = {
          canonical_key: `${bestMatch.setCode}|*|*|*`,
          confidence: bestMatch.correlation,
          metadata: {
            set_code: bestMatch.setCode,
            correlation: bestMatch.correlation,
            scale: bestMatch.scale,
            template_type: bestMatch.templateType,
            early_exit: bestMatch.correlation > this.earlyExitThreshold,
            location: bestMatch.location,
            roi
          }
        } as any;

        return {
          matched: true,
          confidence: bestMatch.correlation,
          best_candidate: candidate as any,
          all_candidates: [candidate as any],
          processing_time_ms: matchTime,
          cached: false,
          metadata: {
            zncc_results: results.length,
            best_scale: bestMatch.scale,
            template_type: bestMatch.templateType,
            roi
          }
        } as any;
      }

      return {
        matched: false,
        confidence: bestMatch?.correlation || 0,
        processing_time_ms: matchTime,
        cached: false,
        metadata: {
          zncc_results: results.length,
          best_correlation: bestMatch?.correlation || 0,
          threshold: this.defaultNccThreshold,
          roi
        }
      } as any;
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      logger.error(`SetIconMatcher.matchWithinROI failed for ${scanId}:`, error);
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: String(error) }
      } as any;
    }
  }

  private extractHints(imagePath: string): string[] {
    // Extract potential set hints from filename or path
    const filename = path.basename(imagePath, path.extname(imagePath)).toLowerCase();
    const hints: string[] = [];
    
    // Common set code patterns in filenames
    const patterns = [
      /base(\d+|p)/,     // base1, base2, basep
      /neo(\d+)/,        // neo1, neo2, neo3, neo4
      /pop(\d+)/,        // pop1, pop2, etc
      /mcd[_-]?(\d{4})/  // mcd2019, mcd_2019
    ];
    
    for (const pattern of patterns) {
      const match = filename.match(pattern);
      if (match) {
        hints.push(match[0]);
      }
    }
    
    return hints;
  }

  private async performTemplateMatching(
    targetBuffer: Buffer, 
    hints: string[]
  ): Promise<Array<ZNCCResult & { template: SetIconTemplate }>> {
    const results: Array<ZNCCResult & { template: SetIconTemplate }> = [];
    
    // Load target image
    const targetImage = await loadImage(targetBuffer);
    const targetCanvas = createCanvas(targetImage.width, targetImage.height);
    const targetCtx = targetCanvas.getContext('2d');
    targetCtx.drawImage(targetImage, 0, 0);
    
    // Define ROI for set icon (top-right area typically)
    const roiX = Math.floor(targetImage.width * 0.7);
    const roiY = Math.floor(targetImage.height * 0.05);
    const roiW = Math.floor(targetImage.width * 0.25);
    const roiH = Math.floor(targetImage.height * 0.15);
    
    const roiImageData = targetCtx.getImageData(roiX, roiY, roiW, roiH);
    
    // Prioritize templates based on hints
    const templateOrder = this.prioritizeTemplates(hints);
    
    for (const [setCode, template] of templateOrder) {
      // Test both raw and contrast versions
      const templateTypes: Array<{ image: Image; stats: ImageStats; type: 'raw' | 'contrast' }> = [
        { image: template.rawImage, stats: template.rawStats, type: 'raw' },
        { image: template.contrastImage, stats: template.contrastStats, type: 'contrast' }
      ];
      
      for (const templateData of templateTypes) {
        for (const scale of template.scales) {
          const result = this.computeZNCC(
            roiImageData,
            templateData.image,
            templateData.stats,
            scale
          );
          
          if (result) {
            results.push({
              ...result,
              setCode,
              templateType: templateData.type,
              scale,
              template
            });
            
            // Early exit if we find a very high confidence match
            if (result.correlation > this.earlyExitThreshold) {
              logger.debug(`Early exit triggered for ${setCode} with correlation ${result.correlation}`);
              return results;
            }
          }
        }
      }
    }
    
    return results;
  }

  private prioritizeTemplates(hints: string[]): Array<[string, SetIconTemplate]> {
    const allTemplates = Array.from(this.templates.entries());
    
    if (hints.length === 0) {
      return allTemplates;
    }
    
    // Move hinted templates to the front
    const prioritized: Array<[string, SetIconTemplate]> = [];
    const remaining: Array<[string, SetIconTemplate]> = [];
    
    for (const [setCode, template] of allTemplates) {
      if (hints.some(hint => setCode.includes(hint) || hint.includes(setCode))) {
        prioritized.push([setCode, template]);
      } else {
        remaining.push([setCode, template]);
      }
    }
    
    return [...prioritized, ...remaining];
  }

  private computeZNCC(
    targetImageData: ImageData,
    templateImage: Image,
    templateStats: ImageStats,
    scale: number
  ): ZNCCResult | null {
    try {
      // Scale template
      const scaledWidth = Math.round(templateStats.width * scale);
      const scaledHeight = Math.round(templateStats.height * scale);
      
      // Check if scaled template fits in ROI
      if (scaledWidth > targetImageData.width || scaledHeight > targetImageData.height) {
        return null;
      }
      
      // Create scaled template
      const templateCanvas = createCanvas(scaledWidth, scaledHeight);
      const templateCtx = templateCanvas.getContext('2d');
      templateCtx.drawImage(templateImage, 0, 0, scaledWidth, scaledHeight);
      const templateImageData = templateCtx.getImageData(0, 0, scaledWidth, scaledHeight);
      
      let bestCorrelation = -1;
      let bestLocation = { x: 0, y: 0 };
      
      // Slide template across ROI
      const maxX = targetImageData.width - scaledWidth;
      const maxY = targetImageData.height - scaledHeight;
      const stepSize = Math.max(1, Math.floor(Math.min(scaledWidth, scaledHeight) / 8));
      
      for (let y = 0; y <= maxY; y += stepSize) {
        for (let x = 0; x <= maxX; x += stepSize) {
          const correlation = this.computeZNCCAtPosition(
            targetImageData,
            templateImageData,
            x, y,
            scaledWidth,
            scaledHeight,
            templateStats.mean * (scale * scale), // Adjust mean for scaling
            templateStats.stdDev * scale
          );
          
          if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLocation = { x, y };
          }
        }
      }
      
      return {
        correlation: bestCorrelation,
        location: bestLocation,
        setCode: '', // Will be filled by caller
        scale,
        templateType: 'raw' // Will be filled by caller
      };
      
    } catch (error) {
      logger.debug('ZNCC computation failed:', error);
      return null;
    }
  }

  private computeZNCCAtPosition(
    target: ImageData,
    template: ImageData,
    offsetX: number,
    offsetY: number,
    templateWidth: number,
    templateHeight: number,
    templateMean: number,
    templateStdDev: number
  ): number {
    let targetSum = 0;
    let targetSumSq = 0;
    let crossCorr = 0;
    let pixelCount = 0;
    
    // Compute correlation components
    for (let ty = 0; ty < templateHeight; ty++) {
      for (let tx = 0; tx < templateWidth; tx++) {
        const targetX = offsetX + tx;
        const targetY = offsetY + ty;
        
        if (targetX >= target.width || targetY >= target.height) continue;
        
        // Get grayscale values
        const targetIdx = (targetY * target.width + targetX) * 4;
        const templateIdx = (ty * template.width + tx) * 4;
        
        const targetGray = 0.299 * target.data[targetIdx] + 
                          0.587 * target.data[targetIdx + 1] + 
                          0.114 * target.data[targetIdx + 2];
        
        const templateGray = 0.299 * template.data[templateIdx] + 
                           0.587 * template.data[templateIdx + 1] + 
                           0.114 * template.data[templateIdx + 2];
        
        targetSum += targetGray;
        targetSumSq += targetGray * targetGray;
        crossCorr += targetGray * templateGray;
        pixelCount++;
      }
    }
    
    if (pixelCount === 0) return -1;
    
    // Compute ZNCC
    const targetMean = targetSum / pixelCount;
    const targetVariance = (targetSumSq / pixelCount) - (targetMean * targetMean);
    const targetStdDev = Math.sqrt(Math.max(0, targetVariance));
    
    if (targetStdDev === 0 || templateStdDev === 0) return -1;
    
    const numerator = (crossCorr / pixelCount) - (targetMean * templateMean);
    const denominator = targetStdDev * templateStdDev;
    
    return numerator / denominator;
  }

  private findBestMatch(results: Array<ZNCCResult & { template: SetIconTemplate }>): 
    (ZNCCResult & { template: SetIconTemplate }) | null {
    
    if (results.length === 0) return null;
    
    // Sort by correlation descending
    results.sort((a, b) => b.correlation - a.correlation);
    
    return results[0];
  }

  isReady(): boolean {
    return this.initialized && this.templates.size > 0;
  }

  getStats(): Record<string, any> {
    return {
      initialized: this.initialized,
      templatesLoaded: this.templates.size,
      warmupComplete: this.warmupComplete,
      earlyExitThreshold: this.earlyExitThreshold,
      defaultThreshold: this.defaultNccThreshold
    };
  }
}

// Export a singleton for lightweight API/testing usage
export const setIconMatcher = new SetIconMatcher();
