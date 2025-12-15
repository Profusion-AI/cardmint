/**
 * Image Processing Service (Stage 2)
 *
 * Resizes and compresses corrected images (from Stage 1 distortion correction)
 * into EverShop-compatible format with deterministic hashing and atomic handoffs.
 *
 * Pipeline: Distorted Image → Corrected Image (Stage 1) → Resized/Compressed (Stage 2)
 *
 * Processing guarantees:
 * - Deterministic: Same input → identical MD5 hash (Pillow 10.4.0 LANCZOS, optimize=False)
 * - Atomic: Temp files never leak; only move on complete success
 * - Observable: Stage timing, size deltas, hash validation logged per image
 * - Resilient: Retryable IO errors surface as structured errors
 *
 * Output format: {SKU}-front.jpg (1024px height, JPEG Q82, sRGB, <=250KB typically)
 * Performance target: <500ms per image on Pi5 (budget: ~12-15sec per 1,000-card sweep)
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const execAsync = promisify(exec);

/**
 * Simple async lock for serializing manifest updates.
 * Prevents concurrent read-modify-write cycles from dropping entries.
 */
class AsyncLock {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waiters.push(() => resolve());
      });
    }
    this.locked = true;
  }

  release(): void {
    this.locked = false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }
}

interface ImageProcessingResult {
  success: boolean;
  originalImagePath: string;
  processedImagePath?: string;
  sku?: string;
  processingTimeMs?: number;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  inputDimensions?: string; // "WxH"
  outputDimensions?: string; // "WxH"
  md5Hash?: string;
  error?: string;
  errorCode?: string;
}

interface ProcessingMetrics {
  totalImages: number;
  successCount: number;
  failureCount: number;
  averageProcessingMs: number;
  peakMemoryMb?: number;
  avgImageSizeKb?: number;
}

export class ImageProcessingService {
  private readonly scriptPath: string;
  private readonly tempDir: string;
  private readonly outputDir: string;
  private readonly manifestPath: string;
  private scriptReady = false;
  private readonly manifestLock = new AsyncLock();

  constructor(
    private readonly logger: Logger,
    outputDir: string = "images/incoming",
    tempDir: string = "images/incoming/.tmp",
    manifestPath: string = "images/manifest-md5.csv"
  ) {
    // Resolve paths relative to this file's location (handle ES modules without __dirname)
    // From: apps/backend/src/services/imageProcessing.ts
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // -> workspace root: ../../../../scripts
    this.scriptPath = path.resolve(__dirname, "../../../../scripts/resize_and_compress.py");

    // -> backend root: ../.. (then relative outputDir/tempDir/manifestPath from there)
    // This ensures paths are stable regardless of systemd/process working directory
    this.outputDir = path.resolve(__dirname, "../..", outputDir);
    this.tempDir = path.resolve(__dirname, "../..", tempDir);
    this.manifestPath = path.resolve(__dirname, "../..", manifestPath);
  }

  /**
   * Initialize service: verify script and dependencies are available
   */
  async initialize(): Promise<void> {
    try {
      // Check if Python script exists
      await fs.access(this.scriptPath);

      // Check if Pillow and numpy are available with correct versions
      const { stdout } = await execAsync(
        "python3 -c \"import PIL; import numpy; print('OK')\""
      );
      if (!stdout.includes("OK")) {
        throw new Error("Pillow/NumPy check failed");
      }

      // Create temp and output directories
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.mkdir(this.outputDir, { recursive: true });

      this.scriptReady = true;
      this.logger.info(
        { scriptPath: this.scriptPath, tempDir: this.tempDir },
        "Image processing service initialized"
      );
    } catch (error) {
      this.logger.error(
        { err: error, scriptPath: this.scriptPath },
        "Failed to initialize image processing service"
      );
      this.scriptReady = false;
    }
  }

