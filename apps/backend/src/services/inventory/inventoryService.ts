/**
 * Inventory Service (Phase 2.3)
 * Purpose: Manage products, items, and scan deduplication logic
 * Reference: docs/MANIFEST_SKU_BEHAVIOR_ANALYSIS.md Phase 2 implementation plan
 * Date: 2025-10-24
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { randomUUID, createHash } from "node:crypto";
import type { SKUCanonicalizer, ConditionBucket, SKUResult } from "./skuHelpers";
import { generateProductSlug } from "../slugGenerator";
import { MINIMUM_LISTING_PRICE } from "../pricing/types";

/**
 * Deduplication decision result
 */
export interface DedupDecision {
  action: "attach" | "mint_new" | "fallback_pending";
  item_uid: string | null;
  product_uid: string | null;
  reason: string;
  scan_fingerprint_collision: boolean;
  similarity_score?: number;
}

/**
 * Scan metadata for deduplication and inventory tracking
 */
export interface ScanMetadata {
  scan_id: string;
  capture_session_id: string | null;
  processed_image_path: string;
  raw_image_path: string | null;
  capture_uid: string | null;
}

/**
 * Inventory Service manages products, items, and scan deduplication
 */
export class InventoryService {
  constructor(
    private readonly db: Database,
    private readonly skuHelper: SKUCanonicalizer,
    private readonly logger: Logger
  ) {}

  /**
   * Main entry point: Deduplicate scan and attach to existing item or mint new one.
   *
   * Strategy (Phase 2.3):
   * 1. Generate scan_fingerprint (SHA256 of normalized crop) - STUB for now
   * 2. Check for exact duplicate via scan_fingerprint UNIQUE constraint
   * 3. If no exact match, run similarity heuristics (pHash/ORB + session/pose proximity)
   * 4. Decide: attach to existing item_uid OR mint new item
   * 5. Upsert products table (ensure product exists for this SKU)
   * 6. Insert/update items table
   * 7. Update scans table with item_uid, product_sku, listing_sku, cm_card_id
   *
   * @param extracted - Extracted card data from inference
   * @param scanMeta - Scan metadata (scan_id, paths, session)
   * @param condition - Condition bucket (defaults to UNKNOWN)
   * @returns DedupDecision with item_uid, product_uid, and action taken
   */
  async dedupAttachOrMint(
    extracted: Record<string, unknown>,
    scanMeta: ScanMetadata,
    condition: ConditionBucket = "UNKNOWN"
  ): Promise<DedupDecision> {
    const now = Math.floor(Date.now() / 1000);

    try {
      // Step 1: Generate product_uid first (needed for unique SKU suffix)
      const product_uid = randomUUID();

      // Step 2: Canonicalize to CardMint ID and compute SKUs (pass product_uid for unique suffix)
      const skuResult = this.skuHelper.canonicalize(extracted, condition, product_uid);

      // Step 3: Generate scan_fingerprint (STUB - actual implementation Phase 4)
      // For now, use a placeholder to avoid blocking Phase 2 progress
      const scan_fingerprint = this.generateScanFingerprint(scanMeta.processed_image_path);

      // Step 4: Check for exact duplicate via scan_fingerprint
      const existingScan = this.findScanByFingerprint(scan_fingerprint);
      if (existingScan) {
        this.logger.warn(
          { scan_id: scanMeta.scan_id, existing_scan_id: existingScan.id, scan_fingerprint },
          "Exact duplicate scan detected via fingerprint; blocking resubmit"
        );

        // Attach to existing item (resubmit prevention)
        return {
          action: "attach",
          item_uid: existingScan.item_uid,
          product_uid: existingScan.product_uid ?? null,
          reason: "exact_fingerprint_match",
          scan_fingerprint_collision: true,
        };
      }

      // Step 5: Run similarity heuristics (STUB - actual implementation Phase 4)
      // For now, always mint new items (no similarity matching in Phase 2)
      // TODO: Implement similarity search in Phase 4

      // Mint new item (no duplicates found - similarity matching deferred to Phase 4)
      // Relaxed canonical lock (Nov 21): Allow inventory creation even without cm_card_id match
      // Set accepted_without_canonical flag for reconciliation tracking
      if (!skuResult.cm_card_id) {
        this.logger.warn(
          {
            scan_id: scanMeta.scan_id,
            canonical_sku: skuResult.canonical_sku,
            product_sku: skuResult.product_sku,
            reason: "no_canonical_match",
          },
          "Creating inventory without canonical match - will use fallback SKU and mark for reconciliation"
        );
      }

      const item_uid = randomUUID();
      // product_uid already generated above (needed for SKU suffix)
      this.upsertProduct(product_uid, skuResult, extracted, condition, now);

      this.insertItem(item_uid, product_uid, scanMeta.capture_session_id, now);

      const decision: DedupDecision = {
        action: "mint_new",
        item_uid,
        product_uid,
        reason: "no_duplicates_found",
        scan_fingerprint_collision: false,
      };

      // Step 6: Update scans table with inventory linkage
      this.updateScanInventory(
        scanMeta.scan_id,
        decision.item_uid,
        decision.product_uid,
        skuResult,
        scan_fingerprint,
        scanMeta
      );

      this.logger.info(
        {
          scan_id: scanMeta.scan_id,
          action: decision.action,
          item_uid: decision.item_uid,
          product_uid: decision.product_uid,
          canonical_sku: skuResult.canonical_sku,
          product_sku: skuResult.product_sku,
          listing_sku: skuResult.listing_sku,
          confidence: skuResult.confidence,
        },
        "Deduplication complete"
      );

      return decision;
    } catch (error) {
      this.logger.error(
        { err: error, scan_id: scanMeta.scan_id },
        "Deduplication failed; cannot populate inventory"
      );
      throw error;
    }
  }

