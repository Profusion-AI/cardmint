/**
 * Sharp-based ImageIO adapter for OS-agnostic image processing
 * 
 * Uses libvips via Sharp for high-performance image operations
 * across Linux, macOS, and Windows platforms.
 */

import sharp, { Sharp } from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';

// Platform-agnostic image interface
export interface Image {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
  format: string;
}

// Image processing operations
export interface ImageIO {
  read(imagePath: string): Promise<Image>;
  readBuffer(buffer: Buffer): Promise<Image>;
  writeDebug(outputPath: string, image: Image): Promise<void>;
  resize(image: Image, width: number, height: number): Promise<Image>;
  crop(image: Image, x: number, y: number, w: number, h: number): Promise<Image>;
  createPyramid(image: Image, levels: number[]): Promise<Image[]>;
  extractRegion(image: Image, region: { x: number; y: number; w: number; h: number }): Promise<Buffer>;
}

export class SharpImageIO implements ImageIO {
  private readonly maxDimension = 4096; // Safety limit for memory usage
  
  async read(imagePath: string): Promise<Image> {
    try {
      // Validate file exists
      await fs.access(imagePath);
      
      const sharpInstance = sharp(imagePath);
      const metadata = await sharpInstance.metadata();
      
      if (!metadata.width || !metadata.height) {
        throw new Error(`Invalid image dimensions: ${imagePath}`);
      }
      
      // Safety check for oversized images
      if (metadata.width > this.maxDimension || metadata.height > this.maxDimension) {
        throw new Error(`Image too large: ${metadata.width}x${metadata.height} exceeds ${this.maxDimension}px limit`);
      }
      
      // Convert to consistent format (RGB, 8-bit)
      const buffer = await sharpInstance
        .ensureAlpha(false)
        .toColorspace('srgb')
        .raw()
        .toBuffer();
      
      return {
        data: buffer,
        width: metadata.width,
        height: metadata.height,
        channels: 3, // RGB
        format: metadata.format || 'unknown',
      };
      
    } catch (error) {
      throw new Error(`Failed to read image ${imagePath}: ${error}`);
    }
  }
  
  async readBuffer(buffer: Buffer): Promise<Image> {
    try {
      const sharpInstance = sharp(buffer);
      const metadata = await sharpInstance.metadata();
      
      if (!metadata.width || !metadata.height) {
        throw new Error('Invalid buffer image dimensions');
      }
      
      // Safety check
      if (metadata.width > this.maxDimension || metadata.height > this.maxDimension) {
        throw new Error(`Buffer image too large: ${metadata.width}x${metadata.height}`);
      }
      
      const rawBuffer = await sharpInstance
        .ensureAlpha(false)
        .toColorspace('srgb')
        .raw()
        .toBuffer();
      
      return {
        data: rawBuffer,
        width: metadata.width,
        height: metadata.height,
        channels: 3,
        format: metadata.format || 'unknown',
      };
      
    } catch (error) {
      throw new Error(`Failed to read buffer image: ${error}`);
    }
  }
  
  async writeDebug(outputPath: string, image: Image): Promise<void> {
    try {
      // Ensure output directory exists
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });
      
