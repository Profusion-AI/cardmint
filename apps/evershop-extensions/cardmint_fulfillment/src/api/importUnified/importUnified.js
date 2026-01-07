/**
 * Unified CSV Import API
 *
 * Auto-detects CSV format and proxies to CardMint backend.
 * Supports:
 * - TCGPlayer Shipping Export (full address, label-ready)
 * - TCGPlayer Order List (no address, external fulfillment)
 * - EasyPost Tracking (tracking linkage)
 *
 * Supports dry-run mode for validation without database changes.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function importUnified(request, response) {
  const { csvData, dryRun, fileName } = request.body;

  if (!csvData || typeof csvData !== "string") {
    return response.status(400).json({
      ok: false,
      error: "csvData is required and must be a string",
    });
  }

  // Default to dry-run for safety (matches backend's dry-run by default behavior)
  const result = await proxyPost("/api/cm-admin/marketplace/import/unified", {
    csvData,
    dryRun: dryRun ?? true,
    fileName,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      // Forward human-readable message for UX (prefers message over error code)
      message: result.data?.message || result.error,
      // Include format info if available (helps debugging)
      format: result.data?.format,
      formatDisplayName: result.data?.formatDisplayName,
      detectedHeaders: result.data?.detectedHeaders,
    });
  }

  return response.status(200).json({
    ok: true,
    ...result.data,
  });
}
