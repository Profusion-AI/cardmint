import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { ImageProcessorPort, ImageProcessingOptions, ValidationOptions } from "../../core/image/ImageProcessorPort";
import { logger } from "../../utils/logger";

/**
 * OpenCV-based image processor using Python helper scripts.
 * Provides real implementation of image enhancement and validation.
 */
export class OpenCvImageProcessor implements ImageProcessorPort {
  private readonly scriptDir: string;
  
  constructor(scriptDir: string = path.join(process.cwd(), 'scripts')) {
    this.scriptDir = scriptDir;
  }
  
  async enhance(inputPath: string, _options: ImageProcessingOptions = {}): Promise<{ outputPath: string; meta: { rotation?: number } }> {
    try {
      await access(inputPath);
      
      // Call Python helper for OpenCV enhancement
      await this.execPython('opencv_enhance.py', [inputPath, inputPath]);
      
      logger.info(`Enhanced image: ${inputPath}`);
      return { outputPath: inputPath, meta: {} };
    } catch (error) {
      logger.error('Image enhancement failed:', error);
      throw new Error(`Image enhancement failed: ${error}`);
    }
  }
  
  async validate(inputPath: string, options: ValidationOptions = {}): Promise<{ ok: boolean; reasons?: string[] }> {
    try {
      await access(inputPath);
      
      // Check file stats first
      const stats = await stat(inputPath);
      if (options.maxFileSize && stats.size > options.maxFileSize) {
        return { ok: false, reasons: ['File too large'] };
      }
      
      // Call Python helper for detailed validation
      try {
        await this.execPython('opencv_validate.py', [inputPath]);
        return { ok: true };
      } catch (validationError) {
        return { 
          ok: false, 
          reasons: ['OpenCV validation failed', String(validationError)] 
        };
      }
    } catch (error) {
      return { 
        ok: false, 
        reasons: ['File access error', String(error)] 
      };
    }
  }
  
  async generateThumbnail(
    inputPath: string, 
    size: { width: number; height: number } = { width: 200, height: 280 }
  ): Promise<string> {
    const thumbnailPath = inputPath.replace(/(\.[^.]+)$/, `_thumb_${size.width}x${size.height}$1`);
    
    try {
      await this.execPython('opencv_thumbnail.py', [
        inputPath, 
        thumbnailPath, 
        String(size.width), 
        String(size.height)
      ]);
      
      return thumbnailPath;
    } catch (error) {
      logger.error('Thumbnail generation failed:', error);
      // Fallback: return original image
      return inputPath;
    }
  }
  
  async getMetadata(inputPath: string): Promise<{
    width: number;
    height: number;
    format: string;
    aspectRatio: number;
    fileSize: number;
  }> {
    try {
      const stats = await stat(inputPath);
      
      // Use Python helper to get image dimensions
      const output = await this.execPython('opencv_metadata.py', [inputPath], true);
      const metadata = JSON.parse(output);
      
      return {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        aspectRatio: metadata.width / metadata.height,
        fileSize: stats.size,
      };
    } catch (error) {
      logger.error('Metadata extraction failed:', error);
      throw new Error(`Metadata extraction failed: ${error}`);
    }
  }
  
  /**
   * Execute Python helper script
   */
  private execPython(script: string, args: string[], captureOutput = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(this.scriptDir, script);
      const pythonProcess = spawn("python3", [scriptPath, ...args], {
        stdio: captureOutput ? "pipe" : "inherit"
      });
      
      let output = "";
      
      if (captureOutput && pythonProcess.stdout) {
        pythonProcess.stdout.on("data", (data) => {
          output += data.toString();
        });
      }
      
      pythonProcess.on("exit", (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Python script ${script} exited with code ${code}`));
        }
      });
      
      pythonProcess.on("error", (error) => {
        reject(new Error(`Failed to execute ${script}: ${error}`));
      });
    });
  }
}