import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export type CalibrationStatus =
  | "PENDING"    // Capture requested, waiting for SFTP
  | "CAPTURED"   // Raw image received from SFTP
  | "STAGE1"     // Distortion correction complete
  | "STAGE2"     // Resize/compress complete
  | "PROCESSED"  // Stage-3 complete, ready for preview
  | "EXPIRED"    // TTL exceeded, pending cleanup
  | "FAILED";    // Processing error

export interface CalibrationCapture {
  id: string;
  capture_uid: string;
  raw_image_path: string | null;
  stage1_image_path: string | null;
  stage2_image_path: string | null;
  processed_image_path: string | null;
  settings_snapshot_json: string | null;
  stage3_params_json: string | null;
  status: CalibrationStatus;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface CaptureSettings {
  id: number;
  // Camera controls
  exposure_us: number;
  analogue_gain: number;
  colour_gains_red: number;
  colour_gains_blue: number;
  ae_enable: boolean;
  awb_enable: boolean;
  // Stage-3 controls
  clahe_clip_limit: number;
  clahe_tile_size: number;
  stage3_awb_enable: boolean;
  // Metadata
  created_at: number;
  updated_at: number;
}

export interface CaptureSettingsInput {
  exposure_us?: number;
  analogue_gain?: number;
  colour_gains_red?: number;
  colour_gains_blue?: number;
  ae_enable?: boolean;
  awb_enable?: boolean;
  clahe_clip_limit?: number;
  clahe_tile_size?: number;
  stage3_awb_enable?: boolean;
}

// ============================================================================
// Repository
// ============================================================================

const now = () => Date.now();
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class CalibrationRepository {
  constructor(private readonly db: Database.Database) {}

  // -------------------------------------------------------------------------
  // Calibration Captures
  // -------------------------------------------------------------------------

  /**
   * Create a new calibration capture record.
   * Called when operator triggers a test capture.
   */
  createCalibration(
    captureUid: string,
    settingsSnapshot?: Record<string, unknown>
  ): CalibrationCapture {
    const id = randomUUID();
    const timestamp = now();
    const expiresAt = timestamp + DEFAULT_TTL_MS;

    this.db
      .prepare(
        `INSERT INTO calibration_captures (
          id, capture_uid, settings_snapshot_json, status,
          created_at, updated_at, expires_at
        ) VALUES (
          @id, @capture_uid, @settings_snapshot_json, 'PENDING',
          @created_at, @updated_at, @expires_at
        )`
      )
      .run({
        id,
        capture_uid: captureUid,
        settings_snapshot_json: settingsSnapshot ? JSON.stringify(settingsSnapshot) : null,
        created_at: timestamp,
        updated_at: timestamp,
        expires_at: expiresAt,
      });

    return {
      id,
      capture_uid: captureUid,
      raw_image_path: null,
      stage1_image_path: null,
      stage2_image_path: null,
      processed_image_path: null,
      settings_snapshot_json: settingsSnapshot ? JSON.stringify(settingsSnapshot) : null,
      stage3_params_json: null,
      status: "PENDING",
      error_message: null,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: expiresAt,
    };
  }

  /**
   * Find calibration capture by its capture_uid (Pi5 kiosk UID).
   * Used by SFTP ingestion to detect calibration captures.
   */
  findByCaptureUid(captureUid: string): CalibrationCapture | undefined {
    const row = this.db
      .prepare(`SELECT * FROM calibration_captures WHERE capture_uid = @capture_uid`)
      .get({ capture_uid: captureUid }) as CalibrationCapture | undefined;

    return row ? this.mapCalibrationRow(row) : undefined;
  }

  /**
   * Get calibration capture by ID.
   */
  getById(id: string): CalibrationCapture | undefined {
    const row = this.db
      .prepare(`SELECT * FROM calibration_captures WHERE id = @id`)
      .get({ id }) as CalibrationCapture | undefined;

    return row ? this.mapCalibrationRow(row) : undefined;
  }

  /**
   * Update calibration status.
   */
  updateStatus(id: string, status: CalibrationStatus, errorMessage?: string): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET status = @status, error_message = @error_message, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        status,
        error_message: errorMessage ?? null,
        updated_at: now(),
      });
  }

  /**
   * Update raw image path (called by SFTP ingestion).
   */
  updateRawPath(id: string, rawImagePath: string): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET raw_image_path = @raw_image_path, status = 'CAPTURED', updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        raw_image_path: rawImagePath,
        updated_at: now(),
      });
  }

  /**
   * Update Stage-1 image path (after distortion correction).
   */
  updateStage1Path(id: string, stage1ImagePath: string): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET stage1_image_path = @stage1_image_path, status = 'STAGE1', updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        stage1_image_path: stage1ImagePath,
        updated_at: now(),
      });
  }

  /**
   * Update Stage-2 image path (after resize/compress).
   */
  updateStage2Path(id: string, stage2ImagePath: string): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET stage2_image_path = @stage2_image_path, status = 'STAGE2', updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        stage2_image_path: stage2ImagePath,
        updated_at: now(),
      });
  }

  /**
   * Update processed image path and Stage-3 params (after Stage-3 processing).
   */
  updateProcessedPath(
    id: string,
    processedImagePath: string,
    stage3Params?: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET processed_image_path = @processed_image_path,
             stage3_params_json = @stage3_params_json,
             status = 'PROCESSED',
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        processed_image_path: processedImagePath,
        stage3_params_json: stage3Params ? JSON.stringify(stage3Params) : null,
        updated_at: now(),
      });
  }

  /**
   * Get all expired calibration captures for cleanup.
   */
  getExpired(): CalibrationCapture[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM calibration_captures
         WHERE expires_at < @now AND status != 'EXPIRED'`
      )
      .all({ now: now() }) as CalibrationCapture[];

    return rows.map((row) => this.mapCalibrationRow(row));
  }

  /**
   * Mark calibration as expired.
   */
  markExpired(id: string): void {
    this.db
      .prepare(
        `UPDATE calibration_captures
         SET status = 'EXPIRED', updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, updated_at: now() });
  }

  /**
   * Delete old expired records (older than 24 hours).
   */
  purgeOldExpired(): number {
    const cutoff = now() - 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare(
        `DELETE FROM calibration_captures
         WHERE status = 'EXPIRED' AND updated_at < @cutoff`
      )
      .run({ cutoff });

    return result.changes;
  }

  private mapCalibrationRow(row: any): CalibrationCapture {
    return {
      id: row.id,
      capture_uid: row.capture_uid,
      raw_image_path: row.raw_image_path,
      stage1_image_path: row.stage1_image_path,
      stage2_image_path: row.stage2_image_path,
      processed_image_path: row.processed_image_path,
      settings_snapshot_json: row.settings_snapshot_json,
      stage3_params_json: row.stage3_params_json,
      status: row.status as CalibrationStatus,
      error_message: row.error_message,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
    };
  }

  // -------------------------------------------------------------------------
  // Capture Settings (single-row global settings)
  // -------------------------------------------------------------------------

  /**
   * Get global capture settings.
   */
  getSettings(): CaptureSettings | undefined {
    const row = this.db
      .prepare(`SELECT * FROM capture_settings WHERE id = 1`)
      .get() as any | undefined;

    return row ? this.mapSettingsRow(row) : undefined;
  }

  /**
   * Update global capture settings (partial update supported).
   */
  updateSettings(settings: CaptureSettingsInput): CaptureSettings {
    const current = this.getSettings();
    const timestamp = now();

    // Build update SQL dynamically based on provided fields
    const updates: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = { updated_at: timestamp };

    if (settings.exposure_us !== undefined) {
      updates.push("exposure_us = @exposure_us");
      params.exposure_us = settings.exposure_us;
    }
    if (settings.analogue_gain !== undefined) {
      updates.push("analogue_gain = @analogue_gain");
      params.analogue_gain = settings.analogue_gain;
    }
    if (settings.colour_gains_red !== undefined) {
      updates.push("colour_gains_red = @colour_gains_red");
      params.colour_gains_red = settings.colour_gains_red;
    }
    if (settings.colour_gains_blue !== undefined) {
      updates.push("colour_gains_blue = @colour_gains_blue");
      params.colour_gains_blue = settings.colour_gains_blue;
    }
    if (settings.ae_enable !== undefined) {
      updates.push("ae_enable = @ae_enable");
      params.ae_enable = settings.ae_enable ? 1 : 0;
    }
    if (settings.awb_enable !== undefined) {
      updates.push("awb_enable = @awb_enable");
      params.awb_enable = settings.awb_enable ? 1 : 0;
    }
    if (settings.clahe_clip_limit !== undefined) {
      updates.push("clahe_clip_limit = @clahe_clip_limit");
      params.clahe_clip_limit = settings.clahe_clip_limit;
    }
    if (settings.clahe_tile_size !== undefined) {
      updates.push("clahe_tile_size = @clahe_tile_size");
      params.clahe_tile_size = settings.clahe_tile_size;
    }
    if (settings.stage3_awb_enable !== undefined) {
      updates.push("stage3_awb_enable = @stage3_awb_enable");
      params.stage3_awb_enable = settings.stage3_awb_enable ? 1 : 0;
    }

    this.db.prepare(`UPDATE capture_settings SET ${updates.join(", ")} WHERE id = 1`).run(params);

    return this.getSettings()!;
  }

  private mapSettingsRow(row: any): CaptureSettings {
    return {
      id: row.id,
      exposure_us: row.exposure_us,
      analogue_gain: row.analogue_gain,
      colour_gains_red: row.colour_gains_red,
      colour_gains_blue: row.colour_gains_blue,
      ae_enable: row.ae_enable === 1,
      awb_enable: row.awb_enable === 1,
      clahe_clip_limit: row.clahe_clip_limit,
      clahe_tile_size: row.clahe_tile_size,
      stage3_awb_enable: row.stage3_awb_enable === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
