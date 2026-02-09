import type { SearchResult, ScoredCandidate, RetrievalPath } from "../retrieval/types.js";
import { runPipeline, type PipelineOptions } from "../retrieval/searchPipeline.js";

export interface SearchCandidate {
  id: string;
  title: string;
  confidence: number;
  source: "internal_inventory" | "canonical_index" | "reference_market";
}

export interface SearchResponse {
  query: string;
  status: "resolved" | "needs_disambiguation";
  chosen: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  sourceLabel: "internal_truth" | "reference_aggregate";
  sourceExplanation: string;
  disambiguationReason: string | null;
  retrievalPath: RetrievalPath;
}

const SOURCE_EXPLANATIONS: Record<string, string> = {
  internal_truth: "CardMint verified inventory",
  reference_aggregate: "Reference market aggregate — not a live seller listing",
};

export function rankCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  return [...candidates].sort((left, right) => right.confidence - left.confidence);
}

/**
 * Run search using DB-backed pipeline if adapters are available,
 * otherwise fall back to client-provided candidates.
 */
export function runSearch(
  query: string,
  candidates: SearchCandidate[],
  minConfidence: number,
  pipelineOptions?: PipelineOptions | null,
): SearchResponse {
  // DB-backed pipeline path
  if (pipelineOptions && (pipelineOptions.inventoryAdapter || pipelineOptions.referenceAdapter)) {
    return runPipeline(query, pipelineOptions);
  }

  // Legacy client-candidate fallback
  const ranked = rankCandidates(candidates);
  const top = ranked[0] ?? null;
  const resolved = Boolean(top && top.confidence >= minConfidence);

  // Convert legacy candidates to ScoredCandidate shape
  let scoredCandidates: ScoredCandidate[] = ranked.map((c) => ({
    id: c.id,
    cardName: c.title,
    setName: "",
    collectorNo: null,
    rarity: null,
    conditionBucket: null,
    marketPrice: null,
    imageUrl: null,
    sourceLabel: c.source === "internal_inventory" ? "internal_truth" as const : "reference_aggregate" as const,
    freshness: null,
    confidence: c.confidence,
  }));

  // Guard: enforce single-source invariant for legacy candidates
  const uniqueLabels = new Set(scoredCandidates.map((c) => c.sourceLabel));
  if (uniqueLabels.size > 1) {
    const primaryLabel = scoredCandidates[0].sourceLabel;
    scoredCandidates = scoredCandidates.filter((c) => c.sourceLabel === primaryLabel);
  }

  // Derive sourceLabel from the actual candidates, not hardcoded
  const responseLabel = resolved
    ? scoredCandidates[0].sourceLabel
    : (scoredCandidates[0]?.sourceLabel ?? "reference_aggregate");

  return {
    query,
    status: resolved ? "resolved" : "needs_disambiguation",
    chosen: resolved ? scoredCandidates[0] : null,
    candidates: resolved ? scoredCandidates.slice(0, 3) : scoredCandidates.slice(0, 5),
    sourceLabel: responseLabel,
    sourceExplanation: SOURCE_EXPLANATIONS[responseLabel],
    disambiguationReason: resolved ? null : "Confidence below threshold for client-provided candidates",
    retrievalPath: "degraded",
  };
}
