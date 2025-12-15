import type { ScanJob, Candidate as BackendCandidate, StageTimings } from "./types";

/**
 * Component-expected Job interface (from consultation component)
 */
export interface Job {
  id: string;
  status: string;
  created_at: string; // ISO string
  updated_at?: string; // ISO string
  session_id?: string;
  card_name?: string | null;
  hp_value?: number | null;
  set_number?: string | null;
  set_name?: string | null;
  image_path?: string | null; // Best available (processed > raw)
  raw_image_path?: string | null;
  processed_image_path?: string | null;
  candidates?: Candidate[];
  timings?: ComponentTimings;
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

export interface Candidate {
  id?: string;
  title: string;
  confidence: number;
  thumb_path?: string;
  source?: string;
  autoConfirm?: boolean;
  enrichmentSignals?: string[];
}

interface ComponentTimings {
  capture_ms?: number;
  preprocess_ms?: number;
  inference_ms?: number;
  e2e_ms?: number;
  distortion_ms?: number; // Stage 1: Image distortion correction
  processing_ms?: number; // Stage 2: Image resize/rotate/compress
  preprocessing_ms?: number; // Total: Stage 1 + Stage 2
  retried_once?: boolean; // Path A (OpenAI) retry metadata
}

/**
 * Safely convert epoch timestamp to ISO string, with fallback for invalid values
 */
function safeToISOString(epochMs: number | null | undefined): string {
  if (epochMs == null || !Number.isFinite(epochMs)) {
    return new Date().toISOString();
  }
  const date = new Date(epochMs);
  // Check for Invalid Date
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

/**
 * Convert backend ScanJob to component-expected Job format
 */
export function adaptScanJobToJob(scanJob: ScanJob): Job {
  return {
    id: scanJob.id,
    status: scanJob.status,
    created_at: safeToISOString(scanJob.created_at),
    updated_at: safeToISOString(scanJob.updated_at),
    session_id: scanJob.session_id,
    card_name: scanJob.extracted.card_name,
    hp_value: scanJob.extracted.hp_value,
    set_number: scanJob.extracted.set_number,
    set_name: scanJob.extracted.set_name,
    image_path: scanJob.image_path ? `/api/jobs/${scanJob.id}/image` : null,
    raw_image_path: scanJob.raw_image_path ? `/api/jobs/${scanJob.id}/image?variant=raw` : null,
    processed_image_path: scanJob.processed_image_path ? `/api/jobs/${scanJob.id}/image?variant=processed` : null,
    candidates: adaptCandidates(scanJob.top3),
    timings: adaptTimings(scanJob.timings),
    // Phase 4: Manual override and manifest tracking
    ppt_failure_count: scanJob.ppt_failure_count,
    staging_ready: scanJob.staging_ready,
    manual_override: scanJob.manual_override,
    accepted_without_canonical: scanJob.accepted_without_canonical,
    // Stage 1 lifecycle flags (Nov 19, 2025: Two-stage capture flow)
    front_locked: scanJob.front_locked,
    back_ready: scanJob.back_ready,
    canonical_locked: scanJob.canonical_locked,
    // Operator-verified Truth Core (persisted on Lock Canonical / Accept)
    accepted_name: scanJob.accepted_name,
    accepted_hp: scanJob.accepted_hp,
    accepted_collector_no: scanJob.accepted_collector_no,
    accepted_set_name: scanJob.accepted_set_name,
    accepted_set_size: scanJob.accepted_set_size,
    accepted_variant_tags: scanJob.accepted_variant_tags,
    // Canonical card ID (for reconciliation status display)
    cm_card_id: scanJob.cm_card_id,
    // Sync state (Dec 4, 2025: EverShop promotion)
    evershop_sync_state: scanJob.evershop_sync_state,
    promoted_at: scanJob.promoted_at,
  };
}

/**
 * Convert backend candidates (top3) to component format
 */
function adaptCandidates(backendCandidates: BackendCandidate[]): Candidate[] {
  return backendCandidates.map((c) => ({
    id: c.id,
    title: c.title,
    confidence: c.confidence,
    thumb_path: c.thumb_path,
    source: c.source,
    autoConfirm: c.autoConfirm,
    enrichmentSignals: c.enrichmentSignals,
  }));
}

/**
 * Convert backend timings to component format
 */
function adaptTimings(backendTimings: StageTimings): ComponentTimings {
  return {
    capture_ms: backendTimings.capture_ms,
    preprocess_ms: backendTimings.preprocess_ms,
    inference_ms: backendTimings.infer_ms,
    e2e_ms: backendTimings.end_to_end_ms,
    distortion_ms: backendTimings.distortion_ms,
    processing_ms: backendTimings.processing_ms,
    preprocessing_ms: backendTimings.preprocessing_ms,
    retried_once: backendTimings.retried_once,
  };
}
