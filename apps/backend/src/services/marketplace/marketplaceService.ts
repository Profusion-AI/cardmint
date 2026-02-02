/**
 * MarketplaceService: CRUD operations for marketplace fulfillment tables
 *
 * Handles TCGPlayer/eBay orders separately from Stripe-keyed orders.
 * Supports 1:N order-to-shipment relationships and encrypted address storage.
 */

import type { Database, Statement } from "better-sqlite3";
import type { Logger } from "pino";
import { runtimeConfig } from "../../config.js";
import { encryptJson, decryptJson } from "../../utils/encryption";
import { normalizeNameForMatching } from "../../utils/nameNormalization.js";
import { parseTcgplayerOrderNumber, formatTcgplayerOrderNumber } from "../../utils/orderNumberFormat.js";
import type { EasyPostService } from "../easyPostService.js";
import type { UspsTrackingService } from "../uspsTrackingService.js";

// ============================================================================
// Module-Level State
// ============================================================================

/**
 * Process-wide flag to ensure name normalization backfill runs at most once.
 * Set to true after first successful probe/backfill.
 */
let didBackfillCustomerNameNormalization = false;

// ============================================================================
// Types
// ============================================================================

export interface ImportBatch {
  id: number;
  source: "tcgplayer" | "ebay" | "easypost_tracking";
  imported_by: string;
  imported_at: number;
  file_checksum: string;
  file_name: string | null;
  row_count: number;
  success_count: number;
  skip_count: number;
  error_count: number;
  status: "pending" | "processing" | "completed" | "failed";
  error_details: string | null;
}

export interface MarketplaceOrder {
  id: number;
  source: "tcgplayer" | "ebay";
  external_order_id: string;
  display_order_number: string;
  customer_name: string;
  customer_name_normalized: string;
  order_date: number;
  item_count: number;
  product_value_cents: number;
  shipping_fee_cents: number;
  product_weight_oz: number | null;
  shipping_method: string | null;
  status: "pending" | "processing" | "shipped" | "delivered" | "exception" | "cancelled";
  import_batch_id: number | null;
  import_format: "shipping_export" | "orderlist";
  created_at: number;
  updated_at: number;
}

export interface ShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface MarketplaceShipment {
  id: number;
  marketplace_order_id: number;
  shipment_sequence: number;
  shipping_address_encrypted: string | null;
  shipping_zip: string | null;
  address_expires_at: number | null;
  easypost_shipment_id: string | null;
  easypost_rate_id: string | null;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  label_cost_cents: number | null;
  label_purchased_at: number | null;
  status: "pending" | "label_purchased" | "shipped" | "in_transit" | "delivered" | "exception";
  shipped_at: number | null;
  delivered_at: number | null;
  exception_type: string | null;
  exception_notes: string | null;
  tracking_match_confidence: "auto" | "manual" | "unmatched" | null;
  tracking_matched_at: number | null;
  tracking_matched_by: string | null;
  // Phase 4 audit columns
  parcel_preset_key: string | null;
  parcel_weight_oz: number | null;
  insured_value_cents: number | null;
  item_count: number | null;
  // External fulfillment flag (Order List imports)
  is_external: number; // 0 = CardMint label, 1 = TCGPlayer/external fulfillment
  // Operator flag: Plain White Envelope (PWE) / stamp-based manual shipment
  is_pwe: number; // 0 = normal fulfillment, 1 = PWE (no label purchase)
  // Concurrency lock for label purchase
  label_purchase_in_progress: number;
  label_purchase_locked_at: number | null;
  // Refund tracking
  refund_status: "submitted" | "refunded" | "rejected" | null;
  refund_requested_at: number | null;
  // Combined shipment support
  fulfilled_by_shipment_id: number | null; // Parent shipment if combined
  combined_at: number | null;
  combined_by: string | null;
  combined_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Result of a combine validation check
 */
export interface CombineValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
  addressMismatchWarning?: string;
}

/**
 * Candidate parent shipment for combining
 */
export interface CombineCandidate {
  shipmentId: number;
  orderNumber: string;
  externalOrderId: string;
  customerName: string;
  trackingNumber: string;
  trackingUrl: string | null;
  carrier: string | null;
  status: string;
  shippedAt: number | null;
  orderDate: number;
  shippingZip: string | null;
  itemCount: number;
}

/**
 * Shipment with decrypted address (used in rates/label flow)
 */
export interface ShipmentWithAddress extends MarketplaceShipment {
  decryptedAddress: ShippingAddress | null;
  order: MarketplaceOrder | null;
}

export interface UnmatchedTracking {
  id: number;
  import_batch_id: number | null;
  easypost_tracker_id: string;
  easypost_shipment_id: string | null;
  tracking_number: string;
  carrier: string | null;
  signed_by: string | null;
  signed_by_normalized: string | null;
  destination_zip: string | null;
  easypost_status: string | null;
  usps_status: string | null;
  usps_delivered_at: number | null;
  usps_last_event_at: number | null;
  usps_events_json: string | null;
  last_usps_fetch_at: number | null;
  created_at_easypost: number | null;
  resolution_status: "pending" | "matched" | "ignored" | "manual_entry";
  matched_to_shipment_id: number | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
}

export interface CreateOrderInput {
  source: "tcgplayer" | "ebay";
  external_order_id: string;
  customer_name: string;
  order_date: number;
  item_count: number;
  product_value_cents: number;
  shipping_fee_cents: number;
  product_weight_oz?: number;
  shipping_method?: string;
  import_batch_id?: number;
  shipping_address?: ShippingAddress;
  import_format?: "shipping_export" | "orderlist";
  is_external?: boolean; // true = external fulfillment (Order List imports)
}

export interface ListOrdersOptions {
  source?: "tcgplayer" | "ebay" | "all";
  status?: MarketplaceOrder["status"];
  limit?: number;
  offset?: number;
}

// ============================================================================
// Order Item Types (Pull Sheet)
// ============================================================================

