export type JobId = string;

export type JobStatus =
  | "QUEUED"
  | "CAPTURING"
  | "CAPTURED"
  | "BACK_IMAGE"
  | "PREPROCESSING"
  | "INFERENCING"
  | "CANDIDATES_READY"
  | "OPERATOR_PENDING"
  | "UNMATCHED_NO_REASONABLE_CANDIDATE"
  | "ACCEPTED"
  | "FLAGGED"
  | "NEEDS_REVIEW"
  | "FAILED";

export interface StageTimings {
  capture_ms?: number;
  preprocess_ms?: number;
  infer_ms?: number;
  validation_ms?: number;
  ui_ms?: number;
  end_to_end_ms?: number;
  retried_once?: boolean; // Path A (OpenAI) retry metadata
  distortion_ms?: number; // Image distortion correction time
  processing_ms?: number; // Image processing time
  preprocessing_ms?: number; // Total preprocessing time
  preview_ready_ms?: number; // SFTP delivery to raw available
  processed_ready_ms?: number; // Stage 1+2 complete
  inference_complete_ms?: number; // Full pipeline including GPT
  operator_first_view_ms?: number; // Frontend: first image render
  // Path C: Set Triangulation telemetry (Dec 2025)
  pathC_ran?: boolean;
  pathC_action?: "hard_filter" | "soft_rerank" | "discard" | "skipped" | "error";
  pathC_confidence?: number;
  pathC_set_hint?: string | null;
  pathC_latency_ms?: number;
  pathC_matching_signals?: string[];
}

// Variant disambiguation: constrained holo type to prevent arbitrary strings from model
export type HoloType = "holo" | "reverse_holo" | "non_holo" | "unknown";

// Rarity type constrained to official Pokemon TCG rarity values (Dec 2025)
export type RarityType =
  | "Common"
  | "Uncommon"
  | "Rare"
  | "Double Rare"
  | "Ultra Rare"
  | "Illustration Rare"
  | "Special Illustration Rare"
  | "Hyper Rare";

export interface ExtractedFields {
  card_name?: string;
  hp_value?: number | null; // null/undefined ⇒ treat as Trainer
  set_number?: string;
  set_name?: string; // Expansion name (e.g., "Base Set", "Evolving Skies")
  // Variant discrimination fields (HT-001)
  first_edition_stamp?: boolean; // 1st Edition logo detected
  shadowless?: boolean; // Shadowless variant (no shadow behind art box)
  holo_type?: HoloType; // Holographic pattern type
  // Additional extraction fields (Dec 2025)
  rarity?: RarityType | null; // Rarity from symbol (●/◆/★)
  artist?: string | null; // Artist name from "Illus. Artist Name"
  card_type?: string | null; // Pokemon type or card category (matches PPT)
}

export interface Candidate {
  id: string;
  title: string;
  confidence: number; // 0..1
  thumb_path?: string;
  source?: string;
  autoConfirm?: boolean;
  enrichmentSignals?: string[];
}

export interface ScanJob {
  id: JobId;
  created_at: number;
  updated_at: number;
  status: JobStatus;
  image_path?: string; // Backward compat: points to best available (processed > raw)
  raw_image_path?: string; // Original SFTP inbox image
  processed_image_path?: string; // Stage 2 output (rotated, resized, compressed)
  capture_uid?: string; // Pi5 kiosk-provided UID for placeholder hydration
  extracted: ExtractedFields;
  top3: Candidate[];
  retry_count: number;
  error_code?: string;
  error_message?: string;
  operator_id?: string;
  session_id?: string;
  timings: StageTimings;
  processor_id?: string;
  locked_at?: number;
  inference_path?: "openai" | "lmstudio"; // Unambiguous tracking of which inference path was used
  // Phase 2/3 inventory fields (populated after dedupAttachOrMint)
  product_sku?: string;
  listing_sku?: string;
  item_uid?: string;
  cm_card_id?: string;
  scan_fingerprint?: string;
  // Phase 4: Manual override and manifest tracking
  ppt_failure_count?: number;
  staging_ready?: boolean;
  manual_override?: boolean;
  accepted_without_canonical?: boolean;
  // Camera control audit trail (from Pi5 manifest)
  camera_applied_controls?: Record<string, unknown>;
  // Stage 1 lifecycle flags (Nov 19, 2025: Two-stage capture flow)
  front_locked?: boolean;
  back_ready?: boolean;
  canonical_locked?: boolean;
  scan_orientation?: "front" | "back";
  // Master image (Stage 4.5)
  master_image_path?: string;
  master_cdn_url?: string;
  // Operator-verified Truth Core (persisted on Lock Canonical / Accept)
  accepted_name?: string;
  accepted_hp?: number | null;
  accepted_collector_no?: string;
  accepted_set_name?: string;
  accepted_set_size?: number | null;
  accepted_variant_tags?: string[];
}

export const TERMINAL_STATES: JobStatus[] = [
  "ACCEPTED",
  "FLAGGED",
  "NEEDS_REVIEW",
  "FAILED",
];

export const ACTIVE_STATES: JobStatus[] = [
  "QUEUED",
  "CAPTURING",
  "CAPTURED",
  "PREPROCESSING",
  "INFERENCING",
  "CANDIDATES_READY",
  "OPERATOR_PENDING",
  "UNMATCHED_NO_REASONABLE_CANDIDATE",
];

/**
 * Compute diff between original extracted fields and manual overrides
 *
 * Returns an object showing which fields changed, their old and new values.
 * Used for audit trail and telemetry.
 *
 * @param extracted - Original extracted fields from inference
 * @param overrides - Manual overrides from operator
 * @returns Object with field diffs
 */
export function computeOverrideDiff(
  extracted: ExtractedFields,
  overrides: {
    card_name?: string;
    set_number?: string;
    hp_value?: number;
    variant_hint?: string;
  }
): Record<string, { from: any; to: any }> {
  const diffs: Record<string, { from: any; to: any }> = {};

  // Card name
  if (overrides.card_name !== undefined && overrides.card_name !== extracted.card_name) {
    diffs.card_name = {
      from: extracted.card_name ?? null,
      to: overrides.card_name,
    };
  }

  // Set number
  if (overrides.set_number !== undefined && overrides.set_number !== extracted.set_number) {
    diffs.set_number = {
      from: extracted.set_number ?? null,
      to: overrides.set_number,
    };
  }

  // HP value
  if (overrides.hp_value !== undefined && overrides.hp_value !== extracted.hp_value) {
    diffs.hp_value = {
      from: extracted.hp_value ?? null,
      to: overrides.hp_value,
    };
  }

  // Variant hint (new field, no extracted equivalent)
  if (overrides.variant_hint !== undefined) {
    diffs.variant_hint = {
      from: null,
      to: overrides.variant_hint,
    };
  }

  return diffs;
}
