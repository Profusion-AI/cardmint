/**
 * Image Processing Port Interface
 * 
 * Clean abstraction for image processing operations.
 * Implementations provide concrete OpenCV, Sharp, or other processing logic.
 */

export interface ImageProcessorPort {
  /**
   * Enhance an image in place or to a derived path.
   * Returns the output path and any derived metadata (e.g., rotation).
   */
  enhance(inputPath: string): Promise<{ outputPath: string; meta: { rotation?: number } }>;

  /**
   * Lightweight, deterministic checks that gate further processing.
   * Should be fast (<100ms) and reliable.
   */
  validate(inputPath: string): Promise<{ ok: boolean; reasons?: string[] }>;
  
  /**
   * Generate a thumbnail for web display.
   * Should be optimized for fast loading and consistent sizing.
   */
  generateThumbnail(inputPath: string, size?: { width: number; height: number }): Promise<string>;
  
  /**
   * Extract basic metadata from image without heavy processing.
   */
  getMetadata(inputPath: string): Promise<{
    width: number;
    height: number;
    format: string;
    aspectRatio: number;
    fileSize: number;
  }>;
}

/**
 * Image processing configuration options
 */
export interface ImageProcessingOptions {
  quality?: number;
  denoise?: boolean;
  sharpen?: boolean;
  contrastEnhancement?: boolean;
  autoRotate?: boolean;
}

/**
 * Validation configuration
 */
export interface ValidationOptions {
  minResolution?: { width: number; height: number };
  maxFileSize?: number;
  allowedFormats?: string[];
  aspectRatioTolerance?: number;
}