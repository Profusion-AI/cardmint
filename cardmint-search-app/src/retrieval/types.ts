export type RetrievalPath = "deterministic" | "fts" | "like" | "fallback" | "degraded";

export interface AdapterSearchResult {
  candidates: RetrievalCandidate[];
  retrievalPath: "deterministic" | "fts" | "like";
}

export interface ParsedQuery {
  cardName: string | null;
  setName: string | null;
  collectorNo: string | null;
  variantHint: string | null;
  raw: string;
}

export interface RetrievalCandidate {
  id: string;
  cardName: string;
  setName: string;
  collectorNo: string | null;
  rarity: string | null;
  conditionBucket: string | null;
  marketPrice: number | null;
  imageUrl: string | null;
  sourceLabel: "internal_truth" | "reference_aggregate";
  /** ISO-8601 timestamp of data freshness, or null if unknown */
  freshness: string | null;
}

export interface ScoredCandidate extends RetrievalCandidate {
  confidence: number;
}

export interface SearchResult {
  query: string;
  status: "resolved" | "needs_disambiguation";
  chosen: ScoredCandidate | null;
  candidates: ScoredCandidate[];
  sourceLabel: "internal_truth" | "reference_aggregate";
  /** Human-readable explanation of the data source for UI display */
  sourceExplanation: string;
  /** When status is needs_disambiguation, explains why. Null when resolved. */
  disambiguationReason: string | null;
  /** Which retrieval path was used (deterministic/fts/like/fallback/degraded) */
  retrievalPath: RetrievalPath;
}
