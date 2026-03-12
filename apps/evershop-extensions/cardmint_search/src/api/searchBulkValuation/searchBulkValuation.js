/**
 * Search Bulk Valuation API
 *
 * Proxies to CardMint backend's POST /api/cm-admin/search/bulk-valuation.
 * Accepts JSON rows (client-side CSV parse) and returns matched/priced results.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function searchBulkValuation(request, response) {
  const body = request.body;

  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
    return response.status(400).json({
      ok: false,
      error: "rows array is required and must not be empty",
    });
  }

  const result = await proxyPost("/api/cm-admin/search/bulk-valuation", body);

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
