/**
 * Fulfillment Stats API
 *
 * Proxies to CardMint backend's marketplace stats endpoint.
 * Returns combined CardMint + Marketplace fulfillment statistics.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function getStats(request, response) {
  const result = await proxyGet("/api/cm-admin/marketplace/stats");

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