  /**
   * Generate scan_fingerprint (SHA256 of normalized crop).
   * STUB: Phase 2 placeholder - actual implementation in Phase 4.
   *
   * Real implementation will:
   * 1. Load image from processed_image_path
   * 2. Convert to grayscale
   * 3. Resize to 1024px long-edge
   * 4. Compute SHA256 hash of pixel data
   */
  private generateScanFingerprint(processed_image_path: string): string {
    // STUB: Use image path hash as placeholder
    // Real implementation: createHash('sha256').update(normalized_pixels).digest('hex')
    const placeholder = createHash("sha256")
      .update(processed_image_path)
      .digest("hex");

    return `STUB_${placeholder.substring(0, 16)}`;
  }

  /**
   * Find existing scan by fingerprint.
   * Returns null if no match found.
   */
  private findScanByFingerprint(scan_fingerprint: string): ExistingScan | null {
    const stmt = this.db.prepare(`
      SELECT id, item_uid, product_sku, listing_sku
      FROM scans
      WHERE scan_fingerprint = ?
      LIMIT 1
    `);

    const result = stmt.get(scan_fingerprint) as ExistingScan | undefined;

    if (result) {
      // Lookup product_uid from product_sku
      const productStmt = this.db.prepare(`
        SELECT product_uid FROM products WHERE product_sku = ? LIMIT 1
      `);
      const product = productStmt.get(result.product_sku) as { product_uid: string } | undefined;

      if (product) {
        result.product_uid = product.product_uid;
      } else {
        result.product_uid = null;
      }
    }

    return result || null;
  }

