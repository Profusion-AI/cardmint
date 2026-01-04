/**
 * Print Queue Reprint API
 *
 * Proxies to CardMint backend reprint endpoint.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function reprintPrintQueue(request, response) {
  const { id } = request.params;

  const result = await proxyPost(`/api/cm-admin/print-queue/${id}/reprint`, {});

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

