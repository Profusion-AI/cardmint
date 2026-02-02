/**
 * Discount Analysis API
 *
 * Proxies to CardMint backend's dashboard discount-analysis endpoint.
 * Returns discount/promo code usage analytics.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function discountAnalysis(request, response) {
  const { start, end } = request.query;

  const result = await proxyGet("/api/cm-admin/dashboard/discount-analysis", {
    start,
    end,
  });

  if (!result.ok) {
    return response.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.data?.message,
    });
  }

  return response.status(200).json(result.data);
}
