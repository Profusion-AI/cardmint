import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('image-resize');

export interface ResizeConfig {
  name: string;
  width: number;
  quality: number;
  format: 'jpeg' | 'webp' | 'png';
  directory: string;
}

export interface ResizeResult {
  originalSize: number;
  resizedSize: number;
  width: number;
  height: number;
  format: string;
  path: string;
  compressionRatio: number;
  processingTimeMs: number;
}

export class ImageResizeService {
  private readonly configs: ResizeConfig[] = [
    {
      name: 'dashboard',
      width: 800,
      quality: 85,
      format: 'jpeg',
      directory: 'web/thumbnails'
    },
    {
      name: 'qwen',
      width: 1280,
      quality: 90,
      format: 'jpeg',
      directory: 'scans'
    },
    {
      name: 'thumb',
      width: 200,
      quality: 75,
      format: 'jpeg',
      directory: 'web/cache'
    },
    {
      name: 'webp_dashboard',
      width: 800,
      quality: 80,
      format: 'webp',
      directory: 'web/webp'
    }
  ];

  private readonly baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = baseDir;
  }

  /**
   * Process a captured image through all resize configurations
   */
  async processCapture(
    inputPath: string,
    filename?: string
  ): Promise<Map<string, ResizeResult>> {
    const startTime = Date.now();
    
    if (!filename) {
      filename = path.basename(inputPath, path.extname(inputPath));
    }

    logger.info(`Processing image: ${inputPath} -> ${filename}`);

    // Get original image info
    const originalStats = await fs.stat(inputPath);
    const originalSize = originalStats.size;

    // Load image once for all operations
    const baseImage = sharp(inputPath);
    const metadata = await baseImage.metadata();

    logger.debug(`Original image: ${metadata.width}x${metadata.height}, ${(originalSize / 1024 / 1024).toFixed(1)}MB`);

    const results = new Map<string, ResizeResult>();

    // Process each resize configuration
    for (const config of this.configs) {
      try {
        const result = await this.resizeImage(
          baseImage.clone(),
          config,
          filename,
          originalSize
        );
        results.set(config.name, result);
      } catch (error) {
        logger.error(`Failed to resize ${filename} for ${config.name}:`, error);
      }
    }

    const totalTime = Date.now() - startTime;
    logger.info(`Processed ${filename} in ${totalTime}ms, generated ${results.size} sizes`);

    return results;
  }

  /**
   * Test different resolutions for ML processing optimization
   */
  async testResolutions(
    inputPath: string,
    testSizes: number[] = [640, 800, 1024, 1280, 1600, 1920, 2560]
  ): Promise<Map<number, ResizeResult>> {
    const startTime = Date.now();
    const filename = path.basename(inputPath, path.extname(inputPath));
    
    logger.info(`Testing resolutions for ML optimization: ${inputPath}`);

    const originalStats = await fs.stat(inputPath);
    const originalSize = originalStats.size;
    const baseImage = sharp(inputPath);

    const results = new Map<number, ResizeResult>();

    for (const width of testSizes) {
      try {
        const config: ResizeConfig = {
          name: `test_${width}`,
          width,
          quality: 85,
          format: 'jpeg',
          directory: 'resize-tests'
        };

        const result = await this.resizeImage(
          baseImage.clone(),
          config,
          `${filename}_${width}`,
          originalSize
        );

        results.set(width, result);
      } catch (error) {
        logger.error(`Failed to test resolution ${width}:`, error);
      }
    }

    const totalTime = Date.now() - startTime;
    logger.info(`Tested ${testSizes.length} resolutions in ${totalTime}ms`);

    return results;
  }

  /**
   * Resize image according to configuration
   */
  private async resizeImage(
    image: sharp.Sharp,
    config: ResizeConfig,
    filename: string,
    originalSize: number
  ): Promise<ResizeResult> {
    const startTime = Date.now();

    // Ensure output directory exists
    const outputDir = path.join(this.baseDir, config.directory);
    await fs.mkdir(outputDir, { recursive: true });

    // Generate output filename
    const ext = config.format === 'jpeg' ? 'jpg' : config.format;
    const outputPath = path.join(outputDir, `${filename}.${ext}`);

    // Configure Sharp pipeline
    let pipeline = image
      .resize(config.width, null, {
        withoutEnlargement: true,
        fit: 'inside',
        kernel: sharp.kernel.lanczos3  // High-quality resampling
      });

    // Apply format-specific optimizations
    switch (config.format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({
          quality: config.quality,
          progressive: true,
          mozjpeg: true  // Use mozjpeg for better compression
        });
        break;
      case 'webp':
        pipeline = pipeline.webp({
          quality: config.quality,
          effort: 6,  // Max compression effort
          smartSubsample: true
        });
        break;
      case 'png':
        pipeline = pipeline.png({
          compressionLevel: 9,
          effort: 10
        });
        break;
    }

    // Process and save
    const info = await pipeline.toFile(outputPath);
    
    const processingTime = Date.now() - startTime;
    const resizedStats = await fs.stat(outputPath);
    const compressionRatio = (1 - (resizedStats.size / originalSize)) * 100;

    const result: ResizeResult = {
      originalSize,
      resizedSize: resizedStats.size,
      width: info.width,
      height: info.height,
      format: info.format,
      path: outputPath,
      compressionRatio,
      processingTimeMs: processingTime
    };

    logger.debug(`${config.name}: ${info.width}x${info.height} ${(resizedStats.size / 1024).toFixed(0)}KB (${compressionRatio.toFixed(1)}% savings) in ${processingTime}ms`);

    return result;
  }

  /**
   * Generate optimal image for Qwen VLM processing
   */
  async prepareForQwen(inputPath: string): Promise<ResizeResult> {
    const filename = path.basename(inputPath, path.extname(inputPath));
    const originalStats = await fs.stat(inputPath);
    
    const config: ResizeConfig = {
      name: 'qwen_optimized',
      width: 1280,  // Optimal balance of detail vs processing speed
      quality: 92,  // High quality for ML accuracy
      format: 'jpeg',
      directory: 'scans'
    };

    const image = sharp(inputPath);
    const result = await this.resizeImage(image, config, filename, originalStats.size);

    logger.info(`Prepared ${filename} for Qwen: ${result.width}x${result.height} ${(result.resizedSize / 1024).toFixed(0)}KB`);

    return result;
  }

  /**
   * Create web-optimized thumbnails for dashboard
   */
  async createWebThumbnails(inputPath: string): Promise<Map<string, ResizeResult>> {
    const filename = path.basename(inputPath, path.extname(inputPath));
    const originalStats = await fs.stat(inputPath);
    const baseImage = sharp(inputPath);

    const webConfigs: ResizeConfig[] = [
      {
        name: 'dashboard_jpeg',
        width: 800,
        quality: 85,
        format: 'jpeg',
        directory: 'web/thumbnails'
      },
      {
        name: 'dashboard_webp',
        width: 800,
        quality: 80,
        format: 'webp',
        directory: 'web/thumbnails'
      },
      {
        name: 'grid_thumb',
        width: 200,
        quality: 75,
        format: 'jpeg',
        directory: 'web/cache'
      }
    ];

    const results = new Map<string, ResizeResult>();

    for (const config of webConfigs) {
      try {
        const result = await this.resizeImage(
          baseImage.clone(),
          config,
          filename,
          originalStats.size
        );
        results.set(config.name, result);
      } catch (error) {
        logger.error(`Failed to create web thumbnail ${config.name}:`, error);
      }
    }

    return results;
  }

  /**
   * Get storage efficiency report
   */
  async getStorageReport(directory: string): Promise<{
    totalFiles: number;
    totalSize: number;
    averageSize: number;
    formats: Map<string, { count: number; size: number }>;
  }> {
    const dirPath = path.join(this.baseDir, directory);
    
    try {
      const files = await fs.readdir(dirPath);
      const formats = new Map<string, { count: number; size: number }>();
      let totalSize = 0;
      let totalFiles = 0;

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isFile()) {
          const ext = path.extname(file).toLowerCase().slice(1);
          
          if (!formats.has(ext)) {
            formats.set(ext, { count: 0, size: 0 });
          }
          
          const format = formats.get(ext)!;
          format.count++;
          format.size += stats.size;
          
          totalSize += stats.size;
          totalFiles++;
        }
      }

      return {
        totalFiles,
        totalSize,
        averageSize: totalFiles > 0 ? totalSize / totalFiles : 0,
        formats
      };
    } catch (error) {
      logger.error(`Failed to generate storage report for ${directory}:`, error);
      throw error;
    }
  }
}

// Utility function for CLI usage
export async function optimizeImageForML(inputPath: string, outputDir?: string): Promise<ResizeResult> {
  const resizer = new ImageResizeService(outputDir);
  return await resizer.prepareForQwen(inputPath);
}