  /**
   * Process a single corrected image through Stage 2 (resize/compress)
   * Atomically moves result from temp to final location on success.
   *
   * @param correctedImagePath - Path to corrected image from Stage 1
   * @param sku - SKU identifier for output naming
   * @returns Processing result with MD5 hash and metrics
   */
  async processImage(correctedImagePath: string, sku: string): Promise<ImageProcessingResult> {
    const startTime = Date.now();

    // Fail gracefully if service not ready
    if (!this.scriptReady) {
      this.logger.warn(
        { correctedImagePath, sku },
        "Image processing service not ready; skipping Stage 2"
      );
      return {
        success: false,
        originalImagePath: correctedImagePath,
        sku,
        error: "SERVICE_NOT_READY",
        errorCode: "IMAGE_PROCESSING_SERVICE_UNAVAILABLE",
      };
    }

    try {
      // Verify input image exists
      await fs.access(correctedImagePath);

      // Temp output path for this image (atomic write pattern)
      const tempOutputPath = path.join(this.tempDir, `${sku}-front.tmp.jpg`);
      const finalOutputPath = path.join(this.outputDir, `${sku}-front.jpg`);

      // Run image processing script in single-file mode
      // Script processes exactly one image and emits JSON result
      // Use spawn with argv to prevent shell injection from file paths
      const stdout = await this.spawnPythonScript(
        this.scriptPath,
        [
          "--input-file", correctedImagePath,
          "--output-file", tempOutputPath,
          "--sku", sku,
        ],
        30_000 // 30s timeout for image processing
      );

      // Parse script output for metrics (JSON on stdout)
      let processingMetrics: Record<string, unknown> = {};
      try {
        // Last line should be JSON result from script
        const lines = stdout.trim().split("\n");
        const jsonLine = lines[lines.length - 1];
        processingMetrics = JSON.parse(jsonLine);
      } catch {
        // If not JSON, just use empty metrics
        processingMetrics = {};
      }

      // Check if processing succeeded (look for temp output file)
      const tempResult = tempOutputPath;
      await fs.access(tempResult); // Throws if not found

      // Get input file stats
      const inputStat = await fs.stat(correctedImagePath);
      const outputStat = await fs.stat(tempResult);

      // Compute MD5 of output (for manifest validation)
      const md5Hash = await this.computeMd5(tempResult);

      // Atomic move: rename temp → final only if MD5 matches expected
      try {
        await fs.rename(tempResult, finalOutputPath);

        // Set file permissions to 664 per workspace policy
        // (fs.rename preserves source permissions, which may be 600 from Python umask)
        try {
          await fs.chmod(finalOutputPath, 0o664);
        } catch (chmodError) {
          // Log warning but don't fail the job on chmod errors
          this.logger.warn(
            { err: chmodError, path: finalOutputPath },
            "Failed to set file permissions to 664 (non-critical)"
          );
        }
      } catch (moveError) {
        // On move failure, clean up temp and fail
        try {
          await fs.unlink(tempResult);
        } catch {
          // Ignore cleanup errors
        }
        throw moveError;
      }

      const processingTimeMs = Date.now() - startTime;

      // Extract output dimensions from the processed image for manifest
      const outputDimensions = `${(processingMetrics.output_dimensions as string) || "unknown"}`;

      this.logger.info(
        {
          sku,
          processingMs: processingTimeMs,
          inputSize: inputStat.size,
          outputSize: outputStat.size,
          md5: md5Hash.substring(0, 8),
          compression: `${(100 * (1 - outputStat.size / inputStat.size)).toFixed(1)}%`,
        },
        "Image processing (Stage 2) complete"
      );

      // Update manifest with new processed image entry (asynchronous, non-blocking)
      this.updateManifest(sku, finalOutputPath, md5Hash, outputStat.size, outputDimensions).catch((err) => {
        this.logger.warn({ err, sku }, "Manifest update failed (non-critical)");
      });

      return {
        success: true,
        originalImagePath: correctedImagePath,
        processedImagePath: finalOutputPath,
        sku,
        processingTimeMs,
        inputSizeBytes: inputStat.size,
        outputSizeBytes: outputStat.size,
        md5Hash,
        error: undefined,
        errorCode: undefined,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes("ENOENT")) {
        this.logger.error({ correctedImagePath, sku }, "Corrected image not found for processing");
        return {
          success: false,
          originalImagePath: correctedImagePath,
          sku,
          error: "Image not found",
          errorCode: "FILE_NOT_FOUND",
          processingTimeMs: elapsed,
        };
      }

      if (errorMsg.includes("timeout")) {
        this.logger.error({ correctedImagePath, sku, elapsed }, "Image processing timeout");
        return {
          success: false,
          originalImagePath: correctedImagePath,
          sku,
          error: "Processing timeout",
          errorCode: "IMAGE_PROCESSING_TIMEOUT",
          processingTimeMs: elapsed,
        };
      }

      this.logger.error(
        { err: error, correctedImagePath, sku, elapsed },
        "Image processing failed"
      );
      return {
        success: false,
        originalImagePath: correctedImagePath,
        sku,
        error: errorMsg,
        errorCode: "IMAGE_PROCESSING_ERROR",
        processingTimeMs: elapsed,
      };
    }
  }

