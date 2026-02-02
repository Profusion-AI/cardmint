/**
 * Uncombine Marketplace Shipment from Parent
 *
 * Proxies to CardMint backend's uncombine endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/uncombine
 *
 * Removes a child shipment from its parent shipment.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function uncombineShipment(request, response) {
  const { id } = request.params;
  const { reason } = request.body || {};

  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/uncombine`,
    { reason: reason?.trim() || undefined }
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
