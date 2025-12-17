import { posthogProxy } from "./services/PostHogProxyService.js";

export default async function bootstrap() {
  console.log("[cardmint_analytics] Initializing PostHog integration...");

  const health = await posthogProxy.checkHealth();
  if (!health.healthy) {
    console.warn(`[cardmint_analytics] PostHog health check failed: ${health.message}`);
  } else {
    console.log("[cardmint_analytics] PostHog healthy");
  }

  process.on("SIGTERM", async () => {
    await posthogProxy.shutdown();
  });

  process.on("SIGINT", async () => {
    await posthogProxy.shutdown();
  });
}