  /**
   * Create new product for this scan (strict 1:1 mapping).
   * Each scan gets its own unique product_uid and product_sku (with UID suffix), even for identical cards.
   * This enforces CardMint's WYSIWYG promise: buyer sees exact card they're purchasing.
   */
  private upsertProduct(
    product_uid: string,
    skuResult: SKUResult,
    extracted: Record<string, unknown>,
    condition: ConditionBucket,
    now: number
  ): void {
    // Always create new product (strict 1:1 scan → item → product_uid mapping)
    // Product pooling is intentionally disabled per operator-expectations.md §2
    // product_uid passed in from caller (needed for unique SKU suffix)
    const card_name = (extracted.card_name as string) || "Unknown Card";
    const hp_value = (extracted.hp_value as number) || null;

    // Extract set info: Operator's Truth Core corrections take priority over canonical DB
    // This ensures HITL edits persist to the products table (Dec 8, 2025 fix)
    let set_name = (extracted.set_name as string) || "Unknown Set";
    let collector_no = (extracted.set_number as string) || "UNK";

    // Only fall back to canonical DB if operator didn't provide values
    if (skuResult.cm_card_id && (set_name === "Unknown Set" || collector_no === "UNK")) {
      const cardStmt = this.db.prepare(`
        SELECT c.collector_no, s.set_name
        FROM cm_cards c
        JOIN cm_sets s ON c.cm_set_id = s.cm_set_id
        WHERE c.cm_card_id = ?
      `);
      const cardInfo = cardStmt.get(skuResult.cm_card_id) as
        | { collector_no: string; set_name: string }
        | undefined;

      if (cardInfo) {
        if (set_name === "Unknown Set") set_name = cardInfo.set_name;
        if (collector_no === "UNK") collector_no = cardInfo.collector_no;
      }
    }

    // Generate deterministic product slug (UID-based for uniqueness)
    const product_slug = generateProductSlug(card_name, set_name, collector_no, product_uid);

    // Dec 8, 2025: Extract variant_tags for persistence to products table
    const variant_tags = Array.isArray(extracted.variant_tags)
      ? JSON.stringify(extracted.variant_tags)
      : null;

    const insertStmt = this.db.prepare(`
      INSERT INTO products (
        product_uid, cm_card_id, condition_bucket, canonical_sku, product_sku, listing_sku,
        card_name, set_name, collector_no, hp_value,
        market_price, launch_price, pricing_channel, total_quantity,
        notes, product_slug, accepted_without_canonical, variant_tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      product_uid,
      skuResult.cm_card_id,
      condition,
      skuResult.canonical_sku,
      skuResult.product_sku,
      skuResult.listing_sku,
      card_name,
      set_name,
      collector_no,
      hp_value,
      null, // market_price - TODO: Populate from PriceCharting in Phase 3
      null, // launch_price - TODO: Compute from market_price * markup
      this.determinePricingChannel(condition),
      0, // total_quantity - will be updated by triggers
      `Auto-generated from scan (confidence: ${skuResult.confidence})`,
      product_slug,
      skuResult.cm_card_id ? 0 : 1, // accepted_without_canonical: 1 if no cm_card_id
      variant_tags, // Dec 8, 2025: HITL variant tags
      now,
      now
    );

    this.logger.debug(
      {
        product_uid,
        canonical_sku: skuResult.canonical_sku,
        product_sku: skuResult.product_sku,
        product_slug,
        condition,
      },
      "Created new product"
    );
  }

  /**
   * Insert new item into inventory.
   */
  private insertItem(
    item_uid: string,
    product_uid: string,
    capture_session_id: string | null,
    now: number
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO items (
        item_uid, product_uid, quantity, acquisition_date, acquisition_source,
        capture_session_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item_uid,
      product_uid,
      1, // quantity
      now, // acquisition_date
      "scan", // acquisition_source
      capture_session_id,
      "IN_STOCK", // status
      now,
      now
    );

    this.logger.debug({ item_uid, product_uid }, "Created new item");
  }

  /**
   * Update scans table with inventory linkage and SKU data.
   */
  private updateScanInventory(
    scan_id: string,
    item_uid: string | null,
    product_uid: string | null,
    skuResult: SKUResult,
    scan_fingerprint: string,
    scanMeta: ScanMetadata
  ): void {
    const stmt = this.db.prepare(`
      UPDATE scans
      SET
        item_uid = ?,
        scan_fingerprint = ?,
        product_sku = ?,
        listing_sku = ?,
        cm_card_id = ?,
        processed_image_path = ?,
        raw_image_path = ?,
        capture_uid = ?
      WHERE id = ?
    `);

    stmt.run(
      item_uid,
      scan_fingerprint,
      skuResult.product_sku,
      skuResult.listing_sku,
      skuResult.cm_card_id,
      scanMeta.processed_image_path,
      scanMeta.raw_image_path,
      scanMeta.capture_uid,
      scan_id
    );

    this.logger.debug(
      {
        scan_id,
        item_uid,
        product_uid,
        canonical_sku: skuResult.canonical_sku,
        product_sku: skuResult.product_sku,
      },
      "Updated scan inventory linkage"
    );
  }

  /**
   * Determine pricing channel based on condition bucket.
   * Reference: MANIFEST_SKU_BEHAVIOR_ANALYSIS.md lines 309-312
   */
  private determinePricingChannel(condition: ConditionBucket): string {
    // NM/LP → graded/blended channel
    if (condition === "NM" || condition === "LP") {
      return "blended";
    }

    // MP/HP/UNKNOWN/NO_CONDITION → raw/ungraded channel
    return "raw";
  }

  // ============================================================================
  // Stripe Payment Integration Methods (Dec 2025)
  // ============================================================================

  /**
   * Get item data for Stripe checkout creation
   * Returns null if item doesn't exist or isn't in valid state
   */
  getItemForCheckout(itemUid: string): ItemCheckoutData | null {
    const stmt = this.db.prepare(`
      SELECT
        i.item_uid,
        i.product_uid,
        i.status,
        i.stripe_product_id,
        i.stripe_price_id,
        p.cm_card_id,
        p.card_name,
        p.set_name,
        p.collector_no,
        p.condition_bucket,
        p.canonical_sku,
        p.launch_price,
        p.cdn_image_url,
        p.staging_ready
      FROM items i
      JOIN products p ON i.product_uid = p.product_uid
      WHERE i.item_uid = ?
    `);

    const row = stmt.get(itemUid) as ItemCheckoutRow | undefined;
    if (!row) return null;

    return {
      item_uid: row.item_uid,
      product_uid: row.product_uid,
      status: row.status,
      stripe_product_id: row.stripe_product_id,
      stripe_price_id: row.stripe_price_id,
      cm_card_id: row.cm_card_id,
      name: row.card_name ?? "Unknown Card",
      set_name: row.set_name,
      collector_no: row.collector_no,
      condition: row.condition_bucket,
      canonical_sku: row.canonical_sku,
      price_cents: Math.round(Math.max(row.launch_price ?? 0, MINIMUM_LISTING_PRICE) * 100),
      image_url: row.cdn_image_url,
      staging_ready: row.staging_ready === 1,
    };
  }

  /**
   * Reserve item for checkout (transactional)
   * Sets status=RESERVED, checkout_session_id, reserved_until
   * Returns false if item is not IN_STOCK
   */
  reserveItem(
    itemUid: string,
    checkoutSessionId: string,
    stripeProductId: string,
    stripePriceId: string,
    reservedUntil: number
  ): boolean {
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE items
         SET status = 'RESERVED',
             checkout_session_id = ?,
             stripe_product_id = ?,
             stripe_price_id = ?,
             reserved_until = ?,
             updated_at = ?
         WHERE item_uid = ? AND status = 'IN_STOCK'`
      )
      .run(checkoutSessionId, stripeProductId, stripePriceId, reservedUntil, now, itemUid);

    if (result.changes === 0) {
      this.logger.warn({ itemUid }, "Failed to reserve item - not IN_STOCK");
      return false;
    }

    this.logger.info({ itemUid, checkoutSessionId, reservedUntil }, "Item reserved for checkout");
    return true;
  }

