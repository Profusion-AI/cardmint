import type { MetricsResponse, ScanJob } from "./types";
import { adaptScanJobToJob, type Job } from "./adapters";

// ============================================================================
// Evidence Types (co-located to avoid touching types.ts)
// ============================================================================

export interface EvidenceSignal {
  key: string;
  strength: "strong" | "medium" | "weak";
  detail?: string;
}

export interface Evidence {
  status: "AVAILABLE" | "UNAVAILABLE" | "PARTIAL";
  provenance: {
    scorer_version: string;
    signal_schema: string;
    corpus_hash: string;
  };
  etag: string;
  modelVerdict: {
    productId: string;
    productName: string;
    setNumber: string | null;
    setName: string | null;
    confidence: number;
    why: EvidenceSignal[];
    priceChartingUrl?: string;
    referenceArtThumb?: string | null;
  };
  checks: Array<{
    field: string;
    extracted?: string | null;
    canonical?: string | null;
    pass: boolean;
    note?: string;
  }>;
  variants: Array<{
    productId: string;
    productName: string;
    variantSuffix: string;
    setNumber: string | null;
    rarity: string | null;
    releaseYear: number | null;
    score: number;
    deltas: {
      name?: "suffixMismatch" | "nameOverlap" | null;
      setNumber?: "match" | "mismatch";
      total?: "match" | "mismatch";
    };
  }>;
  alerts: string[];
  breadcrumbs: {
    pathA_ms: number | null;
    retries: number;
    captureUid: string;
    inference_path?: "openai" | "lmstudio";
    // Path C: Set Triangulation telemetry (Dec 2025)
    pathC?: {
      ran: boolean;
      action: "hard_filter" | "soft_rerank" | "discard" | "skipped" | "error";
      confidence: number | null;
      setHint: string | null;
      latencyMs: number | null;
      matchingSignals: string[];
    } | null;
  };
  inventory: {
    product_sku: string | null;
    listing_sku: string | null;
    item_uid: string | null;
    product_uid: string | null;
    cm_card_id: string | null;
    scan_fingerprint: string | null;
    cdn_image_url: string | null;
    cdn_back_image_url: string | null;
    cdn_published_at: number | null;
  };
}

// ============================================================================
// Scan Manifest Types (Path A/Path B + operator/enrichment metadata)
// ============================================================================

export interface ScanManifestAsset {
  path: string;
  captured_at: number;
}

export interface ScanManifestInference {
  cm_card_id: string;
  top_candidates: Array<{ id: string; score: number }>;
  engine: "PathA" | "PathB";
  version: string;
  retries: number;
}

export interface ScanManifestEnrichment {
  pricing_source: "ppt" | "csv" | "manual" | null;
  market_price: number | null;
  pricing_status: "fresh" | "stale" | "missing";
  quota_delta: number;
  updated_at: number | null;
}

export interface ScanManifestOperator {
  accepted: boolean;
  accepted_without_canonical: boolean;
  canonical_cm_card_id: string | null;
  manual_override: boolean;
  manual_reason_code: string | null;
  manual_note: string | null;
}

export interface ScanManifestStaging {
  ready: boolean;
  promoted_by: string | null;
  promoted_at: number | null;
}

export interface ScanManifest {
  uid: string;
  asset: ScanManifestAsset;
  inference: ScanManifestInference;
  enrichment: ScanManifestEnrichment;
  operator: ScanManifestOperator;
  staging: ScanManifestStaging;
}

// ============================================================================
// API Functions
// ============================================================================

export const fetchMetrics = async (): Promise<MetricsResponse> => {
  const response = await fetch("/api/metrics");
  if (!response.ok) {
    throw new Error(`Metrics fetch failed: ${response.status}`);
  }
  return response.json();
};

