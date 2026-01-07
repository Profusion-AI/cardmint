/**
 * Trigger Re-match API
 *
 * Proxies manual re-match request to CardMint backend.
 * Useful when orders were imported before tracking, or to retry
 * matching after adding new orders without uploading a new CSV.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function triggerRematch(request, response) {
  const result = await proxyPost("/api/cm-admin/marketplace/rematch", {});

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