  /**
   * Mark item as sold after successful payment
   * Sets status=SOLD, payment_intent_id, sold_at
   * Returns false if item is not RESERVED
   */
  markItemSold(itemUid: string, paymentIntentId: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE items
         SET status = 'SOLD',
             payment_intent_id = ?,
             sold_at = ?,
             reserved_until = NULL,
             updated_at = ?
         WHERE item_uid = ? AND status = 'RESERVED'`
      )
      .run(paymentIntentId, now, now, itemUid);

    if (result.changes === 0) {
      this.logger.warn({ itemUid }, "Failed to mark item sold - not RESERVED");
      return false;
    }

    this.logger.info({ itemUid, paymentIntentId }, "Item marked as sold");
    return true;
  }

  /**
   * Release reservation back to IN_STOCK
   * Used when checkout session expires or is cancelled
   * Returns false if item is not RESERVED
   */
  releaseReservation(itemUid: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE items
         SET status = 'IN_STOCK',
             checkout_session_id = NULL,
             reserved_until = NULL,
             updated_at = ?
         WHERE item_uid = ? AND status = 'RESERVED'`
      )
      .run(now, itemUid);

    if (result.changes === 0) {
      this.logger.warn({ itemUid }, "Failed to release reservation - not RESERVED");
      return false;
    }

