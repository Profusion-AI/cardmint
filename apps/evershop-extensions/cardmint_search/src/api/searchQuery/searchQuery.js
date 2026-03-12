/**
 * Search Query API
 *
 * Proxies to search app's POST /api/search endpoint.
 * Transforms the backend response contract (candidates) into the UI contract (results).
 */

import { proxyPost } from "../../services/SearchProxy.js";

function confidenceBucket(score) {
  if (score == null) return "none";
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  if (score >= 0.2) return "low";
  return "none";
}

function transformCandidate(c) {
  return {
    name: c.cardName ?? c.name,
    set: c.setName ?? c.set,
    collectorNumber: c.collectorNo ?? c.collectorNumber,
    condition: c.conditionBucket ?? c.condition,
    price: c.marketPrice ?? c.price,
    confidence: typeof c.confidence === "number" ? confidenceBucket(c.confidence) : (c.confidence || "none"),
    tcgPlayerId: c.id ?? c.tcgPlayerId,
    imageUrl: c.imageUrl,
    status: c.status,
    retrievalPath: c.retrievalPath,
    disambiguation: c.disambiguationReason ? { reason: c.disambiguationReason } : c.disambiguation,
  };
}

export default async function searchQuery(request, response) {
  const body = request.body;

  if (!body || !body.query) {
    return response.status(400).json({
      ok: false,
      error: "Missing required field: query",
    });
  }

  const result = await proxyPost("/api/search", body);

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  const data = result.data;

  // If response already has `results` array, pass through (already in UI format)
  if (data.results) {
    return response.status(200).json(data);
  }

  // Transform candidates -> results
  if (data.candidates) {
    const transformed = {
      ...data,
      results: data.candidates.map(transformCandidate),
    };
    delete transformed.candidates;
    return response.status(200).json(transformed);
  }

  // Fallback: pass through as-is
  return response.status(200).json(data);
}
