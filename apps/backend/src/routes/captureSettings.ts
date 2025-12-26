/**
 * Capture Settings Routes
 *
 * Provides GET/PUT endpoints for global capture settings (camera controls + Stage-3 params).
 * Settings persist to capture_settings table and apply to all future captures.
 *
 * Auth: Localhost-only (operator workbench runs locally)
 * Reference: Pre-CDN Image Tuning Controls plan (Dec 24, 2025)
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { CalibrationRepository, CaptureSettings, CaptureSettingsInput } from "../repositories/calibrationRepository";
import { requireInternalAccess } from "../middleware/adminAuth";

export interface CaptureSettingsResponse {
  camera: {
    exposure_us: number;
    analogue_gain: number;
    colour_gains: { red: number; blue: number };
    ae_enable: boolean;
    awb_enable: boolean;
  };
  stage3: {
    clahe_clip_limit: number;
    clahe_tile_size: number;
    awb_enable: boolean;
  };
  updated_at: number;
}

function mapSettingsToResponse(settings: CaptureSettings): CaptureSettingsResponse {
  return {
    camera: {
      exposure_us: settings.exposure_us,
      analogue_gain: settings.analogue_gain,
      colour_gains: {
        red: settings.colour_gains_red,
        blue: settings.colour_gains_blue,
      },
      ae_enable: settings.ae_enable,
      awb_enable: settings.awb_enable,
    },
    stage3: {
      clahe_clip_limit: settings.clahe_clip_limit,
      clahe_tile_size: settings.clahe_tile_size,
      awb_enable: settings.stage3_awb_enable,
    },
    updated_at: settings.updated_at,
  };
}

export function registerCaptureSettingsRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;
  const calibrationRepo = new CalibrationRepository(db);

  /**
   * GET /api/capture-settings
   *
   * Retrieve global capture settings.
   * Returns current camera controls and Stage-3 processing parameters.
   * Localhost-only for security.
   */
  app.get("/api/capture-settings", requireInternalAccess, (_req: Request, res: Response) => {
    try {
      const settings = calibrationRepo.getSettings();

      if (!settings) {
        logger.error("Capture settings not found - migration may not have run");
        return res.status(500).json({
          error: "Settings not found",
          message: "Capture settings table is empty. Run migrations.",
        });
      }

      const response = mapSettingsToResponse(settings);
      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Failed to get capture settings");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * PUT /api/capture-settings
   *
   * Update global capture settings (partial update supported).
   * Changes apply to all future captures.
   * Localhost-only for security.
   */
  app.put("/api/capture-settings", requireInternalAccess, (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<CaptureSettingsResponse>;

      // Map request body to settings input
      const input: CaptureSettingsInput = {};

      if (body.camera) {
        if (body.camera.exposure_us !== undefined) {
          input.exposure_us = body.camera.exposure_us;
        }
        if (body.camera.analogue_gain !== undefined) {
          input.analogue_gain = body.camera.analogue_gain;
        }
        if (body.camera.colour_gains?.red !== undefined) {
          input.colour_gains_red = body.camera.colour_gains.red;
        }
        if (body.camera.colour_gains?.blue !== undefined) {
          input.colour_gains_blue = body.camera.colour_gains.blue;
        }
        if (body.camera.ae_enable !== undefined) {
          input.ae_enable = body.camera.ae_enable;
        }
        if (body.camera.awb_enable !== undefined) {
          input.awb_enable = body.camera.awb_enable;
        }
      }

      if (body.stage3) {
        if (body.stage3.clahe_clip_limit !== undefined) {
          input.clahe_clip_limit = body.stage3.clahe_clip_limit;
        }
        if (body.stage3.clahe_tile_size !== undefined) {
          input.clahe_tile_size = body.stage3.clahe_tile_size;
        }
        if (body.stage3.awb_enable !== undefined) {
          input.stage3_awb_enable = body.stage3.awb_enable;
        }
      }

      // Update settings
      const updated = calibrationRepo.updateSettings(input);

      logger.info({ input }, "Updated capture settings");

      const response = mapSettingsToResponse(updated);
      res.json(response);
    } catch (error) {
      logger.error({ err: error }, "Failed to update capture settings");
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
