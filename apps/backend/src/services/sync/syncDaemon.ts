/**
 * Sync Daemon
 * Standalone worker for processing pending sync events
 * RFC-fullduplexDB_triple Phase 1
 *
 * Run as: node dist/services/sync/syncDaemon.js
 * Or via systemd: cardmint-sync.service
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../../db/connection";
import { createLogger } from "../../app/context";
import { runtimeConfig } from "../../config";
import { SyncService } from "./syncService";
import type { SyncLeader, SyncEvent } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SyncDaemon {
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number = 60000; // 1 minute lease
  private running = false;
  private syncService: SyncService | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    // Unique identifier for this daemon instance
    this.leaseOwner = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Start the daemon main loop
   */
  async start(): Promise<void> {
    if (!runtimeConfig.syncEnabled) {
      this.logger.warn("Sync daemon disabled (SYNC_ENABLED=false). Exiting.");
      process.exit(0);
    }

    this.logger.info({ leaseOwner: this.leaseOwner }, "Sync daemon starting");

    // Initialize sync service
    this.syncService = new SyncService(this.db, this.logger);

    // Attempt to acquire lease
    const acquired = await this.acquireLease();
    if (!acquired) {
      this.logger.info("Another daemon holds the lease. Exiting.");
      process.exit(0);
    }

    this.running = true;

    // Setup graceful shutdown
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));

    // Main loop
    this.logger.info(
      { leaseOwner: this.leaseOwner, intervalMs: runtimeConfig.syncIntervalMs },
      "Sync daemon started, entering main loop"
    );

    while (this.running) {
      try {
        // Renew lease
        const renewed = await this.renewLease();
        if (!renewed) {
          this.logger.warn("Failed to renew lease, exiting");
          break;
        }

        // Run sync cycle
        await this.runSyncCycle();

        // Update last sync cycle timestamp in sync_leader
        this.updateLastSyncCycle();

        // Wait for next interval
        await sleep(runtimeConfig.syncIntervalMs);
      } catch (error) {
        this.logger.error({ error }, "Error in sync cycle");
        // Backoff on error
        await sleep(Math.min(runtimeConfig.syncIntervalMs * 2, 60000));
      }
    }

    this.logger.info("Sync daemon stopped");
  }

  /**
   * Acquire the leader lease
   */
  private async acquireLease(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + Math.floor(this.leaseDurationMs / 1000);

    try {
      // Try to insert or update expired lease
      const result = this.db
        .prepare(
          `INSERT INTO sync_leader (id, lease_owner, lease_expires_at, last_heartbeat)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             lease_owner = excluded.lease_owner,
             lease_expires_at = excluded.lease_expires_at,
             last_heartbeat = excluded.last_heartbeat
           WHERE lease_expires_at < ?`
        )
        .run(this.leaseOwner, expiresAt, now, now);

      if (result.changes > 0) {
        this.logger.info({ leaseOwner: this.leaseOwner, expiresAt }, "Lease acquired");
        return true;
      }

      // Check who holds the lease
      const current = this.db
        .prepare("SELECT lease_owner, lease_expires_at FROM sync_leader WHERE id = 1")
        .get() as SyncLeader | undefined;

      if (current) {
        this.logger.info(
          { currentOwner: current.lease_owner, expiresAt: current.lease_expires_at },
          "Lease held by another daemon"
        );
      }

      return false;
    } catch (error) {
      this.logger.error({ error }, "Failed to acquire lease");
      return false;
    }
  }

  /**
   * Renew the leader lease
   */
  private async renewLease(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + Math.floor(this.leaseDurationMs / 1000);

    try {
      const result = this.db
        .prepare(
          `UPDATE sync_leader
           SET lease_expires_at = ?, last_heartbeat = ?
           WHERE id = 1 AND lease_owner = ?`
        )
        .run(expiresAt, now, this.leaseOwner);

      if (result.changes === 0) {
        // Lost the lease
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error({ error }, "Failed to renew lease");
      return false;
    }
  }

  /**
   * Release the lease on shutdown
   */
  private releaseLease(): void {
    try {
      this.db
        .prepare(
          `UPDATE sync_leader
           SET lease_expires_at = 0
           WHERE id = 1 AND lease_owner = ?`
        )
        .run(this.leaseOwner);
      this.logger.info("Lease released");
    } catch (error) {
      this.logger.warn({ error }, "Failed to release lease");
    }
  }

  /**
   * Update last sync cycle timestamp
   */
  private updateLastSyncCycle(): void {
    const now = Math.floor(Date.now() / 1000);
    try {
      this.db
        .prepare(
          `UPDATE sync_leader
           SET last_heartbeat = ?
           WHERE id = 1 AND lease_owner = ?`
        )
        .run(now, this.leaseOwner);
    } catch (error) {
      this.logger.warn({ error }, "Failed to update last sync cycle");
    }
  }

  /**
   * Run a single sync cycle
   */
  private async runSyncCycle(): Promise<void> {
    if (!this.syncService) {
      return;
    }

    const cycleStart = Date.now();

    // 1. Process pending promotion events
    const pendingEvents = this.syncService.getPendingSyncEvents(10);

    if (pendingEvents.length > 0) {
      this.logger.info({ count: pendingEvents.length }, "Processing pending sync events");

      for (const event of pendingEvents) {
        await this.processEvent(event);
      }
    }

    // 2. Retry failed events (with backoff)
    const failedEvents = this.syncService.getFailedSyncEvents(5);

    if (failedEvents.length > 0) {
      this.logger.info({ count: failedEvents.length }, "Retrying failed sync events");

      for (const event of failedEvents) {
        // Exponential backoff based on retry count
        const minAge = Math.pow(2, event.retry_count) * 60; // 1m, 2m, 4m, 8m, etc.
        const eventAge = Math.floor(Date.now() / 1000) - event.created_at;

        if (eventAge >= minAge) {
          await this.processEvent(event);
        }
      }
    }

    // 3. Phase 2: Pull sale events from prod and archive to staging
    let salesSynced = 0;
    try {
      const salesResult = await this.syncService.syncSales(10);
      salesSynced = salesResult.synced;

      if (salesResult.total > 0) {
        this.logger.info(
          { total: salesResult.total, synced: salesResult.synced, failed: salesResult.failed },
          "Sale sync completed"
        );
      }
    } catch (error) {
      this.logger.warn({ error }, "Sale sync failed (will retry next cycle)");
    }

    const cycleMs = Date.now() - cycleStart;
    if (pendingEvents.length > 0 || failedEvents.length > 0 || salesSynced > 0) {
      this.logger.info(
        { pendingProcessed: pendingEvents.length, failedRetried: failedEvents.length, salesSynced, cycleMs },
        "Sync cycle complete"
      );
    }
  }

  /**
   * Process a single sync event
   */
  private async processEvent(event: SyncEvent): Promise<void> {
    if (!this.syncService) {
      return;
    }

    const startMs = Date.now();

    try {
      switch (event.event_type) {
        case "promote":
          // Re-attempt promotion
          await this.syncService.promoteProduct(event.product_uid);
          break;

        case "sale":
          // Phase 2: Sale events are handled by syncSales() in bulk
          // Individual sale events in local queue shouldn't happen (they come from prod)
          this.logger.debug({ eventUid: event.event_uid }, "Sale event in local queue (processed by syncSales)");
          break;

        case "evershop_hide_listing":
          await this.syncService.processEvershopHideListing(event);
          break;

        case "unpromote":
          // Unpromote should complete synchronously, not go through daemon
          this.logger.warn({ eventUid: event.event_uid }, "Unexpected unpromote event in daemon queue");
          break;

        default:
          this.logger.warn({ eventType: event.event_type }, "Unknown event type");
      }

      this.logger.debug(
        { eventUid: event.event_uid, eventType: event.event_type, ms: Date.now() - startMs },
        "Event processed"
      );
    } catch (error) {
      this.logger.error(
        { eventUid: event.event_uid, error },
        "Failed to process sync event"
      );
      // BUG 1 fix: Update event status on unhandled errors so it doesn't retry forever
      // Note: evershop_hide_listing handles its own errors; this catches promote/other events
      try {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.syncService.markEventFailed(event.event_uid, errMsg);
      } catch (markErr) {
        this.logger.warn({ eventUid: event.event_uid, markErr }, "Failed to mark event as failed");
      }
    }
  }

  /**
   * Graceful shutdown
   */
  private shutdown(signal: string): void {
    this.logger.info({ signal }, "Received shutdown signal");
    this.running = false;
    this.releaseLease();

    // Give pending operations time to complete
    setTimeout(() => {
      this.logger.info("Shutdown complete");
      process.exit(0);
    }, 2000);
  }
}

// -----------------------------------------------------------------------------
// Standalone entry point
// -----------------------------------------------------------------------------

if (process.argv[1]?.includes("syncDaemon")) {
  const logger = createLogger();
  const db = openDatabase();

  const daemon = new SyncDaemon(db, logger);
  daemon.start().catch((error) => {
    logger.error({ error }, "Daemon failed to start");
    process.exit(1);
  });
}
