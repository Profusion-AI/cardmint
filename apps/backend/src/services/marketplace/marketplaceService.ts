/**
 * MarketplaceService: CRUD operations for marketplace fulfillment tables
 *
 * Handles TCGPlayer/eBay orders separately from Stripe-keyed orders.
 * Supports 1:N order-to-shipment relationships and encrypted address storage.
 */

import type { Database, Statement } from "better-sqlite3";
import type { Logger } from "pino";
import { encryptJson, decryptJson } from "../../utils/encryption";
import { normalizeNameForMatching } from "../../utils/nameNormalization.js";
import { parseTcgplayerOrderNumber } from "../../utils/orderNumberFormat.js";

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
  // Concurrency lock for label purchase
  label_purchase_in_progress: number;
  label_purchase_locked_at: number | null;
  created_at: number;
  updated_at: number;
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
    updateShipmentAddressIfMissing: Statement;
    setAddressExpiry: Statement;
    purgeExpiredAddresses: Statement;
    insertUnmatchedTracking: Statement;
    listUnmatchedTracking: Statement;
    resolveUnmatchedTracking: Statement;
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
        SELECT * FROM unmatched_tracking WHERE resolution_status = 'pending' ORDER BY created_at DESC LIMIT ? OFFSET ?
      `),

      resolveUnmatchedTracking: this.db.prepare(`
        UPDATE unmatched_tracking
        SET resolution_status = ?, matched_to_shipment_id = ?, resolved_by = ?, resolved_at = strftime('%s', 'now')
        WHERE id = ?
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
   * Returns null for unknown carriers to avoid incorrect URLs.
   */
  generateTrackingUrl(trackingNumber: string, carrier: string | null): string | null {
    if (!trackingNumber || !carrier) return null;

    const carrierLower = carrier.toLowerCase();

    // USPS
    if (carrierLower === "usps" || carrierLower.includes("usps")) {
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    }

    // UPS
    if (carrierLower === "ups" || carrierLower.includes("ups")) {
      return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    }

    // FedEx
    if (carrierLower === "fedex" || carrierLower.includes("fedex")) {
      return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
    }

    // DHL
    if (carrierLower === "dhl" || carrierLower.includes("dhl")) {
      return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
    }

    // Unknown carrier - return null to avoid incorrect URL
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
      if (tracking.easypost_status) {
        const statusMap: Record<string, MarketplaceShipment["status"]> = {
          delivered: "delivered",
          in_transit: "in_transit",
          pre_transit: "shipped",
          out_for_delivery: "in_transit",
        };
        const newStatus = statusMap[tracking.easypost_status.toLowerCase()];
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
      SELECT COUNT(*) as count FROM marketplace_shipments
      WHERE status = 'pending' AND is_external = 0
    `).get() as { count: number };

    // CardMint pending labels (awaiting label action)
    const cardmintPending = this.db.prepare(`
      SELECT COUNT(*) as count FROM fulfillment
      WHERE status IN ('pending', 'reviewed')
    `).get() as { count: number };

    // Unmatched tracking count (marketplace only - no CardMint equivalent)
    const unmatchedCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM unmatched_tracking
      WHERE resolution_status = 'pending'
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
}
