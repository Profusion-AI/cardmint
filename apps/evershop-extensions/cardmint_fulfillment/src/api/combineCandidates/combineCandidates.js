/**
 * Get Combine Candidates for Marketplace Shipment
 *
 * Proxies to CardMint backend's combine-candidates endpoint.
 * GET /admin/api/fulfillment/marketplace/shipments/:id/combine-candidates
 *
 * Returns eligible parent shipments for combining with this child shipment.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function combineCandidates(request, response) {
  const { id } = request.params;

  const result = await proxyGet(
    `/api/cm-admin/marketplace/shipments/${id}/combine-candidates`
  );

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
    });
  }

  return response.status(200).json({
    ok: true,
    ...result.data,
  });
}