export const listRecentJobs = async (): Promise<ScanJob[]> => {
  const response = await fetch("/api/jobs/recent");
  if (!response.ok) {
    throw new Error(`Recent jobs fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.jobs ?? [];
};

/**
 * Fetch recent jobs adapted to component format
 */
export const listRecentJobsAdapted = async (): Promise<Job[]> => {
  const scanJobs = await listRecentJobs();
  return scanJobs.map(adaptScanJobToJob);
};

/**
 * Fetch a single job by ID, adapted to component format
 */
export const fetchJobById = async (id: string): Promise<Job | null> => {
  const response = await fetch(`/api/jobs/${id}`);
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Job fetch failed: ${response.status}`);
  }
  const data: ScanJob = await response.json();
  return adaptScanJobToJob(data);
};

/**
 * Trigger a capture via POST /api/capture
 * Returns placeholder job for instant UI feedback, or null if unavailable
 */
export const triggerCapture = async (): Promise<Job | null> => {
  const response = await fetch("/api/capture", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Capture failed: ${response.status}`);
  }
  const data = await response.json();
  return data.job ? adaptScanJobToJob(data.job) : null;
};

/**
 * Nov 19 Production: Lock front image (Stage 1A - Ready for Back Capture)
 * POST /api/scans/:id/lock-front
 */
export const lockFrontImage = async (scanId: string): Promise<{ ok: boolean; message: string; front_locked: boolean }> => {
  const response = await fetch(`/api/scans/${scanId}/lock-front`, { method: "POST" });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Lock front failed: ${response.status}`);
  }
  const data = await response.json();
  return {
    ok: data.ok,
    message: data.message || "Front image locked",
    front_locked: data.front_locked,
  };
};

/**
 * Nov 19 Production: Capture back image for scan (Stage 1A → Stage 1B)
 * POST /api/scans/:id/capture-back
 * Replaces product-based capture-back endpoint for two-stage flow.
 *
 * NOTE: Back capture no longer creates a job. SFTP ingestion attaches the image directly.
 * The response returns immediately after camera trigger. Poll job status to detect when
 * SFTP has attached the image (back_ready flag).
 */
export const captureBackForScan = async (scanId: string): Promise<{ ok: boolean; frontScanId: string; captureUid?: string; message: string }> => {
  const response = await fetch(`/api/scans/${scanId}/capture-back`, { method: "POST" });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Back capture failed: ${response.status}`);
  }
  const data = await response.json();
  return {
    ok: data.ok,
    frontScanId: data.frontScanId,
    captureUid: data.captureUid,
    message: data.message || "Back image capture triggered",
  };
};

/**
 * Capture back image for an existing product (Phase 2J: two-capture workflow)
 * POST /api/products/:product_uid/capture-back
 * @deprecated Use captureBackForScan for Stage 1 flow (Nov 19+)
 */
export const captureBackImage = async (productUid: string): Promise<{ ok: boolean; job: Job | null; message: string }> => {
  const response = await fetch(`/api/products/${productUid}/capture-back`, { method: "POST" });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Back capture failed: ${response.status}`);
  }
  const data = await response.json();
  return {
    ok: data.ok,
    job: data.job ? adaptScanJobToJob(data.job) : null,
    message: data.message || "Back image captured",
  };
};

/**
 * Upload an image file via POST /api/upload
 */
export const uploadImage = async (file: File, sessionId?: string): Promise<Job> => {
  const formData = new FormData();
  formData.append("image", file);
  if (sessionId) {
    formData.append("sessionId", sessionId);
  }

  const response = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(error.error || `Upload failed: ${response.status}`);
  }

  const data = await response.json();
  return adaptScanJobToJob(data.job);
};

/**
 * Perform an action on a job (accept, flag, retry)
 * Nov 18 Production: Accept now requires condition parameter for Stage 2 inventory creation
 */
