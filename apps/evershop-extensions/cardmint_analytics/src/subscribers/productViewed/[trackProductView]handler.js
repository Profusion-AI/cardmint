import { posthogProxy } from "../../services/PostHogProxyService.js";

function getDistinctId(data) {
  if (data.customer_email) return `customer:${data.customer_email}`;
  if (data.visitor_id) return `visitor:${data.visitor_id}`;
  return null;
}

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
