/**
 * Search Snapshot Lookup API
 *
 * Proxies to CardMint backend's POST /api/cm-admin/search/snapshot-lookup.
 * Returns deterministic pricing from TCGPlayer snapshot data.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function searchSnapshotLookup(request, response) {
  const body = request.body;

  if (!body || (!body.cardName && !body.tcgPlayerId)) {
    return response.status(400).json({
      ok: false,
      error: "At least one of cardName or tcgPlayerId is required",
    });
  }

  const result = await proxyPost("/api/cm-admin/search/snapshot-lookup", body);

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