export const patchJob = async (
  id: string,
  action: "ACCEPT" | "FLAG" | "RETRY",
  candidateIndex?: number,
  selectionSource?: "top3" | "expanded_family" | "manual_tab",
  telemetry?: Record<string, any>,
  condition?: string
): Promise<void> => {
  const body: {
    action: string;
    candidateIndex?: number;
    selectionSource?: string;
    telemetry?: Record<string, any>;
    condition?: string;
  } = { action };

  if (candidateIndex !== undefined) {
    body.candidateIndex = candidateIndex;
  }

  if (selectionSource !== undefined) {
    body.selectionSource = selectionSource;
  }

  if (telemetry !== undefined) {
    body.telemetry = telemetry;
  }

  // Include condition for ACCEPT actions (defaults to "UNKNOWN" on backend if not provided)
  if (action === "ACCEPT" && condition !== undefined) {
    body.condition = condition;
  }

  const response = await fetch(`/api/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      /* no body */
    }
    const err: any = new Error(data?.error || `Job patch failed: ${response.status}`);
    err.response = { status: response.status, data };
    throw err;
  }
};

/**
 * Get the URL for a job's image
 */
export const jobImageUrl = (id: string): string => `/api/jobs/${id}/image`;

/**
 * Record operator_first_view_ms timing when image first renders in UI
 * @param jobId - The job ID
 * @param createdAtMs - The job creation timestamp in milliseconds
 */
export const recordOperatorFirstView = async (jobId: string, createdAtMs: number): Promise<void> => {
  const operator_first_view_ms = Date.now() - createdAtMs;
  const response = await fetch(`/api/jobs/${jobId}/timings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operator_first_view_ms }),
  });
  if (!response.ok) {
    // Non-critical: log but don't throw
    console.warn(`Failed to record operator_first_view_ms for job ${jobId}: ${response.status}`);
  }
};

/**
 * Fetch scan manifest (single JSON file on disk) with optional ETag caching.
 * Returns "not-modified" if unchanged.
 */
export const fetchScanManifest = async (
  scanId: string,
  cachedEtagHeader?: string
): Promise<{ manifest: ScanManifest; etagHeader: string } | "not-modified"> => {
  const headers: HeadersInit = {};
  if (cachedEtagHeader) {
    headers["If-None-Match"] = cachedEtagHeader;
  }
  const response = await fetch(`/api/scans/${scanId}/manifest`, { headers });
  if (response.status === 304) return "not-modified";
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Manifest fetch failed: ${response.status}`;
    throw new Error(message);
  }
  const etagHeader = response.headers.get("ETag") ?? undefined;
  const manifest = (await response.json()) as ScanManifest;
  return { manifest, etagHeader: etagHeader ?? `"${manifest.uid}"` };
};

/**
 * Fetch expanded variant family for a job
 * Returns sibling variants from the same family (same card number + set)
 */
export const fetchVariants = async (
  jobId: string,
  limit = 20
): Promise<{
  variants: Array<{
    id: string;
    title: string;
    confidence: number;
    source: string;
  }>;
  top3_ids: string[];
  corpus_hash: string | null;
}> => {
  const response = await fetch(`/api/jobs/${jobId}/variants?limit=${limit}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: { code: "UNKNOWN", message: "Variant fetch failed" },
    }));
    throw new Error(error.error?.message || `Variant fetch failed: ${response.status}`);
  }

  const data = await response.json();
  return data.data;
};

/**
 * Fetch evidence for a job with ETag caching support
 * Returns "not-modified" if server responds with 304
 * On 200, returns { evidence, etagHeader } where etagHeader is the full quoted ETag header value
 */
export const fetchEvidence = async (
  jobId: string,
  cachedEtagHeader?: string
): Promise<{ evidence: Evidence; etagHeader: string } | "not-modified"> => {
  const headers: HeadersInit = {};
  if (cachedEtagHeader) {
    headers["If-None-Match"] = cachedEtagHeader;
  }

  const response = await fetch(`/api/jobs/${jobId}/evidence`, { headers });

  if (response.status === 304) {
    return "not-modified";
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: { code: "UNKNOWN", message: "Evidence fetch failed" },
    }));
    throw new Error(error.error?.message || `Evidence fetch failed: ${response.status}`);
  }

  const data = await response.json();
  const etagHeader = response.headers.get("ETag") ?? `"${data.data.etag}"`;

  return { evidence: data.data, etagHeader };
};

