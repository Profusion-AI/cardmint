/**
 * Sales Summary API
 *
 * Proxies to CardMint backend's dashboard sales-summary endpoint.
 * Returns aggregate sales metrics for CardMint + marketplace orders.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function salesSummary(request, response) {
  const { start, end, source } = request.query;

  const result = await proxyGet("/api/cm-admin/dashboard/sales-summary", {
    start,
    end,
    source,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
