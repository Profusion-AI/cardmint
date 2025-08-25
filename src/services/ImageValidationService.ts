/* TODO: Review and add specific port type imports from @core/* */
import { createHash } from 'crypto';
import sharp from 'sharp';
import * as cv from '@u4/opencv4nodejs';
import { logger } from '../utils/logger';

export interface SimilarityScore {
  structural: number;    // SSIM score
  perceptual: number;   // Perceptual hash similarity
  histogram: number;    // Color histogram comparison
  feature: number;      // Feature matching score
  overall: number;      // Weighted average
  confidence: number;   // Confidence in the comparison
}

export interface ImageFeatures {
  width: number;
  height: number;
  aspectRatio: number;
  dominantColors: Array<{ r: number; g: number; b: number; percentage: number }>;
  brightness: number;
  contrast: number;
  sharpness: number;
  hash: string;
  histogram: number[];
}

export interface QualityScore {
  overall: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  noise: number;
  issues: string[];
  isAcceptable: boolean;
}

export interface SpecialMarkers {
  hasFirstEdition: boolean;
  hasShadowless: boolean;
  hasPromoStamp: boolean;
  hasHolographic: boolean;
  hasReverseHolo: boolean;
  confidence: number;
}

export class ImageValidationService {
  private readonly MIN_QUALITY_THRESHOLD = 0.6;
  private readonly MIN_SIMILARITY_THRESHOLD = 0.7;

  constructor() {
    logger.info('Image Validation Service initialized');
  }

  /**
   * Compare two card images using multiple algorithms
   */
  async compareImages(image1: Buffer, image2: Buffer): Promise<SimilarityScore> {
    try {
      // Resize images to standard size for comparison
      const [img1Processed, img2Processed] = await Promise.all([
        this.preprocessImage(image1),
        this.preprocessImage(image2)
      ]);

      // Run multiple comparison algorithms in parallel
      const [structural, perceptual, histogram, feature] = await Promise.all([
        this.calculateSSIM(img1Processed, img2Processed),
        this.calculatePerceptualHash(img1Processed, img2Processed),
        this.compareHistograms(img1Processed, img2Processed),
        this.compareFeatures(img1Processed, img2Processed)
      ]);

      // Calculate weighted overall score
      const overall = this.calculateOverallScore({
        structural,
        perceptual,
        histogram,
        feature
      });

      // Calculate confidence based on consistency of scores
      const scores = [structural, perceptual, histogram, feature];
      const variance = this.calculateVariance(scores);
      const confidence = 1 - Math.min(variance, 1);

      const result: SimilarityScore = {
        structural,
        perceptual,
        histogram,
        feature,
        overall,
        confidence
      };

      logger.info('Image comparison completed', result);
      return result;

    } catch (error) {
      logger.error('Image comparison failed', { error });
      return {
        structural: 0,
        perceptual: 0,
        histogram: 0,
        feature: 0,
        overall: 0,
        confidence: 0
      };
    }
  }

  /**
   * Preprocess image for comparison
   */
  private async preprocessImage(imageBuffer: Buffer): Promise<cv.Mat> {
    // Convert buffer to OpenCV Mat
    const img = cv.imdecode(imageBuffer);
    
    // Resize to standard dimensions (maintain aspect ratio)
    const targetWidth = 600;
    const scale = targetWidth / img.cols;
    const targetHeight = Math.round(img.rows * scale);
    
    const resized = img.resize(targetHeight, targetWidth);
    
    // Convert to grayscale for some comparisons
    return resized;
  }

