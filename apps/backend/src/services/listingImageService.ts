import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import type { Logger } from "pino";
import type Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ListingAssetResult {
  success: boolean;
  listingPath?: string;
  error?: string;
}

export interface Stage3Params {
  clahe_clip?: number;    // CLAHE clipLimit (default: 1.5)
  clahe_tiles?: number;   // CLAHE tile grid size (default: 8)
  awb_enable?: boolean;   // Auto white balance (default: true)
  padding?: number;       // Padding % around card (default: 1.5)
  max_size?: number;      // Max dimension pixels (default: 2000)
  quality?: number;       // JPEG quality (default: 85)
}

export interface ScanForListing {
  id: string;
  corrected_image_path: string | null;
  processed_image_path: string | null;
  raw_image_path: string | null;
}

/**
 * ListingImageService - Stage 3 asset generation
 *
 * Generates production-ready listing images suitable for e-commerce platforms.
 * Uses generate_listing_asset.py to crop, resize, and color-correct cards.
 */
export class ListingImageService {
  private readonly logger: Logger;
  private readonly db: Database.Database;
  private readonly scriptPath: string;
  private readonly outputBaseDir: string;

  constructor(logger: Logger, db: Database.Database) {
    this.logger = logger;
    this.db = db;

    // Path to Python script (at workspace root /scripts/)
    this.scriptPath = path.resolve(__dirname, "../../../../scripts/generate_listing_asset.py");

    // Output directory for listing assets
    this.outputBaseDir = path.resolve(__dirname, "../../images/listing");
  }

  /**
   * Check if listing image service is ready
   */
  async isReady(): Promise<boolean> {
    try {
      // Check if Python script exists
      await fs.access(this.scriptPath);
      return true;
    } catch {
      this.logger.warn("ListingImageService not ready: script not found");
      return false;
    }
  }

