/**
 * Calibration Routes
 *
 * Provides endpoints for the pre-CDN image tuning workflow:
 * - POST /api/capture/test: Trigger a test capture (bypasses session gating)
 * - GET /api/calibration/:id/status: Poll calibration status
 * - POST /api/calibration/:id/process: Run Stage 1-2-3 pipeline
 * - GET /api/calibration/:id/raw: Serve raw capture image
 * - GET /api/calibration/:id/processed: Serve Stage-3 processed image
 *
 * Auth: Localhost-only + rate limiting on test capture
 * Reference: Pre-CDN Image Tuning Controls plan (Dec 24, 2025)
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { CalibrationRepository, CaptureSettings } from "../repositories/calibrationRepository";
import { Pi5KioskDriver, CaptureControlOverrides } from "../services/capture/pi5KioskDriver";
import { ListingImageService, Stage3Params } from "../services/listingImageService";
import { requireInternalAccess } from "../middleware/adminAuth";

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rate limiting state
let lastTestCaptureTime = 0;
const TEST_CAPTURE_RATE_LIMIT_MS = 5000; // 5 seconds between test captures

// Base directory for calibration images
const CALIBRATION_IMAGES_DIR = path.resolve(__dirname, "../../images/calibration");

export function registerCalibrationRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, captureAdapter, distortionCorrection, imageProcessing } = ctx;
  const calibrationRepo = new CalibrationRepository(db);
  const listingImageService = new ListingImageService(logger, db);

  // Get Pi5KioskDriver from capture adapter if available
  const getPi5Driver = (): Pi5KioskDriver | null => {
    // Check if capture adapter has a Pi5 driver
    const adapter = captureAdapter as any;
    if (adapter?.driver && adapter.driver instanceof Pi5KioskDriver) {
      return adapter.driver;
    }
    // Try to create one directly with db access
    return new Pi5KioskDriver(logger, db);
  };

  /**
   * POST /api/capture/test
   *
   * Trigger a test capture for calibration workflow.
   * - Localhost-only for security
   * - Bypasses session gating (works regardless of session state)
   * - Rate limited (1 request per 5 seconds)
   * - Creates calibration_captures record and triggers Pi5 capture
   * - Returns immediately with calibration_id (image delivered async via SFTP)
   */
  app.post("/api/capture/test", requireInternalAccess, async (req: Request, res: Response) => {
    try {
      // Rate limiting
      const now = Date.now();
      const elapsed = now - lastTestCaptureTime;
      if (elapsed < TEST_CAPTURE_RATE_LIMIT_MS) {
        return res.status(429).json({
          error: "Rate limited",
          message: `Test captures are limited to 1 per ${TEST_CAPTURE_RATE_LIMIT_MS / 1000} seconds`,
          retry_after_ms: TEST_CAPTURE_RATE_LIMIT_MS - elapsed,
        });
      }
      lastTestCaptureTime = now;

      // Get Pi5 driver
      const pi5Driver = getPi5Driver();
      if (!pi5Driver) {
        return res.status(503).json({
          error: "Capture unavailable",
          message: "Pi5 kiosk driver not available",
        });
      }

      // Check driver availability
      const available = await pi5Driver.isAvailable();
      if (!available) {
        return res.status(503).json({
          error: "Capture unavailable",
          message: "Pi5 kiosk is not responding",
        });
      }

      // Parse optional camera control overrides from request body
      const body = req.body as {
        camera?: {
          exposure_us?: number;
          analogue_gain?: number;
          colour_gains?: { red: number; blue: number };
          ae_enable?: boolean;
          awb_enable?: boolean;
        };
      };

      const overrides: CaptureControlOverrides | undefined = body.camera ? {
        ExposureTime: body.camera.exposure_us,
        AnalogueGain: body.camera.analogue_gain,
        ColourGains: body.camera.colour_gains
          ? [body.camera.colour_gains.red, body.camera.colour_gains.blue]
          : undefined,
        AeEnable: body.camera.ae_enable,
        AwbEnable: body.camera.awb_enable,
      } : undefined;

      // Trigger capture
      const result = await pi5Driver.captureWithOverrides(overrides);

      if (result.exitCode !== 0) {
        return res.status(500).json({
          error: "Capture failed",
          message: result.output,
        });
      }

      // Extract capture_uid from kiosk response
      const captureUid = Pi5KioskDriver.extractCaptureUid(result);
      if (!captureUid) {
        return res.status(500).json({
          error: "Capture failed",
          message: "Could not extract capture UID from kiosk response",
        });
      }

      // Get current settings for snapshot
      const settings = calibrationRepo.getSettings();

      // Create calibration capture record
      const calibration = calibrationRepo.createCalibration(
        captureUid,
        {
          camera: overrides ?? settings,
        }
      );

      logger.info(
        { calibrationId: calibration.id, captureUid },
        "Test capture triggered, waiting for SFTP delivery"
      );

      res.status(202).json({
        ok: true,
        calibration_id: calibration.id,
        capture_uid: captureUid,
        status: "PENDING",
        message: "Capture triggered. Poll /api/calibration/:id/status for updates.",
      });
    } catch (error) {
      logger.error({ err: error }, "Test capture failed");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/calibration/:id/status
   *
   * Poll calibration capture status.
   * Returns current status and image URLs when available.
   * Localhost-only for security.
   */
  app.get("/api/calibration/:id/status", requireInternalAccess, (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const calibration = calibrationRepo.getById(id);
      if (!calibration) {
        return res.status(404).json({
          error: "Not found",
          message: `Calibration ${id} not found`,
        });
      }

      const response: Record<string, unknown> = {
        id: calibration.id,
        status: calibration.status,
        created_at: calibration.created_at,
        updated_at: calibration.updated_at,
      };

      // Add URLs if images are available
      if (calibration.raw_image_path) {
        response.raw_url = `/api/calibration/${id}/raw`;
      }
      if (calibration.processed_image_path) {
        response.processed_url = `/api/calibration/${id}/processed`;
      }

      // Add error if failed
      if (calibration.status === "FAILED" && calibration.error_message) {
        response.error = calibration.error_message;
      }

      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Failed to get calibration status");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/calibration/:id/process
   *
   * Process calibration capture through Stage 1-2-3 pipeline.
   * Requires status = CAPTURED (raw image available).
   * Localhost-only for security.
   */
  app.post("/api/calibration/:id/process", requireInternalAccess, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const calibration = calibrationRepo.getById(id);
      if (!calibration) {
        return res.status(404).json({
          error: "Not found",
          message: `Calibration ${id} not found`,
        });
      }

      if (calibration.status !== "CAPTURED") {
        return res.status(400).json({
          error: "Invalid state",
          message: `Calibration status is ${calibration.status}, expected CAPTURED`,
        });
      }

      if (!calibration.raw_image_path) {
        return res.status(400).json({
          error: "Missing image",
          message: "Raw image path is not set",
        });
      }

      // Parse optional Stage-3 parameters from request body
      const body = req.body as {
        stage3?: {
          clahe_clip_limit?: number;
          clahe_tile_size?: number;
          awb_enable?: boolean;
        };
      };

      const stage3Params: Stage3Params = {
        clahe_clip: body.stage3?.clahe_clip_limit,
        clahe_tiles: body.stage3?.clahe_tile_size,
        awb_enable: body.stage3?.awb_enable,
      };

      // Ensure calibration images directory exists
      const outputDir = path.join(CALIBRATION_IMAGES_DIR, id);
      await fs.mkdir(outputDir, { recursive: true });

      // Stage-1: Distortion correction
      // Applies barrel distortion correction for IMX477 + 6mm lens
      let stage1Path = calibration.raw_image_path;
      if (distortionCorrection.isReady()) {
        const stage1Result = await distortionCorrection.correctImage(calibration.raw_image_path);
        if (stage1Result.success && stage1Result.correctedImagePath) {
          stage1Path = stage1Result.correctedImagePath;
          calibrationRepo.updateStage1Path(id, stage1Path);
          logger.debug({ calibrationId: id, stage1Path }, "Stage-1 complete");
        } else {
          logger.warn(
            { calibrationId: id, error: stage1Result.error },
            "Stage-1 skipped (distortion correction failed/unavailable)"
          );
          // Continue with raw image - Stage-1 is optional for calibration preview
        }
      } else {
        logger.debug({ calibrationId: id }, "Stage-1 skipped (service not ready)");
      }

      // Stage-2: Resize and compress
      // Produces EverShop-compatible portrait image (1024px height, JPEG Q82)
      let stage2Path = stage1Path;
      if (imageProcessing.isReady()) {
        // Use calibration ID as SKU for Stage-2 output naming
        const stage2Result = await imageProcessing.processImage(stage1Path, `cal-${id.slice(0, 8)}`);
        if (stage2Result.success && stage2Result.processedImagePath) {
          stage2Path = stage2Result.processedImagePath;
          calibrationRepo.updateStage2Path(id, stage2Path);
          logger.debug({ calibrationId: id, stage2Path }, "Stage-2 complete");
        } else {
          logger.warn(
            { calibrationId: id, error: stage2Result.error },
            "Stage-2 skipped (image processing failed/unavailable)"
          );
          // Continue with Stage-1 output - Stage-2 is optional for calibration preview
        }
      } else {
        logger.debug({ calibrationId: id }, "Stage-2 skipped (service not ready)");
      }

      // Stage-3: Generate listing asset with tunable parameters
      // This is the main tuning target for calibration workflow
      const processedPath = path.join(outputDir, "processed.jpg");
      const result = await listingImageService.runGeneratorWithParams(
        stage2Path,  // Use Stage-2 output (or Stage-1/raw as fallback)
        processedPath,
        stage3Params
      );

      if (!result.success) {
        calibrationRepo.updateStatus(id, "FAILED", result.error);
        return res.status(500).json({
          error: "Processing failed",
          message: result.error,
        });
      }

      // Update calibration record
      calibrationRepo.updateProcessedPath(id, processedPath, stage3Params as Record<string, unknown>);

      logger.info(
        { calibrationId: id, processedPath, stage3Params },
        "Calibration processing complete"
      );

      res.json({
        ok: true,
        status: "PROCESSED",
        processed_url: `/api/calibration/${id}/processed`,
      });
    } catch (error) {
      logger.error({ err: error }, "Calibration processing failed");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/calibration/:id/raw
   *
   * Serve raw capture image for calibration.
   * Security: Localhost-only + path whitelisted to calibration directory.
   */
  app.get("/api/calibration/:id/raw", requireInternalAccess, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const calibration = calibrationRepo.getById(id);
      if (!calibration) {
        return res.status(404).json({
          error: "Not found",
          message: `Calibration ${id} not found`,
        });
      }

      if (!calibration.raw_image_path) {
        return res.status(404).json({
          error: "Not ready",
          message: "Raw image not yet available",
        });
      }

      // Verify file exists
      try {
        await fs.access(calibration.raw_image_path);
      } catch {
        return res.status(404).json({
          error: "File not found",
          message: "Raw image file does not exist",
        });
      }

      // Send file with appropriate headers
      res.set({
        "Content-Type": "image/jpeg",
        "X-Robots-Tag": "noimageindex, noarchive",
        "Cache-Control": "private, max-age=3600",
      });

      res.sendFile(calibration.raw_image_path);
    } catch (error) {
      logger.error({ err: error }, "Failed to serve raw calibration image");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/calibration/:id/processed
   *
   * Serve Stage-3 processed image for calibration.
   * Security: Localhost-only + path whitelisted to calibration directory.
   */
  app.get("/api/calibration/:id/processed", requireInternalAccess, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const calibration = calibrationRepo.getById(id);
      if (!calibration) {
        return res.status(404).json({
          error: "Not found",
          message: `Calibration ${id} not found`,
        });
      }

      if (!calibration.processed_image_path) {
        return res.status(404).json({
          error: "Not ready",
          message: "Processed image not yet available. Call POST /api/calibration/:id/process first.",
        });
      }

      // Verify file exists
      try {
        await fs.access(calibration.processed_image_path);
      } catch {
        return res.status(404).json({
          error: "File not found",
          message: "Processed image file does not exist",
        });
      }

      // Send file with appropriate headers
      res.set({
        "Content-Type": "image/jpeg",
        "X-Robots-Tag": "noimageindex, noarchive",
        "Cache-Control": "private, max-age=3600",
      });

      res.sendFile(calibration.processed_image_path);
    } catch (error) {
      logger.error({ err: error }, "Failed to serve processed calibration image");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
