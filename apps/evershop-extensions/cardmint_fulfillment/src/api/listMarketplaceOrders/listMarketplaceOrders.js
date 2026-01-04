/**
 * Marketplace Orders List API
 *
 * Proxies to CardMint backend's marketplace orders endpoint.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function listMarketplaceOrders(request, response) {
  const { source, status, limit, offset } = request.query;

  const result = await proxyGet("/api/cm-admin/marketplace/orders", {
    source,
    status,
    limit,
    offset,
  });

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
