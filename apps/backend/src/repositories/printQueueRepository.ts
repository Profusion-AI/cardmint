import type { Database } from "better-sqlite3";
import type { Logger } from "pino";

export type ShipmentType = "stripe" | "marketplace";
export type PrintQueueStatus = "pending" | "downloading" | "ready" | "printing" | "printed" | "failed";
export type ReviewStatus = "needs_review" | "reviewed";

export interface LabelPrintQueueRow {
  id: number;
  shipment_id: number;
  shipment_type: ShipmentType;
  label_url: string;
  label_local_path: string | null;
  status: PrintQueueStatus;
  review_status: ReviewStatus;
  print_count: number;
  attempts: number;
  last_attempt_at: number | null;
  error_message: string | null;
  printer_job_id: string | null;
  created_at: number;
  archived_at: number | null;
  printed_at: number | null;
}

export class PrintQueueRepository {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /**
   * Ensure a print queue row exists for a shipment.
   *
   * Rules:
   * - Insert exactly one row per (shipment_type, shipment_id) if missing.
   * - If label_url changes (repurchase/new label), reset archival/print state and set status='pending'.
   * - If label_url unchanged, do not reset state (idempotent retries should not reprint by default).
   */
  upsertForShipment(params: { shipmentType: ShipmentType; shipmentId: number; labelUrl: string }): void {
    const existing = this.getByShipment(params.shipmentType, params.shipmentId);

    if (!existing) {
      this.db
        .prepare(
          `
          INSERT INTO label_print_queue (
            shipment_id, shipment_type, label_url, status, review_status
          ) VALUES (?, ?, ?, 'pending', 'needs_review')
        `
        )
        .run(params.shipmentId, params.shipmentType, params.labelUrl);
      return;
    }

    // Label URL changed -> treat as repurchase/new-label and reset state.
    if (existing.label_url !== params.labelUrl) {
      this.db
        .prepare(
          `
          UPDATE label_print_queue
          SET label_url = ?,
              label_local_path = NULL,
              status = 'pending',
              review_status = 'needs_review',
              print_count = 0,
              attempts = 0,
              last_attempt_at = NULL,
              error_message = NULL,
              printer_job_id = NULL,
              archived_at = NULL,
              printed_at = NULL
          WHERE shipment_type = ? AND shipment_id = ?
        `
        )
        .run(params.labelUrl, params.shipmentType, params.shipmentId);
      return;
    }
  }

