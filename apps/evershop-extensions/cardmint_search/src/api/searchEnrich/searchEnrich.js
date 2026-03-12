/**
 * Search Enrich API (Search Extension)
 *
 * Proxies to CardMint backend's search/enrich endpoint.
 * Returns full PPT condition pricing for a card.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function searchEnrich(request, response) {
  const body = request.body;

  if (!body || !body.cardName) {
    return response.status(400).json({
      ok: false,
      error: "Missing required field: cardName",
    });
  }

  const result = await proxyPost("/api/cm-admin/search/enrich", body);

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
