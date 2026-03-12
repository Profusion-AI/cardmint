import type { ParsedQuery, RetrievalCandidate, ScoredCandidate } from "./types.js";
import { normalizeCollectorNo } from "../normalize/collectorNo.js";

/** Strip trailing parenthetical: "Base Set (Shadowless)" → "base set" */
export function normalizeSetName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

/**
 * Score a retrieval candidate against a parsed query.
 *
 * | Signal                      | Weight |
 * |-----------------------------|--------|
 * | Exact card name match       | +0.45  |
 * | Partial name (contains)     | +0.30  |
 * | Exact set match             | +0.25  |
 * | Exact collector_no match    | +0.30  |
 */
export function scoreCandidate(
  candidate: RetrievalCandidate,
  parsed: ParsedQuery,
): ScoredCandidate {
  let confidence = 0;

  // Card name scoring
  if (parsed.cardName) {
    const queryName = parsed.cardName.toLowerCase();
    const candidateName = candidate.cardName.toLowerCase();

    if (candidateName === queryName) {
      confidence += 0.45;
    } else if (candidateName.includes(queryName) || queryName.includes(candidateName)) {
      confidence += 0.30;
    }
  }

  // Set name scoring — normalize away parentheticals so "Base Set" matches "Base Set (Shadowless)"
  if (parsed.setName) {
    const normQuery = normalizeSetName(parsed.setName);
    const normCandidate = normalizeSetName(candidate.setName);
    if (normCandidate === normQuery) {
      confidence += 0.25;
    }
  }

  // Collector number scoring
  if (parsed.collectorNo) {
    const normalizedCandidate = normalizeCollectorNo(candidate.collectorNo);
    if (normalizedCandidate === parsed.collectorNo) {
      confidence += 0.30;
    }
  }

  // Variant qualifier penalty: if user specified a variant (e.g. "shadowless")
  // and the candidate's card/set name doesn't contain it, penalize to force disambiguation
  if (parsed.variantHint) {
    const hint = parsed.variantHint.toLowerCase();
    const candidateText = `${candidate.cardName} ${candidate.setName}`.toLowerCase();
    if (!candidateText.includes(hint)) {
      confidence -= 0.20;
    }
  }

  // Clamp to [0, 1]
  confidence = Math.min(1, Math.max(0, confidence));

  return { ...candidate, confidence };
}

export function scoreCandidates(
  candidates: RetrievalCandidate[],
  parsed: ParsedQuery,
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, parsed))
    .sort((a, b) => b.confidence - a.confidence);
}
