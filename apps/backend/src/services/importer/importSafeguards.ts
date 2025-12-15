/**
 * EverShop Import Safeguards Service
 * Handles idempotency, audit logging, and safeguards for confirmed imports
 *
 * Safeguards:
 * - Idempotency keys prevent double-imports (unique constraint + payload hash)
 * - Audit log tracks who ran confirm, when, what, and result
 * - 24h TTL cleanup for expired/aborted keys on startup
 *
 * See: apps/backend/docs/routes-evershop.md
 */

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { Logger } from "pino";

export type IdempotencyStatus = "pending" | "completed" | "failed" | "aborted";

export interface IdempotencyCheckResult {
  exists: boolean;
  status?: IdempotencyStatus;
  jobId?: string;
  requestHash?: string;
  createdAt?: number;
}

export interface AuditEntry {
  jobId: string | null;
  idempotencyKey: string;
  userId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  payloadSummary: {
    limit: number;
    skuCount: number;
    firstSkus: string[];
  };
  confirmMode: boolean;
}

export interface AuditResult {
  imported: number;
  created: number;
  updated: number;
  errored: number;
  status: "success" | "partial" | "failed";
  error?: string;
}

export class ImportSafeguardsService {
  private readonly IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
  private readonly PENDING_ABORT_THRESHOLD_SECONDS = 1800; // 30 minutes

  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /**
   * Check if idempotency key has been used
   */
  checkIdempotency(key: string): IdempotencyCheckResult {
    const row = this.db
      .prepare(
        `SELECT job_id, status, request_hash, created_at
         FROM evershop_import_idempotency
         WHERE idempotency_key = ?`
      )
      .get(key) as
      | { job_id: string; status: string; request_hash: string; created_at: number }
      | undefined;

    if (!row) {
      return { exists: false };
    }

    return {
      exists: true,
      status: row.status as IdempotencyStatus,
      jobId: row.job_id,
      requestHash: row.request_hash,
      createdAt: row.created_at,
    };
  }

