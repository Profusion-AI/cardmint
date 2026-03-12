/**
 * Search Health API
 *
 * Proxies to search app's GET /health endpoint.
 * Returns service status, stage, device tier, vector search, and DB connections.
 */

import { proxyGet } from "../../services/SearchProxy.js";

export default async function searchHealth(request, response) {
  const result = await proxyGet("/health");

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
