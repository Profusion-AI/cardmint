import Database from "better-sqlite3";
import {
  ACTIVE_STATES,
  Candidate,
  ExtractedFields,
  JobStatus,
  ScanJob,
  StageTimings,
} from "../domain/job";

interface DbRow {
  id: string;
  created_at: number;
  updated_at: number;
  status: JobStatus;
  image_path: string | null;
  raw_image_path: string | null;
  processed_image_path: string | null;
  capture_uid: string | null;
  extracted_json: string | null;
  top3_json: string | null;
  retry_count: number;
  error_code: string | null;
  error_message: string | null;
  operator_id: string | null;
  session_id: string | null;
  timings_json: string | null;
  processor_id: string | null;
  locked_at: number | null;
  inference_path: string | null;
  // Phase 2/3 inventory fields
  product_sku: string | null;
  listing_sku: string | null;
  item_uid: string | null;
  cm_card_id: string | null;
  scan_fingerprint: string | null;
  // Phase 4: Manual override and manifest tracking
  ppt_failure_count: number | null;
  staging_ready: number | null; // SQLite boolean (0/1)
  manual_override: number | null; // SQLite boolean (0/1)
  accepted_without_canonical: number | null; // SQLite boolean (0/1)
  // Nov 7 MVP: Truth Core persistence
  accepted_name: string | null;
  accepted_hp: number | null;
  accepted_collector_no: string | null;
  accepted_set_name: string | null;
  accepted_set_size: number | null;
  accepted_variant_tags: string | null; // JSON-encoded string array
  // Camera control audit trail
  camera_applied_controls_json: string | null;
  // Stage 1 lifecycle flags
  front_locked: number | null;
  back_ready: number | null;
  canonical_locked: number | null;
  scan_orientation: string | null;
  // Master crop (Stage 1.5)
  master_image_path: string | null;
  master_cdn_url: string | null;
}

const serialize = (value: unknown) => JSON.stringify(value ?? null);
const deserialize = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    return fallback;
  }
};

const now = () => Date.now();

export class JobRepository {
  constructor(private readonly db: Database.Database) { }