  getByShipment(shipmentType: ShipmentType, shipmentId: number): LabelPrintQueueRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM label_print_queue WHERE shipment_type = ? AND shipment_id = ? LIMIT 1`
      )
      .get(shipmentType, shipmentId) as LabelPrintQueueRow | undefined;
    return row ?? null;
  }

  getById(id: number): LabelPrintQueueRow | null {
    const row = this.db
      .prepare(`SELECT * FROM label_print_queue WHERE id = ?`)
      .get(id) as LabelPrintQueueRow | undefined;
    return row ?? null;
  }

  list(params: { status?: PrintQueueStatus; reviewStatus?: ReviewStatus; limit: number; offset: number }): {
    rows: LabelPrintQueueRow[];
    total: number;
  } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (params.status) {
      where.push("status = ?");
      args.push(params.status);
    }
    if (params.reviewStatus) {
      where.push("review_status = ?");
      args.push(params.reviewStatus);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `
        SELECT * FROM label_print_queue
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `
      )
      .all(...args, params.limit, params.offset) as LabelPrintQueueRow[];

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM label_print_queue ${whereSql}`)
      .get(...args) as { total: number };

    return { rows, total: countRow.total };
  }

  getStatusCounts(): Record<PrintQueueStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as count FROM label_print_queue GROUP BY status`)
      .all() as { status: PrintQueueStatus; count: number }[];
    const counts: Record<PrintQueueStatus, number> = {
      pending: 0,
      downloading: 0,
      ready: 0,
      printing: 0,
      printed: 0,
      failed: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  getNeedsReviewCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as total FROM label_print_queue WHERE review_status = 'needs_review'`)
      .get() as { total: number };
    return row.total;
  }

  markReviewed(queueId: number): boolean {
    const result = this.db
      .prepare(`UPDATE label_print_queue SET review_status = 'reviewed' WHERE id = ?`)
      .run(queueId);
    return result.changes === 1;
  }

  /**
   * Admin-triggered reprint request.
   *
   * If we have a local archive path, move to 'ready' so agent prints from archive.
   * If not, move back to 'pending' so agent attempts download again.
   */
  requestReprint(queueId: number): { ok: boolean; status?: PrintQueueStatus; error?: string } {
    const row = this.getById(queueId);
    if (!row) return { ok: false, error: "Queue item not found" };

    const nextStatus: PrintQueueStatus = row.label_local_path ? "ready" : "pending";

    const result = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = ?,
            error_message = NULL,
            printer_job_id = NULL
        WHERE id = ?
      `
      )
      .run(nextStatus, queueId);

    return result.changes === 1 ? { ok: true, status: nextStatus } : { ok: false, error: "Failed to update queue item" };
  }

  // ---------------------------------------------------------------------------
  // Print agent claim/update methods
  // ---------------------------------------------------------------------------

  /**
   * Recover stuck jobs:
   * - downloading: safe to return to pending after threshold
   * - printing: mark failed after threshold to avoid accidental double prints
   */
  recoverStuckJobs(nowSec: number, thresholdSec: number): void {
    const staleBefore = nowSec - thresholdSec;

    // Recover stale downloads -> pending (safe to retry download)
    this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'pending',
            error_message = 'Recovered stale download attempt (agent crash/offline)',
            printer_job_id = NULL
        WHERE status = 'downloading'
          AND last_attempt_at IS NOT NULL
          AND last_attempt_at < ?
      `
      )
      .run(staleBefore);

    // Stale prints -> failed (avoid auto double-print)
    this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'failed',
            error_message = 'Print attempt appears stuck (agent crash/offline). Use Reprint to retry explicitly.'
        WHERE status = 'printing'
          AND last_attempt_at IS NOT NULL
          AND last_attempt_at < ?
      `
      )
      .run(staleBefore);
  }

  claimNextDownload(nowSec: number): LabelPrintQueueRow | null {
    const row = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'downloading',
            attempts = attempts + 1,
            last_attempt_at = ?,
            error_message = NULL,
            printer_job_id = NULL
        WHERE id = (
          SELECT id FROM label_print_queue
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1
        )
        RETURNING *
      `
      )
      .get(nowSec) as LabelPrintQueueRow | undefined;
    return row ?? null;
  }

  markDownloadComplete(params: { queueId: number; localPath: string; archivedAt: number }): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET label_local_path = ?,
            status = 'ready',
            archived_at = ?,
            error_message = NULL
        WHERE id = ? AND status = 'downloading'
      `
      )
      .run(params.localPath, params.archivedAt, params.queueId);
    return result.changes === 1;
  }

  claimNextPrint(nowSec: number): LabelPrintQueueRow | null {
    const row = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'printing',
            attempts = attempts + 1,
            last_attempt_at = ?,
            error_message = NULL
        WHERE id = (
          SELECT id FROM label_print_queue
          WHERE status = 'ready'
          ORDER BY archived_at ASC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `
      )
      .get(nowSec) as LabelPrintQueueRow | undefined;
    return row ?? null;
  }

  markPrintComplete(params: { queueId: number; printedAt: number; printerJobId?: string | null }): boolean {
    // Auto-mark review_status='reviewed' when print succeeds (CEO decision 2026-01-03)
    const result = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'printed',
            printed_at = ?,
            print_count = print_count + 1,
            printer_job_id = ?,
            error_message = NULL,
            review_status = 'reviewed'
        WHERE id = ? AND status = 'printing'
      `
      )
      .run(params.printedAt, params.printerJobId ?? null, params.queueId);
    return result.changes === 1;
  }

  markFailed(params: { queueId: number; message: string; nowSec: number }): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE label_print_queue
        SET status = 'failed',
            error_message = ?
        WHERE id = ?
      `
      )
      .run(params.message, params.queueId);
    if (result.changes === 1) {
      this.logger.warn({ queueId: params.queueId, message: params.message }, "printQueue.item.failed");
    }
    return result.changes === 1;
  }
}

