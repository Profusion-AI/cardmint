/**
 * Order Details API
 *
 * Proxies to CardMint backend order drill-in endpoint.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function getOrderDetails(request, response) {
  const { source, id } = request.params;

  if (!source || !id) {
    return response.status(400).json({
      ok: false,
      error: "source and id are required",
    });
  }

  const result = await proxyGet(
    `/api/cm-admin/fulfillment/orders/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
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

