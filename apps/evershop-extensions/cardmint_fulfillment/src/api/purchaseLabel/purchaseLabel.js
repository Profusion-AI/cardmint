/**
 * Purchase Shipping Label for Marketplace Shipment
 *
 * Proxies to CardMint backend's marketplace label purchase endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/label
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function purchaseLabel(request, response) {
  const { id } = request.params;
  const { rateId } = request.body || {};

  if (!rateId) {
    return response.status(400).json({
      ok: false,
      error: "rateId is required",
    });
  }

  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/label`,
    { rateId }
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
