/**
 * Scan Lifecycle Routes
 *
 * Phase 3 router extraction (Nov 2025).
 * Handles manifest access, canonicalization, two-stage capture flow, and rescan.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import type { ExtractedCardData } from "../services/inventory/skuHelpers";

/**
 * Register scan lifecycle routes on the Express app.
 */
export function registerScanRoutes(app: Express, ctx: AppContext): void {
  const {
    db,
    logger,
    queue,
    jobRepo,
    sessionService,
    captureAdapter,
    manifestWriter,
    skuCanonicalizer,
  } = ctx;

  /**
   * GET /api/scans/:id/manifest
   * Fetch JSON manifest with ETag caching (304 if unchanged)
   */
  app.get("/api/scans/:id/manifest", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ifNoneMatch = req.headers["if-none-match"];

      // Fetch scan to get capture_uid (manifest filename is based on capture_uid, not scan id)
      const scan = jobRepo.getById(id);
      if (!scan || !scan.capture_uid) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found or missing capture_uid",
        });
      }

      const result = manifestWriter.getManifest(scan.capture_uid);
      if (!result) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Manifest not found for this scan",
        });
      }

      const { manifest, etag } = result;

      // 304 Not Modified if ETag matches
      if (ifNoneMatch === etag) {
        return res.status(304).end();
      }

      res.setHeader("ETag", etag);
      res.json(manifest);
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to fetch manifest");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * PUT /api/scans/:id/manifest/operator
   * Update operator section with manual override data
   * Validates: reason code enum, note ≥15 chars, positive price
   */
  app.put("/api/scans/:id/manifest/operator", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const {
        accepted,
        accepted_without_canonical,
        canonical_cm_card_id,
        manual_override,
        manual_reason_code,
        manual_note,
        manual_price,
      } = req.body;

      // Fetch scan to get capture_uid for manifest operations
      const scan = jobRepo.getById(id);
      if (!scan || !scan.capture_uid) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found or missing capture_uid",
        });
      }

      // Validation: Manual override requires reason code and note ≥15 chars
      if (manual_override) {
        const validReasonCodes = [
          "PPT_OUTAGE_OR_RATE_LIMIT",
          "PPT_NO_MATCH_OR_INCOMPLETE_DATA",
          "VARIANT_MISMATCH_OR_EDGE_CASE",
          "CONDITION_DRIVEN_ADJUSTMENT",
          "MARKET_ANOMALY_OR_SUDDEN_SWING",
          "OTHER",
        ];

        if (!manual_reason_code || !validReasonCodes.includes(manual_reason_code)) {
          return res.status(400).json({
            error: "INVALID_REASON_CODE",
            message: "Manual override requires a valid reason code",
            valid_codes: validReasonCodes,
          });
        }

        if (!manual_note || manual_note.length < 15) {
          return res.status(400).json({
            error: "INVALID_NOTE",
            message: "Manual override note must be at least 15 characters",
          });
        }

        if (manual_price !== undefined && (typeof manual_price !== "number" || manual_price <= 0 || manual_price > 10000)) {
          return res.status(400).json({
            error: "INVALID_PRICE",
            message: "Manual price must be positive and ≤$10,000",
          });
        }
      }

      // DB transaction (synchronous, atomic)
      const updateProduct = db.prepare(`
        UPDATE products
        SET manual_reason_code = ?,
            manual_note = ?,
            accepted_without_canonical = ?,
            pricing_source = CASE WHEN ? = 1 THEN 'manual' ELSE pricing_source END,
            pricing_status = CASE WHEN ? = 1 THEN 'fresh' ELSE pricing_status END,
            market_price = COALESCE(?, market_price),
            updated_at = ?
        WHERE product_uid IN (
          SELECT i.product_uid FROM scans s
          JOIN items i ON s.item_uid = i.item_uid
          WHERE s.id = ?
        )
      `);

      const updateScan = db.prepare(`
        UPDATE scans
        SET updated_at = ?
        WHERE id = ?
      `);

      const now = Date.now();

      // Atomic DB transaction (synchronous only)
      db.transaction(() => {
        updateProduct.run(
          manual_reason_code || null,
          manual_note || null,
          accepted_without_canonical ? 1 : 0,
          manual_override ? 1 : 0,
          manual_override ? 1 : 0,
          manual_price || null,
          now,
          id
        );
        updateScan.run(now, id);
      })();

      // Manifest updates after DB commit (async, with error handling)
      try {
        await manifestWriter.updateOperator(scan.capture_uid, {
          accepted,
          accepted_without_canonical,
          canonical_cm_card_id,
          manual_override,
          manual_reason_code,
          manual_note,
        });

        if (manual_override) {
          await manifestWriter.archiveManifest(scan.capture_uid);
        }

        await sessionService.emitEvent(
          "manual_override_committed",
          "info",
          "Manual override committed",
          {
            scanId: id,
            reason_code: manual_reason_code,
            note_length: manual_note?.length || 0,
            manual_price,
          }
        );
      } catch (manifestError) {
        // Log manifest failure but don't fail the response (DB already committed)
        logger.error({ error: manifestError, scanId: id, captureUid: scan.capture_uid }, "Manifest update failed after DB commit");
      }

      res.json({
        ok: true,
        message: "Operator section updated successfully",
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to update operator manifest");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/scans/:id/truth-core
   * Persist operator Truth Core edits without changing lock/accept state.
   */
  app.post("/api/scans/:id/truth-core", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const truth = req.body?.truth_core ?? {};

      if (typeof truth !== "object" || truth === null) {
        return res.status(400).json({
          error: "INVALID_TRUTH_CORE",
          message: "truth_core object is required",
        });
      }

      const name = typeof truth.name === "string" ? truth.name.trim() : "";
      const collector_no = typeof truth.collector_no === "string" ? truth.collector_no.trim() : "";
      const set_name = typeof truth.set_name === "string" ? truth.set_name.trim() : "";
      const set_size_raw = truth.set_size;
      const hp_raw = truth.hp;

      if (!name || !collector_no || !set_name) {
        return res.status(400).json({
          error: "TRUTH_CORE_INCOMPLETE",
          message: "Truth Core must include name, set_name, and collector_no to persist",
        });
      }

      const hp =
        hp_raw === null || hp_raw === undefined || hp_raw === ""
          ? null
          : Number.isNaN(Number(hp_raw))
            ? null
            : Number(hp_raw);
      const set_size =
        set_size_raw === null || set_size_raw === undefined || set_size_raw === ""
          ? null
          : Number.isNaN(Number(set_size_raw))
            ? null
            : Number(set_size_raw);

      // Extract and sanitize variant_tags from truth_core
      const variant_tags = Array.isArray(truth.variant_tags)
        ? truth.variant_tags
            .filter((t: unknown) => typeof t === "string")
            .map((t: string) => t.trim())
            .filter((t: string) => t.length > 0)
        : [];

      jobRepo.persistTruthCoreSnapshot(id, {
        name,
        collector_no,
        set_name,
        hp,
        set_size,
        variant_tags,
      });

      const updated = jobRepo.getById(id);

      res.json({
        ok: true,
        accepted: {
          name,
          collector_no,
          set_name,
          hp,
          set_size,
          variant_tags,
        },
        job: updated,
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to persist truth core");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/scans/:id/lock-canonical
   * Relaxed canonical lock: allow operators to lock identity from Truth Core without requiring a cm_card_id match.
   * Uses provided truth_core payload or falls back to extracted fields; marks reconciliation_status when no canonical match.
   */
  app.post("/api/scans/:id/lock-canonical", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const scan = jobRepo.getById(id);
      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      // Stage 1C prerequisite: Stage 1A (front_locked) and Stage 1B (back_ready) must be complete
      if (!scan.front_locked) {
        return res.status(400).json({
          error: "STAGE_1A_REQUIRED",
          message: "Front must be locked before locking canonical (Stage 1A → 1C)",
          required_flags: { front_locked: false, back_ready: scan.back_ready },
        });
      }
      if (!scan.back_ready) {
        return res.status(400).json({
          error: "STAGE_1B_REQUIRED",
          message: "Back image must be captured before locking canonical (Stage 1B → 1C)",
          required_flags: { front_locked: scan.front_locked, back_ready: false },
        });
      }

      // Accept truth core from request (preferred) or fall back to extracted fields
      const truthCore = (req.body && typeof req.body.truth_core === "object" ? (req.body as any).truth_core : null) ?? {
        name: (scan.extracted as any)?.card_name ?? "",
        collector_no: (scan.extracted as any)?.set_number ?? "",
        set_name: (scan.extracted as any)?.set_name ?? "",
        hp: (scan.extracted as any)?.hp_value ?? null,
      };

      if (!truthCore.name || !truthCore.collector_no || !truthCore.set_name) {
        return res.status(400).json({
          error: "TRUTH_CORE_INCOMPLETE",
          message: "Truth Core must include name, set_name, and collector_no before locking canonical",
          truth_core: truthCore,
        });
      }

      // Extract and sanitize variant_tags from truth_core
      const variant_tags = Array.isArray(truthCore.variant_tags)
        ? truthCore.variant_tags
            .filter((t: unknown) => typeof t === "string")
            .map((t: string) => t.trim())
            .filter((t: string) => t.length > 0)
        : [];

      // Persist Truth Core snapshot for reconciliation/export and lock canonical
      jobRepo.persistTruthCoreSnapshot(id, {
        name: truthCore.name,
        hp: truthCore.hp ?? null,
        collector_no: truthCore.collector_no,
        set_name: truthCore.set_name,
        set_size: truthCore.set_size ?? null,
        variant_tags,
      });

      // Lock canonical (repository sets reconciliation_status when cm_card_id missing/UNKNOWN)
      jobRepo.lockCanonical(id);

      // Refresh scan to capture latest cm_card_id/reconciliation_status
      const updated = jobRepo.getById(id);
      const hasValidCmCardId =
        updated?.cm_card_id &&
        updated.cm_card_id.trim().length > 0 &&
        !updated.cm_card_id.toUpperCase().startsWith("UNKNOWN_");

      // If a cm_card_id exists, clear reconciliation_status to remove "pending" badge
      if (hasValidCmCardId) {
        db.prepare(
          `UPDATE scans
           SET reconciliation_status = NULL
           WHERE id = ?`
        ).run(id);
      }

      logger.info(
        {
          scanId: id,
          cm_card_id: scan.cm_card_id,
          has_canonical_match: hasValidCmCardId,
          needs_reconciliation: !hasValidCmCardId,
          canonical_locked: true,
        },
        "Canonical locked (relaxed mode)"
      );

      res.json({
        ok: true,
        message: hasValidCmCardId
          ? "Canonical locked with database match"
          : "Canonical locked without database match (pending reconciliation)",
        canonical_locked: true,
        cm_card_id: updated?.cm_card_id ?? null,
        needs_reconciliation: !hasValidCmCardId,
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to lock canonical");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/scans/:id/canonicalize
   * Resolve UNKNOWN_* cm_card_id to canonical match
   * Updates products table and clears from unmatched queue
   */
  app.post("/api/scans/:id/canonicalize", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { canonical_cm_card_id } = req.body;

      if (!canonical_cm_card_id || canonical_cm_card_id.startsWith("UNKNOWN_")) {
        return res.status(400).json({
          error: "INVALID_CM_CARD_ID",
          message: "Canonical cm_card_id must not start with UNKNOWN_",
        });
      }

      // Verify canonical_cm_card_id exists in cm_cards table
      const canonicalCard = db.prepare(`
        SELECT cm_card_id, card_name, collector_no
        FROM cm_cards
        WHERE cm_card_id = ?
      `).get(canonical_cm_card_id) as { cm_card_id: string; card_name: string; collector_no: string } | undefined;

      if (!canonicalCard) {
        return res.status(404).json({
          error: "CM_CARD_ID_NOT_FOUND",
          message: `Canonical ID "${canonical_cm_card_id}" does not exist in cm_cards table`,
        });
      }

      // Fetch scan to get capture_uid (always required) and optional product linkage
      const scan = jobRepo.getById(id);
      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      // Stage 1C prerequisite: Stage 1A (front_locked) and Stage 1B (back_ready) must be complete
      if (!scan.front_locked) {
        return res.status(400).json({
          error: "STAGE_1A_REQUIRED",
          message: "Front must be locked before canonicalize (Stage 1A → 1C)",
          required_flags: { front_locked: false, back_ready: scan.back_ready },
        });
      }
      if (!scan.back_ready) {
        return res.status(400).json({
          error: "STAGE_1B_REQUIRED",
          message: "Back image must be captured before canonicalize (Stage 1B → 1C)",
          required_flags: { front_locked: scan.front_locked, back_ready: false },
        });
      }

      if (!scan.capture_uid) {
        return res.status(400).json({
          error: "NO_CAPTURE_UID",
          message: "Scan missing capture_uid",
        });
      }

      let product_uid: string | null = null;
      if (scan.item_uid) {
        const itemRow = db.prepare(`
          SELECT product_uid FROM items WHERE item_uid = ?
        `).get(scan.item_uid) as { product_uid: string } | undefined;
        if (itemRow?.product_uid) {
          product_uid = itemRow.product_uid;
          db.prepare(`
            UPDATE products
            SET cm_card_id = ?,
                updated_at = ?
            WHERE product_uid = ?
          `).run(canonical_cm_card_id, Date.now(), product_uid);
        } else {
          logger.warn(
            { scanId: id, item_uid: scan.item_uid },
            "Canonicalization: item has no product_uid (Stage 1 lock only)"
          );
        }
      }

      // Update scan with canonical cm_card_id
      db.prepare(`
        UPDATE scans
        SET cm_card_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(canonical_cm_card_id, Date.now(), id);

      // Update manifest (use capture_uid)
      await manifestWriter.updateOperator(scan.capture_uid, {
        canonical_cm_card_id,
      });

      // Nov 19 Production: Lock canonical ID (Stage 1B transition)
      // Operator has confirmed canonical cm_card_id is correct
      queue.lockCanonical(id);

      // Emit session event
      await sessionService.emitEvent(
        "canonicalize_scan",
        "info",
        "Scan canonicalized",
        {
          scanId: id,
          canonical_cm_card_id,
          product_uid,
          previous_cm_card_id: scan.cm_card_id,
          timestamp: new Date().toISOString(),
          canonical_locked: true, // Stage 1B flag
        }
      );

      logger.info(
        {
          scanId: id,
          canonical_cm_card_id,
          product_uid,
          previous_cm_card_id: scan.cm_card_id,
          canonical_locked: true,
        },
        "Scan canonicalized (Stage 1B)"
      );

      res.json({
        ok: true,
        message: "Scan canonicalized successfully",
        canonical_cm_card_id,
        product_uid,
        canonical_locked: true,
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to canonicalize scan");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/scans/:id/lock-front
   * Nov 19 Production: Lock front image (Stage 1A - Ready for Back Capture)
   * Operator confirms this front scan is the keeper.
   * Enables back capture without requiring Stage 2 (final Accept).
   */
  app.post("/api/scans/:id/lock-front", (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Validate scan exists
      const scan = queue.getById(id);
      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      // Call service layer to lock front (validates preconditions)
      queue.lockFront(id);

      logger.info({ scanId: id }, "Front image locked (Stage 1A)");

      res.json({
        ok: true,
        message: "Front image locked successfully",
        scanId: id,
        front_locked: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, scanId: req.params.id }, "Failed to lock front");
      res.status(400).json({
        error: "LOCK_FRONT_FAILED",
        message: errorMessage,
      });
    }
  });

  /**
   * POST /api/scans/:id/capture-back
   * Nov 19 Production: Capture back image for scan (Stage 1A → Stage 1B)
   * Replaces product-based capture-back endpoint for two-stage flow.
   * Requires front_locked = true (Stage 1A prerequisite).
   */
  app.post("/api/scans/:id/capture-back", async (req: Request, res: Response) => {
    const { id } = req.params;

    if (ctx.isShuttingDown()) {
      return res.status(503).json({
        error: "Server shutting down",
        message: "Capture requests blocked during shutdown",
      });
    }

    try {
      // Validate scan exists
      const scan = queue.getById(id);
      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      // Validate Stage 1A prerequisite: front must be locked
      if (!scan.front_locked) {
        return res.status(400).json({
          error: "FRONT_NOT_LOCKED",
          message: "Front must be locked before capturing back (lock front first)",
        });
      }

      // Validate capture driver available
      const available = await captureAdapter.isAvailable();
      if (!available) {
        return res.status(503).json({
          error: "Capture driver unavailable",
          driver: captureAdapter.getDriverName(),
        });
      }

      // Gate on active RUNNING session
      const activeSession = await sessionService.getActiveSession();
      if (!activeSession || activeSession.status !== "RUNNING") {
        return res.status(409).json({
          error: "Session not active",
          message: "Start a session (RUNNING state) before capturing",
          current_status: activeSession?.status ?? "PREP",
        });
      }

      // Nov 19: Set expectation for SFTP to attach back image directly (no job creation)
      queue.expectBackCapture(activeSession.id, id);

      let captureUid: string | undefined;

      try {
        // Trigger capture
        const captureResult = await captureAdapter.capture();

        if (captureResult.exitCode !== 0) {
          queue.resolveBackCapture(activeSession.id); // Clear expectation on failure
          return res.status(500).json({
            error: "Capture command failed",
            exitCode: captureResult.exitCode,
            output: captureResult.output,
            timedOut: captureResult.timedOut,
          });
        }

        // Parse UID for logging (Pi5 driver only)
        if (captureAdapter.getDriverName() === "pi-hq") {
          try {
            const payload = JSON.parse(captureResult.output);
            captureUid = payload.uid;
            if (captureUid) {
              queue.attachBackCaptureUid(captureUid, id);
            }
          } catch (parseError) {
            logger.warn({ err: parseError, output: captureResult.output }, "Failed to parse Pi5 back capture UID");
          }
        }

        logger.info(
          { frontScanId: id, captureUid, card_name: scan.extracted?.card_name },
          "Back image capture triggered - SFTP will attach directly to front scan"
        );

        // Emit session event
        await sessionService.emitEvent(
          "back_image_capture_triggered",
          "info",
          "Back image capture triggered (SFTP will attach)",
          {
            frontScanId: id,
            captureUid,
            card_name: scan.extracted?.card_name,
          }
        );

        // Return success immediately - SFTP ingestion will attach image and mark back_ready
        res.json({
          ok: true,
          message: "Back image capture triggered - image will be attached by SFTP ingestion",
          frontScanId: id,
          captureUid,
        });
      } catch (error) {
        queue.resolveBackCapture(activeSession.id, captureUid); // Clear expectation on error
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, scanId: id }, "Failed to capture back image");
      res.status(500).json({
        error: "CAPTURE_BACK_FAILED",
        message: errorMessage,
      });
    }
  });

  /**
   * POST /api/scans/:id/canonicalize/suggest
   * Generate a canonical cm_card_id suggestion from operator Truth Core inputs
   * Optional ppt_hint parameter can provide setName and cardNumber from PPT enrichment
   */
  app.post("/api/scans/:id/canonicalize/suggest", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const truth = req.body?.truth_core ?? {};
      const ppt_hint = req.body?.ppt_hint ?? null;

      if (typeof truth !== "object" || truth === null) {
        return res.status(400).json({
          error: "INVALID_TRUTH_CORE",
          message: "truth_core object is required",
        });
      }

      const name = typeof truth.name === "string" ? truth.name.trim() : "";
      const collector_no = typeof truth.collector_no === "string" ? truth.collector_no.trim() : "";
      const rawSetNumber = typeof truth.set_number === "string" ? truth.set_number.trim() : "";
      const set_name = typeof truth.set_name === "string" ? truth.set_name.trim() : "";
      const hp_raw = truth.hp;
      const hasHp = hp_raw !== null && hp_raw !== undefined && hp_raw !== "";
      const hp_value =
        hasHp && !Number.isNaN(Number(hp_raw)) ? Number(hp_raw) : undefined;

      if (!name || !collector_no || !set_name) {
        return res.status(400).json({
          error: "MISSING_FIELDS",
          message: "name, collector_no, and set_name are required",
        });
      }

      const job = queue.getById(id);
      if (!job) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      // Use PPT cardNumber hint if available and collector_no is missing/weak
      let set_number = rawSetNumber || collector_no;
      let ppt_hint_applied = false;
      if (ppt_hint && typeof ppt_hint === "object") {
        const pptCardNumber = typeof ppt_hint.cardNumber === "string" ? ppt_hint.cardNumber.trim() : null;
        const pptSetName = typeof ppt_hint.setName === "string" ? ppt_hint.setName.trim() : null;

        // Apply PPT cardNumber if it's more specific than truth collector_no
        if (pptCardNumber && (!set_number || set_number === collector_no)) {
          set_number = pptCardNumber;
          ppt_hint_applied = true;
          logger.debug(
            { scanId: id, pptCardNumber, pptSetName, originalSetNumber: rawSetNumber || collector_no },
            "PPT hint applied to canonical suggestion"
          );
        }
      }

      const extracted: ExtractedCardData = {
        card_name: name,
        set_number,
        set_name,
      };
      if (hp_value !== undefined) {
        extracted.hp_value = hp_value;
      }

      const suggestion = skuCanonicalizer.canonicalize(extracted, "UNKNOWN");

      logger.info(
        {
          scanId: id,
          truth: { name, collector_no, set_name, hp_value },
          ppt_hint_applied,
          suggestion: suggestion.cm_card_id,
          confidence: suggestion.confidence,
        },
        "Truth-core canonical suggestion generated"
      );

      res.json({
        ok: true,
        suggestion: suggestion.cm_card_id,
        product_sku: suggestion.product_sku,
        listing_sku: suggestion.listing_sku,
        confidence: suggestion.confidence,
        ppt_hint_applied,
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to generate canonical suggestion");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/scans/:id/rescan
   * Re-run Path A inference on existing scan (reuse job, increment retry_count)
   */
  app.post("/api/scans/:id/rescan", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const scan = jobRepo.getById(id);
      if (!scan) {
        return res.status(404).json({
          error: "NOT_FOUND",
          message: "Scan not found",
        });
      }

      if (!scan.capture_uid) {
        return res.status(400).json({
          error: "NO_CAPTURE_UID",
          message: "Scan missing capture_uid",
        });
      }

      if (!scan.processed_image_path && !scan.raw_image_path) {
        return res.status(400).json({
          error: "NO_IMAGE",
          message: "Scan has no image to rescan",
        });
      }

      // Increment retry_count
      const newRetryCount = scan.retry_count + 1;
      db.prepare(`
        UPDATE scans
        SET retry_count = ?,
            status = 'QUEUED',
            updated_at = ?
        WHERE id = ?
      `).run(newRetryCount, Date.now(), id);

      // Update manifest inference retries (use capture_uid)
      const result = manifestWriter.getManifest(scan.capture_uid);
      if (result) {
        await manifestWriter.updateInference(
          scan.capture_uid,
          result.manifest.inference.cm_card_id,
          result.manifest.inference.top_candidates,
          "PathA", // Rescan always uses Path A
          newRetryCount
        );
      }

      // Emit session event
      await sessionService.emitEvent(
        "rescan_triggered",
        "info",
        "Rescan triggered",
        {
          scanId: id,
          retry_count: newRetryCount,
        }
      );

      logger.info({ scanId: id, retry_count: newRetryCount }, "Rescan triggered");

      res.json({
        ok: true,
        message: "Rescan queued successfully",
        retry_count: newRetryCount,
      });
    } catch (error) {
      logger.error({ error, scanId: req.params.id }, "Failed to trigger rescan");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
