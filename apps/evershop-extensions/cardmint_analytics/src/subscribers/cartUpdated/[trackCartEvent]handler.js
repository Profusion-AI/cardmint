import { posthogProxy } from "../../services/PostHogProxyService.js";
import { getDistinctId } from "../../services/hashDistinctId.js";

export default async function trackCartEvent(data) {
  const distinctId = getDistinctId(data);
  if (!distinctId) return;

  await posthogProxy.captureEvent(distinctId, "cart_updated", {
    cart_id: data.cart_id,
    item_count: data.item_count,
    cart_total: data.total,
  });
}
