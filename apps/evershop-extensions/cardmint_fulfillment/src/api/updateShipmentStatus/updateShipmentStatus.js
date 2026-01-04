/**
 * Update Marketplace Shipment Status
 *
 * Proxies to CardMint backend's marketplace shipment status endpoint.
 * PATCH /admin/api/fulfillment/marketplace/shipments/:id/status
 */

import { proxyPatch } from "../../services/BackendProxy.js";

export default async function updateShipmentStatus(request, response) {
  const { id } = request.params;
  const { status, notes, labelUrl } = request.body || {};

  if (!status) {
    return response.status(400).json({
      ok: false,
      error: "status is required",
    });
  }

  const result = await proxyPatch(
    `/api/cm-admin/marketplace/shipments/${id}/status`,
    { status, notes, labelUrl }
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
