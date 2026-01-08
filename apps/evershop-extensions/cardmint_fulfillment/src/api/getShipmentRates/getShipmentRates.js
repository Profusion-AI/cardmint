/**
 * Get Shipping Rates for Marketplace Shipment
 *
 * Proxies to CardMint backend's marketplace shipment rates endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/rates
 *
 * Body params:
 *   - customWeightOz: number (optional)
 *   - parcelPreset: string (optional) - "singlecard" | "multicard-bubble" | "multicard-box"
 *   - parcelLength: number (optional) - inches
 *   - parcelWidth: number (optional) - inches
 *   - parcelHeight: number (optional) - inches
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function getShipmentRates(request, response) {
  const { id } = request.params;
  const body = request.body || {};

  // Forward all parcel-related params to backend
  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/rates`,
    {
      customWeightOz: body.customWeightOz,
      parcelPreset: body.parcelPreset,
      parcelLength: body.parcelLength,
      parcelWidth: body.parcelWidth,
      parcelHeight: body.parcelHeight,
    }
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