  /**
   * Register idempotency key for a new import
   * Uses INSERT OR IGNORE to handle concurrent requests safely
   */
  registerIdempotencyKey(
    key: string,
    requestHash: string,
    userId: string | null,
    clientIp: string | null
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO evershop_import_idempotency
         (idempotency_key, job_id, user_id, client_ip, request_hash, created_at, status)
         VALUES (?, NULL, ?, ?, ?, ?, 'pending')`
      )
      .run(key, userId, clientIp, requestHash, now);

    // If changes is 0, key already existed (concurrent request or replay)
    return result.changes > 0;
  }

  /**
   * Update idempotency key with job_id after import starts
   */
  updateIdempotencyJobId(key: string, jobId: string): void {
    this.db
      .prepare(
        `UPDATE evershop_import_idempotency
         SET job_id = ?
         WHERE idempotency_key = ?`
      )
      .run(jobId, key);
  }

  /**
   * Mark idempotency key as completed or failed
   */
  completeIdempotency(key: string, status: "completed" | "failed"): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE evershop_import_idempotency
         SET status = ?, completed_at = ?
         WHERE idempotency_key = ?`
      )
      .run(status, now, key);
  }

  /**
   * Generate deterministic hash of request payload for replay detection
   * Uses sorted JSON to ensure consistent hashing regardless of key order
   */
  hashPayload(limit: number, productUids: string[]): string {
    // Sort for deterministic hash
    const sorted = [...productUids].sort();
    const content = JSON.stringify({ limit, productUids: sorted });
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Create audit log entry at import start
   * Called even before import begins to ensure failures are logged
   */
  createAuditEntry(entry: AuditEntry): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        `INSERT INTO evershop_import_audit
         (job_id, idempotency_key, user_id, client_ip, user_agent,
          payload_summary, confirm_mode, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.jobId,
        entry.idempotencyKey,
        entry.userId,
        entry.clientIp,
        entry.userAgent,
        JSON.stringify(entry.payloadSummary),
        entry.confirmMode ? 1 : 0,
        now
      );

    this.logger.info(
      {
        auditId: result.lastInsertRowid,
        jobId: entry.jobId,
        idempotencyKey: entry.idempotencyKey,
        userId: entry.userId ?? "unknown",
        clientIp: entry.clientIp ?? "unknown",
        confirmMode: entry.confirmMode,
        skuCount: entry.payloadSummary.skuCount,
      },
      "evershop_import.audit.started"
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Complete audit log entry with results
   * Called in finally block to ensure failures are recorded
   */
  completeAuditEntry(idempotencyKey: string, results: AuditResult): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE evershop_import_audit
         SET completed_at = ?, products_imported = ?, products_created = ?,
             products_updated = ?, products_errored = ?, result_status = ?, error_message = ?
         WHERE idempotency_key = ? AND completed_at IS NULL`
      )
      .run(
        now,
        results.imported,
        results.created,
        results.updated,
        results.errored,
        results.status,
        results.error ?? null,
        idempotencyKey
      );

    const logMethod = results.status === "failed" ? "error" : "info";
    this.logger[logMethod](
      {
        idempotencyKey,
        imported: results.imported,
        created: results.created,
        updated: results.updated,
        errored: results.errored,
        status: results.status,
        error: results.error,
      },
      `evershop_import.audit.${results.status}`
    );
  }

  /**
   * Cleanup expired idempotency keys (call on startup)
   * Also marks "pending" keys older than threshold as "aborted"
   */
  cleanupExpiredKeys(): { deleted: number; aborted: number } {
    const now = Math.floor(Date.now() / 1000);
    const expiryCutoff = now - this.IDEMPOTENCY_TTL_SECONDS;
    const abortCutoff = now - this.PENDING_ABORT_THRESHOLD_SECONDS;

    // Mark stale pending imports as aborted (process may have crashed)
    const abortResult = this.db
      .prepare(
        `UPDATE evershop_import_idempotency
         SET status = 'aborted', completed_at = ?
         WHERE status = 'pending' AND created_at < ?`
      )
      .run(now, abortCutoff);

    // Delete old completed/failed/aborted keys
    const deleteResult = this.db
      .prepare(
        `DELETE FROM evershop_import_idempotency
         WHERE created_at < ? AND status IN ('completed', 'failed', 'aborted')`
      )
      .run(expiryCutoff);

    if (abortResult.changes > 0) {
      this.logger.warn(
        { aborted: abortResult.changes },
        "evershop_import.cleanup.aborted_stale"
      );
    }

    return {
      deleted: deleteResult.changes,
      aborted: abortResult.changes,
    };
  }

  /**
   * Get stored report for idempotent replay (returns audit entry details)
   */
  getAuditEntryByIdempotencyKey(key: string): {
    jobId: string | null;
    imported: number;
    created: number;
    updated: number;
    errored: number;
    status: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT job_id, products_imported, products_created, products_updated,
                products_errored, result_status
         FROM evershop_import_audit
         WHERE idempotency_key = ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(key) as {
        job_id: string | null;
        products_imported: number;
        products_created: number;
        products_updated: number;
        products_errored: number;
        result_status: string | null;
      } | undefined;

    if (!row) return null;

    return {
      jobId: row.job_id,
      imported: row.products_imported,
      created: row.products_created,
      updated: row.products_updated,
      errored: row.products_errored,
      status: row.result_status,
    };
  }

  /**
   * Extract Basic Auth user from Authorization header
   */
  extractBasicAuthUser(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return null;
    }
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const [username] = decoded.split(":");
      return username || null;
    } catch {
      return null;
    }
  }

  /**
   * Get client IP from request (handles X-Forwarded-For behind nginx)
   */
  extractClientIp(
    xForwardedFor: string | undefined,
    remoteAddress: string | undefined
  ): string | null {
    if (xForwardedFor) {
      // Take first IP in chain (original client)
      return xForwardedFor.split(",")[0].trim();
    }
    return remoteAddress || null;
  }
}
