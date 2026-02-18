/**
 * Fulfillment Search API
 *
 * Proxies unified fulfillment search to CardMint backend.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function searchFulfillment(request, response) {
  const { q, type, limit } = request.query;

  const result = await proxyGet("/api/cm-admin/fulfillment/search", {
    q,
    type,
    limit,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json({
    ok: true,
    ...result.data,
  });
}
