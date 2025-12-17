import { posthogProxy } from "../../services/PostHogProxyService.js";

function getDistinctId(data) {
  if (data.customer_email) return `customer:${data.customer_email}`;
  if (data.visitor_id) return `visitor:${data.visitor_id}`;
  return null;
}

export default async function trackCheckoutStarted(data) {
  const distinctId = getDistinctId(data);
  if (!distinctId) return;

  await posthogProxy.captureEvent(distinctId, "checkout_started", {
    cart_id: data.cart_id,
    total: data.total,
  });
}
