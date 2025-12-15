import type { Logger } from "pino";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ManifestAsset {
  path: string;
  captured_at: number;
}

export interface ManifestInference {
  cm_card_id: string;
  top_candidates: Array<{ id: string; score: number }>;
  engine: "PathA" | "PathB";
  version: string;
  retries: number;
}

export interface ManifestEnrichment {
  pricing_source: "ppt" | "csv" | "manual" | null;
  market_price: number | null;
  pricing_status: "fresh" | "stale" | "missing";
  quota_delta: number;
  updated_at: number | null;
}

export interface ManifestOperator {
  accepted: boolean;
  accepted_without_canonical: boolean;
  canonical_cm_card_id: string | null;
  manual_override: boolean;
  manual_reason_code: string | null;
  manual_note: string | null;
}

export interface ManifestStaging {
  ready: boolean;
  promoted_by: string | null;
  promoted_at: number | null;
}

export interface JobManifest {
  uid: string;
  asset: ManifestAsset;
  inference: ManifestInference;
  enrichment: ManifestEnrichment;
  operator: ManifestOperator;
  staging: ManifestStaging;
}

interface ManifestCacheEntry {
  manifest: JobManifest;
  etag: string;
  lastWrite: number;
}

/**
 * Type for scheduling partial manifest updates.
 * Allows partial nested objects (e.g., operator: { accepted: true } without requiring all fields).
 */
interface ManifestUpdates {
  asset?: Partial<ManifestAsset>;
  inference?: Partial<ManifestInference>;
  enrichment?: Partial<ManifestEnrichment>;
  operator?: Partial<ManifestOperator>;
  staging?: Partial<ManifestStaging>;
}

interface PendingWrite {
  uid: string;
  updates: ManifestUpdates;
  timer: NodeJS.Timeout;
}

/**
 * jobManifestWriter: Maintains dual-location JSON manifests (inbox + archive)
 * with atomic writes, debouncing, and ETag caching.
 *
 * Responsibilities:
 * - Write manifest updates to data/sftp-inbox/{uid}.json (active)
 * - Archive snapshots to results/manifests/{uid}.json (immutable)
 * - Compute SHA256 hash for integrity verification
 * - Debounce rapid updates (250ms window)
 * - Provide cached reads with ETag support
 */
export class JobManifestWriter {
  private cache: Map<string, ManifestCacheEntry> = new Map();
  private pendingWrites: Map<string, PendingWrite> = new Map();
  private readonly debounceMs = 250;
  private readonly inboxDir: string;
  private readonly archiveDir: string;
  private readonly version = "2025-11-03";

  constructor(
    private readonly logger: Logger,
    private readonly baseDir: string = process.cwd()
  ) {
    this.inboxDir = path.join(baseDir, "data/sftp-inbox");
    this.archiveDir = path.join(baseDir, "results/manifests");

    // Ensure archive directory exists
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      this.logger.info({ archiveDir: this.archiveDir }, "Created manifest archive directory");
    }

