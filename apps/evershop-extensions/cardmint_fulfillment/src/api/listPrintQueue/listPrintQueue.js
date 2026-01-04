/**
 * Print Queue List API
 *
 * Proxies to CardMint backend print queue list endpoint.
 * GET /admin/api/fulfillment/print-queue
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function listPrintQueue(request, response) {
  const { status, reviewStatus, limit, offset } = request.query;

  const result = await proxyGet("/api/cm-admin/print-queue", {
    status,
    reviewStatus,
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

