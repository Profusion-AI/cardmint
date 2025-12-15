/**
 * Inventory Override Service (Phase 3)
 * Purpose: Provide manual override endpoints for operator dedup corrections
 * Reference: docs/tasks/manifest-inventory-overhaul.md Phase 3
 * Date: 2025-10-24
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";

/**
 * Result of an inventory override operation
 */
export interface OverrideResult {
  success: boolean;
  affected_items: string[];
  affected_scans: string[];
  message: string;
}

/**
 * InventoryOverrideService handles operator-driven inventory corrections
 */
export class InventoryOverrideService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /**
   * Attach a scan to an existing item (operator override for dedup decision)
   *
   * @param item_uid - Target item to attach scan to
   * @param scan_id - Scan to reattach
   * @returns OverrideResult with affected entities
   */
  attachScanToItem(item_uid: string, scan_id: string): OverrideResult {
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = this.db.transaction(() => {
        // Validate item exists and fetch product info
        const item = this.db
          .prepare(`SELECT item_uid, product_uid FROM items WHERE item_uid = ?`)
          .get(item_uid) as { item_uid: string; product_uid: string } | undefined;

        if (!item) {
          throw new Error(`Item ${item_uid} not found`);
        }

        // Fetch product SKU data to sync with scan
        const product = this.db
          .prepare(`
            SELECT product_sku, listing_sku, cm_card_id
            FROM products
            WHERE product_uid = ?
          `)
          .get(item.product_uid) as {
            product_sku: string;
            listing_sku: string;
            cm_card_id: string;
          } | undefined;

        if (!product) {
          throw new Error(`Product ${item.product_uid} not found`);
        }

        // Validate scan exists
        const scan = this.db
          .prepare(`SELECT id, item_uid, product_sku FROM scans WHERE id = ?`)
          .get(scan_id) as { id: string; item_uid: string | null; product_sku: string } | undefined;

        if (!scan) {
          throw new Error(`Scan ${scan_id} not found`);
        }

        const old_item_uid = scan.item_uid;

        // Update scan to point to new item AND sync SKU fields from target product
        // This ensures UI/exports show correct product data after attach operation
        this.db
          .prepare(`
            UPDATE scans
            SET item_uid = ?,
                product_sku = ?,
                listing_sku = ?,
                cm_card_id = ?,
                updated_at = ?
            WHERE id = ?
          `)
          .run(item_uid, product.product_sku, product.listing_sku, product.cm_card_id, now, scan_id);

        // Recalculate quantities for both items (old and new)
        const affected_items = [item_uid];
        if (old_item_uid) {
          affected_items.push(old_item_uid);
          this.recalculateItemQuantity(old_item_uid, now);
        }
        this.recalculateItemQuantity(item_uid, now);

        return {
          success: true,
          affected_items,
          affected_scans: [scan_id],
          message: `Scan ${scan_id} attached to item ${item_uid}`,
        };
      })();

      this.logger.info(
        { item_uid, scan_id, old_item_uid: result.affected_items[1] },
        "Scan reattached to item (SKU fields synced)"
      );

      return result;
    } catch (error) {
      this.logger.error({ err: error, item_uid, scan_id }, "Failed to attach scan to item");
      return {
        success: false,
        affected_items: [],
        affected_scans: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Merge multiple items into a single target item
   * All scans from source items are repointed to target item, source items are soft-deleted
   *
   * @param target_item_uid - Item to merge into (keeps this one)
   * @param source_item_uids - Items to merge from (will be soft-deleted)
   * @returns OverrideResult with affected entities
   */
  mergeItems(target_item_uid: string, source_item_uids: string[]): OverrideResult {
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = this.db.transaction(() => {
        // Validate target item exists
        const target = this.db
          .prepare(`SELECT item_uid, product_uid FROM items WHERE item_uid = ?`)
          .get(target_item_uid) as { item_uid: string; product_uid: string } | undefined;

        if (!target) {
          throw new Error(`Target item ${target_item_uid} not found`);
        }

        // Validate all source items exist and belong to same product
        const placeholders = source_item_uids.map(() => "?").join(",");
        const sources = this.db
          .prepare(`SELECT item_uid, product_uid FROM items WHERE item_uid IN (${placeholders})`)
          .all(...source_item_uids) as { item_uid: string; product_uid: string }[];

        if (sources.length !== source_item_uids.length) {
          throw new Error(`Some source items not found`);
        }

        // Verify all items share the same product_uid
        const mismatched = sources.filter((s) => s.product_uid !== target.product_uid);
        if (mismatched.length > 0) {
          throw new Error(
            `Cannot merge items from different products: ${mismatched.map((m) => m.item_uid).join(", ")}`
          );
        }

        // Repoint all scans from source items to target item
        const scanUpdate = this.db.prepare(`
          UPDATE scans SET item_uid = ?, updated_at = ? WHERE item_uid = ?
        `);

        for (const source of sources) {
          scanUpdate.run(target_item_uid, now, source.item_uid);
        }

        // Get affected scan IDs for audit
        const affected_scans = this.db
          .prepare(`SELECT id FROM scans WHERE item_uid = ?`)
          .all(target_item_uid)
          .map((row: any) => row.id);

        // Soft-delete source items (set status to MERGED)
        const itemUpdate = this.db.prepare(`
          UPDATE items SET status = 'MERGED', updated_at = ? WHERE item_uid = ?
        `);

        for (const source of sources) {
          itemUpdate.run(now, source.item_uid);
        }

        // Recalculate target item quantity
        this.recalculateItemQuantity(target_item_uid, now);

        return {
          success: true,
          affected_items: [target_item_uid, ...source_item_uids],
          affected_scans,
          message: `Merged ${source_item_uids.length} items into ${target_item_uid}`,
        };
      })();

      this.logger.info(
        { target_item_uid, source_item_uids, scan_count: result.affected_scans.length },
        "Items merged"
      );

      return result;
    } catch (error) {
      this.logger.error(
        { err: error, target_item_uid, source_item_uids },
        "Failed to merge items"
      );
      return {
        success: false,
        affected_items: [],
        affected_scans: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Split an item by moving specified scans to a new item
   * Creates a new item with the same product_uid and moves the specified scans
   *
   * @param source_item_uid - Item to split from
   * @param scan_ids - Scans to move to new item
   * @returns OverrideResult with affected entities (includes new item_uid in message)
   */
  splitItem(source_item_uid: string, scan_ids: string[]): OverrideResult {
    const now = Math.floor(Date.now() / 1000);

    try {
      const result = this.db.transaction(() => {
        // Validate source item exists
        const source = this.db
          .prepare(`SELECT item_uid, product_uid, capture_session_id FROM items WHERE item_uid = ?`)
          .get(source_item_uid) as {
            item_uid: string;
            product_uid: string;
            capture_session_id: string | null;
          } | undefined;

        if (!source) {
          throw new Error(`Source item ${source_item_uid} not found`);
        }

        // Validate all scans exist and belong to source item
        const placeholders = scan_ids.map(() => "?").join(",");
        const scans = this.db
          .prepare(`SELECT id, item_uid FROM scans WHERE id IN (${placeholders})`)
          .all(...scan_ids) as { id: string; item_uid: string }[];

        if (scans.length !== scan_ids.length) {
          throw new Error(`Some scans not found`);
        }

        const mismatched = scans.filter((s) => s.item_uid !== source_item_uid);
        if (mismatched.length > 0) {
          throw new Error(
            `Scans do not belong to source item: ${mismatched.map((m) => m.id).join(", ")}`
          );
        }

        // Create new item with same product_uid
        const new_item_uid = randomUUID();

        this.db
          .prepare(`
            INSERT INTO items (
              item_uid, product_uid, quantity, acquisition_date, acquisition_source,
              capture_session_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            new_item_uid,
            source.product_uid,
            0, // Will be recalculated below
            now,
            "split", // acquisition_source
            source.capture_session_id,
            "IN_STOCK",
            now,
            now
          );

        // Move scans to new item
        const scanUpdate = this.db.prepare(`
          UPDATE scans SET item_uid = ?, updated_at = ? WHERE id = ?
        `);

        for (const scan of scans) {
          scanUpdate.run(new_item_uid, now, scan.id);
        }

        // Recalculate quantities for both items
        this.recalculateItemQuantity(source_item_uid, now);
        this.recalculateItemQuantity(new_item_uid, now);

        return {
          success: true,
          affected_items: [source_item_uid, new_item_uid],
          affected_scans: scan_ids,
          message: `Split ${scan_ids.length} scans from ${source_item_uid} to new item ${new_item_uid}`,
        };
      })();

      this.logger.info(
        { source_item_uid, new_item_uid: result.affected_items[1], scan_count: scan_ids.length },
        "Item split"
      );

      return result;
    } catch (error) {
      this.logger.error({ err: error, source_item_uid, scan_ids }, "Failed to split item");
      return {
        success: false,
        affected_items: [],
        affected_scans: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Recalculate item quantity based on attached scans
   * Also updates product total_quantity via trigger
   */
  private recalculateItemQuantity(item_uid: string, now: number): void {
    const count = this.db
      .prepare(`SELECT COUNT(*) as count FROM scans WHERE item_uid = ?`)
      .get(item_uid) as { count: number };

    this.db
      .prepare(`UPDATE items SET quantity = ?, updated_at = ? WHERE item_uid = ?`)
      .run(count.count, now, item_uid);

    this.logger.debug({ item_uid, quantity: count.count }, "Recalculated item quantity");
  }
}
