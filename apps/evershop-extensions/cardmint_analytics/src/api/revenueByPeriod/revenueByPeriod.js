/**
 * Revenue by Period API
 *
 * Proxies to CardMint backend's dashboard revenue-by-period endpoint.
 * Returns time series revenue data (daily/weekly/monthly).
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function revenueByPeriod(request, response) {
  const { start, end, granularity, source } = request.query;

  const result = await proxyGet("/api/cm-admin/dashboard/revenue-by-period", {
    start,
    end,
    granularity,
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
