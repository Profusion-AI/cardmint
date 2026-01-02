import { posthogProxy } from "../../services/PostHogProxyService.js";
import { getDistinctId } from "../../services/hashDistinctId.js";

export default async function trackCheckoutStarted(data) {
  const distinctId = getDistinctId(data);
  if (!distinctId) return;

  await posthogProxy.captureEvent(distinctId, "checkout_started", {
    cart_id: data.cart_id,
    total: data.total,
  });
}