// ============================================================================
// Inventory Override API (Phase 3)
// ============================================================================

export interface InventoryOverrideResult {
  success: boolean;
  affected_items: string[];
  affected_scans: string[];
  message: string;
}

/**
 * Attach a scan to a different item (operator override for wrong SKU)
 */
export const attachScanToItem = async (
  item_uid: string,
  scan_id: string
): Promise<InventoryOverrideResult> => {
  const response = await fetch(`/api/items/${item_uid}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_id }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "ATTACH_FAILED",
      message: "Failed to attach scan to item",
    }));
    throw new Error(error.message || `Attach failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result;
};

/**
 * Split scans from an item into a new item (operator override for wrong dedup)
 */
export const splitItemScans = async (
  source_item_uid: string,
  scan_ids: string[]
): Promise<InventoryOverrideResult> => {
  const response = await fetch(`/api/items/${source_item_uid}/split`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_ids }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "SPLIT_FAILED",
      message: "Failed to split item",
    }));
    throw new Error(error.message || `Split failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result;
};

/**
 * Merge multiple items into a single target item (operator override for duplicate items)
 */
export const mergeItems = async (
  target_item_uid: string,
  source_item_uids: string[]
): Promise<InventoryOverrideResult> => {
  const response = await fetch("/api/items/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_item_uid, source_item_uids }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "MERGE_FAILED",
      message: "Failed to merge items",
    }));
    throw new Error(error.message || `Merge failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result;
};

// ============================================================================
// Manual Override & Quota API (Phase 4)
// ============================================================================

export interface ManualOverridePayload {
  accepted: boolean;
  accepted_without_canonical?: boolean;
  canonical_cm_card_id?: string;
  manual_override: boolean;
  manual_reason_code: string;
  manual_note: string;
  manual_price?: number;
}

/**
 * Submit manual override for a scan (operator-provided card identification)
 */
export const submitManualOverride = async (
  scanId: string,
  payload: ManualOverridePayload
): Promise<void> => {
  const response = await fetch(`/api/scans/${scanId}/manifest/operator`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "OVERRIDE_FAILED",
      message: "Failed to submit manual override",
    }));
    throw new Error(error.message || `Manual override failed: ${response.status}`);
  }
};

export interface QuotaState {
  tier: string;
  dailyLimit: number;
  dailyRemaining: number | null;
  callsConsumed: number | null;
  warningLevel: "ok" | "warning" | "critical";
  lastUpdated: number;
}

/**
 * Fetch current PPT quota state from active session
 */
export const fetchQuotaState = async (): Promise<QuotaState | null> => {
  const response = await fetch("/api/operator-sessions/active");
  if (!response.ok) {
    throw new Error(`Quota fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return data.quota ?? null;
};

// ============================================================================
// Canonicalization, Rescan, and PPT Enrichment (Operator actions)
// ============================================================================

/**
 * Canonicalize a scan's cm_card_id (resolve UNKNOWN_* -> canonical)
 */
export const canonicalizeScan = async (
  scanId: string,
  canonical_cm_card_id: string
): Promise<{ canonical_cm_card_id: string }> => {
  const response = await fetch(`/api/scans/${scanId}/canonicalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canonical_cm_card_id }),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Canonicalize failed: ${response.status}`;
    throw new Error(message);
  }
  const data = await response.json();
  return { canonical_cm_card_id: data.canonical_cm_card_id };
};

/**
 * Nov 21 Relaxed Canonical Lock: Lock canonical identity without requiring cm_card_id match
 * Operator confirms Truth Core is correct even if database has no match.
 */
export const lockCanonical = async (
  scanId: string,
  payload?: { truth_core?: { name?: string; collector_no?: string; set_name?: string; hp?: number | null; set_size?: number | null; variant_tags?: string[] } }
): Promise<{ canonical_locked: boolean; needs_reconciliation: boolean; cm_card_id: string | null }> => {
  const response = await fetch(`/api/scans/${scanId}/lock-canonical`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Lock canonical failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Persist Truth Core edits without locking/accepting
 */
export const saveTruthCore = async (
  scanId: string,
  truthCore: { name: string; collector_no: string; set_name: string; hp?: number | null; set_size?: number | null; variant_tags?: string[] }
): Promise<{ ok: boolean }> => {
  const response = await fetch(`/api/scans/${scanId}/truth-core`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ truth_core: truthCore }),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Truth Core save failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Trigger a rescan of an existing scan (Path A)
 */
export const rescanJob = async (
  scanId: string
): Promise<{ retry_count: number }> => {
  const response = await fetch(`/api/scans/${scanId}/rescan`, { method: "POST" });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Rescan failed: ${response.status}`;
    throw new Error(message);
  }
  const data = await response.json();
  return { retry_count: data.retry_count };
};

