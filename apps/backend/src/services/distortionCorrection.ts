/**
 * Distortion Correction Service
 *
 * Applies barrel distortion correction to Pi5 camera captures before inference.
 * Uses OpenCV with local calibration profile (IMX477 + 6mm C-mount lens).
 * Correction is performed via Python subprocess for optimal performance.
 *
 * Performance: ~70ms for 4K images (60ms maps + 10ms remap)
 *
 * Assumptions:
 * - Python 3 with opencv-python and numpy installed
 * - Calibration profile at: data/calibration-profiles/imx477_tuned_6mm_20251010_133159.json
 * - Pi5 captures are always from IMX477 with 6mm lens (profile hash c1fc97d81bf6b32a)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const execAsync = promisify(exec);

interface DistortionCorrectionResult {
  success: boolean;
  originalImagePath: string;
  correctedImagePath?: string;
  profileHash?: string;
  processingTimeMs?: number;
  error?: string;
  errorCode?: string;
}

export class DistortionCorrectionService {
  private readonly scriptPath: string;
  private readonly outputBaseDir: string;
  private scriptReady = false;

  constructor(
    private readonly logger: Logger,
    outputDir: string = "data/corrected-images"
  ) {
    // Resolve paths relative to this file's location (handle ES modules without __dirname)
    // From: apps/backend/src/services/distortionCorrection.ts
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // -> workspace root: ../../../../scripts
    this.scriptPath = path.resolve(__dirname, "../../../../scripts/apply_distortion_correction.py");

    // -> backend root: ../.. (then relative outputDir from there)
    // This ensures paths are stable regardless of systemd/process working directory
    this.outputBaseDir = path.resolve(__dirname, "../..", outputDir);
  }

  /**
   * Initialize service: verify script and dependencies are available
   */
  async initialize(): Promise<void> {
    try {
      // Check if Python script exists
      await fs.access(this.scriptPath);

      // Check if OpenCV is available
      const { stdout } = await execAsync("python3 -c \"import cv2, numpy; print('OK')\"");
      if (!stdout.includes("OK")) {
        throw new Error("OpenCV/NumPy check failed");
      }

      this.scriptReady = true;
      this.logger.info({ scriptPath: this.scriptPath }, "Distortion correction service initialized");
    } catch (error) {
      this.logger.error(
        { err: error, scriptPath: this.scriptPath },
        "Failed to initialize distortion correction service"
      );
      this.scriptReady = false;
    }
  }

  /**
   * Apply distortion correction to a captured image
   *
   * @param imagePath - Path to input image from Pi5
   * @returns Corrected image path or error details
   */
  async correctImage(imagePath: string): Promise<DistortionCorrectionResult> {
    const startTime = Date.now();

    // Fail gracefully if service not ready - inference will use distorted image
    if (!this.scriptReady) {
      this.logger.warn(
        { imagePath },
        "Distortion correction service not ready; skipping correction"
      );
      return {
        success: false,
        originalImagePath: imagePath,
        error: "SERVICE_NOT_READY",
        errorCode: "DISTORTION_SERVICE_UNAVAILABLE",
      };
    }

    try {
      // Verify input image exists
      await fs.access(imagePath);

      // Create output directory if needed
      await fs.mkdir(this.outputBaseDir, { recursive: true });

      // Run distortion correction script
      const { stdout } = await execAsync(
        `python3 "${this.scriptPath}" --image "${imagePath}" --output "${this.outputBaseDir}"`,
        { timeout: 30_000 } // 30s timeout for image processing
      );

      // Parse result JSON from Python script
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(stdout);
      } catch (error) {
        this.logger.error(
          { err: error, stdout, imagePath },
          "Failed to parse distortion correction result"
        );
        return {
          success: false,
          originalImagePath: imagePath,
          error: "INVALID_RESULT",
          errorCode: "DISTORTION_RESULT_PARSE_FAILED",
        };
      }

      // Check for Python-side errors
      if (result.status !== "success") {
        this.logger.warn(
          { imagePath, error: result.error, message: result.message },
          "Distortion correction failed on Python side"
        );
        return {
          success: false,
          originalImagePath: imagePath,
          error: String(result.message),
          errorCode: String(result.error),
        };
      }

      const processingTime = Date.now() - startTime;

      // Ensure corrected image path is absolute for downstream consumers
      const correctedPath = String(result.output_image);
      const absoluteCorrectedPath = path.isAbsolute(correctedPath)
        ? correctedPath
        : path.resolve(process.cwd(), correctedPath);

      // Verify file actually exists before returning (defense against race conditions)
      // Python cv2.imwrite() is buffered; this ensures the file is accessible to Stage 2
      try {
        await fs.access(absoluteCorrectedPath);
      } catch (accessError) {
        this.logger.error(
          { imagePath, correctedPath: absoluteCorrectedPath, elapsed: processingTime },
          "Corrected image file not accessible after Python script completion (buffer race)"
        );
        return {
          success: false,
          originalImagePath: imagePath,
          error: "Corrected file not accessible",
          errorCode: "FILE_NOT_SYNCED",
          processingTimeMs: processingTime,
        };
      }

      this.logger.info(
        {
          imagePath,
          correctedPath: absoluteCorrectedPath,
          profileHash: result.profile_hash,
          processingMs: processingTime,
        },
        "Image distortion correction complete"
      );

      return {
        success: true,
        originalImagePath: imagePath,
        correctedImagePath: absoluteCorrectedPath,
        profileHash: String(result.profile_hash),
        processingTimeMs: processingTime,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes("ENOENT")) {
        this.logger.error({ imagePath }, "Image file not found for distortion correction");
        return {
          success: false,
          originalImagePath: imagePath,
          error: "Image not found",
          errorCode: "FILE_NOT_FOUND",
          processingTimeMs: elapsed,
        };
      }

      if (errorMsg.includes("timeout")) {
        this.logger.error({ imagePath, elapsed }, "Distortion correction timeout");
        return {
          success: false,
          originalImagePath: imagePath,
          error: "Processing timeout",
          errorCode: "DISTORTION_TIMEOUT",
          processingTimeMs: elapsed,
        };
      }

      this.logger.error(
        { err: error, imagePath, elapsed },
        "Unexpected error during distortion correction"
      );
      return {
        success: false,
        originalImagePath: imagePath,
        error: errorMsg,
        errorCode: "DISTORTION_PROCESSING_ERROR",
        processingTimeMs: elapsed,
      };
    }
  }

  /**
   * Check if service is ready to process images
   */
  isReady(): boolean {
    return this.scriptReady;
  }

  /**
   * Clean up corrected images from output directory (optional)
   * Useful for disk space management in long-running scenarios
   */
  async cleanupOldCorrectedImages(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const files = await fs.readdir(this.outputBaseDir);
      const now = Date.now();
      let deleted = 0;

      for (const file of files) {
        const filePath = path.join(this.outputBaseDir, file);
        const stat = await fs.stat(filePath);

        if (now - stat.mtimeMs > olderThanMs) {
          await fs.unlink(filePath);
          deleted++;
        }
      }

      if (deleted > 0) {
        this.logger.info(
          { dir: this.outputBaseDir, deleted, olderThanMs },
          "Cleaned up old corrected images"
        );
      }

      return deleted;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to cleanup corrected images");
      return 0;
    }
  }
}
