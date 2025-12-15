/**
 * SKU Helper Functions (Phase 2.2)
 * Purpose: Deterministic SKU computation sourced from CardMint canonical IDs
 * Reference: docs/MANIFEST_SKU_BEHAVIOR_ANALYSIS.md lines 349-352
 * Date: 2025-10-24
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import { createHash } from "node:crypto";

/**
 * Condition buckets allowed in the system
 * Reference: MANIFEST_SKU_BEHAVIOR_ANALYSIS.md lines 332-334
 */
export type ConditionBucket = "NM" | "LP" | "MP" | "HP" | "UNKNOWN" | "NO_CONDITION";

/**
 * Normalize user-provided condition strings to supported ConditionBucket values.
 * Per Nov 18 QA: Frontend may send unsupported codes like "DAMAGED".
 * This normalizer ensures only enum values reach inventory/SKU generation.
 */
export function normalizeCondition(raw: string | null | undefined): ConditionBucket {
  const normalized = raw?.toUpperCase().trim();
  switch (normalized) {
    case "NM":
    case "NEAR_MINT":
      return "NM";
    case "LP":
    case "LIGHTLY_PLAYED":
      return "LP";
    case "MP":
    case "MODERATELY_PLAYED":
      return "MP";
    case "HP":
    case "HEAVILY_PLAYED":
    case "DAMAGED": // Map DAMAGED to HP per Nov 18 QA
    case "DMG":
      return "HP";
    case "NO_CONDITION":
      return "NO_CONDITION";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

/**
 * Canonical SKU format: PKM:{cm_set_id}:{collector_no}:{variant}:{lang}
 * Product SKU format: {canonical_sku}:{short_uid} (unique per listing)
 * Listing SKU format: {product_sku}:{condition_bucket}
 */
export interface SKUResult {
  canonical_sku: string;
  product_sku: string;
  listing_sku: string;
  cm_card_id: string | null;
  confidence: number;
}

/**
 * Extracted card data from inference (matches ExtractedFields from domain/job.ts)
 */
export interface ExtractedCardData {
  card_name?: string;
  hp_value?: number;
  set_number?: string; // Format: "177/264" or "177"
  [key: string]: unknown;
}

/**
 * Canonicalization service for mapping extracted card data to CardMint IDs and SKUs
 */
export class SKUCanonicalizer {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {}

  /**
   * Map extracted card data to CardMint canonical ID and compute SKUs.
   *
   * Strategy:
   * 1. Fuzzy match card_name against cm_cards FTS5 index
   * 2. Filter by HP value if available (exact match)
   * 3. Filter by collector number if available (extracted from set_number)
   * 4. Return best match with confidence score
   *
   * @param extracted - Extracted card data from inference
   * @param condition - Condition bucket (defaults to UNKNOWN per policy)
   * @param product_uid - Product UID for generating unique listing SKU (optional, defaults to random)
   * @returns SKU result with canonical_sku, product_sku (with UID), listing_sku, cm_card_id, and confidence
   */
  canonicalize(
    extracted: ExtractedCardData,
    condition: ConditionBucket = "UNKNOWN",
    product_uid?: string
  ): SKUResult {
    const { card_name, hp_value, set_number } = extracted;

    // Handle missing card_name (should not happen in normal flow, but be defensive)
    if (!card_name) {
      this.logger.warn({ extracted }, "Missing card_name in extraction; generating fallback SKU");
      return this.generateFallbackSKU("Unknown", null, condition, product_uid);
    }

    // Extract collector number from set_number (e.g., "177/264" → "177")
    const collector_no = this.extractCollectorNumber(set_number);

    try {
      // Step 1: FTS5 fuzzy match on card_name
      const candidates = this.searchCardsByName(card_name);

      if (candidates.length === 0) {
        this.logger.warn(
          { card_name, hp_value, set_number },
          "No CardMint canonical match found; generating fallback SKU"
        );
        return this.generateFallbackSKU(card_name, collector_no, condition, product_uid);
      }

      // Step 2: Filter by HP value if available
      let filtered = candidates;
      if (hp_value !== undefined) {
        const hpMatches = filtered.filter((c) => c.hp_value === hp_value);
        if (hpMatches.length > 0) {
          filtered = hpMatches;
        }
      }

      // Step 3: Filter by collector number if available
      if (collector_no) {
        const collectorMatches = filtered.filter((c) =>
          c.collector_no === collector_no ||
          c.collector_no.startsWith(`${collector_no}/`)
        );
        if (collectorMatches.length > 0) {
          filtered = collectorMatches;
        }
      }

      // Step 4: Select best match (first result, sorted by relevance from FTS5)
      const bestMatch = filtered[0];

      // Compute SKUs
      const variant_str = this.formatVariantBits(bestMatch.variant_bits);
      const canonical_sku = `PKM:${bestMatch.cm_set_id}:${bestMatch.collector_no}:${variant_str}:${bestMatch.lang}`;

      // Generate unique product_sku with UID suffix (last 8 chars)
      const uid_suffix = (product_uid || this.generateUidSuffix()).slice(-8).toUpperCase();
      const product_sku = `${canonical_sku}:${uid_suffix}`;
      const listing_sku = `${product_sku}:${condition}`;

      // Confidence scoring:
      // - 1.0: exact match on name + HP + collector_no
      // - 0.9: match on name + HP
      // - 0.8: match on name + collector_no
      // - 0.7: match on name only
      let confidence = 0.7;
      if (hp_value !== undefined && bestMatch.hp_value === hp_value) {
        confidence = 0.9;
      }
      if (collector_no && bestMatch.collector_no === collector_no) {
        confidence = Math.max(confidence, 0.8);
      }
      if (hp_value !== undefined && collector_no &&
          bestMatch.hp_value === hp_value &&
          bestMatch.collector_no === collector_no) {
        confidence = 1.0;
      }

      this.logger.debug(
        {
          card_name,
          hp_value,
          set_number,
          cm_card_id: bestMatch.cm_card_id,
          canonical_sku,
          product_sku,
          confidence,
        },
        "Canonicalized to CardMint ID"
      );

      return {
        canonical_sku,
        product_sku,
        listing_sku,
        cm_card_id: bestMatch.cm_card_id,
        confidence,
      };
    } catch (error) {
      this.logger.error(
        { err: error, card_name, hp_value, set_number },
        "Canonicalization failed; falling back to generated SKU"
      );
      return this.generateFallbackSKU(card_name, collector_no, condition, product_uid);
    }
  }

  /**
   * Search cm_cards by card name using FTS5 index.
   * Returns up to 25 candidates, prioritizing canonicalized (non-UNKNOWN) sets first.
   */
  private searchCardsByName(card_name: string): CardMintCard[] {
    // Wrap in double quotes for FTS5 phrase search - handles apostrophes and special chars
    // e.g., "Blaine's Growlithe" becomes '"Blaine''s Growlithe"' (phrase with escaped inner quotes)
    // FTS5 phrase queries treat content literally, avoiding syntax errors from apostrophes
    const escaped = `"${card_name.replace(/"/g, '""')}"`;

    const stmt = this.db.prepare(`
      SELECT
        c.cm_card_id,
        c.cm_set_id,
        c.collector_no,
        c.card_name,
        c.hp_value,
        c.variant_bits,
        c.lang
      FROM cm_cards c
      JOIN cm_cards_fts f ON c.rowid = f.rowid
      WHERE cm_cards_fts MATCH ?
      ORDER BY (c.cm_set_id LIKE 'UNKNOWN_%') ASC, rank
      LIMIT 25
    `);

    const results = stmt.all(escaped) as CardMintCard[];
    return results;
  }

  /**
   * Extract collector number from set_number field.
   * Examples:
   *   "177/264" → "177"
   *   "177" → "177"
   *   "SV04-177" → "177"
   */
  private extractCollectorNumber(set_number?: string): string | null {
    if (!set_number) return null;

    // Match patterns: "177/264", "177", "SV04-177"
    const match = set_number.match(/(\d+)(?:\/\d+)?$/);
    return match ? match[1] : null;
  }

  /**
   * Format variant_bits for SKU string.
   * Examples:
   *   "base" → "base"
   *   "holo,full-art" → "holo-full-art"
   */
  private formatVariantBits(variant_bits: string): string {
    return variant_bits.replace(/,/g, "-");
  }

  /**
   * Generate fallback SKU when no CardMint canonical match is found.
   * Canonical format: PKM:UNKNOWN:{sanitized_name}:{collector_no}:EN
   * Product format: {canonical_sku}:{uid_suffix}
   */
  private generateFallbackSKU(
    card_name: string,
    collector_no: string | null,
    condition: ConditionBucket,
    product_uid?: string
  ): SKUResult {
    const sanitized_name = card_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const collector = collector_no || "UNK";
    const canonical_sku = `PKM:UNKNOWN:${sanitized_name}:${collector}:EN`;

    // Generate deterministic UNKNOWN_* cm_card_id so products exist pre-canonicalization.
    const fallbackKey = `${card_name}|${collector}`;
    const fallbackHash = createHash("sha256").update(fallbackKey).digest("hex").slice(0, 6).toUpperCase();
    const fallbackCmCardId = `UNKNOWN_${fallbackHash}-${collector}-a`;

    // Generate unique product_sku with UID suffix
    const uid_suffix = (product_uid || this.generateUidSuffix()).slice(-8).toUpperCase();
    const product_sku = `${canonical_sku}:${uid_suffix}`;
    const listing_sku = `${product_sku}:${condition}`;

    return {
      canonical_sku,
      product_sku,
      listing_sku,
      cm_card_id: fallbackCmCardId,
      confidence: 0.0, // No canonical match
    };
  }

  /**
   * Generate a random UID suffix when product_uid is not provided.
   * Returns last 8 characters of a random hex string.
   */
  private generateUidSuffix(): string {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
  }
}

/**
 * Internal type for cm_cards query results
 */
interface CardMintCard {
  cm_card_id: string;
  cm_set_id: string;
  collector_no: string;
  card_name: string;
  hp_value: number | null;
  variant_bits: string;
  lang: string;
}
