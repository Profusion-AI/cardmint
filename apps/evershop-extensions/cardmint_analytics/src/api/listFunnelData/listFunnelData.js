import { posthogProxy } from "../../services/PostHogProxyService.js";
import { analyticsCache } from "../../services/AnalyticsCacheService.js";

const CACHE_KEY = "funnel_data_7d";

const EVENT_LABELS = {
  product_viewed: "Product Viewed",
  cart_updated: "Added to Cart",
  checkout_started: "Checkout Started",
  checkout_completed: "Order Completed",
};

function parseFunnelResponse(posthogData) {
  if (!posthogData?.results?.length) return [];
  const funnelData = posthogData.results[0];
  if (!Array.isArray(funnelData)) return [];

  return funnelData.map((step, index) => {
    const event = String(step.action_id || step.name || `step_${index}`);
    const count = Number(step.count) || 0;
    let conversionRate;
    if (index === 0) {
      conversionRate = 100;
    } else if (typeof step.conversion_rate === "number") {
      conversionRate = Math.round(step.conversion_rate * 100);
    } else {
      conversionRate = 0;
    }
    return {
      event,
      label: EVENT_LABELS[event] || step.name || event,
      count,
      conversion_rate: conversionRate,
    };
  });
}

export default async function listFunnelData(request, response) {
  const cached = analyticsCache.get(CACHE_KEY);

  if (cached) {
    return response.status(200).json({ ok: true, ...cached, source: "cached" });
  }

  if (!posthogProxy.adminEnabled) {
    return response.status(503).json({
      ok: false,
      configured: false,
      message: "PostHog admin API not configured. Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID to enable.",
      steps: [],
      period: "last_7_days",
      last_updated: new Date().toISOString(),
      source: "unavailable",
    });
  }

  const result = await posthogProxy.queryInsights("/insights/funnel/");

  if (!result.ok) {
    return response.status(502).json({
      ok: false,
      configured: true,
      message: result.reason || "PostHog API error",
      steps: [],
      period: "last_7_days",
      last_updated: new Date().toISOString(),
      source: "unavailable",
    });
  }

  const steps = parseFunnelResponse(result.data);
  const funnelData = { steps, period: "last_7_days", last_updated: new Date().toISOString() };
  analyticsCache.set(CACHE_KEY, funnelData);

  return response.status(200).json({ ok: true, ...funnelData, source: "posthog" });
}
