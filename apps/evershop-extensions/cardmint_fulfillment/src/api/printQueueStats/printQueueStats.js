/**
 * Print Queue Stats API
 *
 * Proxies to CardMint backend print queue stats endpoint.
 * GET /admin/api/fulfillment/print-queue/stats
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function printQueueStats(request, response) {
  const result = await proxyGet("/api/cm-admin/print-queue/stats", {});

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

