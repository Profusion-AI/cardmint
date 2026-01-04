/**
 * Get Shipping Rates for Marketplace Shipment
 *
 * Proxies to CardMint backend's marketplace shipment rates endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/rates
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function getShipmentRates(request, response) {
  const { id } = request.params;
  const { customWeightOz } = request.body || {};

  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/rates`,
    { customWeightOz }
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
