/**
 * Sync Service
 * Handles promotion workflow: staging → prod SQLite + EverShop PostgreSQL
 * RFC-fullduplexDB_triple Phase 1
 */

import type * as Database from "better-sqlite3";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config";
import { RemoteDbService } from "./remoteDbService";
import { EverShopImporter } from "../importer/evershopClient";
import type {
  SyncEvent,
  SyncResult,
  SyncHealthReport,
  SyncSalesResult,
  ProductSnapshot,
  SaleSnapshot,
  EvershopHideListingPayload,
  EverShopSyncState,
  PromoteCandidateRow,
  SyncEventStatus,
  EverShopWebhookPayload,
  WebhookProcessResult,
} from "./types";

export class SyncService {
  private readonly remoteDb: RemoteDbService;
  private readonly evershopImporter: EverShopImporter | null;

  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger
  ) {
    this.remoteDb = new RemoteDbService(logger);

    // EverShop importer for PostgreSQL writes (reuse existing implementation)
    try {
      this.evershopImporter = new EverShopImporter(db, {
        apiUrl: runtimeConfig.evershopApiUrl,
        adminToken: runtimeConfig.evershopAdminToken,
        environment: runtimeConfig.evershopEnvironment as "staging" | "production",
        sshHost: runtimeConfig.evershopSshHost,
        sshUser: runtimeConfig.evershopSshUser,
        sshKeyPath: runtimeConfig.evershopSshKeyPath,
        dockerComposePath: runtimeConfig.evershopDockerComposePath,
        dbUser: runtimeConfig.evershopDbUser,
        dbName: runtimeConfig.evershopDbName,
      }, logger);
    } catch (error) {
      this.logger.warn({ error }, "Failed to initialize EverShop importer");
      this.evershopImporter = null;
    }
  }

  /**
   * Get products ready for promotion
   * Criteria: staging_ready=1, pricing_status='fresh', has cdn_image_url, evershop_sync_state='not_synced' or null
   */
  getPromotionCandidates(limit = 100): PromoteCandidateRow[] {
    return this.db
      .prepare(
        `SELECT
           product_uid, product_sku, card_name, set_name, collector_no,
           condition_bucket, market_price, launch_price, cdn_image_url,
           staging_ready, evershop_sync_state
         FROM products
         WHERE staging_ready = 1
           AND pricing_status = 'fresh'
           AND market_price IS NOT NULL
           AND cdn_image_url IS NOT NULL
           AND (evershop_sync_state IS NULL OR evershop_sync_state = 'not_synced')
           AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
         LIMIT ?`
      )
      .all(limit) as PromoteCandidateRow[];
  }

  /**
   * Promote a single product from staging to production
   * Three-phase commit: prod SQLite → EverShop PG → visibility
   */
  async promoteProduct(productUid: string, operatorId?: string): Promise<SyncResult> {
    const now = Math.floor(Date.now() / 1000);
    const eventUid = `PROMOTE:${productUid}:${Math.floor(now / 60)}`;

    if (!runtimeConfig.syncEnabled) {
      return {
        success: false,
        event_uid: eventUid,
        error: "Sync disabled (SYNC_ENABLED=false)",
      };
    }

    this.logger.info({ productUid, eventUid }, "Starting product promotion");

    // 1. Fetch product snapshot from staging
    const product = this.db
      .prepare(
        `SELECT
           product_uid, public_sku, card_name, set_name, collector_no,
           condition_bucket, market_price, launch_price, pricing_status,
           total_quantity, cm_card_id, evershop_sync_state, sync_version,
           cdn_image_url, cdn_back_image_url, variant_tags, created_at, updated_at,
           product_sku, listing_sku, hp_value, rarity
         FROM products
         WHERE product_uid = ?
           AND staging_ready = 1
           AND pricing_status = 'fresh'
           AND market_price IS NOT NULL
           AND cdn_image_url IS NOT NULL
           AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)`
      )
      .get(productUid) as ProductSnapshot & { product_sku: string; listing_sku: string; hp_value: number | null; rarity: string | null } | undefined;

    if (!product) {
      return {
        success: false,
        event_uid: eventUid,
        error: `Product not found: ${productUid}`,
      };
    }

    // Check if already promoted
    if (product.evershop_sync_state && product.evershop_sync_state !== "not_synced") {
      return {
        success: false,
        event_uid: eventUid,
        error: `Product already in state: ${product.evershop_sync_state}`,
      };
    }

    // Build full snapshot for audit
    const snapshot: ProductSnapshot = {
      product_uid: product.product_uid,
      public_sku: product.public_sku,
      card_name: product.card_name,
      set_name: product.set_name,
      collector_no: product.collector_no,
      condition_bucket: product.condition_bucket,
      market_price: product.market_price,
      launch_price: product.launch_price,
      pricing_status: product.pricing_status,
      total_quantity: product.total_quantity,
      status: "IN_STOCK",
      evershop_sync_state: "not_synced",
      sync_version: product.sync_version || 1,
      cdn_image_url: product.cdn_image_url,
      cdn_back_image_url: product.cdn_back_image_url,
      cm_card_id: product.cm_card_id,
      variant_tags: product.variant_tags ?? null,
      created_at: product.created_at,
      updated_at: product.updated_at,
    };

    // 2. Create pending sync event
    this.db
      .prepare(
        `INSERT INTO sync_events (event_uid, event_type, product_uid, source_db, target_db, operator_id, payload, status, created_at)
         VALUES (?, 'promote', ?, 'staging', 'production', ?, ?, 'pending', ?)`
      )
      .run(eventUid, productUid, operatorId ?? null, JSON.stringify(snapshot), now);

    let finalState: EverShopSyncState = "not_synced";
    let errorMessage: string | undefined;

    try {
      // 3. Phase 1: Write to prod SQLite
      const prodInsertResult = await this.writeToProdSqlite(product, snapshot);
      if (!prodInsertResult.success) {
        throw new Error(`Prod SQLite write failed: ${prodInsertResult.error}`);
      }
      finalState = "vault_only";

      // Update staging state
      this.updateStagingState(productUid, finalState, now);

      // 4. Phase 2: Write to EverShop PostgreSQL
      if (this.evershopImporter) {
        try {
          const evershopResult = await this.evershopImporter.importProductIfReady(productUid);
          if (evershopResult.imported) {
            finalState = runtimeConfig.syncAutoPublishEvershop ? "evershop_live" : "evershop_hidden";
            this.updateStagingState(productUid, finalState, now);
          } else {
            this.logger.warn(
              { productUid, reason: evershopResult.reason },
              "EverShop import skipped (product not ready or import failed)"
            );
            // Stay at vault_only - EverShop sync can be retried later
          }
        } catch (evershopError) {
          this.logger.warn({ productUid, error: evershopError }, "EverShop sync failed, staying at vault_only");
          // Don't fail the entire promotion - prod SQLite succeeded
        }
      }

      // 5. Mark sync event as synced
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'synced', synced_at = ?
           WHERE event_uid = ?`
        )
        .run(now, eventUid);

      this.logger.info({ productUid, eventUid, finalState }, "Product promoted successfully");

      return {
        success: true,
        event_uid: eventUid,
        evershop_sync_state: finalState,
      };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Mark sync event as failed
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'failed', error_message = ?, retry_count = retry_count + 1
           WHERE event_uid = ?`
        )
        .run(errorMessage, eventUid);

      // Update staging state to sync_error if we got past vault_only
      if (finalState !== "not_synced") {
        this.updateStagingState(productUid, "sync_error", now);
      }

      this.logger.error({ productUid, eventUid, error: errorMessage }, "Product promotion failed");

      return {
        success: false,
        event_uid: eventUid,
        evershop_sync_state: finalState === "not_synced" ? undefined : "sync_error",
        error: errorMessage,
      };
    }
  }

  /**
   * Unpromote a product (rollback from production)
   */
  async unpromoteProduct(productUid: string, operatorId?: string): Promise<SyncResult> {
    const now = Math.floor(Date.now() / 1000);
    const eventUid = `UNPROMOTE:${productUid}:${Math.floor(now / 60)}`;

    if (!runtimeConfig.syncEnabled) {
      return {
        success: false,
        event_uid: eventUid,
        error: "Sync disabled (SYNC_ENABLED=false)",
      };
    }

    this.logger.info({ productUid, eventUid }, "Starting product unpromote");

    // 1. Check current state
    const product = this.db
      .prepare(
        `SELECT product_uid, evershop_sync_state, evershop_product_id, sync_version
         FROM products WHERE product_uid = ?`
      )
      .get(productUid) as { product_uid: string; evershop_sync_state: EverShopSyncState | null; evershop_product_id: number | null; sync_version: number } | undefined;

    if (!product) {
      return {
        success: false,
        event_uid: eventUid,
        error: `Product not found: ${productUid}`,
      };
    }

    if (!product.evershop_sync_state || product.evershop_sync_state === "not_synced") {
      return {
        success: false,
        event_uid: eventUid,
        error: "Product is not promoted (state: not_synced)",
      };
    }

    // 2. Check for SOLD items in prod before allowing unpromote
    // This prevents orphaning Stripe/order references
    try {
      const soldCheckResult = await this.remoteDb.queryProd<{ sold_count: number }>(
        `SELECT COUNT(*) as sold_count FROM items WHERE product_uid = '${productUid.replace(/'/g, "''")}' AND status = 'SOLD'`
      );
      const soldCount = soldCheckResult[0]?.sold_count ?? 0;
      if (soldCount > 0) {
        this.logger.warn(
          { productUid, soldCount },
          "Cannot unpromote product with SOLD items"
        );
        return {
          success: false,
          event_uid: eventUid,
          error: `Cannot unpromote: ${soldCount} item(s) already SOLD in production`,
        };
      }
    } catch (soldCheckError) {
      // If we can't reach prod to check, fail safe
      this.logger.error({ productUid, error: soldCheckError }, "Failed to check sold items in prod");
      return {
        success: false,
        event_uid: eventUid,
        error: "Cannot unpromote: failed to verify sold status in production",
      };
    }

    try {
      // 3. Remove from prod SQLite
      await this.remoteDb.runProd(
        `DELETE FROM products WHERE product_uid = '${productUid.replace(/'/g, "''")}'`
      );

      // 3. Remove from EverShop (set visibility=false, don't delete)
      if (product.evershop_product_id && this.evershopImporter) {
        try {
          // Set visibility=false in EverShop
          await this.setEvershopVisibility(product.evershop_product_id, false);
        } catch (error) {
          this.logger.warn({ productUid, error }, "Failed to hide product in EverShop");
        }
      }

      // 4. Reset staging state
      this.db
        .prepare(
          `UPDATE products
           SET evershop_sync_state = 'not_synced',
               promoted_at = NULL,
               last_synced_at = ?,
               sync_version = sync_version + 1
           WHERE product_uid = ?`
        )
        .run(now, productUid);

      // 5. Record unpromote event
      this.db
        .prepare(
          `INSERT INTO sync_events (event_uid, event_type, product_uid, source_db, target_db, operator_id, payload, status, synced_at, created_at)
           VALUES (?, 'unpromote', ?, 'production', 'staging', ?, '{}', 'synced', ?, ?)`
        )
        .run(eventUid, productUid, operatorId ?? null, now, now);

      this.logger.info({ productUid, eventUid }, "Product unpromoted successfully");

      return {
        success: true,
        event_uid: eventUid,
        evershop_sync_state: "not_synced",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      this.logger.error({ productUid, eventUid, error: errorMessage }, "Product unpromote failed");

      return {
        success: false,
        event_uid: eventUid,
        error: errorMessage,
      };
    }
  }

  /**
   * Get pending sync events
   */
  getPendingSyncEvents(limit = 50): SyncEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_events
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as SyncEvent[];
  }

  /**
   * Get failed sync events for retry
   */
  getFailedSyncEvents(limit = 50): SyncEvent[] {
    return this.db
      .prepare(
        `SELECT * FROM sync_events
         WHERE status = 'failed'
         ORDER BY retry_count ASC, created_at ASC
         LIMIT ?`
      )
      .all(limit) as SyncEvent[];
  }

  /**
   * Get sync events with filters
   */
  getSyncEvents(filters: { status?: SyncEventStatus; event_type?: string; limit?: number }): SyncEvent[] {
    let sql = "SELECT * FROM sync_events WHERE 1=1";
    const params: unknown[] = [];

    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.event_type) {
      sql += " AND event_type = ?";
      params.push(filters.event_type);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filters.limit ?? 100);

    return this.db.prepare(sql).all(...params) as SyncEvent[];
  }

  // ==========================================================================
  // EverShop Sale Sync (Hide Listing)
  // ==========================================================================

  /**
   * Mark a sync event as failed with error message and increment retry count
   * Public method for daemon error handling (BUG 1 fix)
   */
  markEventFailed(eventUid: string, errorMessage: string, maxRetries = 5): void {
    const event = this.db
      .prepare("SELECT retry_count FROM sync_events WHERE event_uid = ?")
      .get(eventUid) as { retry_count: number | null } | undefined;

    const nextRetry = (event?.retry_count ?? 0) + 1;
    const status = nextRetry >= maxRetries ? "conflict" : "failed";

    this.db
      .prepare(
        `UPDATE sync_events
         SET status = ?, error_message = ?, retry_count = ?
         WHERE event_uid = ?`
      )
      .run(status, errorMessage, nextRetry, eventUid);
  }

  /**
   * Process a pending evershop_hide_listing event (hide listing + zero inventory)
   */
  async processEvershopHideListing(event: SyncEvent): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const maxRetries = runtimeConfig.evershopSaleSyncMaxRetries;

    const markFailure = (message: string, productUid?: string): void => {
      const nextRetry = (event.retry_count ?? 0) + 1;
      const terminal = nextRetry >= maxRetries;
      const status: SyncEventStatus = terminal ? "conflict" : "failed";
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = ?, error_message = ?, retry_count = ?
           WHERE event_uid = ?`
        )
        .run(status, message, nextRetry, event.event_uid);

      // BUG 3 fix: Update evershop_sync_state to 'sync_error' on terminal failure
      if (terminal && productUid) {
        this.db
          .prepare(
            `UPDATE products
             SET evershop_sync_state = 'sync_error'
             WHERE product_uid = ?`
          )
          .run(productUid);
        this.logger.warn(
          { product_uid: productUid, event_uid: event.event_uid },
          "Hide event hit max retries - marked product as sync_error"
        );
      }
    };

    const markSuccess = (): void => {
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'synced', synced_at = ?, error_message = NULL
           WHERE event_uid = ?`
        )
        .run(now, event.event_uid);
    };

    if (!runtimeConfig.evershopSaleSyncEnabled || runtimeConfig.cardmintEnv !== "production") {
      this.logger.warn(
        { event_uid: event.event_uid },
        "EverShop sale sync disabled or non-production environment"
      );
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'conflict', error_message = ?
           WHERE event_uid = ?`
        )
        .run("Sale sync disabled or non-production environment", event.event_uid);
      return;
    }

    if (!this.evershopImporter) {
      markFailure("EverShop importer not configured");
      return;
    }

    let payload: EvershopHideListingPayload;
    try {
      payload = JSON.parse(event.payload) as EvershopHideListingPayload;
    } catch {
      markFailure("Invalid JSON payload");
      return;
    }

    if (!payload.livemode) {
      this.logger.warn({ event_uid: event.event_uid }, "Skipping non-livemode sale event");
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'conflict', error_message = ?
           WHERE event_uid = ?`
        )
        .run("Sale was not livemode", event.event_uid);
      return;
    }

    const productRow = this.db
      .prepare(
        `SELECT product_uid, product_sku, total_quantity, evershop_product_id
         FROM products WHERE product_uid = ?`
      )
      .get(payload.product_uid) as
      | { product_uid: string; product_sku: string | null; total_quantity: number; evershop_product_id: number | null }
      | undefined;

    if (!productRow) {
      markFailure(`Product not found: ${payload.product_uid}`);
      return;
    }

    if (productRow.total_quantity > 0) {
      this.logger.warn(
        { product_uid: productRow.product_uid, total_quantity: productRow.total_quantity },
        "Skipping EverShop hide: product still has inventory"
      );
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'conflict', error_message = ?
           WHERE event_uid = ?`
        )
        .run("Product still has inventory; hide not required", event.event_uid);
      return;
    }

    const sku = productRow.product_sku ?? payload.product_sku;
    const productId =
      payload.evershop_product_id ??
      productRow.evershop_product_id ??
      (sku ? await this.evershopImporter.findProductIdBySku(sku) : null);

    if (!productId) {
      markFailure(`EverShop product_id not found for sku=${sku ?? "unknown"}`, productRow.product_uid);
      return;
    }

    try {
      await this.evershopImporter.hideListing(productId);

      // Update CardMint state for monitoring purposes
      this.db
        .prepare(
          `UPDATE products
           SET evershop_sync_state = 'evershop_hidden',
               last_synced_at = ?
           WHERE product_uid = ?`
        )
        .run(now, productRow.product_uid);

      markSuccess();
      this.logger.info(
        { product_uid: productRow.product_uid, product_id: productId },
        "EverShop listing hidden after sale"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown EverShop hide error";
      this.logger.error({ error: message, product_uid: productRow.product_uid }, "EverShop hide failed");
      markFailure(message, productRow.product_uid);
    }
  }

  // ==========================================================================
  // Phase 2: Sale Sync (prod -> staging)
  // ==========================================================================

  /**
   * Pull pending sale events from prod and archive to staging
   * This is called by the daemon or manual API trigger when staging is online
   */
  async syncSales(limit = 20): Promise<SyncSalesResult> {
    const result: SyncSalesResult = {
      total: 0,
      synced: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };

    this.logger.info({ limit }, "Starting sale sync from production");

    // 1. Query prod's sync_events for pending sale events
    let pendingSales: Array<{
      id: number;
      event_uid: string;
      item_uid: string;
      product_uid: string;
      payload: string;
      stripe_event_id: string | null;
      created_at: number;
    }>;

    try {
      pendingSales = await this.remoteDb.queryProd<{
        id: number;
        event_uid: string;
        item_uid: string;
        product_uid: string;
        payload: string;
        stripe_event_id: string | null;
        created_at: number;
      }>(
        `SELECT id, event_uid, item_uid, product_uid, payload, stripe_event_id, created_at
         FROM sync_events
         WHERE event_type = 'sale' AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ${limit}`
      );
    } catch (error) {
      this.logger.error({ error }, "Failed to query prod for pending sale events");
      return result;
    }

    result.total = pendingSales.length;

    if (pendingSales.length === 0) {
      this.logger.debug("No pending sale events in production");
      return result;
    }

    this.logger.info({ count: pendingSales.length }, "Found pending sale events to sync");

    // 2. Process each sale event
    const now = Math.floor(Date.now() / 1000);

    for (const saleEvent of pendingSales) {
      const { event_uid, item_uid, product_uid, payload, stripe_event_id } = saleEvent;

      try {
        // Parse payload
        let saleSnapshot: SaleSnapshot;
        try {
          saleSnapshot = JSON.parse(payload);
        } catch {
          this.logger.warn({ event_uid }, "Invalid JSON payload in sale event, skipping");
          result.skipped++;
          result.results.push({ event_uid, item_uid, success: false, error: "Invalid payload" });
          continue;
        }

        // 3. Check if item exists in staging
        const stagingItem = this.db
          .prepare("SELECT item_uid, status FROM items WHERE item_uid = ?")
          .get(item_uid) as { item_uid: string; status: string } | undefined;

        if (!stagingItem) {
          this.logger.warn({ item_uid, event_uid }, "Item not found in staging, skipping sale sync");
          result.skipped++;
          result.results.push({ event_uid, item_uid, success: false, error: "Item not found in staging" });
          // Mark as synced anyway to prevent retry loops - item may have been deleted
          await this.markProdEventSynced(event_uid, now);
          continue;
        }

        // 4. Check idempotency - already SOLD?
        if (stagingItem.status === "SOLD") {
          this.logger.debug({ item_uid, event_uid }, "Item already SOLD in staging, marking event synced");
          result.skipped++;
          result.results.push({ event_uid, item_uid, success: true, error: "Already SOLD" });
          await this.markProdEventSynced(event_uid, now);
          continue;
        }

        // 5. Update staging item to SOLD
        this.db
          .prepare(
            `UPDATE items
             SET status = 'SOLD',
                 payment_intent_id = ?,
                 sync_version = COALESCE(sync_version, 0) + 1,
                 last_synced_at = ?
             WHERE item_uid = ?`
          )
          .run(saleSnapshot.payment_intent_id ?? null, now, item_uid);

        // 6. Update staging product quantity if applicable
        if (product_uid) {
          this.db
            .prepare(
              `UPDATE products
               SET total_quantity = total_quantity - 1,
                   sync_version = COALESCE(sync_version, 0) + 1,
                   last_synced_at = ?
               WHERE product_uid = ? AND total_quantity > 0`
            )
            .run(now, product_uid);
        }

        // 7. Record sale sync event in staging audit log
        const stagingEventUid = `SALE_SYNC:${item_uid}:${Math.floor(now / 60)}`;
        this.db
          .prepare(
            `INSERT INTO sync_events (event_uid, event_type, product_uid, item_uid, source_db, target_db, payload, stripe_event_id, status, synced_at, created_at)
             VALUES (?, 'sale', ?, ?, 'production', 'staging', ?, ?, 'synced', ?, ?)
             ON CONFLICT(event_uid) DO NOTHING`
          )
          .run(stagingEventUid, product_uid, item_uid, payload, stripe_event_id, now, now);

        // 8. Mark prod event as synced
        await this.markProdEventSynced(event_uid, now);

        this.logger.info({ item_uid, event_uid, product_uid }, "Sale synced to staging");
        result.synced++;
        result.results.push({ event_uid, item_uid, success: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        this.logger.error({ event_uid, item_uid, error: errorMessage }, "Failed to sync sale event");
        result.failed++;
        result.results.push({ event_uid, item_uid, success: false, error: errorMessage });
      }
    }

    this.logger.info(
      { total: result.total, synced: result.synced, failed: result.failed, skipped: result.skipped },
      "Sale sync completed"
    );

    return result;
  }

  /**
   * Mark a sync event as synced in prod database
   */
  private async markProdEventSynced(eventUid: string, timestamp: number): Promise<void> {
    const escapedUid = eventUid.replace(/'/g, "''");
    await this.remoteDb.runProd(
      `UPDATE sync_events SET status = 'synced', synced_at = ${timestamp} WHERE event_uid = '${escapedUid}'`
    );
  }

  /**
   * Get count of pending sale events in prod (for monitoring)
   */
  async getPendingSaleCount(): Promise<number> {
    try {
      const result = await this.remoteDb.queryProd<{ count: number }>(
        `SELECT COUNT(*) as count FROM sync_events WHERE event_type = 'sale' AND status = 'pending'`
      );
      return result[0]?.count ?? 0;
    } catch (error) {
      this.logger.warn({ error }, "Failed to query prod for pending sale count");
      return -1; // Indicates error
    }
  }

  /**
   * Get comprehensive sync health report
   */
  async getSyncHealth(): Promise<SyncHealthReport> {
    const now = Math.floor(Date.now() / 1000);

    // Check staging DB (local)
    let stagingDb: "reachable" | "unreachable" | "unknown" = "reachable";

    // Check prod SQLite
    let prodSqlite: "reachable" | "unreachable" | "unknown" = "unknown";
    try {
      const reachable = await this.remoteDb.isReachable();
      prodSqlite = reachable ? "reachable" : "unreachable";
    } catch {
      prodSqlite = "unreachable";
    }

    // Check EverShop PG (via Docker health check)
    let evershopDb: "reachable" | "unreachable" | "unknown" = "unknown";
    if (this.evershopImporter) {
      try {
        const authenticated = await this.evershopImporter.authenticate();
        evershopDb = authenticated ? "reachable" : "unreachable";
      } catch {
        evershopDb = "unreachable";
      }
    }

    // Get state counts
    const stateCounts = this.db
      .prepare(
        `SELECT
           COALESCE(evershop_sync_state, 'not_synced') as state,
           COUNT(*) as count
         FROM products
         WHERE staging_ready = 1
         GROUP BY COALESCE(evershop_sync_state, 'not_synced')`
      )
      .all() as Array<{ state: string; count: number }>;

    const stateCountsMap: SyncHealthReport["state_counts"] = {
      not_synced: 0,
      vault_only: 0,
      evershop_hidden: 0,
      evershop_live: 0,
      sync_error: 0,
    };
    for (const row of stateCounts) {
      if (row.state in stateCountsMap) {
        stateCountsMap[row.state as keyof typeof stateCountsMap] = row.count;
      }
    }

    // Get event queue stats
    const pendingEvents = this.db
      .prepare("SELECT COUNT(*) as count FROM sync_events WHERE status = 'pending'")
      .get() as { count: number };

    const oldestPending = this.db
      .prepare("SELECT MIN(created_at) as oldest FROM sync_events WHERE status = 'pending'")
      .get() as { oldest: number | null };

    const failedEvents = this.db
      .prepare("SELECT COUNT(*) as count FROM sync_events WHERE status = 'failed'")
      .get() as { count: number };

    const conflictEvents = this.db
      .prepare("SELECT COUNT(*) as count FROM sync_events WHERE status = 'conflict'")
      .get() as { count: number };

    const pendingHideEvents = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM sync_events WHERE status = 'pending' AND event_type = 'evershop_hide_listing'"
      )
      .get() as { count: number };

    const oldestPendingHide = this.db
      .prepare(
        "SELECT MIN(created_at) as oldest FROM sync_events WHERE status = 'pending' AND event_type = 'evershop_hide_listing'"
      )
      .get() as { oldest: number | null };

    const evershopVisibleZeroQty = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM products
         WHERE total_quantity = 0
           AND evershop_sync_state = 'evershop_live'`
      )
      .get() as { count: number };

    // Get daemon lease status
    const leaseRow = this.db
      .prepare("SELECT lease_owner, lease_expires_at, last_heartbeat FROM sync_leader WHERE id = 1")
      .get() as { lease_owner: string; lease_expires_at: number; last_heartbeat: number } | undefined;

    // Determine overall health
    let overall: "green" | "yellow" | "red" = "green";

    const evershopHideStaleSec = 1800;
    const pendingHideAge = oldestPendingHide.oldest ? now - oldestPendingHide.oldest : null;

    if (prodSqlite === "unreachable" || evershopDb === "unreachable") {
      overall = "red";
    } else if (
      pendingEvents.count > 10 ||
      failedEvents.count > 0 ||
      conflictEvents.count > 0 ||
      stateCountsMap.sync_error > 0 ||
      evershopVisibleZeroQty.count > 0 ||
      (pendingHideAge !== null && pendingHideAge > evershopHideStaleSec)
    ) {
      overall = "yellow";
    }

    return {
      overall,
      staging_db: stagingDb,
      prod_sqlite: prodSqlite,
      evershop_db: evershopDb,
      state_counts: stateCountsMap,
      pending_events: pendingEvents.count,
      oldest_pending_age_seconds: oldestPending.oldest ? now - oldestPending.oldest : null,
      failed_events: failedEvents.count,
      conflict_events: conflictEvents.count,
      pending_evershop_hide_events: pendingHideEvents.count,
      oldest_pending_evershop_hide_age_seconds: pendingHideAge,
      evershop_visible_zero_qty_count: evershopVisibleZeroQty.count,
      last_sync_cycle: null, // Set by daemon
      daemon_lease_holder: leaseRow?.lease_owner ?? null,
      daemon_lease_expires: leaseRow ? new Date(leaseRow.lease_expires_at * 1000).toISOString() : null,
    };
  }

  /**
   * Write product and its items to prod SQLite
   */
  private async writeToProdSqlite(
    product: ProductSnapshot & { product_sku: string; listing_sku: string; hp_value: number | null; rarity: string | null },
    snapshot: ProductSnapshot
  ): Promise<{ success: boolean; error?: string }> {
    const now = Math.floor(Date.now() / 1000);

    // Escape values for SQL
    const escape = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "NULL";
      return `'${val.replace(/'/g, "''")}'`;
    };

    const productSql = `
      INSERT INTO products (
        product_uid, cm_card_id, condition_bucket, product_sku, listing_sku,
        card_name, set_name, collector_no, hp_value, rarity,
        market_price, launch_price, pricing_status, total_quantity,
        staging_ready, evershop_sync_state, sync_version,
        cdn_image_url, cdn_back_image_url, public_sku, variant_tags,
        promoted_at, last_synced_at, created_at, updated_at
      ) VALUES (
        ${escape(product.product_uid)},
        ${escape(product.cm_card_id)},
        ${escape(product.condition_bucket)},
        ${escape(product.product_sku)},
        ${escape(product.listing_sku)},
        ${escape(product.card_name)},
        ${escape(product.set_name)},
        ${escape(product.collector_no)},
        ${product.hp_value ?? "NULL"},
        ${escape(product.rarity)},
        ${product.market_price ?? "NULL"},
        ${product.launch_price ?? "NULL"},
        ${escape(product.pricing_status)},
        ${product.total_quantity},
        1,
        'vault_only',
        ${snapshot.sync_version},
        ${escape(product.cdn_image_url)},
        ${escape(product.cdn_back_image_url)},
        ${escape(product.public_sku)},
        ${escape(snapshot.variant_tags)},
        ${now},
        ${now},
        ${product.created_at},
        ${now}
      )
      ON CONFLICT(product_uid) DO UPDATE SET
        market_price = excluded.market_price,
        launch_price = excluded.launch_price,
        pricing_status = excluded.pricing_status,
        total_quantity = excluded.total_quantity,
        cdn_image_url = excluded.cdn_image_url,
        cdn_back_image_url = excluded.cdn_back_image_url,
        variant_tags = excluded.variant_tags,
        evershop_sync_state = excluded.evershop_sync_state,
        sync_version = excluded.sync_version,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `;

    try {
      // Phase 1: Write product to prod
      await this.remoteDb.runProd(productSql);

      // Phase 2: Sync items for this product
      const itemsSynced = await this.syncItemsToProd(product.product_uid, escape, now);
      if (!itemsSynced.success) {
        this.logger.warn(
          { productUid: product.product_uid, error: itemsSynced.error },
          "Product synced but items sync failed"
        );
        // Don't fail the promotion - product is in prod, items can be retried
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Sync items for a product to production SQLite
   * Only syncs IN_STOCK items (available inventory)
   */
  private async syncItemsToProd(
    productUid: string,
    escape: (val: string | null | undefined) => string,
    now: number
  ): Promise<{ success: boolean; itemCount: number; error?: string }> {
    // Query staging items for this product
    interface StagingItem {
      item_uid: string;
      product_uid: string;
      quantity: number;
      status: string;
      acquisition_date: number | null;
      acquisition_source: string | null;
      location: string | null;
      internal_notes: string | null;
      created_at: number;
      updated_at: number;
      sync_version: number | null;
    }

    const stagingItems = this.db
      .prepare(
        `SELECT item_uid, product_uid, quantity, status, acquisition_date,
                acquisition_source, location, internal_notes, created_at, updated_at, sync_version
         FROM items
         WHERE product_uid = ? AND status = 'IN_STOCK'`
      )
      .all(productUid) as StagingItem[];

    if (stagingItems.length === 0) {
      this.logger.debug({ productUid }, "No IN_STOCK items to sync for product");
      return { success: true, itemCount: 0 };
    }

    this.logger.info({ productUid, itemCount: stagingItems.length }, "Syncing items to prod");

    // Build batch INSERT for items
    const itemInserts: string[] = [];
    for (const item of stagingItems) {
      const itemSql = `
        INSERT INTO items (
          item_uid, product_uid, quantity, status, acquisition_date,
          acquisition_source, location, internal_notes,
          sync_version, last_synced_at, created_at, updated_at
        ) VALUES (
          ${escape(item.item_uid)},
          ${escape(item.product_uid)},
          ${item.quantity},
          ${escape(item.status)},
          ${item.acquisition_date ?? "NULL"},
          ${escape(item.acquisition_source)},
          ${escape(item.location)},
          ${escape(item.internal_notes)},
          ${item.sync_version ?? 1},
          ${now},
          ${item.created_at},
          ${now}
        )
        ON CONFLICT(item_uid) DO UPDATE SET
          quantity = excluded.quantity,
          status = excluded.status,
          location = excluded.location,
          sync_version = excluded.sync_version,
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
      `;
      itemInserts.push(itemSql);
    }

    try {
      // Execute all item inserts
      for (const sql of itemInserts) {
        await this.remoteDb.runProd(sql);
      }

      // Update staging items sync timestamp
      this.db
        .prepare(
          `UPDATE items SET last_synced_at = ?, sync_version = COALESCE(sync_version, 0) + 1
           WHERE product_uid = ? AND status = 'IN_STOCK'`
        )
        .run(now, productUid);

      return { success: true, itemCount: stagingItems.length };
    } catch (error) {
      return {
        success: false,
        itemCount: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update staging product sync state
   */
  private updateStagingState(productUid: string, state: EverShopSyncState, timestamp: number): void {
    this.db
      .prepare(
        `UPDATE products
         SET evershop_sync_state = ?,
             last_synced_at = ?,
             promoted_at = CASE WHEN ? IN ('vault_only', 'evershop_hidden', 'evershop_live') THEN COALESCE(promoted_at, ?) ELSE promoted_at END,
             sync_version = sync_version + 1
         WHERE product_uid = ?`
      )
      .run(state, timestamp, state, timestamp, productUid);
  }

  /**
   * Set EverShop product visibility via direct PostgreSQL
   */
  private async setEvershopVisibility(evershopProductId: number, visible: boolean): Promise<void> {
    // This would be implemented using the SSH + psql pattern from evershopClient
    // For now, log the intent
    this.logger.info({ evershopProductId, visible }, "Would set EverShop visibility");
  }

  // ==========================================================================
  // EverShop Webhook Handler (Bidirectional Sync Phase 2)
  // ==========================================================================

  /**
   * Handle incoming EverShop product update webhook
   * Called when admin changes visibility/status in EverShop
   *
   * Per Codex QA requirements:
   * - Idempotent state transitions (only sync when state actually changes)
   * - Async vault sync (enqueues sync event for daemon to process)
   * - Structured logging for /api/sync/health metrics
   */
  async handleEverShopWebhook(
    eventUid: string,
    payload: EverShopWebhookPayload
  ): Promise<WebhookProcessResult> {
    const now = Math.floor(Date.now() / 1000);

    // 1. Find product by evershop_uuid, sku, or cardmint_scan_id
    const product = this.db
      .prepare(
        `SELECT
           product_uid, evershop_sync_state, evershop_product_id, evershop_uuid,
           product_sku, set_name, variant_tags, launch_price, updated_at
         FROM products
         WHERE evershop_uuid = ?
            OR product_sku = ?
            OR primary_scan_id = ?
         LIMIT 1`
      )
      .get(payload.uuid, payload.sku, payload.cardmint_scan_id ?? null) as {
        product_uid: string;
        evershop_sync_state: EverShopSyncState | null;
        evershop_product_id: number | null;
        evershop_uuid: string | null;
        product_sku: string;
        set_name: string;
        variant_tags: string | null;
        launch_price: number | null;
        updated_at: number;
      } | undefined;

    if (!product) {
      this.logger.warn(
        { eventUid, uuid: payload.uuid, sku: payload.sku },
        "EverShop webhook: product not found in staging"
      );
      return {
        success: false,
        event_uid: eventUid,
        state_changed: false,
        vault_sync_enqueued: false,
        error: `Product not found (uuid=${payload.uuid}, sku=${payload.sku})`,
      };
    }

    const productUid = product.product_uid;
    const currentState = product.evershop_sync_state ?? "not_synced";

    // 2. Store evershop_uuid if not already stored (for future REST API lookups)
    if (!product.evershop_uuid && payload.uuid) {
      this.db
        .prepare(`UPDATE products SET evershop_uuid = ? WHERE product_uid = ?`)
        .run(payload.uuid, productUid);
    }

    // 2b. Sync category_name to set_name (Dec 8, 2025 - bidirectional metadata sync)
    // EverShop admin is the final staging area for edits, so category changes sync back
    let categoryUpdated = false;
    if (payload.category_name && payload.category_name !== product.set_name) {
      this.db
        .prepare(`UPDATE products SET set_name = ?, updated_at = ? WHERE product_uid = ?`)
        .run(payload.category_name, now, productUid);
      categoryUpdated = true;
      this.logger.info(
        {
          eventUid,
          productUid,
          old_set_name: product.set_name,
          new_set_name: payload.category_name,
        },
        "Category synced from EverShop: set_name updated"
      );
    }

    // 2c. Sync variant_tags from EverShop (Dec 8, 2025 - bidirectional variant sync)
    let variantTagsUpdated = false;
    if (payload.variant_tags !== undefined) {
      // Parse payload variant_tags (could be array or JSON string)
      let newVariantTags: string[] = [];
      if (Array.isArray(payload.variant_tags)) {
        newVariantTags = payload.variant_tags.filter((t) => typeof t === "string" && t.trim().length > 0);
      } else if (typeof payload.variant_tags === "string") {
        try {
          const parsed = JSON.parse(payload.variant_tags);
          if (Array.isArray(parsed)) {
            newVariantTags = parsed.filter((t: unknown) => typeof t === "string" && (t as string).trim().length > 0);
          }
        } catch {
          // Not valid JSON, skip
        }
      }

      // Parse current variant_tags from DB
      let currentVariantTags: string[] = [];
      if (product.variant_tags) {
        try {
          const parsed = JSON.parse(product.variant_tags);
          if (Array.isArray(parsed)) {
            currentVariantTags = parsed;
          }
        } catch {
          // Not valid JSON
        }
      }

      // Compare and update if different
      const newSorted = [...newVariantTags].sort().join(",");
      const currentSorted = [...currentVariantTags].sort().join(",");
      if (newSorted !== currentSorted) {
        const newTagsJson = newVariantTags.length > 0 ? JSON.stringify(newVariantTags) : null;
        this.db
          .prepare(`UPDATE products SET variant_tags = ?, updated_at = ? WHERE product_uid = ?`)
          .run(newTagsJson, now, productUid);
        variantTagsUpdated = true;
        this.logger.info(
          {
            eventUid,
            productUid,
            old_variant_tags: currentVariantTags,
            new_variant_tags: newVariantTags,
          },
          "Variant tags synced from EverShop"
        );
      }
    }

    // 2d. Sync price to launch_price (Dec 9, 2025 - bidirectional price sync)
    // EverShop admin is the authoritative source for customer-facing price
    let priceUpdated = false;
    if (payload.price !== undefined && payload.price !== null && payload.price > 0) {
      // Round to 2 decimal places to avoid floating point issues
      const newPrice = Math.round(payload.price * 100) / 100;
      const currentPrice = product.launch_price;

      // Only update if price actually changed (within 0.01 tolerance)
      if (currentPrice === null || Math.abs(newPrice - currentPrice) >= 0.01) {
        this.db
          .prepare(`UPDATE products SET launch_price = ?, updated_at = ? WHERE product_uid = ?`)
          .run(newPrice, now, productUid);
        priceUpdated = true;
        this.logger.info(
          {
            eventUid,
            productUid,
            old_price: currentPrice,
            new_price: newPrice,
          },
          "Price synced from EverShop: launch_price updated"
        );
      }
    }

    // 3. Calculate new sync state based on visibility and status
    let newState: EverShopSyncState;
    if (!payload.status) {
      // Product disabled in EverShop
      newState = "evershop_hidden";
    } else if (payload.visibility) {
      // Product visible on storefront
      newState = "evershop_live";
    } else {
      // Product enabled but hidden (staging)
      newState = "evershop_hidden";
    }

    // 4. Check if state actually changed (idempotent guard)
    const stateChanged = currentState !== newState;

    if (!stateChanged) {
      this.logger.debug(
        { eventUid, productUid, currentState, newState },
        "EverShop webhook: no state change, skipping"
      );
      return {
        success: true,
        event_uid: eventUid,
        product_uid: productUid,
        previous_state: currentState,
        new_state: newState,
        state_changed: false,
        vault_sync_enqueued: false,
      };
    }

    // 5. Update staging DB evershop_sync_state
    this.updateStagingState(productUid, newState, now);

    // 6. If transitioning to evershop_live, enqueue vault sync
    let vaultSyncEnqueued = false;
    if (newState === "evershop_live" && currentState !== "evershop_live") {
      // Enqueue a sync event for the daemon to process (async vault sync)
      const syncEventUid = `WEBHOOK_SYNC:${productUid}:${now}`;

      try {
        // Check if product already in prod vault
        const isInVault = currentState === "vault_only" || currentState === "evershop_hidden";

        if (!isInVault) {
          // Need to promote to vault first
          this.db
            .prepare(
              `INSERT INTO sync_events
               (event_uid, event_type, product_uid, source_db, target_db, operator_id, payload, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              syncEventUid,
              "promote",
              productUid,
              "staging",
              "production",
              "evershop_webhook",
              JSON.stringify({ triggered_by: eventUid, visibility: payload.visibility }),
              "pending",
              now
            );
          vaultSyncEnqueued = true;
          this.logger.info(
            { eventUid, productUid, syncEventUid },
            "Enqueued vault sync for webhook-driven promotion"
          );
        } else {
          // Already in vault, just update evershop_published_at
          this.db
            .prepare(
              `UPDATE products SET evershop_published_at = ? WHERE product_uid = ?`
            )
            .run(now, productUid);
        }
      } catch (error) {
        this.logger.error(
          { error, eventUid, productUid },
          "Failed to enqueue vault sync"
        );
        // Don't fail the webhook - state update already succeeded
      }
    }

    // 7. Log structured event for health metrics
    this.logger.info(
      {
        eventUid,
        productUid,
        previousState: currentState,
        newState,
        visibility: payload.visibility,
        status: payload.status,
        vaultSyncEnqueued,
        categoryUpdated,
      },
      "EverShop webhook processed: state transition"
    );

    return {
      success: true,
      event_uid: eventUid,
      product_uid: productUid,
      previous_state: currentState,
      new_state: newState,
      state_changed: true,
      vault_sync_enqueued: vaultSyncEnqueued,
    };
  }

  /**
   * Get webhook health statistics for /api/sync/health integration
   */
  getWebhookHealthStats(): {
    pending_count: number;
    processed_last_hour: number;
    failed_last_hour: number;
    oldest_pending_age_seconds: number | null;
    webhook_driven_transitions_last_hour: number;
  } {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;

    try {
      const pendingCount = (
        this.db
          .prepare(`SELECT COUNT(*) as count FROM webhook_events WHERE status = 'pending'`)
          .get() as { count: number }
      ).count;

      const processedLastHour = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM webhook_events
             WHERE status = 'processed' AND processed_at >= ?`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      const failedLastHour = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM webhook_events
             WHERE status = 'failed' AND created_at >= ?`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      const oldestPending = this.db
        .prepare(
          `SELECT created_at FROM webhook_events
           WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 1`
        )
        .get() as { created_at: number } | undefined;

      const oldestPendingAgeSeconds = oldestPending
        ? now - oldestPending.created_at
        : null;

      // Count sync events triggered by webhooks
      const webhookTransitionsLastHour = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM sync_events
             WHERE created_at >= ? AND operator_id = 'evershop_webhook'`
          )
          .get(oneHourAgo) as { count: number }
      ).count;

      return {
        pending_count: pendingCount,
        processed_last_hour: processedLastHour,
        failed_last_hour: failedLastHour,
        oldest_pending_age_seconds: oldestPendingAgeSeconds,
        webhook_driven_transitions_last_hour: webhookTransitionsLastHour,
      };
    } catch (error) {
      this.logger.warn({ error }, "Failed to get webhook health stats (table may not exist)");
      return {
        pending_count: 0,
        processed_last_hour: 0,
        failed_last_hour: 0,
        oldest_pending_age_seconds: null,
        webhook_driven_transitions_last_hour: 0,
      };
    }
  }

  /**
   * Sync product to prod SQLite via Accept flow.
   * Reuses writeToProdSqlite() to maintain column parity with the daemon promotion path.
   * Records full sync_events for observability (pending → synced/failed lifecycle).
   */
  async syncProductToProdSqlite(
    productUid: string,
    operatorId?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!runtimeConfig.syncEnabled) {
      this.logger.debug({ productUid }, "Sync disabled, skipping prod SQLite sync");
      return { success: true }; // Not an error, just disabled
    }

    const now = Math.floor(Date.now() / 1000);
    const eventUid = `ACCEPT:${productUid}:${Math.floor(now / 60)}`;

    // Fetch product from staging (same fields as promoteProduct)
    const product = this.db
      .prepare(
        `SELECT
           product_uid, public_sku, card_name, set_name, collector_no,
           condition_bucket, market_price, launch_price, pricing_status,
           total_quantity, cm_card_id, evershop_sync_state, sync_version,
           cdn_image_url, cdn_back_image_url, variant_tags, created_at, updated_at,
           product_sku, listing_sku, hp_value, rarity
         FROM products
         WHERE product_uid = ?
           AND staging_ready = 1`
      )
      .get(productUid) as
      | (ProductSnapshot & {
          product_sku: string;
          listing_sku: string;
          hp_value: number | null;
          rarity: string | null;
        })
      | undefined;

    if (!product) {
      return {
        success: false,
        error: `Product not found or not staging_ready: ${productUid}`,
      };
    }

    // Build snapshot exactly as promoteProduct() does (sync_version || 1, not +1)
    const snapshot: ProductSnapshot = {
      product_uid: product.product_uid,
      public_sku: product.public_sku,
      card_name: product.card_name,
      set_name: product.set_name,
      collector_no: product.collector_no,
      condition_bucket: product.condition_bucket,
      market_price: product.market_price,
      launch_price: product.launch_price,
      pricing_status: product.pricing_status,
      total_quantity: product.total_quantity,
      status: "IN_STOCK",
      evershop_sync_state: "not_synced",
      sync_version: product.sync_version || 1,
      cdn_image_url: product.cdn_image_url,
      cdn_back_image_url: product.cdn_back_image_url,
      cm_card_id: product.cm_card_id,
      variant_tags: product.variant_tags ?? null,
      created_at: product.created_at,
      updated_at: product.updated_at,
    };

    // 1. Create pending sync event with full snapshot (audit trail)
    this.db
      .prepare(
        `INSERT INTO sync_events (event_uid, event_type, product_uid, source_db, target_db, operator_id, payload, status, created_at)
         VALUES (?, 'promote', ?, 'staging', 'production', ?, ?, 'pending', ?)`
      )
      .run(eventUid, productUid, operatorId ?? "job_accept", JSON.stringify(snapshot), now);

    try {
      // 2. Write to prod SQLite (reuse helper for column parity)
      const prodResult = await this.writeToProdSqlite(product, snapshot);
      if (!prodResult.success) {
        throw new Error(`Prod SQLite write failed: ${prodResult.error}`);
      }

      // 3. Update staging state immediately after prod write (mirrors promoteProduct)
      this.updateStagingState(productUid, "vault_only", now);

      // 4. Mark sync event as synced
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'synced', synced_at = ?
           WHERE event_uid = ?`
        )
        .run(now, eventUid);

      this.logger.info(
        { productUid, eventUid, operatorId: operatorId ?? "job_accept" },
        "Product synced to prod SQLite via Accept"
      );

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      // Mark sync event as failed with error details
      this.db
        .prepare(
          `UPDATE sync_events
           SET status = 'failed', error_message = ?, retry_count = retry_count + 1
           WHERE event_uid = ?`
        )
        .run(errorMsg, eventUid);

      this.logger.error(
        { productUid, eventUid, error: errorMsg },
        "Failed to sync product to prod SQLite via Accept"
      );

      return { success: false, error: errorMsg };
    }
  }
}
