import { posthogProxy } from "../../services/PostHogProxyService.js";
import { getDistinctId } from "../../services/hashDistinctId.js";

export default async function trackCheckoutCompleted(data) {
  const distinctId = getDistinctId(data);
  if (!distinctId) return;

  await posthogProxy.captureEvent(distinctId, "checkout_completed", {
    order_id: data.order_id,
    order_number: data.order_number,
    total: data.grand_total,
    currency: data.currency,
  });
}
