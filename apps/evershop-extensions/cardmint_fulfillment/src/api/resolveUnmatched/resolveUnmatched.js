/**
 * Resolve Unmatched Tracking API
 *
 * Proxies resolution action to CardMint backend.
 * Supports 'match' (link to shipment) or 'ignore' actions.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function resolveUnmatched(request, response) {
  const { id } = request.params;
  const { action, shipmentId } = request.body;

  if (!action || !["match", "ignore"].includes(action)) {
    return response.status(400).json({
      ok: false,
      error: "action is required and must be 'match' or 'ignore'",
    });
  }

  if (action === "match" && !shipmentId) {
    return response.status(400).json({
      ok: false,
      error: "shipmentId is required when action is 'match'",
    });
  }

  const result = await proxyPost(`/api/cm-admin/marketplace/unmatched-tracking/${id}/resolve`, {
    action,
    shipmentId,
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