  create(job: Omit<ScanJob, "created_at" | "updated_at" | "processor_id" | "locked_at">): ScanJob {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO scans (
          id, created_at, updated_at, status, image_path, capture_uid, extracted_json, top3_json,
          retry_count, error_code, error_message, operator_id, session_id, timings_json,
          processor_id, locked_at
        ) VALUES (@id, @created_at, @updated_at, @status, @image_path, @capture_uid, @extracted_json,
          @top3_json, @retry_count, @error_code, @error_message, @operator_id, @session_id,
          @timings_json, NULL, NULL)`
      )
      .run({
        id: job.id,
        created_at: timestamp,
        updated_at: timestamp,
        status: job.status,
        image_path: job.image_path ?? null,
        capture_uid: job.capture_uid ?? null,
        extracted_json: serialize(job.extracted),
        top3_json: serialize(job.top3),
        retry_count: job.retry_count ?? 0,
        error_code: job.error_code ?? null,
        error_message: job.error_message ?? null,
        operator_id: job.operator_id ?? null,
        session_id: job.session_id ?? null,
        timings_json: serialize(job.timings ?? {}),
      });

    return {
      ...job,
      created_at: timestamp,
      updated_at: timestamp,
      processor_id: undefined,
      locked_at: undefined,
    };
  }

  updateStatus(
    id: string,
    status: JobStatus,
    timings?: Partial<StageTimings>,
  ): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    const mergedTimings = { ...existing.timings, ...timings };
    this.db
      .prepare(
        `UPDATE scans
         SET status = @status,
             updated_at = @updated_at,
             timings_json = @timings_json
         WHERE id = @id`
      )
      .run({
        id,
        status,
        updated_at: timestamp,
        timings_json: serialize(mergedTimings),
      });
  }

  /**
   * Nov 18 Production: Accept with Truth Core + Inventory (Atomic Stage 1→2 Transition)
   * Persist the final operator-confirmed truth (Name, HP, Collector No, Set Name)
   * AND the Stage 2 inventory results (item_uid, product_uid) in a single atomic update.
   * This ensures Accept is all-or-nothing: either both succeed or neither happens.
   * Caller must create inventory FIRST, then pass results here.
   */
  acceptWithTruthCoreAndInventory(
    id: string,
    truthCore: {
      name: string;
      hp: number | null;
      collector_no: string;
      set_name: string;
      set_size: number | null;
      variant_tags?: string[];
    },
    inventoryResult: {
      item_uid: string | null;
      product_uid: string | null;
    },
    timings?: Partial<StageTimings>,
  ): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    const mergedTimings = { ...existing.timings, ...timings };
    this.db
      .prepare(
        `UPDATE scans
         SET status = @status,
             accepted_name = @accepted_name,
             accepted_hp = @accepted_hp,
             accepted_collector_no = @accepted_collector_no,
             accepted_set_name = @accepted_set_name,
             accepted_set_size = @accepted_set_size,
             accepted_variant_tags = @accepted_variant_tags,
             item_uid = @item_uid,
             updated_at = @updated_at,
             timings_json = @timings_json
         WHERE id = @id`
      )
      .run({
        id,
        status: "ACCEPTED",
        accepted_name: truthCore.name,
        accepted_hp: truthCore.hp,
        accepted_collector_no: truthCore.collector_no,
        accepted_set_name: truthCore.set_name,
        accepted_set_size: truthCore.set_size,
        accepted_variant_tags: JSON.stringify(truthCore.variant_tags ?? []),
        item_uid: inventoryResult.item_uid,
        updated_at: timestamp,
        timings_json: serialize(mergedTimings),
      });
  }

  /**
   * Nov 28 Baseline: Accept for baseline validation only (no inventory/products).
   * Updates scans table with ACCEPTED status and truth core values,
   * but does NOT set item_uid or product_uid (no inventory created).
   */
  acceptForBaselineOnly(
    id: string,
    truthCore: {
      name: string;
      hp: number | null;
      collector_no: string;
      set_name: string;
      set_size: number | null;
      variant_tags?: string[];
    }
  ): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    this.db
      .prepare(
        `UPDATE scans
         SET status = @status,
             accepted_name = @accepted_name,
             accepted_hp = @accepted_hp,
             accepted_collector_no = @accepted_collector_no,
             accepted_set_name = @accepted_set_name,
             accepted_set_size = @accepted_set_size,
             accepted_variant_tags = @accepted_variant_tags,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        status: "ACCEPTED",
        accepted_name: truthCore.name,
        accepted_hp: truthCore.hp,
        accepted_collector_no: truthCore.collector_no,
        accepted_set_name: truthCore.set_name,
        accepted_set_size: truthCore.set_size,
        accepted_variant_tags: JSON.stringify(truthCore.variant_tags ?? []),
        updated_at: timestamp,
      });
  }

  /**
   * Nov 19 Production: Lock front image (Stage 1A - Ready for Back Capture)
   * Operator confirms this front scan is the keeper.
   * Unlocks back capture without requiring Stage 2 (final Accept).
   */
  lockFront(id: string): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    const allowableStatuses: JobStatus[] = [
      "OPERATOR_PENDING",
      "CANDIDATES_READY",
      "UNMATCHED_NO_REASONABLE_CANDIDATE",
      "NEEDS_REVIEW",
    ];
    if (!allowableStatuses.includes(existing.status)) {
      throw new Error(
        `Cannot lock front: scan ${id} status is ${existing.status} (expected one of ${allowableStatuses.join(
          ", "
        )})`
      );
    }
    if (!existing.processed_image_path && !existing.raw_image_path) {
      throw new Error(`Cannot lock front: scan ${id} has no front image`);
    }
    this.db
      .prepare(
        `UPDATE scans
         SET front_locked = 1,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, updated_at: timestamp });
  }

  /**
   * Nov 19 Production: Mark back image as ready (Stage 1B - Back Attached)
   * Called by back capture daemon after uploading back image.
   * Requires front to be locked first.
   */
  markBackReady(id: string): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    if (!existing.front_locked) {
      throw new Error(`Cannot mark back ready: scan ${id} front not locked yet (lock front first)`);
    }
    this.db
      .prepare(
        `UPDATE scans
         SET back_ready = 1,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, updated_at: timestamp });
  }

  /**
   * Nov 19 Production: Lock canonical ID (Stage 1B - Canonical Locked)
   * Nov 21 Relaxed: Allow locking even without cm_card_id match (operator-verified Truth Core sufficient)
   * Operator confirms the canonical identity is correct (explicit or implicit acceptance).
   * Required before final Accept (Stage 2).
   */
  lockCanonical(id: string): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }

    // Relaxed canonical lock (Nov 21): Allow locking even without cm_card_id
    // Operator-verified Truth Core (accepted_name, accepted_set_name, accepted_collector_no) is sufficient
    // Set reconciliation_status = 'pending' when cm_card_id is NULL or UNKNOWN_*
    const hasValidCmCardId =
      existing.cm_card_id &&
      existing.cm_card_id.trim().length > 0 &&
      !existing.cm_card_id.toUpperCase().startsWith("UNKNOWN_");

    const reconciliationStatus = hasValidCmCardId ? null : 'pending';

    this.db
      .prepare(
        `UPDATE scans
         SET canonical_locked = 1,
             reconciliation_status = @reconciliation_status,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, reconciliation_status: reconciliationStatus, updated_at: timestamp });
  }

  /**
   * Persist an operator-provided Truth Core snapshot without changing status.
   * Used when locking canonical prior to Accept so reconciliation/export see HITL-ed fields.
   */
  persistTruthCoreSnapshot(
    id: string,
    truthCore: {
      name: string;
      hp: number | null;
      collector_no: string;
      set_name: string;
      set_size?: number | null;
      variant_tags?: string[];
    }
  ): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    this.db
      .prepare(
        `UPDATE scans
         SET accepted_name = @name,
             accepted_hp = @hp,
             accepted_collector_no = @collector_no,
             accepted_set_name = @set_name,
             accepted_set_size = @set_size,
             accepted_variant_tags = @variant_tags,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        name: truthCore.name,
        hp: truthCore.hp,
        collector_no: truthCore.collector_no,
        set_name: truthCore.set_name,
        set_size: truthCore.set_size ?? null,
        variant_tags: JSON.stringify(truthCore.variant_tags ?? []),
        updated_at: timestamp,
      });
  }

  /**
   * Update timing metrics without changing job status
   * Used for preview_ready_ms, processed_ready_ms, etc.
   */
  updateTimings(id: string, timings: Partial<StageTimings>): void {
    const timestamp = now();
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Scan ${id} not found`);
    }
    const mergedTimings = { ...existing.timings, ...timings };
    this.db
      .prepare(
        `UPDATE scans
         SET updated_at = @updated_at,
             timings_json = @timings_json
         WHERE id = @id`
      )
      .run({
        id,
        updated_at: timestamp,
        timings_json: serialize(mergedTimings),
      });
  }

  attachCandidates(id: string, extracted: ExtractedFields, candidates: Candidate[]): void {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Scan ${id} not found`);
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET extracted_json = @extracted_json,
             top3_json = @top3_json,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        extracted_json: serialize(extracted),
        top3_json: serialize(candidates),
        updated_at: timestamp,
      });
  }

  updateImagePath(id: string, imagePath: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET image_path = @image_path,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, image_path: imagePath, updated_at: timestamp });
  }

  /**
   * Update raw and processed image paths, preferring processed for image_path.
   * Only updates columns when values are explicitly provided (not undefined).
   * This prevents watchers from wiping processed_image_path when re-processing raw files.
   */
  updateImagePaths(id: string, rawPath: string | undefined, processedPath: string | undefined): void {
    const timestamp = now();

    // Build SET clauses only for defined values to preserve existing data
    const updates: string[] = ['updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, updated_at: timestamp };

    if (rawPath !== undefined) {
      updates.push('raw_image_path = @raw_path');
      params.raw_path = rawPath;
    }

    if (processedPath !== undefined) {
      updates.push('processed_image_path = @processed_path');
      updates.push('image_path = @processed_path');
      params.processed_path = processedPath;
    } else if (rawPath !== undefined) {
      // Only update image_path if no processed path provided
      // Use COALESCE to prefer existing processed_image_path over new rawPath
      updates.push('image_path = COALESCE(processed_image_path, @raw_path)');
    }

    const sql = `UPDATE scans SET ${updates.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(params);
  }

  /**
   * Update only the processed image path after Stage 2
   */
  updateProcessedImagePath(id: string, processedPath: string): void {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE scans
         SET processed_image_path = @processed_path,
             image_path = @processed_path,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, processed_path: processedPath, updated_at: timestamp });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update processed_image_path for scan ${id}: no rows affected (job may not exist)`);
    }
  }

  /**
   * Update corrected image path after Stage 1 (distortion correction)
   */
  updateCorrectedImagePath(id: string, correctedPath: string): void {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE scans
         SET corrected_image_path = @corrected_path,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, corrected_path: correctedPath, updated_at: timestamp });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update corrected_image_path for scan ${id}: no rows affected (job may not exist)`);
    }
  }

  /**
   * Nov 19 Production: Update back image path on front scan
   * Called by SFTP ingestion when back capture is directly attached
   */
  updateBackImagePath(id: string, backImagePath: string): void {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE scans
         SET back_image_path = @back_image_path,
             back_ready = 1,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, back_image_path: backImagePath, updated_at: timestamp });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update back_image_path for scan ${id}: no rows affected (job may not exist)`);
    }
  }

  /**
   * Update master image info (Stage 1.5)
   */
  updateMasterInfo(id: string, masterPath: string, masterCdnUrl: string | null): void {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE scans
         SET master_image_path = @master_path,
             master_cdn_url = @master_cdn_url,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        master_path: masterPath,
        master_cdn_url: masterCdnUrl,
        updated_at: timestamp
      });

    if (result.changes === 0) {
      throw new Error(`Failed to update master info for scan ${id}: no rows affected`);
    }
  }

  /**
   * Update CDN image URL for a scan after publishing (Stage 3 → CDN)
   */
  updateScanCdnImageUrl(
    scanId: string,
    cdnUrl: string,
    listingPath: string
  ): void {
    const timestamp = now();
    const result = this.db
      .prepare(
        `UPDATE scans
         SET cdn_image_url = @cdn_url,
             listing_image_path = @listing_path,
             cdn_published_at = @published_at,
             updated_at = @updated_at
         WHERE id = @scan_id`
      )
      .run({
        scan_id: scanId,
        cdn_url: cdnUrl,
        listing_path: listingPath,
        published_at: timestamp,
        updated_at: timestamp
      });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update CDN URL for scan ${scanId}: no rows affected`);
    }
  }

  /**
   * Update CDN image URL for a product after publishing
   */
  updateProductCdnUrl(
    productUid: string,
    cdnUrl: string,
    listingPath: string,
    primaryScanId: string,
    cdnPublishedAt: number
  ): void {
    const result = this.db
      .prepare(
        `UPDATE products
         SET cdn_image_url = @cdn_url,
             listing_image_path = @listing_path,
             primary_scan_id = @primary_scan_id,
             cdn_published_at = @cdn_published_at
         WHERE product_uid = @product_uid`
      )
      .run({
        product_uid: productUid,
        cdn_url: cdnUrl,
        listing_path: listingPath,
        primary_scan_id: primaryScanId,
        cdn_published_at: cdnPublishedAt
      });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update CDN URL for product ${productUid}: no rows affected`);
    }
  }

  /**
   * Update CDN back image URL for a product after publishing back image (Phase 2J)
   */
  updateProductCdnBackUrl(
    productUid: string,
    cdnUrl: string,
    backScanId: string
  ): void {
    const result = this.db
      .prepare(
        `UPDATE products
         SET cdn_back_image_url = @cdn_url,
             updated_at = @updated_at
         WHERE product_uid = @product_uid`
      )
      .run({
        product_uid: productUid,
        cdn_url: cdnUrl,
        updated_at: now()
      });

    // Guard: Verify the write succeeded
    if (result.changes === 0) {
      throw new Error(`Failed to update back CDN URL for product ${productUid}: no rows affected`);
    }
  }

  /**
   * Update master back CDN URL for a product after publishing cropped back image.
   */
  updateProductMasterBackUrl(
    productUid: string,
    cdnUrl: string
  ): void {
    const result = this.db
      .prepare(
        `UPDATE products
         SET master_back_cdn_url = @cdn_url,
             updated_at = @updated_at
         WHERE product_uid = @product_uid`
      )
      .run({
        product_uid: productUid,
        cdn_url: cdnUrl,
        updated_at: now()
      });

    if (result.changes === 0) {
      throw new Error(`Failed to update master back CDN URL for product ${productUid}: no rows affected`);
    }
  }

  /**
   * Insert or replace product_images row for normalized image tracking (Phase 2J)
   */
  insertProductImage(
    productUid: string,
    orientation: 'front' | 'back',
    rawPath: string | null,
    processedPath: string | null,
    cdnUrl: string | null,
    publishedAt: number | null,
    sourceScanId: string | null
  ): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO product_images (
           product_uid, orientation, raw_path, processed_path, cdn_url,
           published_at, source_scan_id, created_at, updated_at
         )
         VALUES (@product_uid, @orientation, @raw_path, @processed_path, @cdn_url,
                 @published_at, @source_scan_id, @created_at, @updated_at)
         ON CONFLICT(product_uid, orientation) DO UPDATE SET
           raw_path = @raw_path,
           processed_path = @processed_path,
           cdn_url = @cdn_url,
           published_at = @published_at,
           source_scan_id = @source_scan_id,
           updated_at = @updated_at`
      )
      .run({
        product_uid: productUid,
        orientation,
        raw_path: rawPath,
        processed_path: processedPath,
        cdn_url: cdnUrl,
        published_at: publishedAt,
        source_scan_id: sourceScanId,
        created_at: timestamp,
        updated_at: timestamp
      });
  }

  listRecent(limit = 10): ScanJob[] {
    const rows = this.db
      .prepare(
        `SELECT
          s.*,
          p.staging_ready,
          p.accepted_without_canonical,
          CASE WHEN p.manual_reason_code IS NOT NULL THEN 1 ELSE 0 END as manual_override
         FROM scans s
         LEFT JOIN items i ON s.item_uid = i.item_uid
         LEFT JOIN products p ON i.product_uid = p.product_uid
         ORDER BY s.created_at DESC LIMIT ?`
      )
      .all(limit) as DbRow[];

    return rows.map((row) => this.mapRow(row));
  }

  getById(id: string): ScanJob | null {
    const row = this.db.prepare(
      `SELECT
        s.*,
        p.staging_ready,
        p.accepted_without_canonical,
        CASE WHEN p.manual_reason_code IS NOT NULL THEN 1 ELSE 0 END as manual_override
       FROM scans s
       LEFT JOIN items i ON s.item_uid = i.item_uid
       LEFT JOIN products p ON i.product_uid = p.product_uid
       WHERE s.id = ?`
    ).get(id) as DbRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  getBySessionId(sessionId: string): ScanJob | null {
    const row = this.db
      .prepare(`SELECT * FROM scans WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as DbRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  getByCaptureUid(captureUid: string): ScanJob | null {
    const row = this.db
      .prepare(`SELECT * FROM scans WHERE capture_uid = ? LIMIT 1`)
      .get(captureUid) as DbRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  queueDepth(): number {
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM scans WHERE status IN (${placeholders})`
      )
      .get(...ACTIVE_STATES) as { count: number };
    return row?.count ?? 0;
  }

  claimNextPending(processorId: string, lockTimeoutMs: number): ScanJob | null {
    const expiredThreshold = now() - lockTimeoutMs;
    const claim = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM scans
           WHERE status IN ('QUEUED','CAPTURED')
             AND (processor_id IS NULL OR locked_at IS NULL OR locked_at < @expired)
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .get({ expired: expiredThreshold }) as DbRow | undefined;

      if (!row) {
        return null;
      }

      const timestamp = now();
      this.db
        .prepare(
          `UPDATE scans
           SET status = 'INFERENCING',
               processor_id = @processor_id,
               locked_at = @locked_at,
               updated_at = @updated_at
           WHERE id = @id`
        )
        .run({
          id: row.id,
          processor_id: processorId,
          locked_at: timestamp,
          updated_at: timestamp,
        });

      row.status = "INFERENCING";
      row.processor_id = processorId;
      row.locked_at = timestamp;
      row.updated_at = timestamp;

      return this.mapRow(row);
    });

    return claim();
  }

  releaseJob(id: string): void {
    this.db
      .prepare(
        `UPDATE scans
         SET processor_id = NULL,
             locked_at = NULL
         WHERE id = @id`
      )
      .run({ id });
  }

  updateError(id: string, errorCode: string, errorMessage: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET error_code = @error_code,
             error_message = @error_message,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, error_code: errorCode, error_message: errorMessage, updated_at: timestamp });
  }

  updateInferencePath(id: string, inferencePath: "openai" | "lmstudio"): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET inference_path = @inference_path,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, inference_path: inferencePath, updated_at: timestamp });
  }

  updateCameraAppliedControls(id: string, controls: Record<string, unknown>): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET camera_applied_controls_json = @controls_json,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, controls_json: serialize(controls), updated_at: timestamp });
  }

  incrementRetry(id: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET retry_count = retry_count + 1,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, updated_at: timestamp });
  }

  incrementPptFailureCount(id: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE scans
         SET ppt_failure_count = COALESCE(ppt_failure_count, 0) + 1,
             updated_at = @updated_at
         WHERE id = @id`
      )
      .run({ id, updated_at: timestamp });
  }

  /**
   * Clear the queue by deleting all jobs in ACTIVE_STATES.
   * Used during session start/end to ensure clean state.
   * Returns the count of jobs deleted.
   */
  clearQueue(): number {
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const result = this.db
      .prepare(`DELETE FROM scans WHERE status IN (${placeholders})`)
      .run(...ACTIVE_STATES);
    return result.changes;
  }

  /**
   * Get product_uid by job/scan ID (for EverShop auto-import)
   * Traverses: scans → items → products
   */
  getProductByJobId(jobId: string): { product_uid: string } | null {
    return this.db
      .prepare(
        `SELECT p.product_uid
         FROM scans s
         JOIN items i ON s.item_uid = i.item_uid
         JOIN products p ON i.product_uid = p.product_uid
         WHERE s.id = ?`,
      )
      .get(jobId) as { product_uid: string } | null;
  }

  private mapRow(row: DbRow): ScanJob {
    return {
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status: row.status,
      image_path: row.image_path ?? undefined,
      raw_image_path: row.raw_image_path ?? undefined,
      processed_image_path: row.processed_image_path ?? undefined,
      capture_uid: row.capture_uid ?? undefined,
      extracted: deserialize(row.extracted_json, {} as ExtractedFields),
      top3: deserialize(row.top3_json, [] as Candidate[]),
      retry_count: row.retry_count ?? 0,
      error_code: row.error_code ?? undefined,
      error_message: row.error_message ?? undefined,
      operator_id: row.operator_id ?? undefined,
      session_id: row.session_id ?? undefined,
      timings: deserialize(row.timings_json, {} as StageTimings),
      processor_id: row.processor_id ?? undefined,
      locked_at: row.locked_at ?? undefined,
      inference_path: row.inference_path as "openai" | "lmstudio" | undefined,
      // Phase 2/3 inventory fields
      product_sku: row.product_sku ?? undefined,
      listing_sku: row.listing_sku ?? undefined,
      item_uid: row.item_uid ?? undefined,
      cm_card_id: row.cm_card_id ?? undefined,
      scan_fingerprint: row.scan_fingerprint ?? undefined,
      // Phase 4: Manual override and manifest tracking
      ppt_failure_count: row.ppt_failure_count ?? 0,
      staging_ready: row.staging_ready === 1,
      manual_override: row.manual_override === 1,
      accepted_without_canonical: row.accepted_without_canonical === 1,
      // Camera control audit trail
      camera_applied_controls: deserialize(row.camera_applied_controls_json, undefined as Record<string, unknown> | undefined),
      // Stage 1 lifecycle flags (Nov 19, 2025: Two-stage capture flow)
      front_locked: row.front_locked === 1,
      back_ready: row.back_ready === 1,
      canonical_locked: row.canonical_locked === 1,
      scan_orientation: (row.scan_orientation as "front" | "back") ?? undefined,
      // Master crop (Stage 1.5)
      master_image_path: row.master_image_path ?? undefined,
      master_cdn_url: row.master_cdn_url ?? undefined,
      // Operator-verified Truth Core (persisted on Lock Canonical / Accept)
      accepted_name: row.accepted_name ?? undefined,
      accepted_hp: row.accepted_hp ?? undefined,
      accepted_collector_no: row.accepted_collector_no ?? undefined,
      accepted_set_name: row.accepted_set_name ?? undefined,
      accepted_set_size: row.accepted_set_size ?? undefined,
      accepted_variant_tags: row.accepted_variant_tags
        ? (JSON.parse(row.accepted_variant_tags) as string[])
        : undefined,
    };
  }
}
