/**
 * Search Scorecard API
 *
 * Proxies to search app's GET /api/scorecard endpoint.
 * Returns KPI metrics: query count, resolution rate, latency, confidence distribution.
 */

import { proxyGet } from "../../services/SearchProxy.js";

export default async function searchScorecard(request, response) {
  const result = await proxyGet("/api/scorecard");

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
