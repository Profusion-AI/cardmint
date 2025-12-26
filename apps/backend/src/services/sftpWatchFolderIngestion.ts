/**
 * SFTP Watch-Folder Ingestion Service
 *
 * Monitors SFTP_WATCH_PATH for image+manifest pairs pushed by RPi5 kiosk agent.
 * Enqueues jobs when both .jpg and .json files arrive atomically.
 *
 * Key behaviors:
 * - Ignores `.tmp` files (atomic rename in progress)
 * - Pairs .jpg + .json by stem (ULID/UUID)
 * - Rate-limits burst ingestion (offline queue flush scenario)
 * - Preserves existing normalizer → queue → worker flow
 */

import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import type { Logger } from "pino";
import { JobQueue } from "./jobQueue";
import type { SessionService } from "./sessionService";
import type { CalibrationRepository } from "../repositories/calibrationRepository";
import { runtimeConfig } from "../config";

interface ManifestData {
  uid: string;
  timestamp: number;
  profile?: string;
  camera_controls?: Record<string, unknown>;
  camera_applied_controls?: Record<string, unknown>;
  sensor?: string;
}

export class SftpWatchFolderIngestion {
  private watcher?: FSWatcher;
  private readonly watchPath: string;
  private readonly rateLimitMs = 100; // Min interval between enqueues (burst tolerance)
  private lastEnqueueTime = 0;
  private pendingPairs = new Map<string, { img?: string; meta?: string }>();

  constructor(
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly session?: SessionService,
    private readonly calibrationRepo?: CalibrationRepository
  ) {
    this.watchPath = runtimeConfig.sftpWatchPath;
  }

  start(): void {
    if (this.watcher) {
      this.logger.warn("SFTP watch-folder ingestion already started");
      return;
    }

    // Verify watch path exists with permission check
    try {
      if (!fs.existsSync(this.watchPath)) {
        this.logger.warn({ watchPath: this.watchPath }, "SFTP watch path does not exist, creating");
        fs.mkdirSync(this.watchPath, { recursive: true });
      }

      // Verify write permissions
      fs.accessSync(this.watchPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      this.logger.error(
        { err: error, watchPath: this.watchPath },
        "SFTP watch path not accessible - check permissions. Watch-folder ingestion disabled."
      );
      // Don't throw - allow backend to start but surface error in health check
      return;
    }

    this.watcher = watch(this.watchPath, {
      persistent: true,
      // Important: process existing files on startup so we can recover after backend restarts
      // (kiosk may have already delivered .jpg/.json pairs while backend was down).
      ignoreInitial: false,
      depth: 0, // Watch only the top-level inbox directory (avoid accidental recursive ingestion)
      awaitWriteFinish: {
        stabilityThreshold: 500, // Wait 500ms for write to stabilize
        pollInterval: 100,
      },
      ignored: /\.tmp$/, // Ignore .tmp files (atomic rename in progress)
    });

    this.watcher
      .on("add", (filePath: string) => this.onFileAdded(filePath))
      .on("error", (err: unknown) =>
        this.logger.error({ err }, "Watch-folder error")
      )
      .on("ready", () => {
        this.logger.info({ watchPath: this.watchPath }, "SFTP watch-folder ingestion started");
      });
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
      this.logger.info("SFTP watch-folder ingestion stopped");
    }
  }

  /**
   * Clear all pending pairs (called when inbox is purged on session start)
   * Prevents stale file paths from being enqueued after files are deleted
   */
  clearPendingPairs(): void {
    const count = this.pendingPairs.size;
    this.pendingPairs.clear();
    if (count > 0) {
      this.logger.info({ clearedCount: count }, "Cleared pending pairs from watch-folder");
    }
  }

  /**
   * Retry processing of pending pairs when session transitions to RUNNING
   * Called when operator starts a session to handle files captured outside the previous session window
   */
  async retryPendingPairs(): Promise<void> {
    // Only proceed if session is RUNNING
    if (!this.session) {
      this.logger.debug("No session service; skipping pending pair retry");
      return;
    }

    const activeSession = this.session.getActiveSession();
    if (!activeSession || activeSession.status !== "RUNNING") {
      this.logger.debug(
        { activeSession: activeSession?.id, status: activeSession?.status },
        "Session not RUNNING; skipping pending pair retry"
      );
      return;
    }

    // Process all retained pairs
    const pairs = Array.from(this.pendingPairs.entries());
    if (pairs.length === 0) {
      return; // No pairs to retry
    }

    this.logger.info(
      { pairCount: pairs.length },
      "SFTP watch-folder: retrying pending pairs for RUNNING session"
    );

    for (const [stem, pair] of pairs) {
      if (pair.img && pair.meta) {
        void this.enqueuePair(stem, pair.img, pair.meta);
      }
    }
  }

