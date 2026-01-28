/**
 * Order Preview API
 *
 * Lightweight preview endpoint for hover flyout on fulfillment dashboard.
 * Returns first 3 cards with images for quick-glance order identification.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function getOrderPreview(request, response) {
  const { source, id } = request.params;

  if (!source || !id) {
    return response.status(400).json({
      ok: false,
      error: "source and id are required",
    });
  }

  const result = await proxyGet(
    `/api/cm-admin/fulfillment/orders/${encodeURIComponent(source)}/${encodeURIComponent(id)}/preview`
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
