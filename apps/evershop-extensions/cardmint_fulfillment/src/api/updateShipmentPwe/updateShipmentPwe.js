/**
 * Update Marketplace Shipment PWE Flag
 *
 * Proxies to CardMint backend's marketplace shipment PWE endpoint.
 * PATCH /admin/api/fulfillment/marketplace/shipments/:id/pwe
 */

import { proxyPatch } from "../../services/BackendProxy.js";

export default async function updateShipmentPwe(request, response) {
  const { id } = request.params;
  let body = request.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = null;
    }
  }

  const normalizeIsPwe = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return null;
  };

  const isPwe = normalizeIsPwe(body?.isPwe);

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
