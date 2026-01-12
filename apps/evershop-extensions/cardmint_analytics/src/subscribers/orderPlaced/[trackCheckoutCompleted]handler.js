// DISABLED (Jan 2026, P0.4.2 analytics dedup decision):
// Frontend (CheckoutSuccess.tsx) is the canonical emitter for checkout_completed.
// Server-side emission here was causing duplicate events with different distinct_ids.
// Re-enable only if frontend tracking proves unreliable.
//
// import { posthogProxy } from "../../services/PostHogProxyService.js";
// import { getDistinctId } from "../../services/hashDistinctId.js";

export default async function trackCheckoutCompleted(/* data */) {
  // No-op: see comment above
  return;
}
