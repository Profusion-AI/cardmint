/**
 * EasyPost Tracking CSV Import API
 *
 * Proxies CSV data to CardMint backend for EasyPost tracking import.
 * Auto-links tracking to orders where possible, queues unmatched for review.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function importEasypostTracking(request, response) {
  const { csvData, dryRun } = request.body;

  if (!csvData || typeof csvData !== "string") {
    return response.status(400).json({
      ok: false,
      error: "csvData is required and must be a string",
    });
  }

  // Default to dry-run for safety (matches backend's dry-run by default behavior)
  const result = await proxyPost("/api/cm-admin/marketplace/import/easypost-tracking", {
    csvData,
    dryRun: dryRun ?? true,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      // Forward human-readable message for UX
      message: result.data?.message || result.error,
    });
  }

  return response.status(200).json({
    ok: true,
    ...result.data,
  });
}