    this.logger.info({ itemUid }, "Item reservation released");
    return true;
  }

  /**
   * Find items with overdue reservations
   * For background expiry job to expire sessions and release items
   */
  findOverdueReservations(): OverdueReservation[] {
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      SELECT item_uid, checkout_session_id, reserved_until
      FROM items
      WHERE status = 'RESERVED'
        AND reserved_until IS NOT NULL
        AND reserved_until < ?
    `);

    return stmt.all(now) as OverdueReservation[];
  }

  /**
   * Update Stripe IDs on item (for sync/regenerate operations)
   */
  updateStripeIds(itemUid: string, stripeProductId: string, stripePriceId: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE items
         SET stripe_product_id = ?,
             stripe_price_id = ?,
             updated_at = ?
         WHERE item_uid = ?`
      )
      .run(stripeProductId, stripePriceId, now, itemUid);

    return result.changes > 0;
  }

  /**
   * Get item by checkout session ID (for webhook handling)
   */
  getItemByCheckoutSession(checkoutSessionId: string): { item_uid: string; status: string } | null {
    const stmt = this.db.prepare(`
      SELECT item_uid, status
      FROM items
      WHERE checkout_session_id = ?
    `);

    return (stmt.get(checkoutSessionId) as { item_uid: string; status: string } | undefined) ?? null;
  }

  /**
   * Get item by payment intent ID (for refund webhook handling)
   */
  getItemByPaymentIntent(paymentIntentId: string): { item_uid: string; status: string; stripe_product_id: string | null; stripe_price_id: string | null } | null {
    const stmt = this.db.prepare(`
      SELECT item_uid, status, stripe_product_id, stripe_price_id
      FROM items
      WHERE payment_intent_id = ?
    `);

    return (stmt.get(paymentIntentId) as { item_uid: string; status: string; stripe_product_id: string | null; stripe_price_id: string | null } | undefined) ?? null;
  }

  /**
   * Get an available IN_STOCK item for a product
   * Used when checkout is initiated by product_uid instead of item_uid
   * Returns null if no available items exist
   */
  getAvailableItemForProduct(productUid: string): string | null {
    const stmt = this.db.prepare(`
      SELECT item_uid
      FROM items
      WHERE product_uid = ?
        AND status = 'IN_STOCK'
      ORDER BY created_at ASC
      LIMIT 1
    `);

    const row = stmt.get(productUid) as { item_uid: string } | undefined;
    return row?.item_uid ?? null;
  }

  /**
   * Restore item from SOLD back to IN_STOCK after refund
   * Clears payment_intent_id but preserves Stripe product/price IDs for re-listing
   * Returns false if item is not SOLD
   */
  restoreItemFromRefund(itemUid: string): boolean {
    const now = Math.floor(Date.now() / 1000);

    const result = this.db
      .prepare(
        `UPDATE items
         SET status = 'IN_STOCK',
             payment_intent_id = NULL,
             sold_at = NULL,
             sold_price = NULL,
             checkout_session_id = NULL,
             updated_at = ?
         WHERE item_uid = ? AND status = 'SOLD'`
      )
      .run(now, itemUid);

    if (result.changes === 0) {
      this.logger.warn({ itemUid }, "Failed to restore item from refund - not SOLD");
      return false;
    }

    this.logger.info({ itemUid }, "Item restored to IN_STOCK after refund");
    return true;
  }
}

/**
 * Internal type for existing scan lookup
 */
interface ExistingScan {
  id: string;
  item_uid: string;
  product_sku: string;
  listing_sku: string;
  product_uid: string | null;
}

/**
 * Item data for checkout creation
 */
export interface ItemCheckoutData {
  item_uid: string;
  product_uid: string;
  status: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  cm_card_id: string | null;
  name: string;
  set_name: string | null;
  collector_no: string | null;
  condition: string | null;
  canonical_sku: string | null;
  price_cents: number;
  image_url: string | null;
  staging_ready: boolean;
}

interface ItemCheckoutRow {
  item_uid: string;
  product_uid: string;
  status: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  cm_card_id: string | null;
  card_name: string | null;
  set_name: string | null;
  collector_no: string | null;
  condition_bucket: string | null;
  canonical_sku: string | null;
  launch_price: number | null;
  cdn_image_url: string | null;
  staging_ready: number | null;
}

export interface OverdueReservation {
  item_uid: string;
  checkout_session_id: string;
  reserved_until: number;
}

/**
 * Internal type for existing scan lookup
 */
interface ExistingScan {
  id: string;
  item_uid: string;
  product_sku: string;
  listing_sku: string;
  product_uid: string | null; // Populated via join when available
}
