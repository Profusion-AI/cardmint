/**
 * Combine Marketplace Shipment with Parent
 *
 * Proxies to CardMint backend's combine endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/combine
 *
 * Combines a child shipment with an existing parent shipment.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function combineShipment(request, response) {
  const { id } = request.params;
  const { parentShipmentId, reason } = request.body || {};

  if (!parentShipmentId) {
    return response.status(400).json({
      ok: false,
      error: "parentShipmentId is required",
    });
  }

  if (!reason || reason.trim().length < 5) {
    return response.status(400).json({
      ok: false,
      error: "reason is required (min 5 characters)",
    });
  }

  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/combine`,
    { parentShipmentId, reason: reason.trim() }
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
