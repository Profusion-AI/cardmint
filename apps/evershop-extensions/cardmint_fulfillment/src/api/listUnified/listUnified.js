/**
 * Unified Fulfillment List API
 *
 * Proxies to CardMint backend's unified fulfillment endpoint.
 * Returns combined Stripe + marketplace fulfillments for dashboard.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function listUnified(request, response) {
  const { source, status, limit, offset } = request.query;

  const result = await proxyGet("/api/cm-admin/fulfillment/unified", {
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