  private onFileAdded(filePath: string): void {
    const ext = path.extname(filePath);
    const stem = path.basename(filePath, ext);

    // Only process .jpg and .json files
    if (![".jpg", ".jpeg", ".json"].includes(ext.toLowerCase())) {
      return;
    }

    // Track pending pairs by stem (ULID/UUID)
    let pair = this.pendingPairs.get(stem);
    if (!pair) {
      pair = {};
      this.pendingPairs.set(stem, pair);
    }

    if (ext.toLowerCase() === ".json") {
      pair.meta = filePath;
    } else {
      pair.img = filePath;
    }

    // Enqueue when both img and meta are present
    // (pair is only deleted from pendingPairs after successful enqueue)
    if (pair.img && pair.meta) {
      void this.enqueuePair(stem, pair.img, pair.meta);
    }
  }

  private async enqueuePair(stem: string, imgPath: string, metaPath: string): Promise<void> {
    // Defense-in-depth: Check files exist before enqueuing
    // (prevents stale pendingPairs entries from creating jobs with missing files)
    if (!fs.existsSync(imgPath) || !fs.existsSync(metaPath)) {
      this.logger.warn(
        { stem, imgPath, metaPath, imgExists: fs.existsSync(imgPath), metaExists: fs.existsSync(metaPath) },
        "SFTP watch-folder: skipping pair with missing files (likely purged during session start)"
      );
      // Remove from pendingPairs since files are gone
      this.pendingPairs.delete(stem);
      return;
    }

    // Parse manifest early for UID detection
    // Needed for both calibration detection AND session/placeholder lookup
    let manifestData: ManifestData | null = null;
    try {
      manifestData = await this.parseManifest(metaPath);
    } catch (err) {
      this.logger.warn({ err, metaPath }, "Failed to parse manifest early");
    }

    // Extract kiosk UID for calibration/placeholder lookup (prefer manifest UID, fallback to stem)
    const captureUid = manifestData?.uid || stem;

    // Dec 24: Check if this is a calibration capture (pre-CDN tuning workflow)
    // Calibration captures bypass session gating AND job creation entirely
    // CRITICAL: This check MUST happen BEFORE session gating
    if (this.calibrationRepo && captureUid) {
      const calibration = this.calibrationRepo.findByCaptureUid(captureUid);
      if (calibration) {
        // Update calibration record with raw image path and mark as CAPTURED
        this.calibrationRepo.updateRawPath(calibration.id, imgPath);

        this.logger.info(
          { calibrationId: calibration.id, captureUid, imgPath },
          "SFTP watch-folder: calibration capture ingested (no job created, session gating bypassed)"
        );

        // Clean up pending pair and return early
        this.pendingPairs.delete(stem);
        return;
      }
    }

    // Gate on active RUNNING session (new Oct 21, 2025)
    // If session service exists, ensure we're in an active RUNNING session
    // Note: Calibration captures bypass this check (handled above)
    if (this.session) {
      const activeSession = this.session.getActiveSession();
      if (!activeSession || activeSession.status !== "RUNNING") {
        this.logger.warn(
          {
            stem,
            activeSession: activeSession?.id,
            status: activeSession?.status,
            imgPath,
            metaPath,
          },
          "SFTP watch-folder: job enqueue blocked - no active RUNNING session (pair retained for retry)"
        );
        return; // Skip enqueue but keep pair in pendingPairs for retry when session resumes
      }
    }
    // If no session service available (e.g., standalone SFTP ingestion), proceed
    // This preserves backward compatibility

    // Rate limiting for burst scenarios (offline queue flush)
    const now = Date.now();
    const elapsed = now - this.lastEnqueueTime;
    if (elapsed < this.rateLimitMs) {
      await this.sleep(this.rateLimitMs - elapsed);
    }
    this.lastEnqueueTime = Date.now();

    try {
      // manifestData already parsed above for calibration detection
      // No need to re-parse

      // Use active session UUID for proper session joins
      // Fall back to manifest UID or stem for backward compatibility
      const activeSession = this.session?.getActiveSession();
      const sessionId = activeSession?.id || manifestData?.uid || stem;

      // Nov 19: Check if this is an expected back capture
      // If true, directly append to front scan and skip job creation entirely
      if (this.queue.isBackCaptureExpected(sessionId, captureUid)) {
        const frontScanId = this.queue.getFrontScanIdForBackCapture(sessionId, captureUid);
        if (frontScanId) {
          try {
            // Update front scan with back image path
            this.queue.updateBackImagePath(frontScanId, imgPath);

            // Clear the expectation flag
            this.queue.resolveBackCapture(sessionId, captureUid);

            // Log success and return early
            this.logger.info(
              { frontScanId, sessionId, captureUid, imgPath },
              "SFTP watch-folder: attached back image to front scan (no job created)"
            );

            // Fire-and-forget event
            void (async () => {
              try {
                await this.session?.emitEvent("back_image_attached", "info", "Back image attached to front scan", {
                  frontScanId,
                  sessionId,
                  captureUid,
                  imagePath: imgPath,
                  source: "sftp-watch-folder",
                });
              } catch (err) {
                this.logger.warn({ err }, "Failed to emit back_image_attached event");
              }
            })();

            // Clean up pending pair and return
            this.pendingPairs.delete(stem);
            return;
          } catch (error) {
            this.logger.error(
              { err: error, frontScanId, sessionId, imgPath },
              "SFTP watch-folder: failed to attach back image to front scan"
            );
            // Fall through to normal job creation as fallback
          }
        } else {
          this.logger.warn(
            { sessionId, imgPath },
            "SFTP watch-folder: back capture expected but no front scan ID found"
          );
          // Fall through to normal job creation as fallback
        }
      }

      // Check for existing placeholder job (created by /api/capture)
      // Use capture_uid for lookup to decouple from session_id
      let job = this.queue.getByCaptureUid(captureUid);

      if (job) {
        // Hydrate placeholder with raw image path from SFTP inbox and advance to QUEUED (or BACK_IMAGE)
        const oldStatus = job.status;
        // Nov 19: If this is a back capture, do NOT queue for inference. Set to BACK_IMAGE.
        const newStatus = job.scan_orientation === "back" ? "BACK_IMAGE" : "QUEUED";

        this.queue.updateImagePaths(job.id, imgPath, undefined);
        this.queue.updateStatus(job.id, newStatus);

        // Fetch fresh job for accurate timing calculation
        const updatedJob = this.queue.getById(job.id);
        if (updatedJob) {
          const preview_ready_ms = Date.now() - updatedJob.created_at;
          this.queue.updateTimings(job.id, { preview_ready_ms });

          // Fire-and-forget preview ready event (don't await)
          void (async () => {
            try {
              await this.session?.emitEvent("job_preview_ready", "info", "Raw preview ready for operator", {
                jobId: job.id,
                captureUid,
                preview_ready_ms,
              });
            } catch (err) {
              this.logger.warn({ err }, "Failed to emit job_preview_ready event");
            }
          })();
        }

        // Fire-and-forget event (don't await)
        void (async () => {
          try {
            await this.session?.emitEvent("placeholder_hydrated", "info", "Placeholder hydrated from Pi5 kiosk", {
              jobId: job.id,
              sessionId,
              captureUid,
              oldStatus,
              newStatus,
              imagePath: imgPath,
              source: "sftp-watch-folder",
            });
          } catch (err) {
            this.logger.warn({ err }, "Failed to emit placeholder_hydrated event");
          }
        })();
        this.logger.info(
          { jobId: job.id, sessionId, captureUid, imgPath, metaPath },
          "SFTP watch-folder: attached to placeholder"
        );
      } else {
        // No placeholder exists - create new job (normal SFTP-first flow)
        // imagePath will be set to raw_image_path during enqueue
        job = this.queue.enqueue({
          imagePath: imgPath,
          sessionId,
          captureUid,
        });
        // Explicitly set as raw image path (processed will be added by Stage 2)
        this.queue.updateImagePaths(job.id, imgPath, undefined);

        // Fetch fresh job for accurate timing calculation
        const updatedJob = this.queue.getById(job.id);
        if (updatedJob) {
          const preview_ready_ms = Date.now() - updatedJob.created_at;
          this.queue.updateTimings(job.id, { preview_ready_ms });

          // Fire-and-forget preview ready event (don't await)
          void (async () => {
            try {
              await this.session?.emitEvent("job_preview_ready", "info", "Raw preview ready for operator", {
                jobId: job.id,
                captureUid,
                preview_ready_ms,
              });
            } catch (err) {
              this.logger.warn({ err }, "Failed to emit job_preview_ready event");
            }
          })();
        }

        // Fire-and-forget event (don't await)
        void (async () => {
          try {
            await this.session?.emitEvent("job_created", "info", "New job created from Pi5 delivery", {
              jobId: job.id,
              sessionId,
              captureUid,
              status: "QUEUED",
              imagePath: imgPath,
              source: "sftp-watch-folder",
            });
          } catch (err) {
            this.logger.warn({ err }, "Failed to emit job_created event");
          }
        })();
        this.logger.info(
          { jobId: job.id, sessionId, captureUid, imgPath, metaPath },
          "SFTP watch-folder: created new job"
        );
      }

      // Persist camera_applied_controls from manifest for audit trail
      if (manifestData?.camera_applied_controls) {
        this.queue.updateCameraAppliedControls(job.id, manifestData.camera_applied_controls);
        this.logger.info(
          { jobId: job.id, controls: manifestData.camera_applied_controls },
          "SFTP watch-folder: persisted camera_applied_controls from manifest"
        );
      }

      // Only delete from pendingPairs after successful enqueue
      this.pendingPairs.delete(stem);
    } catch (error) {
      this.logger.error(
        { err: error, stem, imgPath, metaPath },
        "SFTP watch-folder: failed to enqueue pair"
      );
      // Don't delete pair on error - retry on next opportunity
    }
  }

  private async parseManifest(metaPath: string): Promise<ManifestData | null> {
    try {
      const content = await fs.promises.readFile(metaPath, "utf-8");
      const data = JSON.parse(content) as ManifestData;
      return data;
    } catch (error) {
      this.logger.warn({ err: error, metaPath }, "Failed to parse manifest JSON");
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
