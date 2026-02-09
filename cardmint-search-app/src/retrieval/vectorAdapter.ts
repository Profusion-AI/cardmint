import type { RetrievalCandidate, ParsedQuery } from "./types.js";

/**
 * Lightweight TF-IDF + cosine similarity vector adapter.
 *
 * Zero external dependencies — uses in-memory term-frequency vectors
 * built from candidate text fields. Designed as an optional reranking
 * step in the search pipeline.
 *
 * Architecture note: This is a scaffold for the local-first vector path.
 * A future LanceDB or external embedding backend can implement the same
 * VectorAdapter interface without changing the pipeline.
 */

export interface VectorAdapter {
  /** Rerank candidates by vector similarity to the query. */
  rerank(query: string, candidates: RetrievalCandidate[]): RetrievalCandidate[];
}

/** Tokenize text into lowercase word tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0);
}

/** Build a TF vector (term → frequency) from tokens. */
function buildTfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  // Normalize by doc length
  const len = tokens.length || 1;
  for (const [k, v] of tf) {
    tf.set(k, v / len);
  }
  return tf;
}

/** Cosine similarity between two TF vectors. */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [k, v] of a) {
    normA += v * v;
    const bv = b.get(k);
    if (bv !== undefined) dot += v * bv;
  }
  for (const [, v] of b) {
    normB += v * v;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Build text representation of a candidate for vectorization. */
function candidateText(c: RetrievalCandidate): string {
  return [c.cardName, c.setName, c.collectorNo, c.rarity]
    .filter(Boolean)
    .join(" ");
}

/**
 * TF-IDF vector adapter using in-memory term-frequency cosine similarity.
 * No external model or embedding service required.
 */
export class TfIdfVectorAdapter implements VectorAdapter {
  rerank(query: string, candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    if (candidates.length === 0) return candidates;

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return candidates;

    const queryVec = buildTfVector(queryTokens);

    // Build IDF from candidate corpus
    const docCount = candidates.length;
    const docFreq = new Map<string, number>();
    const candidateTokenSets = candidates.map((c) => {
      const tokens = tokenize(candidateText(c));
      const uniqueTokens = new Set(tokens);
      for (const t of uniqueTokens) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
      return tokens;
    });

    // Compute IDF weights
    const idf = new Map<string, number>();
    for (const [term, df] of docFreq) {
      idf.set(term, Math.log((docCount + 1) / (df + 1)) + 1);
    }

    // Apply IDF weighting to query vector
    const queryTfIdf = new Map<string, number>();
    for (const [term, tf] of queryVec) {
      queryTfIdf.set(term, tf * (idf.get(term) ?? 1));
    }

    // Score each candidate
    const scored = candidates.map((c, i) => {
      const candTf = buildTfVector(candidateTokenSets[i]);
      const candTfIdf = new Map<string, number>();
      for (const [term, tf] of candTf) {
        candTfIdf.set(term, tf * (idf.get(term) ?? 1));
      }
      return {
        candidate: c,
        similarity: cosineSimilarity(queryTfIdf, candTfIdf),
      };
    });

    // Sort by similarity descending, preserve original order for ties
    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.map((s) => s.candidate);
  }
}
