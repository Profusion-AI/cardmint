import type { SearchResult, ParsedQuery, ScoredCandidate, RetrievalPath } from "./types.js";
import type { InventoryAdapter } from "./inventoryAdapter.js";
import type { ReferenceAdapter } from "./referenceAdapter.js";
import type { VectorAdapter } from "./vectorAdapter.js";
import { parseQuery } from "./queryParser.js";
import { scoreCandidates } from "./confidenceScorer.js";
import { normalizeCollectorNo } from "../normalize/collectorNo.js";

export interface PipelineOptions {
  inventoryAdapter: InventoryAdapter | null;
  referenceAdapter: ReferenceAdapter | null;
  vectorAdapter?: VectorAdapter | null;
  minConfidence: number;
}

const SOURCE_EXPLANATIONS: Record<string, string> = {
  internal_truth: "CardMint verified inventory",
  reference_aggregate: "Reference market aggregate — not a live seller listing",
};

/**
 * Orchestrate search: parse → inventory → reference (conditional) → score → respond.
 *
 * Inventory-first, conditional fallback:
 * 1. Parse query
 * 2. Query inventory adapter
 * 3. Score inventory candidates
 * 4. ONLY IF inventory returns 0 candidates → query reference adapter
 * 5. Never mix inventory + reference in the same candidate list
 */
export function runPipeline(
  query: string,
  options: PipelineOptions,
): SearchResult {
  const parsed = parseQuery(query);

  // Try inventory first (if adapter available)
  if (options.inventoryAdapter) {
    const inventoryResult = options.inventoryAdapter.search(parsed);
    let inventoryCandidates = inventoryResult.candidates;

    if (inventoryCandidates.length > 0) {
      // Optional vector reranking before confidence scoring
      if (options.vectorAdapter) {
        inventoryCandidates = options.vectorAdapter.rerank(query, inventoryCandidates);
      }
      const scored = scoreCandidates(inventoryCandidates, parsed);
      return buildResult(query, parsed, scored, options.minConfidence, "internal_truth", inventoryResult.retrievalPath);
    }

    // Inventory ran but returned nothing; no reference to fall back to
    if (!options.referenceAdapter) {
      return {
        query,
        status: "needs_disambiguation",
        chosen: null,
        candidates: [],
        sourceLabel: "internal_truth",
        sourceExplanation: SOURCE_EXPLANATIONS.internal_truth,
        disambiguationReason: "No matching cards found in inventory",
        retrievalPath: "no_results",
      };
    }
  }

  // Conditional fallback to reference (only when inventory returns 0)
  if (options.referenceAdapter) {
    let referenceCandidates = options.referenceAdapter.search(parsed);
    // Optional vector reranking before confidence scoring
    if (options.vectorAdapter) {
      referenceCandidates = options.vectorAdapter.rerank(query, referenceCandidates);
    }
    const scored = scoreCandidates(referenceCandidates, parsed);
    return buildResult(query, parsed, scored, options.minConfidence, "reference_aggregate", "fallback");
  }

  // No adapters available
  return {
    query,
    status: "needs_disambiguation",
    chosen: null,
    candidates: [],
    sourceLabel: "reference_aggregate",
    sourceExplanation: SOURCE_EXPLANATIONS.reference_aggregate,
    disambiguationReason: "Search service not configured",
    retrievalPath: "degraded",
  };
}

function buildResult(
  query: string,
  parsed: ParsedQuery,
  scored: ReturnType<typeof scoreCandidates>,
  minConfidence: number,
  sourceLabel: "internal_truth" | "reference_aggregate",
  retrievalPath: RetrievalPath,
): SearchResult {
  // Dedup before result building to prevent duplicate product rows from inflating lists
  const deduped = dedupCandidates(scored);
  const top = deduped[0] ?? null;

  // Margin guard: require a gap of >= 0.15 from the top candidate to the highest-confidence
  // candidate with a *different* card identity (name+set+collector#).
  // Condition variants of the same card (NM vs LP) share the same identity — they don't
  // count as ambiguous competitors.
  const MARGIN = 0.15;
  const topIdentity = top ? cardIdentityKey(top) : null;
  const runnerUpDifferentIdentity = topIdentity
    ? (deduped.slice(1).find((c) => cardIdentityKey(c) !== topIdentity) ?? null)
    : null;
  const margin = runnerUpDifferentIdentity ? top!.confidence - runnerUpDifferentIdentity.confidence : 1;
  const resolved = Boolean(top && top.confidence >= minConfidence && margin >= MARGIN);

  return {
    query,
    status: resolved ? "resolved" : "needs_disambiguation",
    chosen: resolved ? top : null,
    candidates: resolved ? deduped.slice(0, 5) : deduped.slice(0, 10),
    sourceLabel,
    sourceExplanation: SOURCE_EXPLANATIONS[sourceLabel],
    disambiguationReason: resolved ? null : deriveDisambiguationReason(parsed, deduped, minConfidence),
    retrievalPath,
  };
}

/**
 * Card identity key without condition — used for margin comparison.
 * Two rows are the "same card" if they share name + set + collector#,
 * regardless of condition bucket.
 */
function cardIdentityKey(c: ScoredCandidate): string {
  const normNo = normalizeCollectorNo(c.collectorNo) ?? "";
  return `${c.cardName.toLowerCase()}|${c.setName.toLowerCase()}|${normNo}`;
}

/**
 * Dedup scored candidates by card identity key.
 * Key: (cardName, setName, normalizedCollectorNo, conditionBucket)
 * Keeps the highest-confidence representative per group.
 * Prevents duplicate product rows from inflating candidate lists.
 */
export function dedupCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Map<string, ScoredCandidate>();

  for (const c of candidates) {
    const normNo = normalizeCollectorNo(c.collectorNo) ?? "";
    const key = `${c.cardName.toLowerCase()}|${c.setName.toLowerCase()}|${normNo}|${(c.conditionBucket ?? "").toLowerCase()}`;

    const existing = seen.get(key);
    if (!existing || c.confidence > existing.confidence ||
        (c.confidence === existing.confidence && (c.marketPrice ?? 0) > (existing.marketPrice ?? 0))) {
      seen.set(key, c);
    }
  }

  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

function deriveDisambiguationReason(
  parsed: ParsedQuery,
  scored: ReturnType<typeof scoreCandidates>,
  minConfidence: number,
): string {
  if (scored.length === 0) {
    return "No matching candidates found";
  }

  const top = scored[0];
  const uniqueSets = new Set(scored.map((c) => c.setName.toLowerCase()));

  if (uniqueSets.size > 1 && !parsed.setName) {
    return "Multiple sets match — specify a set to narrow results";
  }

  if (!parsed.collectorNo && !parsed.setName && parsed.cardName) {
    return "Name-only query — add set or collector number for a precise match";
  }

  if (!parsed.collectorNo && parsed.setName) {
    return "No collector number provided — multiple cards in this set may match";
  }

  if (top.confidence < minConfidence) {
    return `Top candidate confidence ${(top.confidence * 100).toFixed(0)}% is below the ${(minConfidence * 100).toFixed(0)}% threshold`;
  }

  return "Unable to resolve to a single confident match";
}