// PPT Quote/Enrichment types
export interface PPTQuota {
  tier: string;
  dailyLimit: number;
  dailyRemaining: number | null;
  minuteRemaining?: number | null;
  callsConsumed?: number | null;
  warningLevel?: string;
  shouldHalt?: boolean;
}

export interface PPTQuoteResponse {
  product_uid: string;
  cm_card_id: string;
  card_name: string;
  estimated_credits: number;
  pricing_status: string;
  pricing_fresh: boolean;
  quota: PPTQuota;
  ready_for_enrichment: boolean;
}

export interface PPTEnrichResult {
  ok: boolean;
  product_uid: string;
  pricing_source: string;
  market_price: number | null;
  pricing_status: string;
  pricing_updated_at: number;
  staging_ready: boolean;
  credits_consumed: number;
  quota: PPTQuota | null;
  from_cache: boolean;
  fallback_used: boolean;
  enrichment_strategy?: "pricecharting_bridge" | "pricecharting_bridge_fallback_parse_title" | "parse_title";
  pricecharting_bridge_id?: string | null;
  parse_title_request?: string | null;
  enrichment_signals?: Record<string, unknown> | null;
}

export interface PPTPreviewResult {
  ok: boolean;
  preview: true;
  title: string;
  result: {
    success: boolean;
    priceData: {
      market_price: number | null;
      pricing_source: string;
      pricing_status: string;
      ppt_card_id?: string;
      hp_value?: number;
      total_set_number?: string;
      enrichment_signals?: Record<string, unknown>;
    } | null;
    quotaStatus: PPTQuota | null;
    error?: string;
    fromCache: boolean;
  };
}

/**
 * Fetch PPT quote (dry run) for a product
 */
