/**
 * Update Marketplace Shipment PWE Flag
 *
 * Proxies to CardMint backend's marketplace shipment PWE endpoint.
 * PATCH /admin/api/fulfillment/marketplace/shipments/:id/pwe
 */

import { proxyPatch } from "../../services/BackendProxy.js";

export default async function updateShipmentPwe(request, response) {
  const { id } = request.params;
  const { isPwe } = request.body || {};

  if (typeof isPwe !== "boolean") {
    return response.status(400).json({
      ok: false,
      error: "isPwe must be boolean",
    });
  }

  const result = await proxyPatch(`/api/cm-admin/marketplace/shipments/${id}/pwe`, { isPwe });

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

