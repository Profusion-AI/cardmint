/**
 * Search Card Intel API (Search Extension)
 *
 * Proxies to CardMint backend's search/card-intel endpoint.
 * Returns listed-vs-market comparison for a card.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function searchCardIntel(request, response) {
  const body = request.body;

  if (!body || !body.cardName) {
    return response.status(400).json({
      ok: false,
      error: "Missing required field: cardName",
    });
  }

  const result = await proxyPost("/api/cm-admin/search/card-intel", body);

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
