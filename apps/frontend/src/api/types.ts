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
  distortion_ms?: number; // Stage 1: Image distortion correction
  processing_ms?: number; // Stage 2: Image resize/rotate/compress
  preprocessing_ms?: number; // Total: Stage 1 + Stage 2
  retried_once?: boolean; // Path A (OpenAI) retry metadata
}

// Variant disambiguation: constrained holo type to prevent arbitrary strings from model
export type HoloType = "holo" | "reverse_holo" | "non_holo" | "unknown";

export interface ExtractedFields {
  card_name?: string;
  hp_value?: number | null;
  set_number?: string;
  set_name?: string; // Expansion name (e.g., "Base Set", "Evolving Skies")
  // Variant discrimination fields (HT-001)
  first_edition_stamp?: boolean; // 1st Edition logo detected
  shadowless?: boolean; // Shadowless variant (no shadow behind art box)
  holo_type?: HoloType; // Holographic pattern type
}

export interface Candidate {
  id: string;
  title: string;
  confidence: number;
  thumb_path?: string;
  source?: string;
  // RFC-001/RFC-002 forward compatibility fields
  autoConfirm?: boolean;
  enrichmentSignals?: string[];
}

export interface ScanJob {
  id: string;
  created_at: number;
  updated_at: number;
  status: JobStatus;
  image_path?: string; // Backward compat: best available (processed > raw)
  raw_image_path?: string; // Original SFTP inbox image
  processed_image_path?: string; // Stage 2 output (rotated, resized, compressed)
  extracted: ExtractedFields;
  top3: Candidate[];
  retry_count: number;
  error_code?: string;
  error_message?: string;
  operator_id?: string;
  session_id?: string;
  timings: StageTimings;
  // Phase 4: Manual override and manifest tracking
  ppt_failure_count?: number;
  staging_ready?: boolean;
  manual_override?: boolean;
  accepted_without_canonical?: boolean;
  // Stage 1 lifecycle flags (Nov 19, 2025: Two-stage capture flow)
  front_locked?: boolean;
  back_ready?: boolean;
  canonical_locked?: boolean;
  // Operator-verified Truth Core (persisted on Lock Canonical / Accept)
  accepted_name?: string;
  accepted_hp?: number | null;
  accepted_collector_no?: string;
  accepted_set_name?: string;
  accepted_set_size?: number | null;
  accepted_variant_tags?: string[];
  // Canonical card ID (for reconciliation status display)
  cm_card_id?: string;
  // Sync state (Dec 4, 2025: EverShop promotion)
  evershop_sync_state?: string;
  promoted_at?: number;
}

export interface MetricsResponse {
  queueDepth: number;
  warning: boolean;
  recent: ScanJob[];
  workerIdleMinutes?: number;
  counters?: {
    jobs_processed_total: number;
    jobs_failed_total: number;
    retries_total: number;
  };
  histograms?: {
    inference_latency_ms: {
      count: number;
      sum: number;
      min: number;
      max: number;
      p50: number;
      p95: number;
      p99: number;
    };
  };
  canonical_retrieval?: {
    canonical_hit: number;
    pricecharting_fallback: number;
    canonical_unavailable: number;
    hit_rate_percent: number;
    gate: {
      passed: boolean | null;
      threshold_hit_rate: number;
      threshold_unavailable: number;
    };
  };
}

// ============================================================================
// Image Publishing API (Stage 3 + Cloudinary)
// ============================================================================

export interface PublishImageRequest {
  product_uid: string;
}

export interface PublishImageResponse {
  ok: boolean;
  product_uid: string;
  cdn_image_url: string;
  listing_image_path: string;
  cdn_published_at: number;
}
