/**
 * Capture & Jobs Routes
 *
 * Phase 3 extraction (Nov 2025).
 * Handles image capture, uploads, job management, evidence generation, and variant expansion.
 * See apps/backend/docs/routes-captureAndJobs.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../app/context";
import { CorpusUnavailableError } from "../services/retrieval/pricechartingRepository";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function registerCaptureAndJobsRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, queue, jobRepo, captureAdapter, sessionService, retrievalService, manifestWriter } = ctx;

  // Multer configuration for image uploads
  const uploadDir = path.resolve(runtimeConfig.captureOutputDir);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(file.originalname);
      cb(null, `upload-${timestamp}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (_req, file, cb) => {
      const allowedMimes = ["image/png", "image/jpeg", "image/jpg"];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Only PNG and JPEG images are allowed"));
      }
    },
  });

  /**
   * POST /api/capture
   * Trigger camera capture (Pi5 or Sony driver)
   */
  app.post("/api/capture", async (_req: Request, res: Response) => {
    if (ctx.isShuttingDown()) {
      return res.status(503).json({
        error: "Server shutting down",
        message: "Capture requests blocked during shutdown",
      });
    }

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

    const depthBefore = queue.getQueueDepth();

    try {
      const captureResult = await captureAdapter.capture();
      const depthAfterCapture = queue.getQueueDepth();
      const warning = depthAfterCapture >= runtimeConfig.queueWarnDepth;

      if (captureResult.exitCode !== 0) {
        return res.status(500).json({
          error: "Capture command failed",
          exitCode: captureResult.exitCode,
          output: captureResult.output,
          timedOut: captureResult.timedOut,
          queueDepthBefore: depthBefore,
          queueDepthAfter: depthAfterCapture,
          warning,
        });
      }

      let job = captureResult.job ?? null;
      if (job?.id) {
        queue.updateStatus(job.id, "CAPTURED");
        job = queue.getById(job.id) ?? job;
        // Emit capture_triggered event with error handling
        void (async () => {
          try {
            await sessionService.emitEvent("capture_triggered", "info", `Capture triggered`, {
              jobId: job.id,
              status: "CAPTURED",
            });
          } catch (err) {
            logger.warn({ err }, "Failed to emit capture_triggered event");
          }
        })();
      } else if (captureAdapter.getDriverName() === "pi-hq") {
        // Pi5 driver: parse UID from response and create/retrieve placeholder
        try {
          const payload = JSON.parse(captureResult.output);
          const uid = payload.uid;
          if (uid) {
            // Check if SFTP already created the job (race condition)
            job = queue.getByCaptureUid(uid);
            if (job) {
              logger.info({ jobId: job.id, uid }, "SFTP job already exists for capture");
            } else {
              // Create placeholder job for instant UI feedback
              job = queue.enqueue({
                sessionId: activeSession.id,
                captureUid: uid,
                initialStatus: "CAPTURING"
              });
              logger.info({ jobId: job.id, sessionUuid: activeSession.id, kioskUid: uid }, "Created placeholder job for capture");
            }
            // Emit capture_triggered event with kiosk UID
            void (async () => {
              try {
                await sessionService.emitEvent("capture_triggered", "info", `Capture triggered (kiosk UID)`, {
                  uid,
                  jobId: job?.id,
                  sessionId: activeSession.id,
                });
              } catch (err) {
                logger.warn({ err }, "Failed to emit capture_triggered event");
              }
            })();
          }
        } catch (parseError) {
          logger.warn({ err: parseError, output: captureResult.output }, "Failed to parse Pi5 capture UID");
        }
      } else if (captureAdapter.getDriverName() === "sony") {
        logger.warn({ output: captureResult.output }, "Capture succeeded but job metadata missing");
      }

      res.json({
        ok: true,
        job: job ?? null,
        rawOutput: captureResult.output,
        queueDepthBefore: depthBefore,
        queueDepthAfter: queue.getQueueDepth(),
        warning,
        timedOut: captureResult.timedOut,
      });
    } catch (error) {
      logger.error({ err: error }, "Capture invocation error");
      res.status(500).json({
        error: "Capture invocation error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/products/:product_uid/capture-back
   * Capture back image for an existing product (Phase 2J)
   */
  app.post("/api/products/:product_uid/capture-back", async (req: Request, res: Response) => {
    const { product_uid } = req.params;

    if (ctx.isShuttingDown()) {
      return res.status(503).json({
        error: "Server shutting down",
        message: "Capture requests blocked during shutdown",
      });
    }

    // Verify product exists and find most recent scan
    const product = db.prepare(`
      SELECT p.product_uid, p.card_name, s.id as scan_id
      FROM products p
      LEFT JOIN scans s ON s.product_uid = p.product_uid
      WHERE p.product_uid = ?
      ORDER BY s.created_at DESC
      LIMIT 1
    `).get(product_uid) as {
      product_uid: string;
      card_name: string;
      scan_id: string | null;
    } | undefined;

    if (!product) {
      return res.status(404).json({
        error: "Product not found",
        product_uid,
      });
    }

    if (!product.scan_id) {
      return res.status(400).json({
        error: "No scans found for product",
        message: "Product must have at least one scan before capturing back image",
        product_uid,
      });
    }

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

    try {
      // Set expectation for SFTP to attach back image directly
      queue.expectBackCapture(activeSession.id, product.scan_id);

      let captureUid: string | undefined;

      try {
        const captureResult = await captureAdapter.capture();

        if (captureResult.exitCode !== 0) {
          queue.resolveBackCapture(activeSession.id);
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
              queue.attachBackCaptureUid(captureUid, product.scan_id);
            }
          } catch (parseError) {
            logger.warn({ err: parseError, output: captureResult.output }, "Failed to parse Pi5 back capture UID");
          }
        }

        logger.info(
          { product_uid, frontScanId: product.scan_id, captureUid, card_name: product.card_name },
          "Back image capture triggered for product - SFTP will attach directly to scan"
        );

        // Emit event
        await sessionService.emitEvent(
          "back_image_capture_triggered",
          "info",
          `Back image capture triggered for ${product.card_name}`,
          {
            product_uid,
            frontScanId: product.scan_id,
            captureUid,
          }
        );

        res.json({
          ok: true,
          product_uid,
          frontScanId: product.scan_id,
          captureUid,
          orientation: "back",
          message: `Back image capture triggered for ${product.card_name} - SFTP will attach to scan`,
        });
      } catch (error) {
        queue.resolveBackCapture(activeSession.id, captureUid);
        throw error;
      }
    } catch (error) {
      logger.error({ err: error, product_uid }, "Back capture invocation error");
      res.status(500).json({
        error: "Back capture invocation error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/upload
   * Upload an image file for processing
   */
  app.post("/api/upload", upload.single("image"), async (req: Request, res: Response) => {
    if (ctx.isShuttingDown()) {
      return res.status(503).json({
        error: "Server shutting down",
        message: "Upload requests blocked during shutdown",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please provide an image file in the 'image' field",
      });
    }

    // Gate on active RUNNING session
    const activeSession = await sessionService.getActiveSession();
    if (!activeSession || activeSession.status !== "RUNNING") {
      return res.status(409).json({
        error: "Session not active",
        message: "Start a session (RUNNING state) before uploading",
        current_status: activeSession?.status ?? "PREP",
      });
    }

    const depthBefore = queue.getQueueDepth();
    const file = req.file;

    try {
      const imagePath = file.path;
      const sessionId = req.body.sessionId || undefined;

      logger.info({ imagePath, sessionId, originalName: file.originalname }, "Image uploaded, creating job");

      const job = queue.enqueue({ imagePath, sessionId });
      const depthAfter = queue.getQueueDepth();
      const warning = depthAfter >= runtimeConfig.queueWarnDepth;

      // Emit placeholder_attached event
      void (async () => {
        try {
          await sessionService.emitEvent("placeholder_attached", "info", `Image uploaded (placeholder created)`, {
            jobId: job.id,
            sessionId: sessionId || null,
            originalName: file.originalname,
          });
        } catch (err) {
          logger.warn({ err }, "Failed to emit placeholder_attached event");
        }
      })();

      res.status(202).json({
        ok: true,
        job,
        queueDepthBefore: depthBefore,
        queueDepthAfter: depthAfter,
        warning,
      });
    } catch (error) {
      logger.error({ err: error }, "Upload processing error");
      res.status(500).json({
        error: "Upload processing error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/jobs
   * Enqueue a job directly (internal use)
   */
  app.post("/api/jobs", (req: Request, res: Response) => {
    const { imagePath, sessionId } = req.body ?? {};
    const job = queue.enqueue({ imagePath, sessionId });
    res.status(202).json({ job });
  });

  /**
   * POST /api/jobs/:id/status
   * Update job status
   */
  app.post("/api/jobs/:id/status", (req: Request, res: Response) => {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (typeof status !== "string") {
      return res.status(400).json({ error: "status is required" });
    }
    try {
      queue.updateStatus(id, status as any);
      res.json({ ok: true });
    } catch (error) {
      logger.error(error);
      res.status(404).json({ error: "job not found" });
    }
  });

  /**
   * POST /api/jobs/:id/candidates
   * Attach candidates to a job
   */
  app.post("/api/jobs/:id/candidates", (req: Request, res: Response) => {
    const { id } = req.params;
    const { extracted, candidates } = req.body ?? {};
    try {
      queue.attachCandidates(id, extracted ?? {}, candidates ?? []);
      res.json({ ok: true });
    } catch (error) {
      logger.error(error);
      res.status(404).json({ error: "job not found" });
    }
  });

  /**
   * GET /api/jobs/recent
   * Get recent jobs
   */
  app.get("/api/jobs/recent", (_req: Request, res: Response) => {
    res.json({ jobs: queue.getRecent(10) });
  });

  /**
   * GET /api/jobs/:id
   * Fetch a single job by id
   */
  app.get("/api/jobs/:id", (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const job = queue.getById(id);
      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }
      res.json({ job });
    } catch (error) {
      logger.error(error);
      res.status(500).json({ error: "failed to fetch job" });
    }
  });

  /**
   * GET /api/jobs/:id/image
   * Serve job image (raw, processed, or best)
   */
  app.get("/api/jobs/:id/image", (req: Request, res: Response) => {
    const { id } = req.params;
    const variant = (req.query.variant as string) || "best";

    try {
      const job = queue.getById(id);
      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      // Select image path based on variant
      let imagePath: string | undefined;
      if (variant === "raw") {
        imagePath = job.raw_image_path;
      } else if (variant === "processed") {
        imagePath = job.processed_image_path;
      } else {
        imagePath = job.processed_image_path || job.raw_image_path || job.image_path;
      }

      if (!imagePath) {
        return res.status(404).json({ error: `job has no ${variant} image` });
      }

      const resolved = path.resolve(imagePath);

      if (!fs.existsSync(resolved)) {
        logger.warn({ jobId: id, imagePath, resolved, variant }, "Image file not found");
        return res.status(404).json({ error: `${variant} image not found` });
      }

      // Allowed roots for path traversal guard
      const allowedRoots = [
        path.resolve(__dirname, "../../images/incoming") + path.sep,
        path.resolve(runtimeConfig.sftpWatchPath) + path.sep,
        path.resolve(__dirname, "../../data/corrected-images") + path.sep,
        path.resolve(__dirname, "../../data/sftp-inbox") + path.sep,
      ];

      const isAllowed = allowedRoots.some((root) => resolved.startsWith(root));
      if (!isAllowed) {
        logger.warn(
          { jobId: id, imagePath, resolved, allowedRoots, variant },
          "Path traversal attempt blocked"
        );
        return res.status(403).json({ error: "forbidden" });
      }

      res.setHeader("X-Robots-Tag", "noimageindex, noarchive, noai, noimageai");

      res.sendFile(resolved, (err) => {
        if (err) {
          logger.error({ err, jobId: id, imagePath: resolved, variant }, "Failed to serve image");
          if (!res.headersSent) {
            res.status(404).json({ error: "image file not found" });
          }
        }
      });
    } catch (error) {
      logger.error(error);
      res.status(500).json({ error: "failed to retrieve image" });
    }
  });

  /**
   * GET /api/jobs/:id/evidence
   * Generate evidence for job candidates
   */
  app.get("/api/jobs/:id/evidence", async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const job = jobRepo.getById(id);
      if (!job) {
        return res.status(404).json({
          error: {
            code: "JOB_NOT_FOUND",
            message: "Job not found",
          },
        });
      }

      const evidence = await retrievalService.explainCandidates(job);
      res.setHeader("ETag", `"${evidence.etag}"`);
      res.json({ data: evidence });
    } catch (error) {
      if (error instanceof CorpusUnavailableError) {
        logger.warn({ jobId: id, err: error }, "Evidence generation blocked: corpus unavailable");
        return res.status(503).json({
          error: {
            code: "CORPUS_UNAVAILABLE",
            message: "PriceCharting reference data not loaded - evidence generation unavailable",
          },
        });
      }

      logger.error({ err: error, jobId: id }, "Evidence generation failed");
      res.status(500).json({
        error: {
          code: "EVIDENCE_GENERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  /**
   * GET /api/health/retrieval
   * Lightweight health check for retrieval/evidence readiness
   */
  app.get("/api/health/retrieval", (req: Request, res: Response) => {
    try {
      const hash = retrievalService.getCorpusHash();
      res.json({ corpusReady: Boolean(hash), corpusHash: hash ?? null });
    } catch (error) {
      logger.warn({ err: error }, "Retrieval health check failed");
      res.status(500).json({ corpusReady: false, corpusHash: null });
    }
  });

  /**
   * GET /api/jobs/:id/variants
   * Get sibling variants for a job's candidates
   */
  app.get("/api/jobs/:id/variants", async (req: Request, res: Response) => {
    const { id } = req.params;
    const parsedLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 20;
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 50);

    try {
      const job = jobRepo.getById(id);
      if (!job) {
        return res.status(404).json({
          error: {
            code: "JOB_NOT_FOUND",
            message: "Job not found",
          },
        });
      }

      if (!job.top3 || job.top3.length === 0) {
        logger.info({ jobId: id }, "Variant request for job with empty top3");
        return res.json({
          data: {
            variants: [],
            top3_ids: [],
            corpus_hash: retrievalService.getCorpusHash(),
          },
        });
      }

      const pcCandidates = job.top3.filter((c) => c.id.startsWith("pricecharting::"));
      if (pcCandidates.length === 0) {
        logger.info({ jobId: id }, "Variant request for job with no PriceCharting candidates");
        return res.json({
          data: {
            variants: [],
            top3_ids: job.top3.map((c) => c.id),
            corpus_hash: retrievalService.getCorpusHash(),
          },
        });
      }

      const referenceCandidate = pcCandidates[0];
      const siblings = await retrievalService.getSiblingVariants(referenceCandidate, limit);
      const top3Ids = job.top3.map((c) => c.id);

      res.json({
        data: {
          variants: siblings,
          top3_ids: top3Ids,
          corpus_hash: retrievalService.getCorpusHash(),
        },
      });
    } catch (error) {
      if (error instanceof CorpusUnavailableError) {
        logger.warn({ jobId: id, err: error }, "Variant fetch blocked: corpus unavailable");
        return res.status(503).json({
          error: {
            code: "CORPUS_UNAVAILABLE",
            message: "PriceCharting reference data not loaded - variant expansion unavailable",
          },
        });
      }

      logger.error({ err: error, jobId: id }, "Variant fetch failed");
      res.status(500).json({
        error: {
          code: "VARIANT_FETCH_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  /**
   * GET /api/operator/queue/unmatched
   * Fetch products with UNKNOWN_* cm_card_id (manual canonicalization queue)
   */
  app.get("/api/operator/queue/unmatched", (_req: Request, res: Response) => {
    try {
      const unmatchedProducts = db
        .prepare(
          `SELECT product_uid, cm_card_id, card_name, set_name, collector_no,
                  hp_value, condition_bucket, created_at, updated_at
           FROM products
           WHERE cm_card_id LIKE 'UNKNOWN_%'
           ORDER BY created_at DESC
           LIMIT 100`
        )
        .all();

      const count = db
        .prepare(`SELECT COUNT(*) as count FROM products WHERE cm_card_id LIKE 'UNKNOWN_%'`)
        .get() as { count: number };

      res.json({
        products: unmatchedProducts,
        total_count: count.count,
        page_size: 100,
      });
    } catch (error) {
      logger.error({ error }, "Failed to fetch unmatched products queue");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
