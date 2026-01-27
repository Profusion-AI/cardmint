/**
 * Request Label Refund for Marketplace Shipment
 *
 * Proxies to CardMint backend's marketplace label refund endpoint.
 * POST /admin/api/fulfillment/marketplace/shipments/:id/refund
 *
 * EasyPost refunds the postage if the label hasn't been scanned.
 * USPS: Must be within 30 days and not scanned.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function refundLabel(request, response) {
  const { id } = request.params;

  const result = await proxyPost(
    `/api/cm-admin/marketplace/shipments/${id}/refund`,
    {}
  );

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      ...(result.data?.refundStatus && { refundStatus: result.data.refundStatus }),
    });
  }

  return response.status(200).json({
    ok: true,
    ...result.data,
  });
}
