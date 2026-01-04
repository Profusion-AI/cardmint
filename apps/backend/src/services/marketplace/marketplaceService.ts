/**
 * MarketplaceService: CRUD operations for marketplace fulfillment tables
 *
 * Handles TCGPlayer/eBay orders separately from Stripe-keyed orders.
 * Supports 1:N order-to-shipment relationships and encrypted address storage.
 */

import type { Database, Statement } from "better-sqlite3";
import type { Logger } from "pino";
import { encryptJson, decryptJson } from "../../utils/encryption";

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
}

export interface ListOrdersOptions {
  source?: "tcgplayer" | "ebay" | "all";
  status?: MarketplaceOrder["status"];
  limit?: number;
  offset?: number;
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
    insertShipment: Statement;
    getShipmentsByOrderId: Statement;
    getShipmentById: Statement;
    updateShipmentTracking: Statement;
    updateShipmentStatus: Statement;
    updateShipmentLabel: Statement;
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
  };

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child({ service: "MarketplaceService" });
    this.statements = this.prepareStatements();
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
          shipping_method, import_batch_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

      insertShipment: this.db.prepare(`
        INSERT INTO marketplace_shipments (
          marketplace_order_id, shipment_sequence, shipping_address_encrypted, shipping_zip, address_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `),

      getShipmentsByOrderId: this.db.prepare(`
        SELECT * FROM marketplace_shipments WHERE marketplace_order_id = ? ORDER BY shipment_sequence
      `),

      getShipmentById: this.db.prepare(`
        SELECT * FROM marketplace_shipments WHERE id = ?
      `),

      updateShipmentTracking: this.db.prepare(`
        UPDATE marketplace_shipments
        SET tracking_number = ?, tracking_url = ?, carrier = ?,
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
   * Normalize customer name for matching (uppercase, trim, remove extra whitespace)
   */
  normalizeCustomerName(name: string): string {
    return name.toUpperCase().trim().replace(/\s+/g, " ");
  }

  /**
   * Generate a display order number: TCG-YYYYMMDD-NNNNNN or EBAY-YYYYMMDD-NNNNNN
   */
  generateDisplayOrderNumber(source: "tcgplayer" | "ebay", orderDate: number): string {
    const prefix = source === "tcgplayer" ? "TCG" : "EBAY";
    const date = new Date(orderDate * 1000);
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, "");
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
        input.import_batch_id ?? null
      );

      const orderId = orderResult.lastInsertRowid as number;

      // Create initial shipment
      const shipmentResult = this.statements.insertShipment.run(
        orderId,
        1, // sequence
        encryptedAddress,
        shippingZip,
        addressExpiresAt
      );

      const shipmentId = shipmentResult.lastInsertRowid as number;

      return { orderId, shipmentId };
    })();

    this.logger.info(
      { orderId: result.orderId, displayOrderNumber, source: input.source },
      "Created marketplace order"
    );

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
    confidence: "auto" | "manual",
    matchedBy: string
  ): void {
    this.statements.updateShipmentTracking.run(
      trackingNumber,
      trackingUrl,
      carrier,
      confidence,
      Math.floor(Date.now() / 1000),
      matchedBy,
      shipmentId
    );
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
    const normalizedSignedBy = signedBy ? this.normalizeCustomerName(signedBy) : null;
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
   * Find potential matches for unmatched tracking by customer name
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
}