      // Convert raw buffer back to PNG for debugging
      await sharp(image.data, {
        raw: {
          width: image.width,
          height: image.height,
          channels: image.channels,
        },
      })
        .png()
        .toFile(outputPath);
        
    } catch (error) {
      throw new Error(`Failed to write debug image ${outputPath}: ${error}`);
    }
  }
  
  async resize(image: Image, width: number, height: number): Promise<Image> {
    try {
      const resized = await sharp(image.data, {
        raw: {
          width: image.width,
          height: image.height,
          channels: image.channels,
        },
      })
        .resize(width, height, {
          kernel: sharp.kernel.lanczos3,
          fastShrinkOnLoad: false, // Maintain quality
        })
        .raw()
        .toBuffer();
      
      return {
        data: resized,
        width,
        height,
        channels: image.channels,
        format: image.format,
      };
      
    } catch (error) {
      throw new Error(`Failed to resize image: ${error}`);
    }
  }
  
  async crop(image: Image, x: number, y: number, w: number, h: number): Promise<Image> {
    try {
      // Clamp crop region to image bounds
      const cropX = Math.max(0, Math.floor(x));
      const cropY = Math.max(0, Math.floor(y));
      const cropW = Math.min(w, image.width - cropX);
      const cropH = Math.min(h, image.height - cropY);
      
      if (cropW <= 0 || cropH <= 0) {
        throw new Error(`Invalid crop region: ${cropX},${cropY} ${cropW}x${cropH}`);
      }
      
      const cropped = await sharp(image.data, {
        raw: {
          width: image.width,
          height: image.height,
          channels: image.channels,
        },
      })
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .raw()
        .toBuffer();
      
      return {
        data: cropped,
        width: cropW,
        height: cropH,
        channels: image.channels,
        format: image.format,
      };
      
    } catch (error) {
      throw new Error(`Failed to crop image: ${error}`);
    }
  }
  
  async createPyramid(image: Image, levels: number[] = [1.0, 0.5]): Promise<Image[]> {
    const pyramid: Image[] = [];
    
    try {
      for (const scale of levels) {
        if (scale <= 0 || scale > 1) {
          throw new Error(`Invalid pyramid scale: ${scale} (must be 0 < scale <= 1)`);
        }
        
        const scaledWidth = Math.floor(image.width * scale);
        const scaledHeight = Math.floor(image.height * scale);
        
        if (scaledWidth < 1 || scaledHeight < 1) {
          continue; // Skip invalid dimensions
        }
        
        if (scale === 1.0) {
          // Original size - just copy
          pyramid.push({ ...image });
        } else {
          // Resize for smaller scales
          const scaled = await this.resize(image, scaledWidth, scaledHeight);
          pyramid.push(scaled);
        }
      }
      
      return pyramid;
      
    } catch (error) {
      throw new Error(`Failed to create image pyramid: ${error}`);
    }
  }
  
  async extractRegion(image: Image, region: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
    try {
      const cropped = await this.crop(image, region.x, region.y, region.w, region.h);
      
      // Return as PNG buffer for caching/debugging
      const pngBuffer = await sharp(cropped.data, {
        raw: {
          width: cropped.width,
          height: cropped.height,
          channels: cropped.channels,
        },
      })
        .png({ compressionLevel: 6 }) // Balance compression vs speed
        .toBuffer();
      
      return pngBuffer;
      
    } catch (error) {
      throw new Error(`Failed to extract region: ${error}`);
    }
  }
  
  // Utility methods for performance optimization
  async getImageStats(image: Image): Promise<{
    mean: number;
    stddev: number;
    min: number;
    max: number;
  }> {
    try {
      const stats = await sharp(image.data, {
        raw: {
          width: image.width,
          height: image.height,
          channels: image.channels,
        },
      })
        .stats();
      
      // Average across channels for grayscale-like stats
      const channelStats = stats.channels[0]; // Use first channel as representative
      
      return {
        mean: channelStats.mean,
        stddev: channelStats.stdev,
        min: channelStats.min,
        max: channelStats.max,
      };
      
    } catch (error) {
      throw new Error(`Failed to compute image statistics: ${error}`);
    }
  }
  
  // Memory-efficient histogram for feature extraction
  async computeHistogram(image: Image, bins: number = 256): Promise<number[]> {
    try {
      // Convert to grayscale first for efficiency
      const grayscale = await sharp(image.data, {
        raw: {
          width: image.width,
          height: image.height,
          channels: image.channels,
        },
      })
        .greyscale()
        .raw()
        .toBuffer();
      
      // Compute histogram
      const histogram = new Array(bins).fill(0);
      const binSize = 256 / bins;
      
      for (let i = 0; i < grayscale.length; i++) {
        const binIndex = Math.floor(grayscale[i] / binSize);
        const clampedIndex = Math.min(binIndex, bins - 1);
        histogram[clampedIndex]++;
      }
      
      return histogram;
      
    } catch (error) {
      throw new Error(`Failed to compute histogram: ${error}`);
    }
  }
}