export const fetchPPTQuote = async (
  product_uid: string
): Promise<PPTQuoteResponse> => {
  const url = `/api/operator/enrich/ppt/quote?product_uid=${encodeURIComponent(product_uid)}`;
  const response = await fetch(url);
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `PPT quote failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Trigger PPT enrichment for a product
 */
export const enrichWithPPT = async (
  product_uid: string
): Promise<PPTEnrichResult> => {
  const response = await fetch(`/api/operator/enrich/ppt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_uid }),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `PPT enrich failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Preview PPT enrichment (parse-title) without persisting pricing. Accepts scan_id or product_uid.
 */
export const previewPPT = async (
  params: { scan_id?: string; product_uid?: string }
): Promise<PPTPreviewResult> => {
  const response = await fetch(`/api/operator/enrich/ppt/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `PPT preview failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

// ============================================================================
// Baseline Session Summary
// ============================================================================

/**
 * Baseline session summary returned by GET /api/operator-sessions/:id/summary
 */
export interface BaselineSummary {
  session_id: string;
  finalized_at: number;
  first_scan_at: number;
  last_scan_at: number;
  total_scans: number;
  accepted_count: number;
  flagged_count: number;
  unmatched_count: number;
  canonicalized_count: number;
  enriched_count: number;
  fresh_pricing_count: number;
  csv_fallback_count: number;
  ppt_calls_consumed: number | null;
  ppt_daily_remaining: number | null;
  staging_ready_count: number;
  eligible_not_staged_count: number;
  manual_override_count: number;
  accepted_without_canonical_count: number;
  retrieval_corpus_hash: string | null;
  openai_model: string | null;
}

/**
 * Fetch session summary (counts, metrics, quota)
 */
export const fetchSessionSummary = async (sessionId: string): Promise<BaselineSummary> => {
  const response = await fetch(`/api/operator-sessions/${sessionId}/summary`);
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Session summary fetch failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Finalize a session as the active baseline
 */
export const finalizeBaseline = async (
  sessionId: string
): Promise<{ ok: boolean; session_id: string; baseline: boolean }> => {
  const response = await fetch(`/api/operator-sessions/${sessionId}/finalize-baseline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.message || data?.error || `Finalize baseline failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

// ============================================================================
// Image Publishing API (Stage 3 + Cloudinary)
// ============================================================================

/**
 * Publish listing image to CDN (generate Stage 3 asset + upload to Cloudinary)
 * Idempotent: safe to call multiple times for the same product
 */
export const publishImage = async (
  product_uid: string
): Promise<{
  ok: boolean;
  product_uid: string;
  cdn_image_url: string;
  listing_image_path: string;
  cdn_published_at: number;
}> => {
  const response = await fetch(`/api/images/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_uid }),
  });

  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Image publish failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
};

/**
 * Publish back image to CDN (upload back orientation scan to Cloudinary)
 * Idempotent: safe to call multiple times for the same product
 */
export const publishBackImage = async (
  product_uid: string
): Promise<{
  ok: boolean;
  product_uid: string;
  cdn_back_image_url: string;
  listing_image_path: string;
  cdn_published_at: number;
}> => {
  const response = await fetch(`/api/images/publish-back`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_uid }),
  });

  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Back image publish failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
};

// ============================================================================
// Sync / Promotion API
// ============================================================================

export type EverShopSyncState =
  | "not_synced"
  | "vault_only"
  | "evershop_hidden"
  | "evershop_live"
  | "sync_error";

export interface PromoteResult {
  product_uid: string;
  success: boolean;
  event_uid?: string;
  evershop_sync_state?: EverShopSyncState;
  error?: string;
}

export interface PromoteResponse {
  dry_run: boolean;
  total: number;
  promoted: number;
  failed: number;
  results: PromoteResult[];
}

export interface SyncStateResponse {
  product_uid: string;
  evershop_sync_state: EverShopSyncState;
  promoted_at: number | null;
  last_synced_at: number | null;
  sync_version: number;
}

/**
 * Promote products to production (prod_db + EverShop)
 */
export const promoteProducts = async (
  product_uids: string[],
  dry_run = false,
  operator_id?: string
): Promise<PromoteResponse> => {
  const response = await fetch("/api/sync/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_uids, dry_run, operator_id }),
  });

  if (!response.ok) {
    let data: any = null;
    try {
      data = await response.json();
    } catch {}
    const message = data?.error || data?.message || `Promotion failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
};

/**
 * Fetch sync state for a single product
 */
export const fetchSyncState = async (product_uid: string): Promise<SyncStateResponse> => {
  const response = await fetch(`/api/sync/state/${encodeURIComponent(product_uid)}`);

  if (!response.ok) {
    let data: any = null;
    try {
      data = await response.json();
    } catch {}
    const message = data?.error || data?.message || `Fetch sync state failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
};

// ============================================================================
// Capture Calibration API (Dec 2025 - Pre-CDN Image Tuning)
// ============================================================================

