import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Candidate, ExtractedFields, JobStatus, ScanJob } from "../domain/job";
import { JobRepository } from "../repositories/jobRepository";
import { InventoryService } from "./inventory/inventoryService";
import type { ConditionBucket } from "./inventory/skuHelpers";

export interface EnqueueOptions {
  imagePath?: string;
  sessionId?: string;
  captureUid?: string;
  initialStatus?: JobStatus;
}

export class JobQueue extends EventEmitter {
  private readonly repo: JobRepository;
  private readonly inventoryService: InventoryService;
  private readonly backCaptureSessions = new Map<string, string>(); // sessionId → frontScanId
  private readonly backCaptureCaptureUids = new Map<string, string>(); // captureUid → frontScanId

  constructor(jobRepo: JobRepository, inventoryService: InventoryService) {
    super();
    this.repo = jobRepo;
    this.inventoryService = inventoryService;
  }

  public expectBackCapture(sessionId: string, frontScanId: string, captureUid?: string): void {
    this.backCaptureSessions.set(sessionId, frontScanId);
    if (captureUid) {
      this.backCaptureCaptureUids.set(captureUid, frontScanId);
    }
    // Safety cleanup
    setTimeout(() => {
      this.backCaptureSessions.delete(sessionId);
      if (captureUid) {
        this.backCaptureCaptureUids.delete(captureUid);
      }
    }, 30000);
  }

  public attachBackCaptureUid(captureUid: string, frontScanId: string): void {
    this.backCaptureCaptureUids.set(captureUid, frontScanId);
    setTimeout(() => {
      this.backCaptureCaptureUids.delete(captureUid);
    }, 30000);
  }

  public resolveBackCapture(sessionId?: string, captureUid?: string): void {
    if (sessionId) {
      this.backCaptureSessions.delete(sessionId);
    }
    if (captureUid) {
      this.backCaptureCaptureUids.delete(captureUid);
    }
  }

  public isBackCaptureExpected(sessionId?: string, captureUid?: string): boolean {
    return (
      (sessionId ? this.backCaptureSessions.has(sessionId) : false) ||
      (captureUid ? this.backCaptureCaptureUids.has(captureUid) : false)
    );
  }

  public getFrontScanIdForBackCapture(sessionId?: string, captureUid?: string): string | undefined {
    if (captureUid) {
      const byUid = this.backCaptureCaptureUids.get(captureUid);
      if (byUid) return byUid;
    }
    return sessionId ? this.backCaptureSessions.get(sessionId) : undefined;
  }

  /**
   * Nov 18 Production (Atomic Accept): Stage 1 → Stage 2 transition in single operation.
   * Creates inventory FIRST, then persists truth core + item_uid atomically.
   * Per Nov 18 hard rule: Accept is all-or-nothing - either both succeed or neither happens.
   * No path exists where a job is ACCEPTED with NULL item_uid.
   */
  async acceptWithTruthCore(
    id: string,
    truthCore: { name: string; hp: number | null; collector_no: string; set_name: string; set_size: number | null; variant_tags?: string[] },
    condition: ConditionBucket,
    timings?: Partial<ScanJob["timings"]>
  ): Promise<void> {
    // 1. Load job and validate preconditions BEFORE any writes
    const job = this.repo.getById(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }

    if (!job.processed_image_path) {
      throw new Error(`Job ${id} missing processed_image_path - cannot create inventory`);
    }

    // 2. Create Stage 2 inventory FIRST (before any DB updates)
    // Build extracted fields from operator-confirmed truth core (not raw job.extracted)
    // This ensures inventory SKUs reflect operator corrections
    const truthExtracted: Record<string, unknown> = {
      card_name: truthCore.name,
      hp_value: truthCore.hp,
      set_number: truthCore.collector_no,
      set_name: truthCore.set_name,
      // set_size is stored in products table separately, not in extracted fields
      // Dec 8, 2025: Include variant_tags for persistence to products table
      variant_tags: truthCore.variant_tags ?? [],
    };

    // Call dedupAttachOrMint with truth-derived fields + operator-selected condition
    // Per Nov 18 rule: errors propagate, failing the Accept operation
    // If this throws, job remains in pre-Accept state (no status change, no item_uid)
    const inventoryResult = await this.inventoryService.dedupAttachOrMint(
      truthExtracted,
      {
        scan_id: job.id,
        capture_session_id: job.session_id ?? null,
        processed_image_path: job.processed_image_path,
        raw_image_path: job.raw_image_path ?? null,
        capture_uid: job.capture_uid ?? null,
      },
      condition
    );

    // 3. Atomically update job with BOTH truth core AND inventory results
    // This is the only write to the scans table - happens after inventory succeeds
    this.repo.acceptWithTruthCoreAndInventory(id, truthCore, inventoryResult, timings);

    // 4. Emit job:updated ONLY after everything succeeded
    const updatedJob = this.repo.getById(id);
    if (updatedJob) {
      this.emit("job:updated", updatedJob);
    }
  }

