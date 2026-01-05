/**
 * Customer Details Lookup API
 *
 * Proxies to CardMint backend to fetch customer shipping details from Stripe.
 * On-demand PII lookup - data is NOT stored, fetched live from Stripe.
 */

import { proxyGet } from "../../services/BackendProxy.js";

export default async function getCustomer(request, response) {
  const { sessionId } = request.params;

  if (!sessionId) {
    return response.status(400).json({
      ok: false,
      error: "sessionId is required",
    });
  }

  const result = await proxyGet(`/api/cm-admin/fulfillment/${sessionId}/customer`);

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