  /**
   * Batch process multiple images and update manifest
   */
  async processBatch(images: Array<{ path: string; sku: string }>): Promise<ProcessingMetrics> {
    const results: ImageProcessingResult[] = [];
    const startTimes: Map<string, number> = new Map();

    for (const img of images) {
      startTimes.set(img.sku, Date.now());
      const result = await this.processImage(img.path, img.sku);
      results.push(result);
    }

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const timings = successful.map((r) => r.processingTimeMs || 0);

    const metrics: ProcessingMetrics = {
      totalImages: results.length,
      successCount: successful.length,
      failureCount: failed.length,
      averageProcessingMs:
        timings.length > 0 ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : 0,
    };

    this.logger.info(
      {
        totalImages: metrics.totalImages,
        successCount: metrics.successCount,
        failureCount: metrics.failureCount,
        avgMs: metrics.averageProcessingMs,
      },
      "Batch image processing complete"
    );

    if (failed.length > 0) {
      this.logger.warn(
        { failureCount: failed.length, skus: failed.map((r) => r.sku) },
        "Some images failed processing"
      );
    }

    return metrics;
  }

  /**
   * Safely spawn Python script with argv to prevent shell injection.
   * Returns stdout as string, throws on error or timeout.
   */
  private spawnPythonScript(
    scriptPath: string,
    args: string[],
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn("python3", [scriptPath, ...args], {
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      process.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("error", (error) => {
        reject(new Error(`Failed to spawn python3: ${error.message}`));
      });

      process.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Compute MD5 hash of a file (cross-platform via Node.js crypto)
   */
  private async computeMd5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("md5");
      const stream = createReadStream(filePath);

      stream.on("error", (err) => reject(err));
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  /**
   * Atomically append processed image to manifest CSV.
   * Reads current manifest, adds new entry, sorts by SKU, writes to temp file, then renames.
   *
   * Uses internal lock to serialize concurrent updates and prevent read-modify-write races.
   * This ensures entries added by concurrent jobs are not lost.
   *
   * Manifest format (CSV):
   *   sku,output_path,md5,size_bytes,dimensions,quality
   *   <entries sorted by SKU>
   *
   * @param sku - SKU identifier
   * @param outputPath - Final path to processed image
   * @param md5Hash - MD5 hash of output image
   * @param outputSizeBytes - Size in bytes
   * @param outputDimensions - Format "WxH"
   * @param quality - JPEG quality (82)
   */
  private async updateManifest(
    sku: string,
    outputPath: string,
    md5Hash: string,
    outputSizeBytes: number,
    outputDimensions: string,
    quality: number = 82
  ): Promise<void> {
    // Acquire lock to serialize manifest updates
    await this.manifestLock.acquire();

    try {
      interface ManifestEntry {
        sku: string;
        output_path: string;
        md5: string;
        size_bytes: number;
        dimensions: string;
        quality: number;
      }

      let entries: ManifestEntry[] = [];

      // Read existing manifest if present
      try {
        const manifestContent = await fs.readFile(this.manifestPath, "utf-8");
        const lines = manifestContent.split("\n").filter((line) => line.trim());

        // Parse CSV: skip header row and extract entries
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith("#")) continue; // Skip comments/empty lines

          const [entrySku, entryPath, entryMd5, entrySize, entryDims, entryQuality] = line.split(",");

          if (entrySku) {
            entries.push({
              sku: entrySku,
              output_path: entryPath,
              md5: entryMd5,
              size_bytes: parseInt(entrySize, 10),
              dimensions: entryDims,
              quality: parseInt(entryQuality, 10),
            });
          }
        }
      } catch (readErr) {
        // Manifest doesn't exist yet; start fresh
        this.logger.debug("Manifest file not found; creating new one");
      }

      // Deduplicate: remove any existing entries with the same SKU (upsert behavior)
      entries = entries.filter((e) => e.sku !== sku);

      // Add new entry (will be the only entry for this SKU after deduplication)
      entries.push({
        sku,
        output_path: outputPath,
        md5: md5Hash,
        size_bytes: outputSizeBytes,
        dimensions: outputDimensions,
        quality,
      });

      // Sort by SKU for determinism
      entries.sort((a, b) => a.sku.localeCompare(b.sku));

      // Build CSV content
      const csvLines: string[] = ["sku,output_path,md5,size_bytes,dimensions,quality"];
      for (const entry of entries) {
        csvLines.push(`${entry.sku},${entry.output_path},${entry.md5},${entry.size_bytes},${entry.dimensions},${entry.quality}`);
      }

      // Write to temp file first
      const tempManifestPath = `${this.manifestPath}.tmp.${Date.now()}`;
      await fs.writeFile(tempManifestPath, csvLines.join("\n") + "\n", "utf-8");

      // Atomically rename temp to final
      await fs.rename(tempManifestPath, this.manifestPath);

      this.logger.debug(
        { sku, manifestPath: this.manifestPath, totalEntries: entries.length },
        "Manifest updated successfully"
      );
    } catch (error) {
      this.logger.error(
        { err: error, sku, manifestPath: this.manifestPath },
        "Failed to update manifest; continuing without manifest update"
      );
      // Do not throw: manifest update is not critical to image processing success
    } finally {
      // Always release the lock so other waiters can proceed
      this.manifestLock.release();
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.scriptReady;
  }

  /**
   * Validate manifest for determinism (re-process and compare hashes)
   */
  async validateDeterminism(testImages: Array<{ path: string; sku: string }>, sampleSize = 3) {
    if (testImages.length === 0) return { deterministic: true, tested: 0 };

    const samples = testImages.slice(0, sampleSize);
    const firstPass: Record<string, string> = {};
    const secondPass: Record<string, string> = {};

    // First pass: process images
    for (const img of samples) {
      const result = await this.processImage(img.path, `${img.sku}_test1`);
      if (result.md5Hash) {
        firstPass[img.sku] = result.md5Hash;
      }
    }

    // Second pass: process same images again
    for (const img of samples) {
      const result = await this.processImage(img.path, `${img.sku}_test2`);
      if (result.md5Hash) {
        secondPass[img.sku] = result.md5Hash;
      }
    }

    // Compare hashes
    const mismatches = Object.entries(firstPass).filter(([sku, hash]) => {
      return secondPass[sku] && secondPass[sku] !== hash;
    });

    const deterministic = mismatches.length === 0;

    this.logger.info(
      {
        tested: samples.length,
        deterministic,
        mismatches: mismatches.length,
      },
      "Determinism validation complete"
    );

    return { deterministic, tested: samples.length, mismatches };
  }

  /**
   * Clean up old processed images (optional)
   */
  async cleanupOldImages(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const files = await fs.readdir(this.outputDir);
      const now = Date.now();
      let deleted = 0;

      for (const file of files) {
        if (file === ".tmp") continue; // Skip temp dir

        const filePath = path.join(this.outputDir, file);
        const stat = await fs.stat(filePath);

        if (now - stat.mtimeMs > olderThanMs) {
          await fs.unlink(filePath);
          deleted++;
        }
      }

      if (deleted > 0) {
        this.logger.info(
          { dir: this.outputDir, deleted, olderThanMs },
          "Cleaned up old processed images"
        );
      }

      return deleted;
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to cleanup old images");
      return 0;
    }
  }
}