export interface MarketplaceOrderItem {
  id: number;
  marketplace_order_id: number | null;
  source: "tcgplayer" | "ebay";
  external_order_id: string;
  item_key: string;
  tcgplayer_sku_id: string | null;
  product_name: string;
  set_name: string | null;
  card_number: string | null;
  condition: string | null;
  rarity: string | null;
  product_line: string | null;
  set_release_date: number | null;
  quantity: number;
  unit_price_cents: number | null;
  price_confidence: "exact" | "estimated" | "unavailable";
  image_url: string | null;
  import_batch_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertOrderItemInput {
  marketplaceOrderId: number | null;
  source: "tcgplayer" | "ebay";
  externalOrderId: string;
  itemKey: string;
  tcgplayerSkuId: string | null;
  productName: string;
  setName: string | null;
  cardNumber: string | null;
  condition: string | null;
  rarity: string | null;
  productLine: string | null;
  setReleaseDate: number | null;
  quantity: number;
  unitPriceCents: number | null;
  priceConfidence: "exact" | "estimated" | "unavailable";
  imageUrl: string | null;
  importBatchId: number | null;
}

// ============================================================================
// Service
// ============================================================================

export class MarketplaceService {
  private db: Database;
  private logger: Logger;
  private statements: {
    insertBatch: Statement;
    updateBatch: Statement;
    getBatchById: Statement;
    insertOrder: Statement;
    getOrderById: Statement;
    getOrderByExternalId: Statement;
    listOrders: Statement;
    listOrdersBySource: Statement;
    listOrdersByStatus: Statement;
    listOrdersBySourceAndStatus: Statement;
    countOrders: Statement;
    updateOrderStatus: Statement;
    updateOrderDate: Statement;
    insertShipment: Statement;
    getShipmentsByOrderId: Statement;
    getShipmentById: Statement;
    updateShipmentTracking: Statement;
    updateShipmentStatus: Statement;
    updateShipmentLabel: Statement;
    updateShipmentPwe: Statement;
    updateShipmentAddressIfMissing: Statement;
    setAddressExpiry: Statement;
    purgeExpiredAddresses: Statement;
    insertUnmatchedTracking: Statement;
    listUnmatchedTracking: Statement;
    resolveUnmatchedTracking: Statement;
    updateUnmatchedTrackingStatus: Statement;
    updateUnmatchedTrackingUspsStatus: Statement;
    touchUnmatchedTrackingUspsFetch: Statement;
    updateUnmatchedTrackingCarrier: Statement;
    listAllPendingUnmatchedTracking: Statement;
    findShipmentsByTrackingNumber: Statement;
    getNextDisplayOrderNumber: Statement;
    countOrdersFiltered: Statement;
    countOrdersBySource: Statement;
    countOrdersByStatus: Statement;
    countOrdersBySourceAndStatus: Statement;
    // Order items (Pull Sheet)
    upsertOrderItem: Statement;
    getItemsByOrderId: Statement;
    getItemsByExternalOrderId: Statement;
    attachItemsToOrder: Statement;
  };

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ service: "MarketplaceService" });
    this.statements = this.prepareStatements();
  }

  /**
   * Backfill customer_name_normalized with consistent punctuation-stripping.
   * Fixes inconsistency where old records may have punctuation (e.g., "O'DONNELL")
   * while new normalization strips it ("ODONNELL").
   *
   * Idempotent: safe to call multiple times.
   * @returns Number of records updated
   */
  backfillCustomerNameNormalization(): number {
    const rows = this.db.prepare(`
      SELECT id, customer_name, customer_name_normalized
      FROM marketplace_orders
    `).all() as Array<{ id: number; customer_name: string; customer_name_normalized: string }>;

    const update = this.db.prepare(`
      UPDATE marketplace_orders
      SET customer_name_normalized = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      let updated = 0;
      for (const row of rows) {
        const normalized = normalizeNameForMatching(row.customer_name);
        if (normalized !== row.customer_name_normalized) {
          update.run(normalized, row.id);
          updated++;
        }
      }
      return updated;
    });

    const updatedCount = tx();
    if (updatedCount > 0) {
      this.logger.info(
        { updatedCount },
        "Backfilled customer_name_normalized (punctuation normalization)"
      );
    }
    return updatedCount;
  }

  /**
   * Ensure customer_name_normalized is backfilled (one-time, process-wide).
   *
   * Uses a fast probe to check if any rows have punctuation in normalized name.
   * If found, runs full backfill. Sets module-level flag to avoid repeated scans.
   *
   * Call this in non-dry-run flows before any matching operations.
   * Safe to call multiple times - returns immediately after first run.
   */
  ensureCustomerNameNormalizationBackfilled(): void {
    // Skip if already done this process
    if (didBackfillCustomerNameNormalization) {
      return;
    }

    // Fast probe: check if any rows have punctuation (apostrophe, hyphen, period, comma)
    // Note: SQLite uses '' to escape single quotes inside single-quoted strings
    const probe = this.db.prepare(`
      SELECT 1 FROM marketplace_orders
      WHERE customer_name_normalized LIKE '%''%'
         OR customer_name_normalized LIKE '%-%'
         OR customer_name_normalized LIKE '%.%'
         OR customer_name_normalized LIKE '%,%'
      LIMIT 1
    `).get();

    if (probe) {
      // Found punctuation in normalized names - run backfill
      this.logger.info("Punctuation detected in customer_name_normalized, running backfill");
      this.backfillCustomerNameNormalization();
    }

    // Mark as done regardless of whether backfill was needed
    didBackfillCustomerNameNormalization = true;
  }

  /**
   * Check if there are any pending unmatched tracking entries.
   * Used to decide whether to run re-match even when no new orders imported.
   */
  hasUnmatchedTracking(): boolean {
    const result = this.db.prepare(`
      SELECT 1 FROM unmatched_tracking
      WHERE resolution_status = 'pending'
      LIMIT 1
    `).get();
    return !!result;
  }

  private prepareStatements() {
    return {
      insertBatch: this.db.prepare(`
        INSERT INTO import_batches (source, imported_by, imported_at, file_checksum, file_name, row_count, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `),

      updateBatch: this.db.prepare(`
        UPDATE import_batches
        SET success_count = ?, skip_count = ?, error_count = ?, status = ?, error_details = ?
        WHERE id = ?
      `),

      getBatchById: this.db.prepare(`
        SELECT * FROM import_batches WHERE id = ?
      `),

      insertOrder: this.db.prepare(`
        INSERT INTO marketplace_orders (
          source, external_order_id, display_order_number, customer_name, customer_name_normalized,
          order_date, item_count, product_value_cents, shipping_fee_cents, product_weight_oz,
          shipping_method, import_batch_id, import_format
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      getOrderById: this.db.prepare(`
        SELECT * FROM marketplace_orders WHERE id = ?
      `),

      getOrderByExternalId: this.db.prepare(`
        SELECT * FROM marketplace_orders WHERE source = ? AND external_order_id = ?
      `),

      listOrders: this.db.prepare(`
        SELECT * FROM marketplace_orders ORDER BY order_date DESC LIMIT ? OFFSET ?
      `),

      listOrdersBySource: this.db.prepare(`
        SELECT * FROM marketplace_orders WHERE source = ? ORDER BY order_date DESC LIMIT ? OFFSET ?
      `),

      listOrdersByStatus: this.db.prepare(`
        SELECT * FROM marketplace_orders WHERE status = ? ORDER BY order_date DESC LIMIT ? OFFSET ?
      `),

      listOrdersBySourceAndStatus: this.db.prepare(`
        SELECT * FROM marketplace_orders WHERE source = ? AND status = ? ORDER BY order_date DESC LIMIT ? OFFSET ?
      `),

      countOrders: this.db.prepare(`
        SELECT COUNT(*) as count FROM marketplace_orders
      `),

      countOrdersFiltered: this.db.prepare(`
        SELECT COUNT(*) as count FROM marketplace_orders
      `),

      countOrdersBySource: this.db.prepare(`
        SELECT COUNT(*) as count FROM marketplace_orders WHERE source = ?
      `),

      countOrdersByStatus: this.db.prepare(`
        SELECT COUNT(*) as count FROM marketplace_orders WHERE status = ?
      `),

      countOrdersBySourceAndStatus: this.db.prepare(`
        SELECT COUNT(*) as count FROM marketplace_orders WHERE source = ? AND status = ?
      `),

      updateOrderStatus: this.db.prepare(`
        UPDATE marketplace_orders SET status = ? WHERE id = ?
      `),

      updateOrderDate: this.db.prepare(`
        UPDATE marketplace_orders
        SET order_date = ?, updated_at = strftime('%s', 'now')
        WHERE id = ?
      `),

      insertShipment: this.db.prepare(`
        INSERT INTO marketplace_shipments (
          marketplace_order_id, shipment_sequence, shipping_address_encrypted, shipping_zip, address_expires_at, is_external
        ) VALUES (?, ?, ?, ?, ?, ?)
      `),

      getShipmentsByOrderId: this.db.prepare(`
        SELECT * FROM marketplace_shipments WHERE marketplace_order_id = ? ORDER BY shipment_sequence
      `),

      getShipmentById: this.db.prepare(`
        SELECT * FROM marketplace_shipments WHERE id = ?
      `),

      updateShipmentTracking: this.db.prepare(`
        UPDATE marketplace_shipments
        SET tracking_number = ?, tracking_url = ?, carrier = ?, service = COALESCE(?, service),
            tracking_match_confidence = ?, tracking_matched_at = ?, tracking_matched_by = ?
        WHERE id = ?
      `),

      updateShipmentStatus: this.db.prepare(`
        UPDATE marketplace_shipments
        SET status = ?, shipped_at = CASE WHEN ? = 'shipped' THEN strftime('%s', 'now') ELSE shipped_at END,
            delivered_at = CASE WHEN ? = 'delivered' THEN strftime('%s', 'now') ELSE delivered_at END
        WHERE id = ?
      `),

      updateShipmentLabel: this.db.prepare(`
        UPDATE marketplace_shipments
        SET easypost_shipment_id = ?, easypost_rate_id = ?, carrier = ?, service = ?,
            tracking_number = ?, tracking_url = ?, label_url = ?, label_cost_cents = ?,
            label_purchased_at = strftime('%s', 'now'), status = 'label_purchased'
        WHERE id = ?
      `),

      updateShipmentPwe: this.db.prepare(`
        UPDATE marketplace_shipments
        SET is_pwe = ?,
            status = CASE
              WHEN ? = 1 AND status = 'pending' THEN 'shipped'
              WHEN ? = 0 AND status = 'shipped' AND tracking_number IS NULL AND label_url IS NULL THEN 'pending'
              ELSE status
            END,
            shipped_at = CASE
              WHEN ? = 1 AND status = 'pending' THEN strftime('%s', 'now')
              WHEN ? = 0 AND status = 'shipped' AND tracking_number IS NULL AND label_url IS NULL THEN NULL
              ELSE shipped_at
            END,
            updated_at = strftime('%s', 'now')
        WHERE id = ?
      `),

      updateShipmentAddressIfMissing: this.db.prepare(`
        UPDATE marketplace_shipments
        SET shipping_address_encrypted = ?,
            shipping_zip = COALESCE(shipping_zip, ?)
        WHERE id = ?
          AND shipping_address_encrypted IS NULL
      `),

      // Set address expiry to 90 days from now (called when shipment delivered)
      setAddressExpiry: this.db.prepare(`
        UPDATE marketplace_shipments
        SET address_expires_at = strftime('%s', 'now') + (90 * 24 * 60 * 60)
        WHERE id = ?
      `),

      // Purge expired addresses (NULLs the encrypted field)
      purgeExpiredAddresses: this.db.prepare(`
        UPDATE marketplace_shipments
        SET shipping_address_encrypted = NULL, updated_at = strftime('%s', 'now')
        WHERE address_expires_at IS NOT NULL
          AND address_expires_at < strftime('%s', 'now')
          AND shipping_address_encrypted IS NOT NULL
      `),

      insertUnmatchedTracking: this.db.prepare(`
        INSERT OR IGNORE INTO unmatched_tracking (
          import_batch_id, easypost_tracker_id, easypost_shipment_id, tracking_number,
          carrier, signed_by, signed_by_normalized, destination_zip, easypost_status, created_at_easypost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      listUnmatchedTracking: this.db.prepare(`
        SELECT * FROM unmatched_tracking
        WHERE resolution_status = 'pending'
          AND (COALESCE(usps_status, easypost_status) IS NULL
               OR COALESCE(usps_status, easypost_status) NOT IN ('delivered', 'in_transit', 'out_for_delivery', 'return_to_sender'))
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `),

      resolveUnmatchedTracking: this.db.prepare(`
        UPDATE unmatched_tracking
        SET resolution_status = ?, matched_to_shipment_id = ?, resolved_by = ?, resolved_at = strftime('%s', 'now')
        WHERE id = ?
      `),

      updateUnmatchedTrackingStatus: this.db.prepare(`
        UPDATE unmatched_tracking
        SET easypost_status = ?, easypost_tracker_id = ?
        WHERE id = ?
      `),

      updateUnmatchedTrackingUspsStatus: this.db.prepare(`
        UPDATE unmatched_tracking
        SET usps_status = ?,
            usps_delivered_at = ?,
            usps_last_event_at = ?,
            usps_events_json = ?,
            last_usps_fetch_at = ?
        WHERE id = ?
      `),

      touchUnmatchedTrackingUspsFetch: this.db.prepare(`
        UPDATE unmatched_tracking
        SET last_usps_fetch_at = ?
        WHERE id = ?
      `),

      updateUnmatchedTrackingCarrier: this.db.prepare(`
        UPDATE unmatched_tracking
        SET carrier = ?
        WHERE id = ?
      `),

      listAllPendingUnmatchedTracking: this.db.prepare(`
        SELECT * FROM unmatched_tracking
        WHERE resolution_status = 'pending'
        ORDER BY created_at DESC
      `),

      findShipmentsByTrackingNumber: this.db.prepare(`
        SELECT * FROM marketplace_shipments
        WHERE (tracking_number = ?
           OR REPLACE(REPLACE(tracking_number, '-', ''), ' ', '') = ?)
          AND fulfilled_by_shipment_id IS NULL
      `),

      getNextDisplayOrderNumber: this.db.prepare(`
        SELECT MAX(CAST(SUBSTR(display_order_number, -6) AS INTEGER)) as max_seq
        FROM marketplace_orders
        WHERE display_order_number LIKE ?
      `),

      // Order items (Pull Sheet) - idempotent upsert with overwrite semantics
      upsertOrderItem: this.db.prepare(`
        INSERT INTO marketplace_order_items (
          marketplace_order_id, source, external_order_id, item_key,
          tcgplayer_sku_id, product_name, set_name, card_number, condition,
          rarity, product_line, set_release_date, quantity, unit_price_cents,
          price_confidence, image_url, import_batch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, external_order_id, item_key) DO UPDATE SET
          marketplace_order_id = COALESCE(excluded.marketplace_order_id, marketplace_order_id),
          quantity = excluded.quantity,
          unit_price_cents = COALESCE(excluded.unit_price_cents, unit_price_cents),
          price_confidence = CASE
            WHEN excluded.price_confidence = 'exact' THEN 'exact'
            WHEN price_confidence = 'exact' THEN 'exact'
            ELSE excluded.price_confidence
          END,
          import_batch_id = excluded.import_batch_id,
          updated_at = strftime('%s', 'now')
      `),

      getItemsByOrderId: this.db.prepare(`
        SELECT * FROM marketplace_order_items
        WHERE marketplace_order_id = ?
        ORDER BY id
      `),

      getItemsByExternalOrderId: this.db.prepare(`
        SELECT * FROM marketplace_order_items
        WHERE source = ? AND external_order_id = ?
        ORDER BY id
      `),

      attachItemsToOrder: this.db.prepare(`
        UPDATE marketplace_order_items
        SET marketplace_order_id = ?, updated_at = strftime('%s', 'now')
        WHERE source = ? AND external_order_id = ? AND marketplace_order_id IS NULL
      `),
    };
  }

  // ============================================================================
  // Import Batches
  // ============================================================================

  createImportBatch(
    source: ImportBatch["source"],
    importedBy: string,
    fileChecksum: string,
    fileName: string | null,
    rowCount: number
  ): number {
    const result = this.statements.insertBatch.run(
      source,
      importedBy,
      Math.floor(Date.now() / 1000),
      fileChecksum,
      fileName,
      rowCount
    );
    return result.lastInsertRowid as number;
  }

  updateImportBatch(
    batchId: number,
    successCount: number,
    skipCount: number,
    errorCount: number,
    status: ImportBatch["status"],
    errorDetails: string | null
  ): void {
    this.statements.updateBatch.run(
      successCount,
      skipCount,
      errorCount,
      status,
      errorDetails,
      batchId
    );
  }

  getImportBatch(batchId: number): ImportBatch | undefined {
    return this.statements.getBatchById.get(batchId) as ImportBatch | undefined;
  }

  // ============================================================================
  // Orders
  // ============================================================================

  /**
   * Normalize customer name for matching.
   * Delegates to shared helper for consistency with EasyPost tracking linker.
   * @deprecated Use normalizeNameForMatching() directly for new code
   */
  normalizeCustomerName(name: string): string {
    return normalizeNameForMatching(name);
  }

  /**
   * Generate a display order number: TCG-YYYYMMDD-NNNNNN or EBAY-YYYYMMDD-NNNNNN
   */
  generateDisplayOrderNumber(source: "tcgplayer" | "ebay", orderDate: number): string {
    const prefix = source === "tcgplayer" ? "TCG" : "EBAY";

    // Use CST (fixed UTC-6) for the date component so that times after ~6pm CST
    // don't roll into the next UTC day in the YYYYMMDD portion.
    const CST_OFFSET_SECONDS = 6 * 3600;
    const cstDate = new Date((orderDate - CST_OFFSET_SECONDS) * 1000);
    const dateStr = cstDate.toISOString().slice(0, 10).replace(/-/g, "");
    const pattern = `${prefix}-${dateStr}-%`;

    const result = this.statements.getNextDisplayOrderNumber.get(pattern) as { max_seq: number | null };
    const nextSeq = (result?.max_seq ?? 0) + 1;
    const seqStr = nextSeq.toString().padStart(6, "0");

    return `${prefix}-${dateStr}-${seqStr}`;
  }

  /**
   * Create a marketplace order with initial shipment
   */
  createOrder(input: CreateOrderInput): { orderId: number; shipmentId: number } {
    const displayOrderNumber = this.generateDisplayOrderNumber(input.source, input.order_date);
    const normalizedName = this.normalizeCustomerName(input.customer_name);

    // Encrypt shipping address if provided
    let encryptedAddress: string | null = null;
    let shippingZip: string | null = null;
    let addressExpiresAt: number | null = null;

    if (input.shipping_address) {
      encryptedAddress = encryptJson(input.shipping_address);
      shippingZip = input.shipping_address.zip;
      // Address expiry is set to null initially; will be set to 90 days post-delivery
      // when updateShipmentStatus is called with status='delivered'
      addressExpiresAt = null;
    }

    // Import format defaults to 'shipping_export' (has address)
    const importFormat = input.import_format ?? "shipping_export";
    // External flag: true for Order List imports (no CardMint label)
    const isExternal = input.is_external ? 1 : 0;

    // Use transaction to ensure atomicity
    const result = this.db.transaction(() => {
      const orderResult = this.statements.insertOrder.run(
        input.source,
        input.external_order_id,
        displayOrderNumber,
        input.customer_name,
        normalizedName,
        input.order_date,
        input.item_count,
        input.product_value_cents,
        input.shipping_fee_cents,
        input.product_weight_oz ?? null,
        input.shipping_method ?? null,
        input.import_batch_id ?? null,
        importFormat
      );

      const orderId = orderResult.lastInsertRowid as number;

      // Create initial shipment
      const shipmentResult = this.statements.insertShipment.run(
        orderId,
        1, // sequence
        encryptedAddress,
        shippingZip,
        addressExpiresAt,
        isExternal
      );

      const shipmentId = shipmentResult.lastInsertRowid as number;

      return { orderId, shipmentId };
    })();

    this.logger.info(
      { orderId: result.orderId, displayOrderNumber, source: input.source, importFormat, isExternal },
      "Created marketplace order"
    );

    // Auto-attach orphaned Pull Sheet items (handles "Pull Sheet first" scenario)
    this.attachItemsToOrder(result.orderId, input.source, input.external_order_id);

    return result;
  }

  /**
   * Check if order already exists (for idempotency)
   */
  orderExists(source: "tcgplayer" | "ebay", externalOrderId: string): boolean {
    const existing = this.statements.getOrderByExternalId.get(source, externalOrderId);
    return !!existing;
  }

  getOrderById(orderId: number): MarketplaceOrder | undefined {
    return this.statements.getOrderById.get(orderId) as MarketplaceOrder | undefined;
  }

  getOrderByExternalId(source: "tcgplayer" | "ebay", externalOrderId: string): MarketplaceOrder | undefined {
    return this.statements.getOrderByExternalId.get(source, externalOrderId) as MarketplaceOrder | undefined;
  }

  findOrdersByOrderNumber(orderNumber: string): MarketplaceOrder[] {
    // Parse input to handle both TCGP-... display format and raw 36666676-... format
    const trimmed = orderNumber.trim();
    const rawOrderNumber = parseTcgplayerOrderNumber(trimmed);

    return this.db
      .prepare(
        `
        SELECT * FROM marketplace_orders
        WHERE external_order_id = ? OR display_order_number = ?
      `
      )
      .all(rawOrderNumber, trimmed) as MarketplaceOrder[];
  }

  /**
   * Upgrade an Order List import to Shipping Export (add address, make label-ready).
   *
   * Used when Shipping Export CSV is imported after Order List for the same order.
   * Updates: import_format, shipping_address, is_external flag.
   *
   * @param orderId - The marketplace order ID to upgrade
   * @param shippingAddress - Full shipping address from Shipping Export
   * @param weight - Product weight in oz (from Shipping Export)
   * @returns true if upgrade was successful
   */
  upgradeOrderWithAddress(
    orderId: number,
    shippingAddress: ShippingAddress,
    weight?: number
  ): boolean {
    const encryptedAddress = encryptJson(shippingAddress);

    const result = this.db.transaction(() => {
      // Update order: set import_format to shipping_export, update weight if provided
      this.db.prepare(`
        UPDATE marketplace_orders
        SET import_format = 'shipping_export',
            product_weight_oz = COALESCE(?, product_weight_oz),
            updated_at = strftime('%s', 'now')
        WHERE id = ?
      `).run(weight ?? null, orderId);

      // Update shipment: add address, clear is_external flag
      this.db.prepare(`
        UPDATE marketplace_shipments
        SET shipping_address_encrypted = ?,
            shipping_zip = ?,
            is_external = 0,
            updated_at = strftime('%s', 'now')
        WHERE marketplace_order_id = ? AND shipment_sequence = 1
      `).run(encryptedAddress, shippingAddress.zip, orderId);

      return true;
    })();

    this.logger.info(
      { orderId, zip: shippingAddress.zip },
      "Upgraded Order List import to Shipping Export (address added)"
    );

    return result;
  }

  listOrders(options: ListOrdersOptions = {}): { orders: MarketplaceOrder[]; total: number } {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const source = options.source;
    const status = options.status;

    let orders: MarketplaceOrder[];
    let countResult: { count: number };

    if (source && source !== "all" && status) {
      orders = this.statements.listOrdersBySourceAndStatus.all(source, status, limit, offset) as MarketplaceOrder[];
      countResult = this.statements.countOrdersBySourceAndStatus.get(source, status) as { count: number };
    } else if (source && source !== "all") {
      orders = this.statements.listOrdersBySource.all(source, limit, offset) as MarketplaceOrder[];
      countResult = this.statements.countOrdersBySource.get(source) as { count: number };
    } else if (status) {
      orders = this.statements.listOrdersByStatus.all(status, limit, offset) as MarketplaceOrder[];
      countResult = this.statements.countOrdersByStatus.get(status) as { count: number };
    } else {
      orders = this.statements.listOrders.all(limit, offset) as MarketplaceOrder[];
      countResult = this.statements.countOrders.get() as { count: number };
    }

    return { orders, total: countResult.count };
  }

  updateOrderStatus(orderId: number, status: MarketplaceOrder["status"]): void {
    this.statements.updateOrderStatus.run(status, orderId);
  }

  updateOrderDate(orderId: number, orderDate: number): void {
    this.statements.updateOrderDate.run(orderDate, orderId);
  }

  // ============================================================================
  // Shipments
  // ============================================================================

  getShipmentsByOrderId(orderId: number): MarketplaceShipment[] {
    return this.statements.getShipmentsByOrderId.all(orderId) as MarketplaceShipment[];
  }

  getShipmentById(shipmentId: number): MarketplaceShipment | undefined {
    return this.statements.getShipmentById.get(shipmentId) as MarketplaceShipment | undefined;
  }

  /**
   * Decrypt shipping address from shipment
   */
  getShipmentAddress(shipment: MarketplaceShipment): ShippingAddress | null {
    if (!shipment.shipping_address_encrypted) {
      return null;
    }
    try {
      return decryptJson<ShippingAddress>(shipment.shipping_address_encrypted);
    } catch (error) {
      this.logger.error({ shipmentId: shipment.id, error }, "Failed to decrypt shipping address");
      return null;
    }
  }

  updateShipmentTracking(
    shipmentId: number,
    trackingNumber: string,
    trackingUrl: string | null,
    carrier: string | null,
    service: string | null,
    confidence: "auto" | "manual",
    matchedBy: string
  ): void {
    this.statements.updateShipmentTracking.run(
      trackingNumber,
      trackingUrl,
      carrier,
      service,
      confidence,
      Math.floor(Date.now() / 1000),
      matchedBy,
      shipmentId
    );

    // Propagate tracking info to any child shipments (combined shipment support)
    this.updateChildShipmentsStatus(shipmentId);
  }

  updateShipmentAddressIfMissing(shipmentId: number, shippingAddress: ShippingAddress): boolean {
    const encryptedAddress = encryptJson(shippingAddress);
    const result = this.statements.updateShipmentAddressIfMissing.run(
      encryptedAddress,
      shippingAddress.zip,
      shipmentId
    );
    return result.changes === 1;
  }

  updateShipmentStatus(
    shipmentId: number,
    status: MarketplaceShipment["status"]
  ): void {
    this.statements.updateShipmentStatus.run(status, status, status, shipmentId);

    // When shipment is delivered, set address expiry to 90 days from now
    if (status === "delivered") {
      this.statements.setAddressExpiry.run(shipmentId);
      this.logger.info(
        { shipmentId },
        "Set address expiry to 90 days post-delivery"
      );
    }

    // Propagate status to any child shipments (combined shipment support)
    this.updateChildShipmentsStatus(shipmentId);
  }

  updateShipmentLabel(
    shipmentId: number,
    easypostShipmentId: string,
    easypostRateId: string,
    carrier: string,
    service: string,
    trackingNumber: string,
    trackingUrl: string,
    labelUrl: string,
    labelCostCents: number
  ): void {
    this.statements.updateShipmentLabel.run(
      easypostShipmentId,
      easypostRateId,
      carrier,
      service,
      trackingNumber,
      trackingUrl,
      labelUrl,
      labelCostCents,
      shipmentId
    );
  }

  updateShipmentPwe(shipmentId: number, isPwe: boolean): void {
    const isPweValue = isPwe ? 1 : 0;
    this.statements.updateShipmentPwe.run(
      isPweValue,
      isPweValue,
      isPweValue,
      isPweValue,
      isPweValue,
      shipmentId
    );
  }

  /**
   * Purge expired shipping addresses (PII retention enforcement).
   * NULLs shipping_address_encrypted where address_expires_at < now.
   * Should be called periodically (e.g., daily job or on startup).
   * @returns Number of addresses purged
   */
  purgeExpiredAddresses(): number {
    const result = this.statements.purgeExpiredAddresses.run();
    const purgedCount = result.changes;
    if (purgedCount > 0) {
      this.logger.info(
        { purgedCount },
        "Purged expired shipping addresses (PII retention)"
      );
    }
    return purgedCount;
  }

  // ============================================================================
  // Unmatched Tracking
  // ============================================================================

  /**
   * Create unmatched tracking entry. Uses INSERT OR IGNORE for idempotency.
   * Returns the new row ID, or 0 if duplicate was skipped.
   */
  createUnmatchedTracking(
    importBatchId: number | null,
    easypostTrackerId: string,
    easypostShipmentId: string | null,
    trackingNumber: string,
    carrier: string | null,
    signedBy: string | null,
    destinationZip: string | null,
    easypostStatus: string | null,
    createdAtEasypost: number | null
  ): number {
    const normalizedSignedBy = signedBy ? normalizeNameForMatching(signedBy) : null;
    const result = this.statements.insertUnmatchedTracking.run(
      importBatchId,
      easypostTrackerId,
      easypostShipmentId,
      trackingNumber,
      carrier,
      signedBy,
      normalizedSignedBy,
      destinationZip,
      easypostStatus,
      createdAtEasypost
    );
    // Returns 0 if duplicate was ignored (changes === 0)
    return result.changes > 0 ? (result.lastInsertRowid as number) : 0;
  }

  listUnmatchedTracking(limit = 20, offset = 0): UnmatchedTracking[] {
    return this.statements.listUnmatchedTracking.all(limit, offset) as UnmatchedTracking[];
  }

  resolveUnmatchedTracking(
    unmatchedId: number,
    status: "matched" | "ignored" | "manual_entry",
    matchedToShipmentId: number | null,
    resolvedBy: string
  ): void {
    this.statements.resolveUnmatchedTracking.run(
      status,
      matchedToShipmentId,
      resolvedBy,
      unmatchedId
    );
  }

  /**
   * Generate carrier-specific tracking URL.
   * Returns null for unknown carriers to allow EasyPost fallback.
   */
  generateTrackingUrl(trackingNumber: string, carrier: string | null): string | null {
    if (!trackingNumber || !carrier) return null;

    // Safety: trim whitespace and URL-encode the tracking number
    const encoded = encodeURIComponent(trackingNumber.trim());
    const carrierLower = carrier.toLowerCase();

    // USPS
    if (carrierLower === "usps" || carrierLower.includes("usps")) {
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
    }

    // UPS
    if (carrierLower === "ups" || carrierLower.includes("ups")) {
      return `https://www.ups.com/track?tracknum=${encoded}`;
    }

    // FedEx
    if (carrierLower === "fedex" || carrierLower.includes("fedex")) {
      return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
    }

    // DHL
    if (carrierLower === "dhl" || carrierLower.includes("dhl")) {
      return `https://www.dhl.com/en/express/tracking.html?AWB=${encoded}`;
    }

    // Unknown carrier - return null to allow EasyPost public_url fallback
    return null;
  }

  /**
   * Find potential matches for unmatched tracking by customer name (legacy ZIP-based)
   */
  findMatchCandidates(normalizedName: string, destinationZip: string | null): MarketplaceOrder[] {
    const stmt = this.db.prepare(`
      SELECT mo.* FROM marketplace_orders mo
      JOIN marketplace_shipments ms ON mo.id = ms.marketplace_order_id
      WHERE mo.customer_name_normalized = ?
      ${destinationZip ? "AND ms.shipping_zip = ?" : ""}
      AND mo.status IN ('pending', 'processing')
      ORDER BY mo.order_date DESC
    `);

    if (destinationZip) {
      return stmt.all(normalizedName, destinationZip) as MarketplaceOrder[];
    }
    return stmt.all(normalizedName) as MarketplaceOrder[];
  }

  /**
   * Find potential matches for tracking by customer name AND order date.
   * Uses America/Chicago (CST) timezone for date normalization.
   *
   * Window logic: Match tracking created within -6h before to +30h after order date.
   * This handles:
   * - Same-day shipments (label purchased hours after order)
   * - Next-day label purchases (most common scenario)
   * - Time zone edge cases
   *
   * @param normalizedName - Normalized customer name (from EasyPost signed_by)
   * @param trackingCreatedAt - Unix timestamp from EasyPost tracking created_at
   * @returns Matching orders where name matches and tracking is within date window
   */
  findMatchCandidatesByDate(
    normalizedName: string,
    trackingCreatedAt: number
  ): MarketplaceOrder[] {
    // Re-normalize the name in case it was stored with old logic (punctuation)
    const reNormalizedName = normalizeNameForMatching(normalizedName);

    // Window: 6 hours before order date to 30 hours after
    // Allows same-day and next-day label purchases
    const WINDOW_BEFORE = 6 * 3600; // 6h before CST midnight
    const WINDOW_AFTER = 30 * 3600; // 30h after CST midnight (next day + 6h)

    const stmt = this.db.prepare(`
      SELECT DISTINCT mo.* FROM marketplace_orders mo
      JOIN marketplace_shipments ms ON mo.id = ms.marketplace_order_id
      WHERE mo.customer_name_normalized = ?
        AND ? BETWEEN (mo.order_date - ?) AND (mo.order_date + ?)
        AND mo.status IN ('pending', 'processing')
      ORDER BY mo.order_date DESC
    `);

    return stmt.all(
      reNormalizedName,
      trackingCreatedAt,
      WINDOW_BEFORE,
      WINDOW_AFTER
    ) as MarketplaceOrder[];
  }

  /**
   * Re-match unmatched tracking entries against marketplace orders.
   * Called after TCGPlayer/eBay order imports to link previously unmatched tracking.
   *
   * Uses date-based matching (name + order date) as primary strategy.
   *
   * Guardrails:
   * 1. Only auto-link when exactly one candidate order found
   * 2. Candidate must have an eligible shipment (pending/label_purchased/shipped)
   * 3. Shipment must have no existing tracking number
   * 4. Full update: tracking_number + tracking_url + status from EasyPost
   *
   * @returns Count of tracking entries that were matched
   */
  reMatchUnmatchedTracking(): {
    matched: number;
    details: Array<{ trackingNumber: string; orderNumber: string }>;
  } {
    // Ensure name normalization is consistent before matching (one-time, process-wide)
    this.ensureCustomerNameNormalizationBackfilled();

    const pending = this.listUnmatchedTracking(1000, 0); // Get all pending
    const matched: Array<{ trackingNumber: string; orderNumber: string }> = [];

    for (const tracking of pending) {
      // Skip if no created_at timestamp or no signed_by
      if (!tracking.created_at_easypost || !tracking.signed_by_normalized) {
        continue;
      }

      // Re-normalize for punctuation consistency
      const normalizedName = normalizeNameForMatching(tracking.signed_by_normalized);

      // Try date-based matching first
      const candidates = this.findMatchCandidatesByDate(
        normalizedName,
        tracking.created_at_easypost
      );

      // Guardrail 1: Exactly one candidate
      if (candidates.length !== 1) {
        continue;
      }

      const order = candidates[0];
      const shipments = this.getShipmentsByOrderId(order.id);

      // Guardrail 2: Find eligible shipment (pending/label_purchased/shipped)
      // Guardrail 3: No existing tracking number
      const eligibleShipment = shipments.find(
        (s) =>
          (s.status === "pending" ||
            s.status === "label_purchased" ||
            s.status === "shipped") &&
          !s.tracking_number
      );

      if (!eligibleShipment) {
        continue;
      }

      // All guardrails passed - perform full update
      // Generate carrier-aware tracking URL (null if carrier unknown)
      const trackingUrl = this.generateTrackingUrl(
        tracking.tracking_number,
        tracking.carrier
      );
      this.updateShipmentTracking(
        eligibleShipment.id,
        tracking.tracking_number,
        trackingUrl,
        tracking.carrier || null,
        null,
        "auto",
        "system:rematch"
      );

      // Update shipment status based on EasyPost status
      const effectiveStatus = tracking.usps_status || tracking.easypost_status;
      if (effectiveStatus) {
        const statusMap: Record<string, MarketplaceShipment["status"]> = {
          delivered: "delivered",
          in_transit: "in_transit",
          // pre_transit = label created but not scanned → keep as label_purchased
          // This allows refunds for unscanned labels
          pre_transit: "label_purchased",
          out_for_delivery: "in_transit",
        };
        const newStatus = statusMap[effectiveStatus.toLowerCase()];
        if (newStatus) {
          this.updateShipmentStatus(eligibleShipment.id, newStatus);
        }
      }

      // Mark tracking as matched
      this.resolveUnmatchedTracking(
        tracking.id,
        "matched",
        eligibleShipment.id,
        "system:rematch"
      );

      matched.push({
        trackingNumber: tracking.tracking_number,
        orderNumber: order.display_order_number,
      });

      this.logger.info(
        {
          unmatchedId: tracking.id,
          trackingNumber: tracking.tracking_number,
          orderNumber: order.display_order_number,
          shipmentId: eligibleShipment.id,
        },
        "Auto-rematched tracking to order"
      );
    }

    if (matched.length > 0) {
      this.logger.info(
        { matchedCount: matched.length },
        "Completed re-matching unmatched tracking"
      );
    }

    return { matched: matched.length, details: matched };
  }

  /**
   * Refresh tracking statuses from EasyPost for all pending unmatched entries.
   * Optionally falls back to USPS tracking for unknown USPS entries.
   *
   * @param easyPostService - EasyPost service instance for API calls
   * @returns Counts of entries refreshed/updated and any that changed status
   */
  async refreshUnmatchedTrackingStatuses(
    easyPostService: EasyPostService,
    options: { includeUspsFallback?: boolean; uspsService?: UspsTrackingService } = {}
  ): Promise<{
    attempted: number;
    refreshed: number;
    updated: number;
    errors: number;
    uspsChecked: number;
    uspsUpdated: number;
    uspsErrors: number;
    autoResolved: number;
    details: Array<{
      trackingNumber: string;
      oldStatus: string | null;
      newStatus: string;
      source: "easypost" | "usps";
    }>;
  }> {
    // Get ALL pending entries (not filtered by status like listUnmatchedTracking)
    const pending = this.statements.listAllPendingUnmatchedTracking.all() as UnmatchedTracking[];

    this.logger.info(
      { pendingCount: pending.length },
      "Starting tracking status refresh from EasyPost"
    );

    const attempted = pending.length;
    let refreshed = 0;
    let updated = 0;
    let errors = 0;
    let uspsChecked = 0;
    let uspsUpdated = 0;
    let uspsErrors = 0;
    const details: Array<{
      trackingNumber: string;
      oldStatus: string | null;
      newStatus: string;
      source: "easypost" | "usps";
    }> = [];
    const uspsCandidates: UnmatchedTracking[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const uspsMinAgeSec = Math.max(1, runtimeConfig.uspsTrackingRefreshMinutes) * 60;
    const includeUspsFallback = Boolean(options.includeUspsFallback && options.uspsService?.isConfigured());

    for (const tracking of pending) {
      try {
        if (!tracking.carrier && isLikelyUspsTrackingNumber(tracking.tracking_number)) {
          this.statements.updateUnmatchedTrackingCarrier.run("USPS", tracking.id);
          tracking.carrier = "USPS";
        }

        const tracker = await easyPostService.getTrackerByTrackingNumber(
          tracking.tracking_number,
          tracking.carrier || undefined
        );

        if (!tracker) {
          errors++;
        } else {
          refreshed++;

          // Update status if changed
          if (tracker.status !== tracking.easypost_status) {
            this.statements.updateUnmatchedTrackingStatus.run(
              tracker.status,
              tracker.id,
              tracking.id
            );

            updated++;
            details.push({
              trackingNumber: tracking.tracking_number,
              oldStatus: tracking.easypost_status,
              newStatus: tracker.status,
              source: "easypost",
            });

            this.logger.info(
              {
                trackingNumber: tracking.tracking_number,
                oldStatus: tracking.easypost_status,
                newStatus: tracker.status,
                trackerId: tracker.id,
              },
              "Updated tracking status from EasyPost"
            );
          }

          tracking.easypost_status = tracker.status;
        }

        if (includeUspsFallback && isUspsCarrier(tracking)) {
          const effectiveStatus = tracking.easypost_status || tracking.usps_status;
          const shouldFetchUsps =
            isUnknownStatus(effectiveStatus) &&
            (!tracking.last_usps_fetch_at || nowSec - tracking.last_usps_fetch_at >= uspsMinAgeSec);

          if (shouldFetchUsps) {
            uspsCandidates.push(tracking);
          }
        }
      } catch (err) {
        errors++;
        this.logger.warn(
          { err, trackingNumber: tracking.tracking_number },
          "Failed to refresh tracking status"
        );
      }
    }

    const uspsService = options.uspsService;
    if (includeUspsFallback && uspsCandidates.length > 0 && uspsService) {
      const concurrency = Math.max(1, runtimeConfig.uspsTrackingConcurrency);
      await runWithConcurrency(uspsCandidates, concurrency, async (tracking) => {
        uspsChecked++;
        const result = await uspsService.getTrackingStatus(tracking.tracking_number);
        const fetchTime = Math.floor(Date.now() / 1000);

        if (!result) {
          uspsErrors++;
          this.statements.touchUnmatchedTrackingUspsFetch.run(fetchTime, tracking.id);
          return;
        }

        const oldStatus = tracking.usps_status;
        if (result.status !== tracking.usps_status) {
          uspsUpdated++;
          details.push({
            trackingNumber: tracking.tracking_number,
            oldStatus,
            newStatus: result.status,
            source: "usps",
          });
        }

        let rawJson = "";
        try {
          rawJson = JSON.stringify(result.raw);
        } catch (err) {
          this.logger.warn({ err, trackingNumber: tracking.tracking_number }, "USPS raw payload stringify failed");
        }

        this.statements.updateUnmatchedTrackingUspsStatus.run(
          result.status,
          result.deliveredAt,
          result.lastEventAt,
          rawJson,
          fetchTime,
          tracking.id
        );
      });
    }

    const autoResolved = this.resolveUnmatchedTrackingByTrackingNumber(pending);

    this.logger.info(
      { attempted, refreshed, updated, errors, uspsChecked, uspsUpdated, uspsErrors, autoResolved },
      "Completed tracking status refresh"
    );

    return {
      attempted,
      refreshed,
      updated,
      errors,
      uspsChecked,
      uspsUpdated,
      uspsErrors,
      autoResolved,
      details,
    };
  }

  private resolveUnmatchedTrackingByTrackingNumber(pending: UnmatchedTracking[]): number {
    let resolved = 0;

    for (const tracking of pending) {
      if (!tracking.tracking_number || !isUspsCarrier(tracking)) {
        continue;
      }

      const normalizedTracking = normalizeTrackingNumber(tracking.tracking_number);
      const shipments = this.statements.findShipmentsByTrackingNumber.all(
        tracking.tracking_number,
        normalizedTracking
      ) as MarketplaceShipment[];

      if (shipments.length !== 1) {
        continue;
      }

      this.resolveUnmatchedTracking(
        tracking.id,
        "matched",
        shipments[0].id,
        "system:tracking-number"
      );

      resolved++;
    }

    if (resolved > 0) {
      this.logger.info({ resolved }, "Resolved unmatched tracking by number");
    }

    return resolved;
  }

  /**
   * Get fulfillment stats for dashboard.
   * Aggregates both marketplace (TCGPlayer/eBay) and CardMint (Stripe) fulfillments.
   *
   * @returns Actionable counts for fulfillment dashboard
   */
  getFulfillmentStats(): {
    pendingLabels: number;
    unmatchedTracking: number;
    exceptions: number;
    shippedToday: number;
  } {
    // Marketplace pending labels (shipments without tracking, excluding external fulfillment)
    // External shipments (is_external=1) are fulfilled via TCGPlayer, not CardMint labels
    const marketplacePending = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM marketplace_shipments ms
      JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
      WHERE ms.status = 'pending'
        AND ms.is_external = 0
        AND ms.is_pwe = 0
        AND ms.tracking_number IS NULL
        AND ms.label_url IS NULL
        AND ms.label_purchased_at IS NULL
        AND ms.label_purchase_in_progress = 0
        AND (COALESCE(mo.product_value_cents, 0) + COALESCE(mo.shipping_fee_cents, 0)) >= 750
    `).get() as { count: number };

    // CardMint pending labels (awaiting label action)
    const cardmintPending = this.db.prepare(`
      SELECT COUNT(*) as count FROM fulfillment
      WHERE status IN ('pending', 'reviewed')
    `).get() as { count: number };

    // Unmatched tracking count (marketplace only - no CardMint equivalent)
    // Exclude entries with terminal tracking statuses (delivered, in_transit, etc.)
    // that are being handled normally and don't require operator attention
    const unmatchedCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM unmatched_tracking
      WHERE resolution_status = 'pending'
        AND (COALESCE(usps_status, easypost_status) IS NULL
             OR COALESCE(usps_status, easypost_status) NOT IN ('delivered', 'in_transit', 'out_for_delivery', 'return_to_sender'))
    `).get() as { count: number };

    // Marketplace exceptions
    const marketplaceExceptions = this.db.prepare(`
      SELECT COUNT(*) as count FROM marketplace_shipments
      WHERE status = 'exception'
    `).get() as { count: number };

    // CardMint exceptions
    const cardmintExceptions = this.db.prepare(`
      SELECT COUNT(*) as count FROM fulfillment
      WHERE status = 'exception'
    `).get() as { count: number };

    // Shipped today (CST calendar day)
    // Calculate CST day boundaries: now - 6 hours, then floor to midnight
    const nowUtc = Math.floor(Date.now() / 1000);
    const cstDayStart = Math.floor((nowUtc - 6 * 3600) / 86400) * 86400 + 6 * 3600;

    const marketplaceShippedToday = this.db.prepare(`
      SELECT COUNT(*) as count FROM marketplace_shipments
      WHERE shipped_at >= ? AND shipped_at < ? + 86400
    `).get(cstDayStart, cstDayStart) as { count: number };

    // CardMint shipped today
    const cardmintShippedToday = this.db.prepare(`
      SELECT COUNT(*) as count FROM fulfillment
      WHERE shipped_at >= ? AND shipped_at < ? + 86400
    `).get(cstDayStart, cstDayStart) as { count: number };

    return {
      pendingLabels: marketplacePending.count + cardmintPending.count,
      unmatchedTracking: unmatchedCount.count,
      exceptions: marketplaceExceptions.count + cardmintExceptions.count,
      shippedToday: marketplaceShippedToday.count + cardmintShippedToday.count,
    };
  }

  // ============================================================================
  // Phase 4: Rates & Label Flow
  // ============================================================================

  /**
   * Get shipment with decrypted address and order details.
   * Used by rates/label endpoints.
   * Returns null address if PII has expired/been purged.
   */
  getShipmentWithDecryptedAddress(shipmentId: number): ShipmentWithAddress | null {
    const shipment = this.getShipmentById(shipmentId);
    if (!shipment) {
      return null;
    }

    const order = this.getOrderById(shipment.marketplace_order_id) ?? null;
    const decryptedAddress = this.getShipmentAddress(shipment);

    return {
      ...shipment,
      decryptedAddress,
      order,
    };
  }

  /**
   * Update shipment with EasyPost shipment ID and parcel metadata.
   * Called when rates are fetched (creates EasyPost shipment).
   */
  updateShipmentEasypostShipment(
    shipmentId: number,
    easypostShipmentId: string,
    parcelPresetKey: string,
    parcelWeightOz: number,
    insuredValueCents: number | null,
    itemCount: number | null
  ): void {
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET easypost_shipment_id = ?,
          parcel_preset_key = ?,
          parcel_weight_oz = ?,
          insured_value_cents = ?,
          item_count = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(
      easypostShipmentId,
      parcelPresetKey,
      parcelWeightOz,
      insuredValueCents,
      itemCount,
      shipmentId
    );
  }

  /**
   * Update shipment after successful label purchase.
   * Sets tracking info, label URL, and status to label_purchased.
   * Uses NULL for missing optional fields (not empty string).
   */
  updateShipmentLabelPurchased(
    shipmentId: number,
    trackingNumber: string,
    trackingUrl: string | null,
    labelUrl: string,
    labelCostCents: number,
    carrier: string | null,
    service: string | null,
    rateId: string
  ): void {
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET tracking_number = ?,
          tracking_url = ?,
          label_url = ?,
          label_cost_cents = ?,
          carrier = ?,
          service = ?,
          easypost_rate_id = ?,
          label_purchased_at = strftime('%s', 'now'),
          status = 'label_purchased',
          label_purchase_in_progress = 0,
          label_purchase_locked_at = NULL,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(
      trackingNumber,
      trackingUrl,
      labelUrl,
      labelCostCents,
      carrier,
      service,
      rateId,
      shipmentId
    );

    // Propagate tracking info to any child shipments (combined shipment support)
    this.updateChildShipmentsStatus(shipmentId);

    this.logger.info(
      {
        shipmentId,
        trackingNumber,
        carrier,
        service,
        labelCostCents,
      },
      "Label purchased for marketplace shipment"
    );
  }

  /**
   * Update shipment label URL (for operator-uploaded labels).
   * Does not change status - separate from EasyPost-purchased labels.
   */
  updateShipmentLabelUrl(shipmentId: number, labelUrl: string): void {
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET label_url = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(labelUrl, shipmentId);
  }

  /**
   * Get shipment item count (from shipment or fallback to order).
   * For split shipments, shipment.item_count takes precedence.
   */
  getShipmentItemCount(shipment: MarketplaceShipment, order: MarketplaceOrder): number {
    // Per-shipment item count (for split shipments)
    if (shipment.item_count !== null) {
      return shipment.item_count;
    }
    // Fallback to order item count (assumes 1 shipment per order)
    return order.item_count;
  }

  // ============================================================================
  // Refund Flow Methods
  // ============================================================================

  /**
   * Update shipment refund status.
   * Called after void request or refund check.
   *
   * @param shipmentId - Internal shipment ID
   * @param refundStatus - New refund status ('submitted' | 'refunded' | 'rejected')
   */
  updateRefundStatus(shipmentId: number, refundStatus: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET refund_status = ?,
          refund_requested_at = COALESCE(refund_requested_at, ?),
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(refundStatus, now, shipmentId);

    this.logger.info(
      { shipmentId, refundStatus },
      "Updated shipment refund status"
    );
  }

  /**
   * Reset shipment to pending state after successful refund.
   *
   * Clears:
   * - status → 'pending'
   * - tracking_number, tracking_url, label_url, label_cost_cents, label_purchased_at
   * - shipped_at, delivered_at
   * - carrier, service, easypost_rate_id, label_viewed_at
   *
   * Preserves:
   * - easypost_shipment_id (for re-rating if needed)
   * - shipping addresses
   * - refund_status (keeps 'refunded' for audit)
   *
   * @param shipmentId - Internal shipment ID
   */
  resetShipmentToPending(shipmentId: number): void {
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET status = 'pending',
          tracking_number = NULL,
          tracking_url = NULL,
          label_url = NULL,
          label_cost_cents = NULL,
          label_purchased_at = NULL,
          shipped_at = NULL,
          delivered_at = NULL,
          carrier = NULL,
          service = NULL,
          easypost_rate_id = NULL,
          label_viewed_at = NULL,
          easypost_status_cached = NULL,
          easypost_status_cached_at = NULL,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(shipmentId);

    this.logger.info(
      { shipmentId },
      "Reset shipment to pending (post-refund)"
    );
  }

  /**
   * Cache EasyPost tracking status for refund eligibility checks.
   * Avoids repeated live API calls during eligibility verification.
   *
   * @param shipmentId - Internal shipment ID
   * @param status - EasyPost tracking status
   */
  cacheEasypostStatus(shipmentId: number, status: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET easypost_status_cached = ?,
          easypost_status_cached_at = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(status, now, shipmentId);
  }

  /**
   * Get cached EasyPost status for a shipment.
   *
   * @param shipmentId - Internal shipment ID
   * @returns Cached status and timestamp, or null if not cached
   */
  getEasypostStatusCache(shipmentId: number): { status: string; cachedAt: number } | null {
    const row = this.db.prepare(`
      SELECT easypost_status_cached, easypost_status_cached_at
      FROM marketplace_shipments
      WHERE id = ?
    `).get(shipmentId) as {
      easypost_status_cached: string | null;
      easypost_status_cached_at: number | null;
    } | undefined;

    if (!row || !row.easypost_status_cached || !row.easypost_status_cached_at) {
      return null;
    }

    return {
      status: row.easypost_status_cached,
      cachedAt: row.easypost_status_cached_at,
    };
  }

  // ============================================================================
  // Label Purchase Lock (Concurrency Control)
  // ============================================================================

  /**
   * Attempt to acquire label purchase lock for a shipment.
   * Returns object with status:
   * - { acquired: true } - lock acquired, proceed with EasyPost call
   * - { acquired: false, reason: 'already_purchased', shipment } - already has label
   * - { acquired: false, reason: 'in_progress' } - another request is processing
   *
   * Uses atomic SQL UPDATE with conditional WHERE clause to prevent race conditions.
   * Stale locks (>5 minutes old) are automatically recovered (crash protection).
   */
  acquireLabelPurchaseLock(
    shipmentId: number
  ): { acquired: true } | { acquired: false; reason: "already_purchased" | "in_progress"; shipment?: MarketplaceShipment } {
    const STALE_LOCK_THRESHOLD_SECONDS = 300; // 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const staleThreshold = now - STALE_LOCK_THRESHOLD_SECONDS;

    // Atomic conditional UPDATE: acquire lock if not already purchased AND
    // (not locked OR lock is stale)
    const result = this.db.prepare(`
      UPDATE marketplace_shipments
      SET label_purchase_in_progress = 1,
          label_purchase_locked_at = ?,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
        AND tracking_number IS NULL
        AND (
          label_purchase_in_progress = 0
          OR label_purchase_locked_at IS NULL
          OR label_purchase_locked_at < ?
        )
    `).run(now, shipmentId, staleThreshold);

    if (result.changes === 1) {
      // Lock acquired (possibly recovered from stale state)
      return { acquired: true as const };
    }

    // Lock not acquired - determine reason
    const shipment = this.getShipmentById(shipmentId);
    if (!shipment) {
      throw new Error("Shipment not found");
    }

    if (shipment.tracking_number) {
      return { acquired: false as const, reason: "already_purchased" as const, shipment };
    }

    // Lock held by another active request
    this.logger.debug(
      { shipmentId, lockedAt: shipment.label_purchase_locked_at },
      "Label purchase lock held by another request"
    );
    return { acquired: false as const, reason: "in_progress" as const };
  }

  /**
   * Release label purchase lock after EasyPost call completes (success or failure).
   * Clears both the lock flag and the timestamp.
   */
  releaseLabelPurchaseLock(shipmentId: number): void {
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET label_purchase_in_progress = 0,
          label_purchase_locked_at = NULL,
          updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(shipmentId);
  }

  // ============================================================================
  // Order Items (Pull Sheet)
  // ============================================================================

  /**
   * Upsert an order item (idempotent via UNIQUE constraint on source+external_order_id+item_key).
   *
   * ON CONFLICT behavior:
   * - marketplace_order_id: COALESCE to preserve existing FK if new value is NULL
   * - quantity: overwrite with new value (not additive, per Codex QA)
   * - unit_price_cents: COALESCE to preserve existing if new is NULL
   * - price_confidence: prefer 'exact' over other values
   */
  upsertOrderItem(input: UpsertOrderItemInput): void {
    this.statements.upsertOrderItem.run(
      input.marketplaceOrderId,
      input.source,
      input.externalOrderId,
      input.itemKey,
      input.tcgplayerSkuId,
      input.productName,
      input.setName,
      input.cardNumber,
      input.condition,
      input.rarity,
      input.productLine,
      input.setReleaseDate,
      input.quantity,
      input.unitPriceCents,
      input.priceConfidence,
      input.imageUrl,
      input.importBatchId
    );
  }

  /**
   * Get all items for a marketplace order (by FK).
   * Returns empty array if order has no items.
   */
  getItemsByOrderId(orderId: number): MarketplaceOrderItem[] {
    return this.statements.getItemsByOrderId.all(orderId) as MarketplaceOrderItem[];
  }

  /**
   * Get items by external order ID (for orders not yet in marketplace_orders).
   * Used when Pull Sheet arrives before Order List.
   */
  getItemsByExternalOrderId(
    source: "tcgplayer" | "ebay",
    externalOrderId: string
  ): MarketplaceOrderItem[] {
    return this.statements.getItemsByExternalOrderId.all(
      source,
      externalOrderId
    ) as MarketplaceOrderItem[];
  }

  /**
   * Attach unlinked items to an order (when order arrives after Pull Sheet).
   * Updates marketplace_order_id for items with NULL FK that match source+external_order_id.
   *
   * @returns Number of items attached
   */
  attachItemsToOrder(
    orderId: number,
    source: "tcgplayer" | "ebay",
    externalOrderId: string
  ): number {
    const result = this.statements.attachItemsToOrder.run(
      orderId,
      source,
      externalOrderId
    );
    if (result.changes > 0) {
      this.logger.info(
        { orderId, source, externalOrderId, itemsAttached: result.changes },
        "Attached Pull Sheet items to order"
      );
    }
    return result.changes;
  }

  // ============================================================================
  // Combined Shipment Support
  // ============================================================================

  /**
   * Validate that a shipment can be combined with a parent shipment.
   * Performs all integrity checks required before combining.
   *
   * @param childShipmentId - Shipment to be combined (child)
   * @param parentShipmentId - Shipment providing tracking (parent)
   * @returns Validation result with error details if invalid
   */
  validateCombine(childShipmentId: number, parentShipmentId: number): CombineValidationResult {
    // Check 1: Self-reference
    if (childShipmentId === parentShipmentId) {
      return { valid: false, error: "Cannot combine shipment with itself", errorCode: "SELF_REFERENCE" };
    }

    // Check 2: Child shipment exists and is pending
    const child = this.getShipmentById(childShipmentId);
    if (!child) {
      return { valid: false, error: "Child shipment not found", errorCode: "CHILD_NOT_FOUND" };
    }
    if (child.status !== "pending") {
      return { valid: false, error: `Child shipment status must be 'pending', got '${child.status}'`, errorCode: "INVALID_CHILD_STATUS" };
    }
    if (child.fulfilled_by_shipment_id) {
      return { valid: false, error: "Child shipment is already combined with another shipment", errorCode: "ALREADY_COMBINED" };
    }

    // Check 3: Parent shipment exists and has tracking
    const parent = this.getShipmentById(parentShipmentId);
    if (!parent) {
      return { valid: false, error: "Parent shipment not found", errorCode: "PARENT_NOT_FOUND" };
    }
    if (!parent.tracking_number) {
      return { valid: false, error: "Parent shipment has no tracking number", errorCode: "PARENT_NO_TRACKING" };
    }

    // Check 4: Parent is not itself a child
    if (parent.fulfilled_by_shipment_id) {
      return { valid: false, error: "Parent shipment is itself a child of another shipment", errorCode: "PARENT_IS_CHILD" };
    }

    // Check 5: Parent refund status check
    const refundBlockingStatuses = ["submitted", "refunded"];
    if (parent.refund_status && refundBlockingStatuses.includes(parent.refund_status)) {
      return { valid: false, error: `Parent shipment has refund status '${parent.refund_status}'`, errorCode: "PARENT_REFUND_BLOCKED" };
    }

    // Check 6: Get orders to verify same marketplace source and buyer
    const childOrder = this.getOrderById(child.marketplace_order_id);
    const parentOrder = this.getOrderById(parent.marketplace_order_id);
    if (!childOrder || !parentOrder) {
      return { valid: false, error: "Could not load order details", errorCode: "ORDER_NOT_FOUND" };
    }

    // Check 7: Same marketplace source
    if (childOrder.source !== parentOrder.source) {
      return { valid: false, error: `Source mismatch: child is '${childOrder.source}', parent is '${parentOrder.source}'`, errorCode: "SOURCE_MISMATCH" };
    }

    // Check 8: Same buyer (normalized name match)
    if (childOrder.customer_name_normalized !== parentOrder.customer_name_normalized) {
      return { valid: false, error: "Customer name does not match between orders", errorCode: "CUSTOMER_MISMATCH" };
    }

    // Address mismatch warning (not blocking)
    let addressMismatchWarning: string | undefined;
    if (child.shipping_zip && parent.shipping_zip && child.shipping_zip !== parent.shipping_zip) {
      addressMismatchWarning = `Shipping ZIP codes differ: child=${child.shipping_zip}, parent=${parent.shipping_zip}. Proceed with caution.`;
    }

    return { valid: true, addressMismatchWarning };
  }

  /**
   * Combine a child shipment with a parent shipment.
   * The child inherits tracking info and status from the parent.
   *
   * @param childShipmentId - Shipment to be combined
   * @param parentShipmentId - Shipment providing tracking
   * @param reason - Operator's reason for combining (min 5 chars)
   * @param operatorId - Operator performing the action
   * @returns Combined shipment info or error
   */
  combineShipment(
    childShipmentId: number,
    parentShipmentId: number,
    reason: string,
    operatorId: string
  ): {
    ok: true;
    childShipmentId: number;
    parentShipmentId: number;
    inheritedTracking: { trackingNumber: string; trackingUrl: string | null; carrier: string | null };
    addressMismatchWarning?: string;
  } | { ok: false; error: string; errorCode: string } {
    // Validate reason
    if (!reason || reason.trim().length < 5) {
      return { ok: false, error: "Reason must be at least 5 characters", errorCode: "REASON_TOO_SHORT" };
    }

    // Run validation
    const validation = this.validateCombine(childShipmentId, parentShipmentId);
    if (!validation.valid) {
      return { ok: false, error: validation.error!, errorCode: validation.errorCode! };
    }

    // Get parent shipment for data copy
    const parent = this.getShipmentById(parentShipmentId)!;
    const now = Math.floor(Date.now() / 1000);

    // Determine child status based on parent status
    let childStatus = parent.status;
    let shippedAt = parent.shipped_at;
    let deliveredAt = parent.delivered_at;

    // Copy tracking and status from parent to child
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET fulfilled_by_shipment_id = ?,
          tracking_number = ?,
          tracking_url = ?,
          carrier = ?,
          status = ?,
          shipped_at = ?,
          delivered_at = ?,
          combined_at = ?,
          combined_by = ?,
          combined_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      parentShipmentId,
      parent.tracking_number,
      parent.tracking_url,
      parent.carrier,
      childStatus,
      shippedAt,
      deliveredAt,
      now,
      operatorId,
      reason.trim(),
      now,
      childShipmentId
    );

    this.logger.info(
      {
        childShipmentId,
        parentShipmentId,
        trackingNumber: parent.tracking_number,
        operatorId,
        reason: reason.trim(),
      },
      "Combined shipment with parent"
    );

    return {
      ok: true,
      childShipmentId,
      parentShipmentId,
      inheritedTracking: {
        trackingNumber: parent.tracking_number!,
        trackingUrl: parent.tracking_url,
        carrier: parent.carrier,
      },
      addressMismatchWarning: validation.addressMismatchWarning,
    };
  }

  /**
   * Uncombine a child shipment from its parent.
   * Resets the child to pending status with no tracking.
   *
   * @param shipmentId - Child shipment to uncombine
   * @returns Success or error
   */
  uncombineShipment(shipmentId: number): { ok: true } | { ok: false; error: string; errorCode: string } {
    const shipment = this.getShipmentById(shipmentId);
    if (!shipment) {
      return { ok: false, error: "Shipment not found", errorCode: "NOT_FOUND" };
    }

    if (!shipment.fulfilled_by_shipment_id) {
      return { ok: false, error: "Shipment is not combined with another shipment", errorCode: "NOT_COMBINED" };
    }

    if (shipment.status === "delivered") {
      return { ok: false, error: "Cannot uncombine a delivered shipment", errorCode: "ALREADY_DELIVERED" };
    }

    const now = Math.floor(Date.now() / 1000);

    // Reset child shipment to pending, clear all inherited fields
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET fulfilled_by_shipment_id = NULL,
          tracking_number = NULL,
          tracking_url = NULL,
          carrier = NULL,
          status = 'pending',
          shipped_at = NULL,
          delivered_at = NULL,
          combined_at = NULL,
          combined_by = NULL,
          combined_reason = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, shipmentId);

    this.logger.info({ shipmentId }, "Uncombined shipment from parent");

    return { ok: true };
  }

  /**
   * Find eligible parent shipments for combining with a given child shipment.
   * Returns shipments from the same buyer within the last 7 days that have tracking.
   *
   * @param childShipmentId - The shipment looking for combine candidates
   * @returns List of eligible parent candidates
   */
  getCombineCandidates(childShipmentId: number): CombineCandidate[] {
    const childShipment = this.getShipmentById(childShipmentId);
    if (!childShipment) {
      return [];
    }

    const childOrder = this.getOrderById(childShipment.marketplace_order_id);
    if (!childOrder) {
      return [];
    }

    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

    // Find potential parent shipments:
    // - Same buyer (normalized name)
    // - Has tracking number
    // - Is NOT itself a child (fulfilled_by_shipment_id IS NULL)
    // - refund_status is NULL or 'rejected' (not 'submitted' or 'refunded')
    // - Order date within last 7 days
    // - Not the same shipment as child
    const candidates = this.db.prepare(`
      SELECT
        ms.id as shipmentId,
        mo.display_order_number as orderNumber,
        mo.external_order_id as externalOrderId,
        mo.customer_name as customerName,
        ms.tracking_number as trackingNumber,
        ms.tracking_url as trackingUrl,
        ms.carrier,
        ms.status,
        ms.shipped_at as shippedAt,
        mo.order_date as orderDate,
        ms.shipping_zip as shippingZip,
        mo.item_count as itemCount
      FROM marketplace_shipments ms
      JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
      WHERE mo.customer_name_normalized = ?
        AND mo.source = ?
        AND ms.tracking_number IS NOT NULL
        AND ms.fulfilled_by_shipment_id IS NULL
        AND (ms.refund_status IS NULL OR ms.refund_status = 'rejected')
        AND mo.order_date >= ?
        AND ms.id != ?
      ORDER BY mo.order_date DESC
      LIMIT 20
    `).all(
      childOrder.customer_name_normalized,
      childOrder.source,
      sevenDaysAgo,
      childShipmentId
    ) as CombineCandidate[];

    return candidates;
  }

  /**
   * Update child shipments when parent status changes.
   * Propagates status, timestamps, and tracking info to all children.
   *
   * @param parentShipmentId - The parent shipment that was updated
   */
  updateChildShipmentsStatus(parentShipmentId: number): void {
    const parent = this.getShipmentById(parentShipmentId);
    if (!parent) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // Update all child shipments to match parent status
    const result = this.db.prepare(`
      UPDATE marketplace_shipments
      SET status = ?,
          shipped_at = CASE WHEN ? IN ('shipped', 'in_transit', 'delivered') THEN COALESCE(shipped_at, ?) ELSE shipped_at END,
          delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
          tracking_number = ?,
          tracking_url = ?,
          carrier = ?,
          updated_at = ?
      WHERE fulfilled_by_shipment_id = ?
    `).run(
      parent.status,
      parent.status, parent.shipped_at,
      parent.status, parent.delivered_at,
      parent.tracking_number,
      parent.tracking_url,
      parent.carrier,
      now,
      parentShipmentId
    );

    if (result.changes > 0) {
      this.logger.info(
        { parentShipmentId, childrenUpdated: result.changes, newStatus: parent.status },
        "Propagated status to child shipments"
      );
    }
  }

  /**
   * Get child shipments for a parent.
   *
   * @param parentShipmentId - The parent shipment ID
   * @returns List of child shipments
   */
  getChildShipments(parentShipmentId: number): MarketplaceShipment[] {
    return this.db.prepare(`
      SELECT * FROM marketplace_shipments
      WHERE fulfilled_by_shipment_id = ?
    `).all(parentShipmentId) as MarketplaceShipment[];
  }

  /**
   * Check if a tracking number already exists on another shipment.
   * Used for duplicate detection when manually entering tracking.
   *
   * @param trackingNumber - Tracking number to check
   * @param excludeShipmentId - Shipment ID to exclude from check (the one being updated)
   * @returns Existing shipment info if duplicate found
   */
  findExistingTrackingShipment(
    trackingNumber: string,
    excludeShipmentId: number
  ): { shipmentId: number; orderNumber: string } | null {
    const normalized = normalizeTrackingNumber(trackingNumber);

    const row = this.db.prepare(`
      SELECT ms.id, mo.display_order_number, mo.external_order_id, mo.source
      FROM marketplace_shipments ms
      JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
      WHERE (ms.tracking_number = ? OR REPLACE(REPLACE(ms.tracking_number, '-', ''), ' ', '') = ?)
        AND ms.id != ?
        AND ms.fulfilled_by_shipment_id IS NULL
      LIMIT 1
    `).get(trackingNumber, normalized, excludeShipmentId) as {
      id: number;
      display_order_number: string;
      external_order_id: string;
      source: string;
    } | undefined;

    if (!row) {
      return null;
    }

    // Format order number for TCGPlayer
    const orderNumber = row.source === "tcgplayer"
      ? formatTcgplayerOrderNumber(row.external_order_id)
      : row.display_order_number;

    return { shipmentId: row.id, orderNumber };
  }

  /**
   * Update shipment tracking manually (with duplicate detection).
   *
   * @param shipmentId - Shipment to update
   * @param trackingNumber - New tracking number
   * @param carrier - Optional carrier name
   * @returns Success with optional duplicate warning
   */
  updateShipmentTrackingManual(
    shipmentId: number,
    trackingNumber: string,
    carrier?: string
  ): {
    ok: true;
    duplicateDetected?: { existingShipmentId: number; existingOrderNumber: string; suggestCombine: boolean };
  } | { ok: false; error: string; errorCode: string } {
    const shipment = this.getShipmentById(shipmentId);
    if (!shipment) {
      return { ok: false, error: "Shipment not found", errorCode: "NOT_FOUND" };
    }

    // Check for duplicate tracking
    const existing = this.findExistingTrackingShipment(trackingNumber, shipmentId);

    // Generate tracking URL
    const trackingUrl = this.generateTrackingUrl(trackingNumber, carrier ?? null);

    const now = Math.floor(Date.now() / 1000);

    // Update the shipment
    this.db.prepare(`
      UPDATE marketplace_shipments
      SET tracking_number = ?,
          tracking_url = ?,
          carrier = COALESCE(?, carrier),
          status = CASE WHEN status = 'pending' THEN 'shipped' ELSE status END,
          shipped_at = CASE WHEN status = 'pending' THEN ? ELSE shipped_at END,
          updated_at = ?
      WHERE id = ?
    `).run(
      trackingNumber,
      trackingUrl,
      carrier ?? null,
      now,
      now,
      shipmentId
    );

    // Propagate tracking info to any child shipments (combined shipment support)
    this.updateChildShipmentsStatus(shipmentId);

    this.logger.info(
      { shipmentId, trackingNumber, carrier, hasDuplicate: !!existing },
      "Manual tracking number updated"
    );

    if (existing) {
      return {
        ok: true,
        duplicateDetected: {
          existingShipmentId: existing.shipmentId,
          existingOrderNumber: existing.orderNumber,
          suggestCombine: true,
        },
      };
    }

    return { ok: true };
  }
}

const USPS_NUMERIC_TRACKING_REGEX = /^9\\d{20,24}$/;
const USPS_ALPHA_TRACKING_REGEX = /^[A-Z]{2}\\d{9}US$/i;

function isUnknownStatus(status?: string | null): boolean {
  return !status || status.toLowerCase() === "unknown";
}

function isLikelyUspsTrackingNumber(trackingNumber: string): boolean {
  const normalized = normalizeTrackingNumber(trackingNumber).toUpperCase();
  return USPS_NUMERIC_TRACKING_REGEX.test(normalized) || USPS_ALPHA_TRACKING_REGEX.test(normalized);
}

function isUspsCarrier(tracking: UnmatchedTracking): boolean {
  const carrier = tracking.carrier?.toLowerCase() || "";
  return carrier.includes("usps") || isLikelyUspsTrackingNumber(tracking.tracking_number);
}

function normalizeTrackingNumber(trackingNumber: string): string {
  return trackingNumber.replace(/[\\s-]+/g, "");
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const max = Math.max(1, limit);
  let index = 0;
  const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) {
        return;
      }
      await worker(items[current]);
    }
  });

  await Promise.all(runners);
}
