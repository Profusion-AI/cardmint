/**
 * Print Queue Mark Reviewed API
 *
 * Proxies to CardMint backend review endpoint.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function markPrintQueueReviewed(request, response) {
  const { id } = request.params;

  const result = await proxyPost(`/api/cm-admin/print-queue/${id}/mark-reviewed`, {});

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

