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
   * Run Python listing asset generator
   */
  private async runGenerator(
    inputPath: string,
    outputPath: string
  ): Promise<ListingAssetResult> {
    return new Promise((resolve) => {
      const args = [
        this.scriptPath,
        inputPath,
        outputPath,
        "--padding", "1.5",
        "--max-size", "2000",
        "--quality", "85"
      ];

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
}
