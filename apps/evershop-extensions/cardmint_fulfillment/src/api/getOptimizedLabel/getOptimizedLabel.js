/**
 * Get Optimized Label for PL-60 Thermal Printer
 *
 * Proxies to CardMint backend's label optimization endpoint.
 * GET /admin/api/fulfillment/marketplace/shipments/:id/label/optimized
 *
 * Query params:
 * - format: "png" (default), "pdf" (print-ready), or "info" (metadata JSON)
 *
 * Returns:
 * - PNG: 812x1218 grayscale image at 203 DPI (for GIMP workflow)
 * - PDF: 4x6 inch print-ready PDF (for direct printing from browser)
 * - info: JSON metadata about the label
 */

import { proxyGet, proxyGetBinary } from "../../services/BackendProxy.js";

// Allowlist of valid formats (prevents query injection)
const VALID_FORMATS = ["png", "pdf", "info"];

export default async function getOptimizedLabel(request, response) {
  const { id } = request.params;
  const rawFormat = request.query.format || "png";

  // Validate format against allowlist
  const format = VALID_FORMATS.includes(rawFormat) ? rawFormat : "png";

  // If format=info, use JSON proxy
  if (format === "info") {
    const result = await proxyGet(
      `/api/cm-admin/marketplace/shipments/${id}/label/optimized?format=info`
    );

    if (!result.ok) {
      return response.status(result.status).json({
        ok: false,
        error: result.error,
      });
    }

    return response.status(200).json(result.data);
  }

  // For binary formats (PNG/PDF), proxy with format parameter
  const result = await proxyGetBinary(
    `/api/cm-admin/marketplace/shipments/${id}/label/optimized?format=${encodeURIComponent(format)}`
  );

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
    });
  }

  // Determine Content-Type and filename extension based on format
  // Use backend's contentType when available, fallback based on requested format
  const contentType = result.contentType || (format === "pdf" ? "application/pdf" : "image/png");
  const fileExt = format === "pdf" ? "pdf" : "png";

  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Disposition", `inline; filename="label_${id}_pl60.${fileExt}"`);
  response.setHeader("Content-Length", result.buffer.length);
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.send(result.buffer);
}
