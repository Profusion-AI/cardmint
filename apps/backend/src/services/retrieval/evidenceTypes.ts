import type { EvidenceSignal } from "./candidateScorer";

/**
 * Evidence bundle for operator UI
 * Computed on-demand from stored job data (extracted fields + top3 candidates)
 */
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
  // Phase 3: Inventory context for operator dedup decisions
  inventory: {
    product_sku: string | null;
    listing_sku: string | null;
    item_uid: string | null;
    product_uid: string | null;
    cm_card_id: string | null;
    scan_fingerprint: string | null;
    // Phase 5: Image pipeline state
    cdn_image_url: string | null;
    cdn_back_image_url: string | null; // Phase 2J: Two-capture workflow
    cdn_published_at: number | null;
    // Phase 6: PPT enrichment metadata
    enrichment_signals?: Record<string, unknown>;
  };
}