  /**
   * Nov 28 Baseline: Accept for baseline validation only (no inventory/products).
   * Records truth core values in scans table for baseline CSV generation,
   * but does NOT create inventory, products, or trigger stage 3 promotion.
   * This keeps baseline sessions side-effect-free for measurement purposes.
   */
  async acceptForBaseline(
    id: string,
    truthCore: { name: string; hp: number | null; collector_no: string; set_name: string; set_size: number | null }
  ): Promise<void> {
    const job = this.repo.getById(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }

    // Update scan with ACCEPTED status and truth core values
    // No inventory, no products, no item_uid
    this.repo.acceptForBaselineOnly(id, truthCore);

    const updatedJob = this.repo.getById(id);
    if (updatedJob) {
      this.emit("job:updated", updatedJob);
    }
  }

  /**
   * Nov 19 Production: Lock front image (Stage 1A - Ready for Back Capture)
   * Operator confirms this front scan is the keeper.
   * Enables back capture without requiring Stage 2 (final Accept).
   */
  lockFront(id: string): void {
    this.repo.lockFront(id);
    const updatedJob = this.repo.getById(id);
    if (updatedJob) {
      this.emit("job:updated", updatedJob);
      this.emit("front:locked", updatedJob);
    }
  }

  /**
   * Nov 19 Production: Mark back image as ready (Stage 1B - Back Attached)
   * Called by back capture daemon after uploading back image.
   * Requires front to be locked first.
   */
  markBackReady(id: string): void {
    this.repo.markBackReady(id);
    const updatedJob = this.repo.getById(id);
    if (updatedJob) {
      this.emit("job:updated", updatedJob);
      this.emit("back:ready", updatedJob);
    }
  }

  /**
   * Nov 19 Production: Lock canonical ID (Stage 1B - Canonical Locked)
   * Operator confirms the canonical cm_card_id is correct (explicit or implicit acceptance).
   * Required before final Accept (Stage 2).
   */
  lockCanonical(id: string): void {
    this.repo.lockCanonical(id);
    const updatedJob = this.repo.getById(id);
    if (updatedJob) {
      this.emit("job:updated", updatedJob);
      this.emit("canonical:locked", updatedJob);
    }
  }

  enqueue(opts: EnqueueOptions = {}): ScanJob {
    const now = Date.now();
    const job: ScanJob = {
      id: randomUUID(),
      created_at: now,
      updated_at: now,
      status: opts.initialStatus ?? "QUEUED",
      image_path: opts.imagePath,
      capture_uid: opts.captureUid,
      extracted: {},
      top3: [],
      retry_count: 0,
      session_id: opts.sessionId,
      timings: {},
      processor_id: undefined,
      locked_at: undefined,
    };
    const inserted = this.repo.create(job);
    this.emit("job:queued", inserted);
    return inserted;
  }

  updateStatus(id: string, status: JobStatus, timings?: Partial<ScanJob["timings"]>): void {
    this.repo.updateStatus(id, status, timings);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateTimings(id: string, timings: Partial<ScanJob["timings"]>): void {
    this.repo.updateTimings(id, timings);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  attachCandidates(id: string, extracted: ExtractedFields, candidates: Candidate[]): void {
    this.repo.attachCandidates(id, extracted, candidates);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateImagePath(id: string, imagePath: string): void {
    this.repo.updateImagePath(id, imagePath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateImagePaths(id: string, rawPath: string | undefined, processedPath: string | undefined): void {
    this.repo.updateImagePaths(id, rawPath, processedPath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateProcessedImagePath(id: string, processedPath: string): void {
    this.repo.updateProcessedImagePath(id, processedPath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateCorrectedImagePath(id: string, correctedPath: string): void {
    this.repo.updateCorrectedImagePath(id, correctedPath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  getRecent(limit = 10): ScanJob[] {
    return this.repo.listRecent(limit);
  }

  getById(id: string): ScanJob | null {
    return this.repo.getById(id);
  }

  getBySessionId(sessionId: string): ScanJob | null {
    return this.repo.getBySessionId(sessionId);
  }

  getByCaptureUid(captureUid: string): ScanJob | null {
    return this.repo.getByCaptureUid(captureUid);
  }

  getQueueDepth(): number {
    return this.repo.queueDepth();
  }

  claimNextPending(processorId: string, lockTimeoutMs: number): ScanJob | null {
    const job = this.repo.claimNextPending(processorId, lockTimeoutMs);
    if (job) {
      this.emit("job:updated", job);
    }
    return job;
  }

  releaseJob(id: string): void {
    this.repo.releaseJob(id);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  markError(id: string, errorCode: string, errorMessage: string): void {
    this.repo.updateError(id, errorCode, errorMessage);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  incrementRetry(id: string): void {
    this.repo.incrementRetry(id);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  incrementPptFailureCount(id: string): void {
    this.repo.incrementPptFailureCount(id);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateInferencePath(id: string, inferencePath: "openai" | "lmstudio"): void {
    this.repo.updateInferencePath(id, inferencePath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  updateCameraAppliedControls(id: string, controls: Record<string, unknown>): void {
    this.repo.updateCameraAppliedControls(id, controls);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }

  /**
   * Nov 19 Production: Update back image path on front scan
   * Called by SFTP ingestion when back capture is expected
   */
  updateBackImagePath(id: string, backImagePath: string): void {
    this.repo.updateBackImagePath(id, backImagePath);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
      this.emit("back:attached", job);
    }
  }

  updateMasterInfo(id: string, masterPath: string, masterCdnUrl: string | null): void {
    this.repo.updateMasterInfo(id, masterPath, masterCdnUrl);
    const job = this.repo.getById(id);
    if (job) {
      this.emit("job:updated", job);
    }
  }
}