  /**
   * Calculate Structural Similarity Index (SSIM)
   */
  private async calculateSSIM(img1: cv.Mat, img2: cv.Mat): Promise<number> {
    try {
      // Convert to grayscale if not already
      const gray1 = img1.channels === 1 ? img1 : img1.cvtColor(cv.COLOR_BGR2GRAY);
      const gray2 = img2.channels === 1 ? img2 : img2.cvtColor(cv.COLOR_BGR2GRAY);

      // Calculate SSIM
      const C1 = 6.5025;  // (0.01 * 255)^2
      const C2 = 58.5225; // (0.03 * 255)^2

      // Calculate means
      const mu1 = gray1.blur(new cv.Size(11, 11));
      const mu2 = gray2.blur(new cv.Size(11, 11));

      const mu1_sq = mu1.mul(mu1);
      const mu2_sq = mu2.mul(mu2);
      const mu1_mu2 = mu1.mul(mu2);

      // Calculate variances and covariance
      const sigma1_sq = gray1.mul(gray1).blur(new cv.Size(11, 11)).sub(mu1_sq);
      const sigma2_sq = gray2.mul(gray2).blur(new cv.Size(11, 11)).sub(mu2_sq);
      const sigma12 = gray1.mul(gray2).blur(new cv.Size(11, 11)).sub(mu1_mu2);

      // Calculate SSIM
      const numerator1 = mu1_mu2.mul(2).add(C1);
      const numerator2 = sigma12.mul(2).add(C2);
      const denominator1 = mu1_sq.add(mu2_sq).add(C1);
      const denominator2 = sigma1_sq.add(sigma2_sq).add(C2);

      const ssim_map = numerator1.mul(numerator2).div(denominator1.mul(denominator2));
      
      // Calculate mean SSIM
      const mean = cv.mean(ssim_map);
      return mean.w; // Return the mean value

    } catch (error) {
      logger.error('SSIM calculation failed', { error });
      return 0;
    }
  }

  /**
   * Calculate perceptual hash similarity
   */
  private async calculatePerceptualHash(img1: cv.Mat, img2: cv.Mat): Promise<number> {
    try {
      // Resize to 32x32
      const size = 32;
      const resized1 = img1.resize(size, size);
      const resized2 = img2.resize(size, size);

      // Convert to grayscale
      const gray1 = resized1.channels === 1 ? resized1 : resized1.cvtColor(cv.COLOR_BGR2GRAY);
      const gray2 = resized2.channels === 1 ? resized2 : resized2.cvtColor(cv.COLOR_BGR2GRAY);

      // Apply DCT
      const dct1 = cv.dct(gray1.convertTo(cv.CV_32F));
      const dct2 = cv.dct(gray2.convertTo(cv.CV_32F));

      // Get low frequency components (top-left 8x8)
      const lowFreq1 = dct1.getRegion(new cv.Rect(0, 0, 8, 8));
      const lowFreq2 = dct2.getRegion(new cv.Rect(0, 0, 8, 8));

      // Calculate hash from DCT coefficients
      const mean1 = cv.mean(lowFreq1).w;
      const mean2 = cv.mean(lowFreq2).w;

      let hash1 = '';
      let hash2 = '';

      const data1 = lowFreq1.getDataAsArray();
      const data2 = lowFreq2.getDataAsArray();

      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          hash1 += data1[i][j] > mean1 ? '1' : '0';
          hash2 += data2[i][j] > mean2 ? '1' : '0';
        }
      }