    // Ensure inbox directory exists
    if (!fs.existsSync(this.inboxDir)) {
      fs.mkdirSync(this.inboxDir, { recursive: true });
      this.logger.info({ inboxDir: this.inboxDir }, "Created manifest inbox directory");
    }
  }

  /**
   * Initialize manifest for a new capture
   */
  async initManifest(uid: string, assetPath: string, capturedAt: number): Promise<void> {
    const manifest: JobManifest = {
      uid,
      asset: {
        path: assetPath,
        captured_at: capturedAt,
      },
      inference: {
        cm_card_id: "",
        top_candidates: [],
        engine: "PathA",
        version: this.version,
        retries: 0,
      },
      enrichment: {
        pricing_source: null,
        market_price: null,
        pricing_status: "missing",
        quota_delta: 0,
        updated_at: null,
      },
      operator: {
        accepted: false,
        accepted_without_canonical: false,
        canonical_cm_card_id: null,
        manual_override: false,
        manual_reason_code: null,
        manual_note: null,
      },
      staging: {
        ready: false,
        promoted_by: null,
        promoted_at: null,
      },
    };

    await this.writeManifest(uid, manifest);
  }

  /**
   * Update inference section after job worker completes
   */
  async updateInference(
    uid: string,
    cmCardId: string,
    topCandidates: Array<{ id: string; score: number }>,
    engine: "PathA" | "PathB",
    retries: number
  ): Promise<void> {
    this.scheduleWrite(uid, {
      inference: {
        cm_card_id: cmCardId,
        top_candidates: topCandidates,
        engine,
        version: this.version,
        retries,
      },
    });
  }

  /**
   * Update enrichment section after PPT/CSV pricing
   */
  async updateEnrichment(
    uid: string,
    pricingSource: "ppt" | "csv" | "manual",
    marketPrice: number | null,
    pricingStatus: "fresh" | "stale" | "missing",
    quotaDelta: number
  ): Promise<void> {
    this.scheduleWrite(uid, {
      enrichment: {
        pricing_source: pricingSource,
        market_price: marketPrice,
        pricing_status: pricingStatus,
        quota_delta: quotaDelta,
        updated_at: Date.now(),
      },
    });
  }

  /**
   * Update operator section (manual override, acceptance, canonicalization)
   */
  async updateOperator(
    uid: string,
    updates: {
      accepted?: boolean;
      accepted_without_canonical?: boolean;
      canonical_cm_card_id?: string;
      manual_override?: boolean;
      manual_reason_code?: string;
      manual_note?: string;
    }
  ): Promise<void> {
    this.scheduleWrite(uid, { operator: updates });
  }

  /**
   * Update staging section after promotion
   */
  async updateStaging(uid: string, ready: boolean, promotedBy: string | null = null): Promise<void> {
    this.scheduleWrite(uid, {
      staging: {
        ready,
        promoted_by: promotedBy,
        promoted_at: ready ? Date.now() : null,
      },
    });
  }

  /**
   * Get manifest with ETag for 304 caching
   */
  getManifest(uid: string): { manifest: JobManifest; etag: string } | null {
    const cached = this.cache.get(uid);
    if (cached) {
      return { manifest: cached.manifest, etag: cached.etag };
    }

    // Cache miss: try to load from disk
    const inboxPath = path.join(this.inboxDir, `${uid}.json`);
    if (fs.existsSync(inboxPath)) {
      try {
        const content = fs.readFileSync(inboxPath, "utf8");
        const manifest = JSON.parse(content) as JobManifest;
        const etag = this.computeHash(content);

        this.cache.set(uid, {
          manifest,
          etag,
          lastWrite: Date.now(),
        });

        return { manifest, etag };
      } catch (err) {
        this.logger.warn({ err, uid }, "Failed to load manifest from disk");
        return null;
      }
    }

    return null;
  }

  /**
   * Archive manifest snapshot (called on manual override commit or session close)
   */
  async archiveManifest(uid: string): Promise<void> {
    const inboxPath = path.join(this.inboxDir, `${uid}.json`);
    const archivePath = path.join(this.archiveDir, `${uid}.json`);

    if (!fs.existsSync(inboxPath)) {
      this.logger.warn({ uid }, "Cannot archive manifest: inbox file not found");
      return;
    }

    try {
      fs.copyFileSync(inboxPath, archivePath);
      this.logger.debug({ uid, archivePath }, "Archived manifest snapshot");
    } catch (err) {
      this.logger.error({ err, uid }, "Failed to archive manifest");
      throw err;
    }
  }

  /**
   * Schedule debounced write (coalesce rapid updates)
   */
  private scheduleWrite(uid: string, updates: ManifestUpdates): void {
    const existing = this.pendingWrites.get(uid);

    if (existing) {
      // Clear existing timer and merge updates
      clearTimeout(existing.timer);
      Object.assign(existing.updates, updates);
    } else {
      // Create new pending write
      this.pendingWrites.set(uid, {
        uid,
        updates,
        timer: setTimeout(() => void this.flushWrite(uid), this.debounceMs),
      });
    }
  }

  /**
   * Flush pending write to disk
   */
  private async flushWrite(uid: string): Promise<void> {
    const pending = this.pendingWrites.get(uid);
    if (!pending) return;

    this.pendingWrites.delete(uid);

    try {
      const startMs = Date.now();

      // Load existing manifest or create new one
      const existing = this.getManifest(uid);
      const manifest: JobManifest = existing
        ? { ...existing.manifest }
        : {
          uid,
          asset: { path: "", captured_at: Date.now() },
          inference: { cm_card_id: "", top_candidates: [], engine: "PathA", version: this.version, retries: 0 },
          enrichment: { pricing_source: null, market_price: null, pricing_status: "missing", quota_delta: 0, updated_at: null },
          operator: { accepted: false, accepted_without_canonical: false, canonical_cm_card_id: null, manual_override: false, manual_reason_code: null, manual_note: null },
          staging: { ready: false, promoted_by: null, promoted_at: null },
        };

      // Deep merge updates
      if (pending.updates.inference) {
        Object.assign(manifest.inference, pending.updates.inference);
      }
      if (pending.updates.enrichment) {
        Object.assign(manifest.enrichment, pending.updates.enrichment);
      }
      if (pending.updates.operator) {
        Object.assign(manifest.operator, pending.updates.operator);
      }
      if (pending.updates.staging) {
        Object.assign(manifest.staging, pending.updates.staging);
      }

      await this.writeManifest(uid, manifest);

      const durationMs = Date.now() - startMs;
      this.logger.debug({ uid, durationMs }, "Flushed manifest write");
    } catch (err) {
      this.logger.error({ err, uid }, "Failed to flush manifest write");
      throw err;
    }
  }

  /**
   * Atomic write to inbox location
   */
  private async writeManifest(uid: string, manifest: JobManifest): Promise<void> {
    const inboxPath = path.join(this.inboxDir, `${uid}.json`);
    const tempPath = path.join(this.inboxDir, `.${uid}.json.tmp`);

    try {
      const content = JSON.stringify(manifest, null, 2);
      const hash = this.computeHash(content);

      // Atomic write: temp file + rename
      fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o664 });
      fs.renameSync(tempPath, inboxPath);

      // Update cache
      this.cache.set(uid, {
        manifest,
        etag: hash,
        lastWrite: Date.now(),
      });

      this.logger.debug({ uid, hash: hash.substring(0, 8), path: inboxPath }, "Wrote manifest");
    } catch (err) {
      // Clean up temp file on failure
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw err;
    }
  }

  /**
   * Compute SHA256 hash for ETag and integrity verification
   */
  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Flush all pending writes (called during shutdown)
   */
  async shutdown(): Promise<void> {
    const pending = Array.from(this.pendingWrites.values());
    this.logger.info({ pendingCount: pending.length }, "Flushing pending manifest writes");

    for (const write of pending) {
      clearTimeout(write.timer);
      await this.flushWrite(write.uid);
    }
  }
}
