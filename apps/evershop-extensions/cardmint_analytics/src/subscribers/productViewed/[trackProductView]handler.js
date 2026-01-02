import { posthogProxy } from "../../services/PostHogProxyService.js";
import { getDistinctId } from "../../services/hashDistinctId.js";

export default async function trackProductView(data) {
  const distinctId = getDistinctId(data);
  if (!distinctId) return;

  await posthogProxy.captureEvent(distinctId, "product_viewed", {
    product_id: data.product_id,
    product_name: data.name,
    product_sku: data.sku,
    product_price: data.price,
    category: data.category_name,
  });
}