  /**
   * Generate listing asset for a product (idempotent)
   *
   * @param productUid - Product UID to generate asset for
   * @returns Result with local filesystem path to listing asset
   */
  async generateListingAsset(productUid: string): Promise<ListingAssetResult> {
    try {
      // Find latest accepted scan for this product
      const scan = this.findLatestScanForProduct(productUid);

      if (!scan) {
        return {
          success: false,
          error: `No scans found for product ${productUid}`
        };
      }

      if (!scan.corrected_image_path && !scan.processed_image_path && !scan.raw_image_path) {
        return {
          success: false,
          error: `Scan ${scan.id} has no image paths`
        };
      }

      // Prefer corrected image (Stage 1 distortion-corrected, highest fidelity),
      // fall back to processed (Stage 2) or raw
      const inputPath = scan.corrected_image_path || scan.processed_image_path || scan.raw_image_path!;

      // Output path: images/listing/{productUid}/front.jpg
      const outputDir = path.join(this.outputBaseDir, productUid);
      const outputPath = path.join(outputDir, "front.jpg");

      // Check if listing asset already exists
      try {
        await fs.access(outputPath);
        this.logger.debug({ productUid, outputPath }, "Listing asset already exists");
        return {
          success: true,
          listingPath: outputPath
        };
      } catch {
        // Asset doesn't exist, generate it
      }

      // Ensure output directory exists
      await fs.mkdir(outputDir, { recursive: true });

      // Generate listing asset using Python script
      const result = await this.runGenerator(inputPath, outputPath);

      if (result.success) {
        this.logger.info(
          { productUid, scanId: scan.id, outputPath },
          "Generated listing asset"
        );
      } else {
        this.logger.error(
          { productUid, scanId: scan.id, error: result.error },
          "Failed to generate listing asset"
        );
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ productUid, error: message }, "Exception in generateListingAsset");
      return {
        success: false,
        error: message
      };
    }
  }

  /**
   * Find latest accepted scan for a product
   */
  private findLatestScanForProduct(productUid: string): ScanForListing | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT s.id, s.corrected_image_path, s.processed_image_path, s.raw_image_path
         FROM scans s
         JOIN items i ON s.item_uid = i.item_uid
         WHERE i.product_uid = ?
           AND s.status = 'ACCEPTED'
         ORDER BY s.updated_at DESC
         LIMIT 1`
      )
      .get(productUid);

    return row as ScanForListing | null;
  }

  /**
   * Load Stage-3 settings from capture_settings table.
   * Returns defaults if table doesn't exist or is empty.
   */
  private loadStage3Settings(): Stage3Params {
    try {
      const row = this.db
        .prepare(`SELECT clahe_clip_limit, clahe_tile_size, stage3_awb_enable FROM capture_settings WHERE id = 1`)
        .get() as { clahe_clip_limit: number; clahe_tile_size: number; stage3_awb_enable: number } | undefined;

      if (row) {
        return {
          clahe_clip: row.clahe_clip_limit,
          clahe_tiles: row.clahe_tile_size,
          awb_enable: row.stage3_awb_enable === 1,
        };
      }
    } catch (err) {
      // Table might not exist yet (migration not run) - use defaults
      this.logger.debug({ err }, "Failed to load Stage-3 settings from DB, using defaults");
    }

    // Default values from generate_listing_asset.py
    return {
      clahe_clip: 1.5,
      clahe_tiles: 8,
      awb_enable: true,
    };
  }

  /**
   * Run Python listing asset generator
   * Uses persisted Stage-3 settings from capture_settings table.
   */
  private async runGenerator(
    inputPath: string,
    outputPath: string
  ): Promise<ListingAssetResult> {
    // Load Stage-3 settings from DB (calibration workflow persists tuned values here)
    const stage3 = this.loadStage3Settings();

    return new Promise((resolve) => {
      const args = [
        this.scriptPath,
        inputPath,
        outputPath,
        "--padding", "1.5",
        "--max-size", "2000",
        "--quality", "85",
        "--clahe-clip", String(stage3.clahe_clip ?? 1.5),
        "--clahe-tiles", String(stage3.clahe_tiles ?? 8),
      ];

      // Add --no-awb flag if AWB is disabled
      if (stage3.awb_enable === false) {
        args.push("--no-awb");
      }

      const proc = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({
            success: true,
            listingPath: outputPath
          });
        } else {
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          resolve({
            success: false,
            error: errorMsg
          });
        }
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          error: err.message
        });
      });
    });
  }

  /**
   * Ensure listing asset exists for a product (generate if missing)
   *
   * Convenience method for use in publishing workflows.
   */
  async ensureListingAsset(productUid: string): Promise<string> {
    const result = await this.generateListingAsset(productUid);

    if (!result.success) {
      throw new Error(`Failed to generate listing asset: ${result.error}`);
    }

    return result.listingPath!;
  }

  /**
   * Run Python listing asset generator with custom Stage-3 parameters.
   * Used by calibration workflow to preview different CLAHE/AWB settings.
   *
   * @param inputPath - Path to input image (Stage-2 processed)
   * @param outputPath - Path to save generated listing asset
   * @param params - Optional Stage-3 parameters to override defaults
   * @returns Result with local filesystem path to listing asset
   */
  async runGeneratorWithParams(
    inputPath: string,
    outputPath: string,
    params?: Stage3Params
  ): Promise<ListingAssetResult> {
    return new Promise((resolve) => {
      const args = [
        this.scriptPath,
        inputPath,
        outputPath,
        "--padding", String(params?.padding ?? 1.5),
        "--max-size", String(params?.max_size ?? 2000),
        "--quality", String(params?.quality ?? 85),
        "--clahe-clip", String(params?.clahe_clip ?? 1.5),
        "--clahe-tiles", String(params?.clahe_tiles ?? 8),
      ];

      // Add --no-awb flag if AWB is explicitly disabled
      if (params?.awb_enable === false) {
        args.push("--no-awb");
      }

      this.logger.debug({ inputPath, outputPath, params, args }, "Running Stage-3 generator with params");

      const proc = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          this.logger.debug({ outputPath }, "Stage-3 generator completed successfully");
          resolve({
            success: true,
            listingPath: outputPath
          });
        } else {
          const errorMsg = stderr || stdout || `Process exited with code ${code}`;
          this.logger.error({ code, stderr, stdout }, "Stage-3 generator failed");
          resolve({
            success: false,
            error: errorMsg
          });
        }
      });

      proc.on("error", (err) => {
        this.logger.error({ err }, "Stage-3 generator process error");
        resolve({
          success: false,
          error: err.message
        });
      });
    });
  }
}
