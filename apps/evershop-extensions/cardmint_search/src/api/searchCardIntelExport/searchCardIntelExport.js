/**
 * Search Card Intel Export API (Search Extension)
 *
 * Proxies to CardMint backend's search/card-intel/export endpoint.
 * Receives JSON { csv, filename } from backend and re-sends as text/csv download.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function searchCardIntelExport(request, response) {
  const { cardName, setName, collectorNo, tcgPlayerId } = request.query;

  if (!cardName) {
    return response.status(400).json({
      ok: false,
      error: "Missing required query param: cardName",
    });
  }

  const result = await proxyGet("/api/cm-admin/search/card-intel/export", {
    cardName,
    setName,
    collectorNo,
    tcgPlayerId,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  const { csv, filename } = result.data;
  response.setHeader("Content-Type", "text/csv");
  response.setHeader("Content-Disposition", `attachment; filename="${filename || "card-intel.csv"}"`);
  return response.status(200).send(csv);
}
