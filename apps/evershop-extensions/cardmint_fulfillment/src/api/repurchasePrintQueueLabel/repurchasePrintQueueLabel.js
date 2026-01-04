/**
 * Print Queue Repurchase Label API
 *
 * Proxies to CardMint backend repurchase endpoint.
 * This may create a new charge and must be explicitly confirmed by the operator.
 */

import { proxyPost } from "../../services/BackendProxy.js";

export default async function repurchasePrintQueueLabel(request, response) {
  const { id } = request.params;
  const { confirm, repurchaseReason, overrideManualReview, overrideReason } = request.body || {};

  const result = await proxyPost(`/api/cm-admin/print-queue/${id}/repurchase-label`, {
    confirm,
    repurchaseReason,
    overrideManualReview,
    overrideReason,
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

