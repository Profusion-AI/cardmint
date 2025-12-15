import type { Logger } from "pino";
import type { Candidate, ExtractedFields, ScanJob } from "../domain/job";
import { runLmStudioInference } from "./inference/lmstudio";
import { runOpenAIInference, OpenAIFallbackError } from "./inference/openai";
import type { JobQueue } from "./jobQueue";
import { RetrievalService } from "./retrieval/retrievalService";
import type { MetricsCollector } from "./metricsCollector";
import type { DistortionCorrectionService } from "./distortionCorrection";
import type { ImageProcessingService } from "./imageProcessing";
import type { SessionService } from "./sessionService";
import type { InventoryService } from "./inventory/inventoryService";
import type { ImageHostingService } from "./imageHosting";
import type { SetTriangulator, TriangulationResult, ParsedSignals } from "./setTriangulator";
import { runtimeConfig } from "../config";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execAsync = promisify(exec);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const keepWarmScriptCandidates = [
  path.resolve(currentDir, "../../../../scripts/cardmint-keepwarm-enhanced.py"),
  path.resolve(currentDir, "../../../scripts/cardmint-keepwarm-enhanced.py"),
];
const masterCropScriptPath = path.resolve(currentDir, "../../../../scripts/create_master_crop.py");

const resolveKeepWarmScriptPath = (): string | null => {
  for (const candidate of keepWarmScriptCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

interface JobWorkerOptions {
  pollIntervalMs: number;
  lockTimeoutMs: number;
  idleKeepaliveMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

const DEFAULT_OPTIONS: JobWorkerOptions = {
  pollIntervalMs: 500,
  lockTimeoutMs: 60_000,
  idleKeepaliveMs: 10 * 60_000,
  maxRetries: 3,
  retryBaseDelayMs: 1000,
};

export class JobWorker {
  private readonly processorId: string;
  private readonly options: JobWorkerOptions;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastActivity = Date.now();

  constructor(
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly retrieval: RetrievalService,
    private readonly metrics: MetricsCollector,
    private readonly distortion?: DistortionCorrectionService,
    private readonly imageProcessing?: ImageProcessingService,
    private readonly session?: SessionService,
    private readonly inventory?: InventoryService,
    private readonly imageHosting?: ImageHostingService,
    private readonly setTriangulator?: SetTriangulator,
    opts: Partial<JobWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...opts };
    this.processorId = `node-worker-${process.pid}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.runLoop();
    this.logger.info({ processorId: this.processorId }, "Job worker started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.info({ processorId: this.processorId }, "Job worker stopped");
  }

  getIdleMinutes(): number {
    const idleMs = Date.now() - this.lastActivity;
    return Math.floor(idleMs / 60_000);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        // Update queue depth metric at start of each poll cycle
        const currentDepth = this.queue.getQueueDepth();
        this.metrics.setQueueDepth(currentDepth);

        // Shadow lane auto-gating with hysteresis
        this.updateShadowLaneState(currentDepth);

        const job = this.queue.claimNextPending(this.processorId, this.options.lockTimeoutMs);
        if (!job) {
          await this.handleIdle();
          continue;
        }

        this.lastActivity = Date.now();
        this.logger.info({ jobId: job.id }, "Processing job");

        if (!job.image_path) {
          this.logger.error({ jobId: job.id }, "Job missing image_path; marking failed");
          const oldStatus = job.status;
          this.queue.updateStatus(job.id, "FAILED");
          this.queue.markError(job.id, "MISSING_IMAGE", "Capture did not provide image path");
          // Fire-and-forget event with error handling
          void (async () => {
            try {
              await this.session?.emitEvent("job_status_changed", "error", "Job failed: missing image path", {
                jobId: job.id,
                oldStatus,
                newStatus: "FAILED",
                reason: "MISSING_IMAGE",
              });
            } catch (err) {
              this.logger.warn({ err, jobId: job.id }, "Failed to emit job_status_changed event");
            }
          })();
          this.queue.releaseJob(job.id);
          continue;
        }

        try {
          // Stage 1: Apply distortion correction if service is available
          let imagePath = job.image_path;
          let distortionTimeMs = 0;
          if (this.distortion?.isReady()) {
            const distortionStart = Date.now();
            const distortionResult = await this.distortion.correctImage(imagePath);
            distortionTimeMs = distortionResult.processingTimeMs ?? 0;

            if (distortionResult.success && distortionResult.correctedImagePath) {
              imagePath = distortionResult.correctedImagePath;
              // Persist corrected image path to database
              this.queue.updateCorrectedImagePath(job.id, imagePath);
              this.logger.debug(
                { jobId: job.id, distortionMs: distortionTimeMs },
                "Applied distortion correction (Stage 1)"
              );
            } else {
              // Log warning but continue with original image
              this.logger.warn(
                { jobId: job.id, error: distortionResult.error },
                "Distortion correction failed; proceeding with original image"
              );
            }
          }

          // Stage 1.5: Master Crop & Upload (New Nov 21)
          // Produces high-res master crop and uploads to ImageKit
          let masterImagePath: string | null = null;
          let masterCdnUrl: string | null = null;
          const sku = job.id.replace(/[^a-zA-Z0-9_-]/g, ""); // Use job ID as SKU base

          try {
            // 1. Generate Master Crop
            if (fs.existsSync(masterCropScriptPath)) {
              const masterOutput = path.join(path.dirname(imagePath), `master-${path.basename(imagePath)}`);
              const cmd = `python3 ${masterCropScriptPath} --input "${imagePath}" --output "${masterOutput}" --side front`;

              this.logger.debug({ jobId: job.id, cmd }, "Generating master crop");
              const { stdout } = await execAsync(cmd);
              let parsedCrop: any = null;
              try {
                parsedCrop = JSON.parse((stdout || "").trim());
              } catch {
                // non-JSON output is fine; file existence is the guard
              }

              // Parse JSON output if script returns it, or check file existence
              if (fs.existsSync(masterOutput)) {
                masterImagePath = masterOutput;
                this.logger.info({ jobId: job.id, masterPath: masterImagePath }, "Master crop generated");
                if (parsedCrop?.rotation !== undefined) {
                  this.logger.info(
                    {
                      jobId: job.id,
                      rotation: parsedCrop.rotation,
                      confidence: parsedCrop.confidence,
                      strategy: parsedCrop.strategy,
                    },
                    "Master crop orientation decision"
                  );
                }

                // Use master crop for subsequent stages?
                // Yes, if we want the processed image (EverShop) to be the cropped version.
                imagePath = masterImagePath;
              } else {
                this.logger.warn({ jobId: job.id, stdout }, "Master crop script failed to produce output");
              }
            } else {
              this.logger.warn({ masterCropScriptPath }, "Master crop script not found");
            }

            // 2. Upload to ImageKit
            if (masterImagePath && this.imageHosting?.isReady()) {
              this.logger.info({ jobId: job.id, sku }, "Uploading master to ImageKit");
              const uploadResult = await this.imageHosting.uploadImage(masterImagePath, sku);

              if (uploadResult.success && uploadResult.publicUrl) {
                masterCdnUrl = uploadResult.publicUrl;
                this.logger.info({ jobId: job.id, url: masterCdnUrl }, "Master uploaded to ImageKit");
                // Persist master info to DB
                this.queue.updateMasterInfo(job.id, masterImagePath, masterCdnUrl);
              } else {
                this.logger.warn({ jobId: job.id, error: uploadResult.error }, "Failed to upload master to ImageKit");
              }
            } else if (masterImagePath) {
              // ImageKit not ready - log warning so operators know Stage 1.5 CDN upload was skipped
              // This will cause Stage 3 to fall back to Path B (listing asset generation)
              if (!this.imageHosting) {
                this.logger.warn({ jobId: job.id }, "Stage 1.5 CDN upload skipped: ImageHostingService not configured");
              } else if (!this.imageHosting.isReady()) {
                this.logger.warn({ jobId: job.id }, "Stage 1.5 CDN upload skipped: ImageKit not ready (check credentials)");
              }
              // Even without upload, persist master path so frontend can reference cropped image
              this.queue.updateMasterInfo(job.id, masterImagePath, null);
            }
          } catch (masterError) {
            this.logger.warn({ err: masterError, jobId: job.id }, "Stage 1.5 (Master Crop/Upload) failed; proceeding");
          }

          // Stage 2: Apply image processing (resize/compress) if service is available
          let processedImagePath = imagePath;
          let processingTimeMs = 0;

          if (this.imageProcessing?.isReady()) {
            const processingStart = Date.now();
            const processingResult = await this.imageProcessing.processImage(imagePath, sku);
            processingTimeMs = processingResult.processingTimeMs ?? 0;

            if (processingResult.success && processingResult.processedImagePath) {
              processedImagePath = processingResult.processedImagePath;
              this.logger.debug(
                { jobId: job.id, processingMs: processingTimeMs, sku, md5: processingResult.md5Hash?.substring(0, 8) },
                "Applied image processing (Stage 2)"
              );
              // Persist the processed image path to the database (updates processed_image_path and image_path)
              try {
                this.queue.updateProcessedImagePath(job.id, processedImagePath);

                // Fetch fresh job and emit processed ready event
                const updatedJob = this.queue.getById(job.id);
                if (updatedJob) {
                  const processed_ready_ms = Date.now() - updatedJob.created_at;
                  this.queue.updateTimings(job.id, { processed_ready_ms });

                  // Fire-and-forget event (don't await)
                  void (async () => {
                    try {
                      await this.session?.emitEvent("job_image_processed", "info", "Processed preview ready", {
                        jobId: job.id,
                        processed_ready_ms,
                        processingTimeMs,
                        masterCdnUrl, // Include in event if available
                      });
                    } catch (err) {
                      this.logger.warn({ err }, "Failed to emit job_image_processed event");
                    }
                  })();
                }
              } catch (updateError) {
                // Log error but continue pipeline - file exists on disk even if DB write failed
                this.logger.warn(
                  { err: updateError, jobId: job.id, processedImagePath },
                  "Failed to update processed_image_path in database"
                );
                // Don't throw - let inference continue with the processed file
              }
              // Record success metric
              if (processingResult.outputSizeBytes) {
                this.metrics.recordImageProcessingSuccess(processingTimeMs, processingResult.outputSizeBytes);
              } else {
                this.metrics.recordImageProcessingSuccess(processingTimeMs);
              }
            } else {
              // Log warning but continue with distorted/original image (fallback)
              this.logger.warn(
                { jobId: job.id, error: processingResult.error },
                "Image processing failed; proceeding with Stage 1 output"
              );
              // Record failure metric
              this.metrics.recordImageProcessingFailure();
            }
          } else {
            // No processing step; persist the path we are using (likely the master crop)
            try {
              this.queue.updateProcessedImagePath(job.id, processedImagePath);
            } catch (updateError) {
              this.logger.warn(
                { err: updateError, jobId: job.id, processedImagePath },
                "Failed to update processed_image_path in database (no imageProcessing path)"
              );
            }
          }

          const inference = await this.runDualPathInference(processedImagePath);

          // Path C: Set Disambiguation via Signal Triangulation
          // Per TDD spec: Only runs when Path A (OpenAI) succeeds AND set_name is null
          // Does NOT run on Path B (LM Studio) fallback
          let setHint: { name: string; tcgPlayerId: string; confidence: number } | null = null;
          let pathCResult: TriangulationResult | null = null;
          let pathCErrorOccurred = false;

          if (
            runtimeConfig.enablePathCSetDisambig &&
            this.setTriangulator &&
            inference.inferencePath === "openai" && // Only when Path A succeeded
            !inference.extracted.set_name
          ) {
            try {
              const signals: ParsedSignals = {
                cardName: inference.extracted.card_name || "",
                ...this.setTriangulator.parseSetNumber(inference.extracted.set_number || ""),
                rarity: inference.extracted.rarity || null,
                cardType: inference.extracted.card_type || null,
                hpValue: inference.extracted.hp_value || null,
                shadowless: inference.extracted.shadowless ?? null,
                artist: inference.extracted.artist || null,
              };

              pathCResult = await this.setTriangulator.triangulate(signals);

              // Update session quota state for operator UI visibility
              if (pathCResult.quotaStatus && this.session) {
                this.session.updateQuota({
                  tier: pathCResult.quotaStatus.tier,
                  dailyLimit: pathCResult.quotaStatus.dailyLimit,
                  dailyRemaining: pathCResult.quotaStatus.dailyRemaining,
                  callsConsumed: pathCResult.quotaStatus.callsConsumed,
                  warningLevel: pathCResult.quotaStatus.warningLevel,
                });
              }

              if (pathCResult.confidence >= runtimeConfig.pathCHardFilterThreshold && pathCResult.setName) {
                // Very high confidence - safe to hard filter
                inference.extracted.set_name = pathCResult.setName;
                this.logger.info(
                  {
                    jobId: job.id,
                    set_name: pathCResult.setName,
                    confidence: pathCResult.confidence,
                    action: "hard_filter",
                    latencyMs: pathCResult.latencyMs,
                  },
                  "Path C1: High confidence, applying hard filter"
                );
              } else if (pathCResult.confidence >= runtimeConfig.pathCSoftRerankThreshold && pathCResult.setName) {
                // Medium confidence - soft reranker only (DO NOT set extracted.set_name)
                setHint = {
                  name: pathCResult.setName,
                  tcgPlayerId: pathCResult.tcgPlayerId || "",
                  confidence: pathCResult.confidence,
                };
                this.logger.info(
                  {
                    jobId: job.id,
                    set_hint: setHint,
                    action: "soft_rerank",
                    latencyMs: pathCResult.latencyMs,
                  },
                  "Path C1: Medium confidence, using as soft reranker"
                );
              } else {
                // Low confidence or no match - discard
                this.logger.debug(
                  {
                    jobId: job.id,
                    confidence: pathCResult.confidence,
                    action: pathCResult.action,
                    latencyMs: pathCResult.latencyMs,
                  },
                  "Path C1: Low confidence, discarding"
                );
              }
            } catch (pathCError) {
              this.logger.warn({ err: pathCError, jobId: job.id }, "Path C failed (non-blocking)");
              pathCErrorOccurred = true;
            }
          }

          const candidates = await this.safeRetrieveCandidates(inference.extracted, setHint);

          this.queue.attachCandidates(job.id, inference.extracted, candidates);
          this.queue.updateInferencePath(job.id, inference.inferencePath);

          // Check if candidates meet unmatched threshold (<0.70 confidence)
          const isUnmatched = this.retrieval.isUnmatchedThreshold(candidates, 0.70);
          if (isUnmatched) {
            this.logger.warn(
              { jobId: job.id, candidateCount: candidates.length, topConfidence: candidates[0]?.confidence ?? 0 },
              "All candidates below threshold - marking as UNMATCHED_NO_REASONABLE_CANDIDATE"
            );
            // Increment failure count (idempotent per detection)
            this.queue.incrementPptFailureCount(job.id);
          }

          // Inference produces Stage 1 (Ingested): scan + truth core, no inventory
          // Stage 2 (Inventoried) is created ONLY during Accept via JobQueue.acceptWithTruthCore
          // This keeps Stage 1/2 semantics clean and allows back capture to attach to stable job_id

          // Race condition guard: Check if job was marked as back capture during inference
          // (e.g. by server.ts linking it after SFTP ingestion)
          const freshJob = this.queue.getById(job.id);
          if (freshJob?.scan_orientation === "back") {
            this.logger.info({ jobId: job.id }, "Job marked as back capture during inference - aborting inference flow");
            this.queue.updateStatus(job.id, "BACK_IMAGE");
            this.queue.releaseJob(job.id);
            continue;
          }

          const oldStatus = job.status;
          const inference_complete_ms = Date.now() - job.created_at;
          const newStatus = isUnmatched ? "UNMATCHED_NO_REASONABLE_CANDIDATE" : "OPERATOR_PENDING";

          // Build Path C telemetry for timings
          const pathCTimings: Record<string, unknown> = {};
          if (pathCResult) {
            // Path C ran and produced a result
            pathCTimings.pathC_ran = true;
            pathCTimings.pathC_action = pathCResult.action;
            pathCTimings.pathC_confidence = pathCResult.confidence;
            pathCTimings.pathC_set_hint = pathCResult.setName;
            pathCTimings.pathC_latency_ms = pathCResult.latencyMs;
            pathCTimings.pathC_matching_signals = pathCResult.matchingSignals;
          } else if (pathCErrorOccurred) {
            // Path C attempted but threw an exception - surface to operator
            pathCTimings.pathC_ran = true;
            pathCTimings.pathC_action = "error";
            pathCTimings.pathC_confidence = null;
            pathCTimings.pathC_set_hint = null;
            pathCTimings.pathC_latency_ms = null;
            pathCTimings.pathC_matching_signals = [];
          } else if (runtimeConfig.enablePathCSetDisambig) {
            // Path C enabled but skipped (Path B fallback, set_name already present, no triangulator)
            pathCTimings.pathC_ran = false;
            pathCTimings.pathC_action = "skipped";
          }
          // If Path C disabled, no pathC fields added (backward compatible)

          this.queue.updateStatus(job.id, newStatus, {
            infer_ms: inference.infer_ms,
            distortion_ms: distortionTimeMs,
            processing_ms: processingTimeMs,
            preprocessing_ms: distortionTimeMs + processingTimeMs,
            retried_once: inference.retriedOnce,
            inference_complete_ms,
            ...pathCTimings,
          });
          // Fire-and-forget event with error handling
          void (async () => {
            try {
              const message = isUnmatched
                ? "Job marked UNMATCHED - all candidates below 0.70 confidence threshold"
                : "Job ready for operator review";
              await this.session?.emitEvent(
                "job_status_changed",
                isUnmatched ? "warning" : "info",
                message,
                {
                  jobId: job.id,
                  oldStatus,
                  newStatus,
                  candidateCount: candidates.length,
                  topConfidence: candidates[0]?.confidence ?? 0,
                  infer_ms: inference.infer_ms,
                  totalMs: distortionTimeMs + processingTimeMs + inference.infer_ms,
                  unmatchedThreshold: isUnmatched ? 0.70 : undefined,
                  masterCdnUrl, // Include master URL in event
                }
              );
            } catch (err) {
              this.logger.warn({ err, jobId: job.id }, "Failed to emit job_status_changed event");
            }
          })();
          this.metrics.recordJobProcessed();
          this.metrics.recordInferenceLatency(inference.infer_ms);
          this.logger.info(
            {
              jobId: job.id,
              status: newStatus,
              infer_ms: inference.infer_ms,
              distortion_ms: distortionTimeMs,
              processing_ms: processingTimeMs,
              total_preprocessing_ms: distortionTimeMs + processingTimeMs,
              candidate_count: candidates.length,
              top_confidence: candidates[0]?.confidence ?? 0,
              unmatched: isUnmatched,
              retried_once: inference.retriedOnce,
              inference_path: inference.inferencePath,
            },
            isUnmatched
              ? "Job inference complete - UNMATCHED (low confidence)"
              : "Job inference complete (full pipeline)",
          );

          // Shadow lane measurement (fire-and-forget, never blocks operator)
          this.runShadowMeasurement(job);
        } catch (error) {
          await this.handleInferenceError(job, error);
        } finally {
          this.queue.releaseJob(job.id);
        }
      } catch (error) {
        this.logger.error({ err: error }, "Job worker loop error");
        await sleep(this.options.pollIntervalMs);
      }
    }
  }

  /**
   * Run dual-path inference: Path A (OpenAI) primary with Path B (LM Studio) fallback.
   * Implements single-retry policy with jitter for Path A before falling back to Path B.
   */
  private async runDualPathInference(imagePath: string) {
    // Track whether Path A was attempted (for retry metadata)
    let pathAAttempted = false;

    // Try Path A (OpenAI) first if API key is configured
    if (runtimeConfig.openaiApiKey) {
      pathAAttempted = true;
      try {
        const result = await runOpenAIInference(
          imagePath,
          {
            recordRetry: () => this.metrics.recordALaneRetry(),
            recordRetrySuccess: () => this.metrics.recordALaneRetrySuccess(),
            recordFallback: () => this.metrics.recordFallbackToLmStudio(),
          },
          this.logger
        );
        return { ...result, inferencePath: "openai" as const };
      } catch (error) {
        if (error instanceof OpenAIFallbackError) {
          // Path A failed after retry, fallback to Path B
          this.metrics.recordPathAFailure();
          this.logger.warn(
            { err: error },
            "Path A (OpenAI) failed after retry; falling back to Path B (LM Studio)",
          );
        } else {
          // Non-retryable error, fallback to Path B
          this.logger.warn(
            { err: error },
            "Path A (OpenAI) error; falling back to Path B (LM Studio)",
          );
        }
      }
    }

    // Path B (LM Studio) - fallback or primary if no OpenAI key
    const result = await runLmStudioInference(imagePath);
    return {
      ...result,
      retriedOnce: pathAAttempted, // Preserve retry context if Path A was attempted
      inferencePath: "lmstudio" as const,
    };
  }

  private async safeRetrieveCandidates(
    extracted: ExtractedFields,
    setHint?: { name: string; tcgPlayerId: string; confidence: number } | null
  ): Promise<Candidate[]> {
    try {
      // Pass setHint to retrieval for soft reranking (not hard filtering)
      return await this.retrieval.getCandidates(extracted, 3, setHint ?? undefined);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Retrieval service failed; returning fallback candidates",
      );
      return this.buildFallbackCandidates(extracted);
    }
  }

  private buildFallbackCandidates(extracted: ExtractedFields): Candidate[] {
    if (!extracted.card_name) {
      return [];
    }

    return [
      {
        id: `fallback::${extracted.card_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title: extracted.card_name,
        confidence: 0.1,
        source: "vision-fallback",
      },
    ];
  }

  /**
   * Update shadow lane enablement based on queue depth with hysteresis.
   * Auto-disables at depth >= AUTO_PAUSE_DEPTH, auto-resumes at depth <= AUTO_RESUME_DEPTH.
   */
  private updateShadowLaneState(currentDepth: number): void {
    const wasEnabled = this.metrics.isShadowLaneEnabled();

    if (currentDepth >= runtimeConfig.autoPauseDepth) {
      if (wasEnabled) {
        this.metrics.setShadowLaneEnabled(false);
        this.logger.info(
          { queueDepth: currentDepth, threshold: runtimeConfig.autoPauseDepth },
          "Shadow lane auto-disabled due to queue depth",
        );
      }
    } else if (currentDepth <= runtimeConfig.autoResumeDepth) {
      if (!wasEnabled) {
        this.metrics.setShadowLaneEnabled(true);
        this.logger.info(
          { queueDepth: currentDepth, threshold: runtimeConfig.autoResumeDepth },
          "Shadow lane auto-enabled after queue depth reduced",
        );
      }
    }
  }

  /**
   * Run shadow lane measurement (fire-and-forget, measurement only).
   * Never blocks operator accept or delays job publishing.
   * Stub implementation - actual shadow measurements will be implemented in Phase 5.
   */
  private runShadowMeasurement(job: ScanJob): void {
    if (!this.metrics.isShadowLaneEnabled()) {
      return;
    }

    // Fire-and-forget: run in background, never await
    // Shadow lane samples at SHADOW_SAMPLE_RATE (default 10%)
    if (Math.random() > runtimeConfig.shadowSampleRate) {
      return;
    }

    // Stub: actual implementation will run dual-path inference and record agreement metrics
    this.logger.debug(
      { jobId: job.id },
      "Shadow lane measurement (stub - not yet implemented)",
    );

    // TODO Phase 5: Implement shadow measurement
    // - Run both Path A and Path B in parallel
    // - Record timings, agreement booleans, and divergence metrics
    // - Store results for analysis (never impact operator workflow)
  }

  private async handleInferenceError(job: ScanJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const isTransient = this.isTransientError(error);

    if (isTransient && job.retry_count < this.options.maxRetries) {
      const nextRetry = job.retry_count + 1;
      const delayMs = this.options.retryBaseDelayMs * Math.pow(2, job.retry_count);

      this.logger.warn(
        { jobId: job.id, retry: nextRetry, maxRetries: this.options.maxRetries, delayMs, err: error },
        "Inference failed; retrying after backoff",
      );

      this.queue.incrementRetry(job.id);
      this.metrics.recordRetry();
      await sleep(delayMs);
      const oldStatus = job.status;
      this.queue.updateStatus(job.id, "QUEUED");
      // Fire-and-forget event with error handling
      void (async () => {
        try {
          await this.session?.emitEvent("job_status_changed", "warning", `Job re-queued for retry (attempt ${nextRetry}/${this.options.maxRetries})`, {
            jobId: job.id,
            oldStatus,
            newStatus: "QUEUED",
            retryCount: nextRetry,
            maxRetries: this.options.maxRetries,
            delayMs,
            reason: "transient error",
          });
        } catch (err) {
          this.logger.warn({ err, jobId: job.id }, "Failed to emit job_status_changed event");
        }
      })();
    } else {
      const reason = isTransient ? "max retries exceeded" : "non-retryable error";
      this.logger.error(
        { jobId: job.id, retry_count: job.retry_count, reason, err: error },
        "Inference failed permanently",
      );
      const oldStatus = job.status;
      this.queue.updateStatus(job.id, "FAILED");
      this.queue.markError(job.id, "INFERENCE_FAILED", message);
      // Fire-and-forget event with error handling
      void (async () => {
        try {
          await this.session?.emitEvent("job_status_changed", "error", `Job failed: ${reason} (${message})`, {
            jobId: job.id,
            oldStatus,
            newStatus: "FAILED",
            retryCount: job.retry_count,
            maxRetries: this.options.maxRetries,
            reason,
            errorMessage: message,
          });
        } catch (err) {
          this.logger.warn({ err, jobId: job.id }, "Failed to emit job_status_changed event");
        }
      })();
      this.metrics.recordJobFailed();
    }
  }

  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    // Network, timeout, and connection errors are transient
    return (
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("network") ||
      message.includes("fetch failed")
    );
  }

  private async handleIdle(): Promise<void> {
    const idleFor = Date.now() - this.lastActivity;
    if (idleFor >= this.options.idleKeepaliveMs) {
      this.lastActivity = Date.now();
      this.logger.info({ idleMinutes: Math.floor(idleFor / 60_000) }, "Job worker idle; running KeepWarm health check");

      // Run KeepWarm health check after long idle periods
      try {
        const scriptPath = resolveKeepWarmScriptPath();
        if (!scriptPath) {
          this.logger.warn({ keepWarmScriptCandidates }, "KeepWarm daemon health check skipped (script not found)");
          return;
        }
        const { stdout } = await execAsync(`python3 ${scriptPath} --check`);
        this.logger.info({ stdout: stdout.trim() }, "KeepWarm daemon health check passed");
      } catch (error) {
        const err = error as any;
        this.logger.warn({ stderr: err.stderr, code: err.code }, "KeepWarm daemon health check failed (non-blocking)");
      }
    }
    await sleep(this.options.pollIntervalMs);
  }
}
