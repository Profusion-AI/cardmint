/**
 * TCGPlayer CSV Import API
 *
 * Proxies CSV data to CardMint backend for TCGPlayer order import.
 * Supports dry-run mode for validation without database changes.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function importTcgplayer(request, response) {
  const { csvData, dryRun } = request.body;

  if (!csvData || typeof csvData !== "string") {
    return response.status(400).json({
      ok: false,
      error: "csvData is required and must be a string",
    });
  }

  // Default to dry-run for safety (matches backend's dry-run by default behavior)
  const result = await proxyPost("/api/cm-admin/marketplace/import/tcgplayer", {
    csvData,
    dryRun: dryRun ?? true,
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
