import { posthogProxy } from "../../services/PostHogProxyService.js";

function getDistinctId(data) {
  if (data.customer_email) return `customer:${data.customer_email}`;
  if (data.visitor_id) return `visitor:${data.visitor_id}`;
  return null;
}

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
