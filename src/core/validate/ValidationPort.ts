/**
 * ValidationPort - Interface for image validation operations
 * Defines the contract for image comparison and quality assessment
 */

export interface ImageSimilarityResult {
  overall: number;
  ssim?: number;
  perceptual?: number;
  histogram?: number;
  features?: number;
}

export interface ImageQualityResult {
  isValid: boolean;
  score: number;
  issues: string[];
  brightness?: number;
  contrast?: number;
  sharpness?: number;
}

export interface ValidationPort {
  /**
   * Compare two images for similarity using multiple algorithms
   */
  compareImages(image1Path: string, image2Path: string): Promise<ImageSimilarityResult>;
  
  /**
   * Validate image quality for OCR processing
   */
  validateImageQuality(imagePath: string): Promise<ImageQualityResult>;
  
  /**
   * Health check for validation service
   */
  healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }>;
}