/**
 * LotBuilder Types
 * Multi-card bundle discount calculation interfaces
 */

export interface LotBuilderItem {
  product_uid: string;
  price_cents: number;
  set_name: string;
  rarity: string;
  condition: string;
}

export type LotBuilderReasonCode =
  | "SET_SYNERGY"
  | "RARITY_CLUSTER"
  | "CONDITION_MATCH"
  | "THEME_BUNDLE"
  | "QUANTITY_ONLY"
  | "NONE";

export interface LotBuilderResult {
  discountPct: number; // 0-15
  reasonCode: LotBuilderReasonCode;
  reasonTags: string[]; // e.g., ['set-synergy', 'rarity']
  reasonText: string; // Customer-facing prose (max 100 chars)
  subtotalBeforeDiscountCents: number;
  discountAmountCents: number;
  finalTotalCents: number;
}

/**
 * LLM-enhanced discount preview result
 * Extends base LotBuilderResult with AI-validated discount and creative text
 */
export interface LotPreviewResult extends LotBuilderResult {
  // System-calculated baseline (deterministic)
  systemDiscountPct: number;
  // LLM-adjusted percentage (±5pp from system, adds controlled randomness)
  llmAdjustedPct: number;
  // Creative reason text from LLM (theme detection, engaging copy)
  llmReasonText: string;
  // Detected theme bundle (e.g., "Gen 1 Collection", "Charizard Family")
  themeBundle: string | null;
  // LLM confidence score (0-1)
  confidence: number;
  // Whether result came from cache
  cached: boolean;
  // Which model was used (primary or fallback)
  model: "primary" | "fallback" | "system_only";
}

/**
 * Cart item for LLM preview (includes card name for theme detection)
 */
export interface LotPreviewItem extends LotBuilderItem {
  card_name: string;
  card_number?: string;
  image_url?: string;
}