      // Calculate Hamming distance
      let distance = 0;
      for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) distance++;
      }

      // Convert to similarity score
      return 1 - (distance / hash1.length);

    } catch (error) {
      logger.error('Perceptual hash calculation failed', { error });
      return 0;
    }
  }

  /**
   * Compare color histograms
   */
  private async compareHistograms(img1: cv.Mat, img2: cv.Mat): Promise<number> {
    try {
      // Ensure images are in BGR color space
      const bgr1 = img1.channels === 3 ? img1 : img1.cvtColor(cv.COLOR_GRAY2BGR);
      const bgr2 = img2.channels === 3 ? img2 : img2.cvtColor(cv.COLOR_GRAY2BGR);

      // Calculate histograms for each channel
      const histSize = 256;
      const ranges = [0, 256];
      
      const hist1_b = cv.calcHist(bgr1, [0], new cv.Mat(), [histSize], [ranges]);
      const hist1_g = cv.calcHist(bgr1, [1], new cv.Mat(), [histSize], [ranges]);
      const hist1_r = cv.calcHist(bgr1, [2], new cv.Mat(), [histSize], [ranges]);

      const hist2_b = cv.calcHist(bgr2, [0], new cv.Mat(), [histSize], [ranges]);
      const hist2_g = cv.calcHist(bgr2, [1], new cv.Mat(), [histSize], [ranges]);
      const hist2_r = cv.calcHist(bgr2, [2], new cv.Mat(), [histSize], [ranges]);

      // Normalize histograms
      hist1_b.normalize(hist1_b, 0, 1, cv.NORM_MINMAX);
      hist1_g.normalize(hist1_g, 0, 1, cv.NORM_MINMAX);
      hist1_r.normalize(hist1_r, 0, 1, cv.NORM_MINMAX);

      hist2_b.normalize(hist2_b, 0, 1, cv.NORM_MINMAX);
      hist2_g.normalize(hist2_g, 0, 1, cv.NORM_MINMAX);
      hist2_r.normalize(hist2_r, 0, 1, cv.NORM_MINMAX);

      // Compare histograms using correlation
      const corr_b = cv.compareHist(hist1_b, hist2_b, cv.HISTCMP_CORREL);
      const corr_g = cv.compareHist(hist1_g, hist2_g, cv.HISTCMP_CORREL);
      const corr_r = cv.compareHist(hist1_r, hist2_r, cv.HISTCMP_CORREL);

      // Average correlation across channels
      return (corr_b + corr_g + corr_r) / 3;

    } catch (error) {
      logger.error('Histogram comparison failed', { error });
      return 0;
    }
  }

  /**
   * Compare image features using ORB
   */
  private async compareFeatures(img1: cv.Mat, img2: cv.Mat): Promise<number> {
    try {
      // Convert to grayscale
      const gray1 = img1.channels === 1 ? img1 : img1.cvtColor(cv.COLOR_BGR2GRAY);
      const gray2 = img2.channels === 1 ? img2 : img2.cvtColor(cv.COLOR_BGR2GRAY);

      // Detect ORB features
      const orb = new cv.ORBDetector();
      const keyPoints1 = orb.detect(gray1);
      const keyPoints2 = orb.detect(gray2);

      // Compute descriptors
      const descriptors1 = orb.compute(gray1, keyPoints1);
      const descriptors2 = orb.compute(gray2, keyPoints2);

      if (!descriptors1 || !descriptors2 || 
          descriptors1.rows === 0 || descriptors2.rows === 0) {
        return 0;
      }

      // Match features using BFMatcher
      const matcher = new cv.BFMatcher(cv.NORM_HAMMING, true);
      const matches = matcher.match(descriptors1, descriptors2);

      // Filter good matches using Lowe's ratio test
      const goodMatches = matches.filter(match => match.distance < 50);

      // Calculate match score
      const matchRatio = goodMatches.length / Math.min(keyPoints1.length, keyPoints2.length);
      
      return Math.min(matchRatio, 1);

    } catch (error) {
      logger.error('Feature comparison failed', { error });
      return 0;
    }
  }

  /**
   * Extract visual features from an image
   */
  async extractFeatures(imageBuffer: Buffer): Promise<ImageFeatures> {
    try {
      const img = await sharp(imageBuffer);
      const metadata = await img.metadata();
      const stats = await img.stats();

      // Calculate dominant colors
      const { dominant } = await img
        .resize(100, 100)
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Simple dominant color extraction (can be enhanced)
      const dominantColors = this.extractDominantColors(dominant);

      // Calculate image properties
      const brightness = this.calculateBrightness(stats);
      const contrast = this.calculateContrast(stats);
      const sharpness = await this.calculateSharpness(imageBuffer);

      // Generate perceptual hash
      const hash = await this.generateImageHash(imageBuffer);

      // Extract histogram
      const histogram = this.extractHistogram(stats);

      return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        aspectRatio: (metadata.width || 1) / (metadata.height || 1),
        dominantColors,
        brightness,
        contrast,
        sharpness,
        hash,
        histogram
      };

    } catch (error) {
      logger.error('Feature extraction failed', { error });
      throw error;
    }
  }

  /**
   * Validate image quality for OCR processing
   */
  async validateImageQuality(imageBuffer: Buffer): Promise<QualityScore> {
    try {
      const features = await this.extractFeatures(imageBuffer);
      const issues: string[] = [];
      
      // Check brightness
      const brightnessScore = this.scoreBrightness(features.brightness);
      if (brightnessScore < 0.6) {
        issues.push(features.brightness < 0.5 ? 'Image too dark' : 'Image too bright');
      }

      // Check contrast
      const contrastScore = this.scoreContrast(features.contrast);
      if (contrastScore < 0.6) {
        issues.push('Low contrast');
      }

      // Check sharpness
      const sharpnessScore = this.scoreSharpness(features.sharpness);
      if (sharpnessScore < 0.6) {
        issues.push('Image blurry');
      }

      // Estimate noise level
      const noiseScore = await this.estimateNoise(imageBuffer);

      // Calculate overall score
      const overall = (brightnessScore + contrastScore + sharpnessScore + (1 - noiseScore)) / 4;

      return {
        overall,
        brightness: brightnessScore,
        contrast: contrastScore,
        sharpness: sharpnessScore,
        noise: noiseScore,
        issues,
        isAcceptable: overall >= this.MIN_QUALITY_THRESHOLD
      };

    } catch (error) {
      logger.error('Quality validation failed', { error });
      return {
        overall: 0,
        brightness: 0,
        contrast: 0,
        sharpness: 0,
        noise: 1,
        issues: ['Failed to analyze image quality'],
        isAcceptable: false
      };
    }
  }

  /**
   * Detect special edition markers in card image
   */
  async detectSpecialMarkers(imageBuffer: Buffer): Promise<SpecialMarkers> {
    try {
      const img = cv.imdecode(imageBuffer);
      
      // Define regions of interest for special markers
      const height = img.rows;
      const width = img.cols;
      
      // 1st Edition stamp is typically in bottom left
      const firstEditionROI = new cv.Rect(
        Math.floor(width * 0.05),
        Math.floor(height * 0.85),
        Math.floor(width * 0.15),
        Math.floor(height * 0.1)
      );
      
      // Extract regions
      const firstEditionRegion = img.getRegion(firstEditionROI);
      
      // Check for 1st Edition stamp (black circular stamp)
      const hasFirstEdition = await this.detectFirstEditionStamp(firstEditionRegion);
      
      // Check for shadowless characteristics
      const hasShadowless = await this.detectShadowless(img);
      
      // Check for promo stamp
      const hasPromoStamp = await this.detectPromoStamp(img);
      
      // Check for holographic pattern
      const hasHolographic = await this.detectHolographic(img);
      
      // Check for reverse holo pattern
      const hasReverseHolo = await this.detectReverseHolo(img);
      
      // Calculate confidence based on detection clarity
      const detections = [
        hasFirstEdition,
        hasShadowless,
        hasPromoStamp,
        hasHolographic,
        hasReverseHolo
      ];
      
      const confidence = detections.filter(d => d).length > 0 ? 0.8 : 0.3;
      
      return {
        hasFirstEdition,
        hasShadowless,
        hasPromoStamp,
        hasHolographic,
        hasReverseHolo,
        confidence
      };

    } catch (error) {
      logger.error('Special marker detection failed', { error });
      return {
        hasFirstEdition: false,
        hasShadowless: false,
        hasPromoStamp: false,
        hasHolographic: false,
        hasReverseHolo: false,
        confidence: 0
      };
    }
  }

  // Helper methods

  private calculateOverallScore(scores: any): number {
    // Weighted average with emphasis on structural similarity
    const weights = {
      structural: 0.35,
      perceptual: 0.25,
      histogram: 0.20,
      feature: 0.20
    };
    
    return (
      scores.structural * weights.structural +
      scores.perceptual * weights.perceptual +
      scores.histogram * weights.histogram +
      scores.feature * weights.feature
    );
  }

  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  private extractDominantColors(buffer: Buffer): any[] {
    // Simplified dominant color extraction
    // In production, use k-means clustering or similar
    return [
      { r: 255, g: 255, b: 255, percentage: 0.3 },
      { r: 200, g: 200, b: 200, percentage: 0.2 }
    ];
  }

  private calculateBrightness(stats: any): number {
    // Calculate average brightness across channels
    const channels = stats.channels;
    const totalBrightness = channels.reduce((sum: number, channel: any) => 
      sum + channel.mean, 0);
    return totalBrightness / channels.length / 255;
  }

  private calculateContrast(stats: any): number {
    // Use standard deviation as contrast measure
    const channels = stats.channels;
    const totalStdDev = channels.reduce((sum: number, channel: any) => 
      sum + channel.stdev, 0);
    return Math.min(totalStdDev / channels.length / 128, 1);
  }

  private async calculateSharpness(imageBuffer: Buffer): Promise<number> {
    try {
      const img = cv.imdecode(imageBuffer);
      const gray = img.channels === 1 ? img : img.cvtColor(cv.COLOR_BGR2GRAY);
      
      // Apply Laplacian operator
      const laplacian = gray.laplacian(cv.CV_64F);
      const variance = laplacian.mul(laplacian).mean().w;
      
      // Normalize to 0-1 range
      return Math.min(variance / 1000, 1);
    } catch (error) {
      return 0.5;
    }
  }

  private async generateImageHash(imageBuffer: Buffer): string {
    const hash = createHash('md5').update(imageBuffer).digest('hex');
    return hash;
  }

  private extractHistogram(stats: any): number[] {
    // Simplified histogram extraction
    return stats.channels.map((channel: any) => channel.mean);
  }

  private scoreBrightness(brightness: number): number {
    // Optimal brightness is around 0.5-0.7
    if (brightness < 0.3 || brightness > 0.9) return 0.3;
    if (brightness < 0.4 || brightness > 0.8) return 0.6;
    return 1.0;
  }

  private scoreContrast(contrast: number): number {
    // Higher contrast is generally better for OCR
    if (contrast < 0.2) return 0.3;
    if (contrast < 0.4) return 0.6;
    return 1.0;
  }

  private scoreSharpness(sharpness: number): number {
    // Higher sharpness is better
    if (sharpness < 0.3) return 0.3;
    if (sharpness < 0.5) return 0.6;
    return 1.0;
  }

  private async estimateNoise(imageBuffer: Buffer): Promise<number> {
    try {
      const img = cv.imdecode(imageBuffer);
      const gray = img.channels === 1 ? img : img.cvtColor(cv.COLOR_BGR2GRAY);
      
      // Apply median filter and calculate difference
      const denoised = gray.medianBlur(5);
      const diff = gray.absdiff(denoised);
      const noise = cv.mean(diff).w / 255;
      
      return Math.min(noise * 10, 1);
    } catch (error) {
      return 0.5;
    }
  }

  private async detectFirstEditionStamp(region: cv.Mat): Promise<boolean> {
    try {
      // Convert to grayscale
      const gray = region.channels === 1 ? region : region.cvtColor(cv.COLOR_BGR2GRAY);
      
      // Look for circular black region
      const circles = gray.houghCircles(cv.HOUGH_GRADIENT, 1, 20, 100, 30, 10, 30);
      
      return circles.length > 0;
    } catch (error) {
      return false;
    }
  }

  private async detectShadowless(img: cv.Mat): Promise<boolean> {
    // Shadowless cards have no drop shadow on the right edge
    // This is a simplified check
    try {
      const height = img.rows;
      const width = img.cols;
      
      // Check right edge for shadow
      const rightEdge = img.getRegion(new cv.Rect(
        width - 20,
        Math.floor(height * 0.2),
        20,
        Math.floor(height * 0.6)
      ));
      
      const gray = rightEdge.channels === 1 ? rightEdge : rightEdge.cvtColor(cv.COLOR_BGR2GRAY);
      const mean = cv.mean(gray).w;
      
      // Shadowless cards have brighter right edges
      return mean > 200;
    } catch (error) {
      return false;
    }
  }

  private async detectPromoStamp(img: cv.Mat): Promise<boolean> {
    // Look for promo star or stamp
    // Basic implementation for promo detection
    return false;
  }

  private async detectHolographic(img: cv.Mat): Promise<boolean> {
    try {
      // Check for rainbow/prismatic patterns in artwork area
      const height = img.rows;
      const width = img.cols;
      
      // Artwork region (middle of card)
      const artworkRegion = img.getRegion(new cv.Rect(
        Math.floor(width * 0.1),
        Math.floor(height * 0.2),
        Math.floor(width * 0.8),
        Math.floor(height * 0.4)
      ));
      
      // Convert to HSV to detect rainbow patterns
      const hsv = artworkRegion.cvtColor(cv.COLOR_BGR2HSV);
      const channels = hsv.split();
      
      // High variance in hue channel indicates holographic
      const hueStdDev = channels[0].mean().w;
      
      return hueStdDev > 30;
    } catch (error) {
      return false;
    }
  }

  private async detectReverseHolo(img: cv.Mat): Promise<boolean> {
    // Reverse holos have holographic background but not artwork
    // This is a simplified check
    return false;
  }
}

// Singleton instance
export const imageValidationService = ports.validate;