export interface CaptureSettings {
  camera: {
    exposure_us: number;
    analogue_gain: number;
    colour_gains: { red: number; blue: number };
    ae_enable: boolean;
    awb_enable: boolean;
  };
  stage3: {
    clahe_clip_limit: number;
    clahe_tile_size: number;
    awb_enable: boolean;
  };
  updated_at: number;
}

export interface CaptureSettingsUpdate {
  camera?: {
    exposure_us?: number;
    analogue_gain?: number;
    colour_gains?: { red?: number; blue?: number };
    ae_enable?: boolean;
    awb_enable?: boolean;
  };
  stage3?: {
    clahe_clip_limit?: number;
    clahe_tile_size?: number;
    awb_enable?: boolean;
  };
}

export type CalibrationStatus = "PENDING" | "CAPTURED" | "STAGE1" | "STAGE2" | "PROCESSED" | "EXPIRED" | "FAILED";

export interface CalibrationStatusResponse {
  id: string;
  status: CalibrationStatus;
  created_at: number;
  updated_at: number;
  raw_url?: string;
  processed_url?: string;
  error?: string;
}

export interface TestCaptureResponse {
  ok: boolean;
  calibration_id: string;
  capture_uid: string;
  status: "PENDING";
  message: string;
}

export interface TestCaptureOptions {
  camera?: {
    exposure_us?: number;
    analogue_gain?: number;
    colour_gains?: { red: number; blue: number };
    ae_enable?: boolean;
    awb_enable?: boolean;
  };
}

export interface ProcessCalibrationOptions {
  stage3?: {
    clahe_clip_limit?: number;
    clahe_tile_size?: number;
    awb_enable?: boolean;
  };
}

/**
 * Fetch global capture settings
 */
export const fetchCaptureSettings = async (): Promise<CaptureSettings> => {
  const response = await fetch("/api/capture-settings");
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Fetch capture settings failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Update global capture settings (partial update supported)
 */
export const updateCaptureSettings = async (settings: CaptureSettingsUpdate): Promise<CaptureSettings> => {
  const response = await fetch("/api/capture-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Update capture settings failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Trigger a test capture for calibration (bypasses session gating)
 * Rate limited to 1 request per 5 seconds
 */
export const triggerTestCapture = async (options?: TestCaptureOptions): Promise<TestCaptureResponse> => {
  const response = await fetch("/api/capture/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {}),
  });

  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}

    // Handle rate limiting
    if (response.status === 429) {
      const retryAfter = data?.retry_after_ms ?? 5000;
      const err: any = new Error(data?.message || "Rate limited");
      err.retryAfterMs = retryAfter;
      throw err;
    }

    const message = data?.error || data?.message || `Test capture failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
};

/**
 * Poll calibration status
 */
export const fetchCalibrationStatus = async (calibrationId: string): Promise<CalibrationStatusResponse> => {
  const response = await fetch(`/api/calibration/${encodeURIComponent(calibrationId)}/status`);
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Fetch calibration status failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Process a captured calibration image through Stage-3 pipeline
 */
export const processCalibration = async (
  calibrationId: string,
  options?: ProcessCalibrationOptions
): Promise<{ ok: boolean; status: "PROCESSED"; processed_url: string }> => {
  const response = await fetch(`/api/calibration/${encodeURIComponent(calibrationId)}/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options ?? {}),
  });
  if (!response.ok) {
    let data: any = null;
    try { data = await response.json(); } catch {}
    const message = data?.error || data?.message || `Process calibration failed: ${response.status}`;
    throw new Error(message);
  }
  return response.json();
};

/**
 * Get URL for raw calibration image
 */
export const calibrationRawImageUrl = (calibrationId: string): string =>
  `/api/calibration/${encodeURIComponent(calibrationId)}/raw`;

/**
 * Get URL for processed calibration image
 */
export const calibrationProcessedImageUrl = (calibrationId: string): string =>
  `/api/calibration/${encodeURIComponent(calibrationId)}/processed`;
