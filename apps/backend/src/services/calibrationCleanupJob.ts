/**
 * Calibration Cleanup Job
 * Background timer that cleans up expired calibration captures and their files.
 *
 * Key behaviors:
 * - Runs every 5 minutes
 * - Marks expired calibration captures (TTL exceeded)
 * - Deletes associated image files (raw, stage1, stage2, processed)
 * - Purges old expired records after 24 hours
 *
 * Reference: Pre-CDN Image Tuning Controls plan (Dec 24, 2025)
 */

import type { Logger } from "pino";
import { promises as fs } from "fs";
import { CalibrationRepository, CalibrationCapture } from "../repositories/calibrationRepository";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface CleanupJobResult {
  expired: number;
  filesDeleted: number;
  purged: number;
  errors: number;
  skipped: boolean;
}

export class CalibrationCleanupJob {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(
    private readonly calibrationRepo: CalibrationRepository,
    private readonly logger: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  /**
   * Start the background cleanup timer.
   */
  start(): void {
    if (this.intervalHandle) {
      this.logger.warn("Calibration cleanup job already running");
      return;
    }

    this.logger.info(
      { intervalMs: this.intervalMs },
      "Starting calibration cleanup job"
    );

    // Run immediately on start
    this.runOnce();

    // Then run on interval
    this.intervalHandle = setInterval(() => {
      this.runOnce();
    }, this.intervalMs);
  }

  /**
   * Stop the background cleanup timer
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Calibration cleanup job stopped");
    }
  }

  /**
   * Run one iteration of the cleanup job
   */
  async runOnce(): Promise<CleanupJobResult> {
    if (this.isRunning) {
      this.logger.debug("Cleanup job already running, skipping");
      return {
        expired: 0,
        filesDeleted: 0,
        purged: 0,
        errors: 0,
        skipped: true,
      };
    }

    this.isRunning = true;
    const result: CleanupJobResult = {
      expired: 0,
      filesDeleted: 0,
      purged: 0,
      errors: 0,
      skipped: false,
    };

    try {
      // 1. Find and process expired calibration captures
      const expired = this.calibrationRepo.getExpired();

      if (expired.length > 0) {
        this.logger.debug({ count: expired.length }, "Processing expired calibration captures");
      }

      for (const cal of expired) {
        result.expired++;

        try {
          // Delete associated files
          const deleted = await this.deleteCalibrationFiles(cal);
          result.filesDeleted += deleted;

          // Mark as expired in DB
          this.calibrationRepo.markExpired(cal.id);
        } catch (error) {
          result.errors++;
          this.logger.error(
            { err: error, calibrationId: cal.id },
            "Failed to clean up calibration capture"
          );
        }
      }

      // 2. Purge old expired records (>24h)
      const purged = this.calibrationRepo.purgeOldExpired();
      result.purged = purged;

      // Log summary if any work was done
      if (result.expired > 0 || result.purged > 0) {
        this.logger.info(
          {
            expired: result.expired,
            filesDeleted: result.filesDeleted,
            purged: result.purged,
            errors: result.errors,
          },
          "Calibration cleanup complete"
        );
      } else {
        this.logger.debug("No calibration cleanup needed");
      }
    } catch (error) {
      this.logger.error({ err: error }, "Calibration cleanup job failed");
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Delete all image files associated with a calibration capture.
   * Returns the number of files deleted.
   */
  private async deleteCalibrationFiles(cal: CalibrationCapture): Promise<number> {
    const paths = [
      cal.raw_image_path,
      cal.stage1_image_path,
      cal.stage2_image_path,
      cal.processed_image_path,
    ].filter((p): p is string => p !== null);

    let deleted = 0;

    for (const path of paths) {
      try {
        await fs.unlink(path);
        deleted++;
        this.logger.debug({ path }, "Deleted calibration file");
      } catch (error: any) {
        // ENOENT is fine - file may already be deleted
        if (error.code !== "ENOENT") {
          this.logger.warn({ err: error, path }, "Failed to delete calibration file");
        }
      }
    }

    return deleted;
  }

  /**
   * Check if the job is currently running
   */
  isActive(): boolean {
    return this.intervalHandle !== null;
  }
}
