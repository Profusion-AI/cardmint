/**
 * EverShop subscriber: product_updated
 * Sends webhook notification to CardMint backend for bidirectional sync
 * RFC-fullduplexDB_triple Phase 2
 *
 * IMPLEMENTATION NOTE (Dec 11, 2025):
 * This is the canonical implementation. An incomplete TypeScript version exists
 * at notifyCardmint.ts.archived but is missing critical features (category_name,
 * variant_tags queries). We chose to stay in JS for now since the ESM migration
 * is the blocker, not TypeScript typing. If converting to TS in the future,
 * ensure ALL features from this file are ported.
 *
 * Dec 8, 2025: Added category_name sync for bidirectional metadata updates
 * Dec 9, 2025: Added variant_tags from cardmint_variant_tags attribute
 * Dec 11, 2025: Migrated from CommonJS to ESM for EverShop 2.1 compatibility
 */

// Module-load logging - confirms subscriber was picked up by event-manager
console.log('[cardmint_sync] notifyCardmint subscriber LOADED at:', new Date().toISOString());

import { createHmac } from "node:crypto";
import { pool } from "@evershop/evershop/lib/postgres";
import { select } from "@evershop/postgres-query-builder";

// Configuration from environment (set in EverShop's config)
const CARDMINT_WEBHOOK_URL =
  process.env.CARDMINT_WEBHOOK_URL || "http://localhost:4000/api/webhooks/evershop";
const CARDMINT_WEBHOOK_SECRET = process.env.CARDMINT_WEBHOOK_SECRET || "";
const WEBHOOK_ENABLED = process.env.CARDMINT_SYNC_ENABLED !== "false";

/**
 * Generate HMAC signature for webhook payload
 */
function signPayload(payload, secret) {
  if (!secret) return "";
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Subscriber function - called when product_updated event fires
 *
 * @param {Object} data - Product update data from EverShop
 * @param {number} data.product_id - Product ID
 * @param {string} data.uuid - Product UUID
 * @param {string} data.sku - Product SKU
 * @param {number} data.price - Product price
 * @param {boolean} data.status - Product enabled status
 * @param {boolean} [data.visibility] - Product visibility on storefront
 * @param {string} data.created_at - Creation timestamp
 * @param {string} data.updated_at - Update timestamp
 * @param {string} [data.name] - Product name
 * @param {number} [data.qty] - Stock quantity
 */
export default async function notifyCardmint(data) {
  console.log("[cardmint_sync] product_updated event received:", JSON.stringify({ uuid: data.uuid, sku: data.sku, status: data.status, visibility: data.visibility }));

  // Skip if disabled
  if (!WEBHOOK_ENABLED) {
    console.log("[cardmint_sync] Webhook disabled, skipping notification");
    return;
  }

  // Skip if no webhook URL configured
  if (!CARDMINT_WEBHOOK_URL) {
    console.warn("[cardmint_sync] No CARDMINT_WEBHOOK_URL configured");
    return;
  }

  // Query category name for bidirectional metadata sync (Dec 8, 2025)
  // CardMint uses category as set_name - this enables admin edits to sync back
  let categoryName = null;
  try {
    if (data.product_id) {
      const categoryRows = await select("cd.name")
        .from("product_category", "pc")
        .innerJoin("category_description", "cd")
        .on("pc.category_id", "=", "cd.category_description_category_id")
        .where("pc.product_id", "=", data.product_id)
        .execute(pool);

      if (categoryRows && categoryRows.length > 0) {
        categoryName = categoryRows[0].name;
      }
    }
  } catch (err) {
    console.warn("[cardmint_sync] Failed to query category:", err.message);
  }

  // Query variant_tags from cardmint_variant_tags attribute (Dec 9, 2025)
  // Stored as comma-separated text (e.g., "First Edition, Holo")
  // Returned as array for CardMint consumption
  let variantTags = null;
  try {
    if (data.product_id) {
      const attrRows = await pool.query(`
        SELECT pavi.option_text
        FROM product_attribute_value_index pavi
        JOIN attribute a ON pavi.attribute_id = a.attribute_id
        WHERE pavi.product_id = $1 AND a.attribute_code = 'cardmint_variant_tags'
      `, [data.product_id]);

      if (attrRows.rows && attrRows.rows.length > 0 && attrRows.rows[0].option_text) {
        const rawText = attrRows.rows[0].option_text.trim();
        if (rawText) {
          // Parse comma-separated into array, trim each tag
          variantTags = rawText.split(',').map(t => t.trim()).filter(t => t.length > 0);
          console.log("[cardmint_sync] Read variant_tags from attribute:", variantTags);
        }
      }
    }
  } catch (err) {
    console.warn("[cardmint_sync] Failed to query variant_tags:", err.message);
  }

  // Build webhook payload (map EverShop schema to CardMint expectations)
  // Use current event time for updated_at - EverShop's DB updated_at may be stale
  // when only visibility changes (doesn't update the timestamp column)
  // IMPORTANT: Must send both status AND visibility for proper state machine transitions
  const payload = {
    uuid: data.uuid,
    sku: data.sku,
    status: data.status ?? true,
    visibility: data.visibility ?? data.status ?? true,
    updated_at: new Date().toISOString(),
    price: data.price,
    name: data.name,
    qty: data.qty,
    category_name: categoryName,
    // Dec 9, 2025: variant_tags from cardmint_variant_tags attribute
    // Stored as comma-separated text in EverShop, sent as array to CardMint
    variant_tags: variantTags,
  };

  const payloadJson = JSON.stringify(payload);
  const signature = signPayload(payloadJson, CARDMINT_WEBHOOK_SECRET);

  try {
    const response = await fetch(CARDMINT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature && { "X-CardMint-Signature": signature }),
      },
      body: payloadJson,
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error(
        `[cardmint_sync] Webhook failed: ${response.status} ${response.statusText}`,
        errorBody.slice(0, 200)
      );
      return;
    }

    const result = await response.json().catch(() => ({}));
    console.log(
      `[cardmint_sync] Webhook sent for product ${data.uuid}:`,
      result.ok ? "processed" : "failed",
      result.event_uid || ""
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[cardmint_sync] Webhook request failed: ${message}`);
  }
};
