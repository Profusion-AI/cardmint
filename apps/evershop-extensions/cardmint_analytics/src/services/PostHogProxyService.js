import { PostHog } from "posthog-node";

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST_RAW = process.env.POSTHOG_HOST || "https://us.posthog.com";
const POSTHOG_PERSONAL_API_KEY = process.env.POSTHOG_PERSONAL_API_KEY || "";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || "";

/**
 * Normalize PostHog host for admin API calls.
 * PostHog ingestion uses *.i.posthog.com, but admin API is on the app host.
 * Maps ingestion hosts to their corresponding app hosts to prevent 404s.
 */
function normalizePostHogApiHost(rawHost) {
  const fallback = "https://us.posthog.com";
  const trimmed = rawHost.trim();
  if (!trimmed) return fallback;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return fallback;
    }
  }

  const hostname = url.hostname;
  if (hostname === "i.posthog.com") {
    url.hostname = "app.posthog.com";
  } else if (hostname.endsWith(".i.posthog.com")) {
    url.hostname = hostname.replace(".i.posthog.com", ".posthog.com");
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

// Ingestion host (can be *.i.posthog.com)
const POSTHOG_INGESTION_HOST = POSTHOG_HOST_RAW;
// Admin API host (must be app host, not ingestion host)
const POSTHOG_API_HOST = normalizePostHogApiHost(POSTHOG_HOST_RAW);

class PostHogProxyService {
  constructor() {
    this.ingestionClient = null;
    this.ingestionEnabled = false;
    this.adminApiEnabled = false;

    if (POSTHOG_API_KEY) {
      this.ingestionClient = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_INGESTION_HOST,
        flushAt: 10,
        flushInterval: 10000,
      });
      this.ingestionEnabled = true;
      console.log("[cardmint_analytics] PostHog ingestion client initialized");
    } else {
      console.warn("[cardmint_analytics] POSTHOG_API_KEY not set - event capture disabled");
    }

    if (POSTHOG_PERSONAL_API_KEY && POSTHOG_PROJECT_ID) {
      this.adminApiEnabled = true;
      console.log("[cardmint_analytics] PostHog admin API enabled");
    }
  }

  get adminEnabled() {
    return this.adminApiEnabled;
  }

  async captureEvent(distinctId, event, properties = {}) {
    if (!this.ingestionEnabled || !this.ingestionClient) {
      return { ok: false, reason: "Ingestion not configured" };
    }
    try {
      this.ingestionClient.capture({
        distinctId,
        event,
        properties: { ...properties, $lib: "cardmint_analytics" },
      });
      return { ok: true };
    } catch (error) {
      console.error("[cardmint_analytics] Event capture error:", error);
      return { ok: false, reason: error.message };
    }
  }

  async queryInsights(endpoint) {
    if (!this.adminApiEnabled) {
      return { ok: false, configured: false, reason: "Admin API not configured" };
    }
    try {
      const url = `${POSTHOG_API_HOST}/api/projects/${POSTHOG_PROJECT_ID}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        return { ok: false, configured: true, reason: `PostHog API error: ${response.status}` };
      }
      const data = await response.json();
      return { ok: true, configured: true, data };
    } catch (error) {
      console.error("[cardmint_analytics] Insights query error:", error);
      return { ok: false, configured: true, reason: error.message };
    }
  }

  async checkHealth() {
    const status = {
      healthy: false,
      ingestionEnabled: this.ingestionEnabled,
      adminApiEnabled: this.adminApiEnabled,
      message: "",
    };
    if (!this.ingestionEnabled) {
      status.message = "Ingestion not configured (missing POSTHOG_API_KEY)";
      return status;
    }
    try {
      if (this.adminApiEnabled) {
        const result = await this.queryInsights("/");
        if (result.ok) {
          status.healthy = true;
          status.message = "All systems operational";
        } else {
          status.message = `Admin API check failed: ${result.reason}`;
        }
      } else {
        status.healthy = true;
        status.message = "Ingestion only (admin API not configured)";
      }
    } catch (error) {
      status.message = `Health check error: ${error.message}`;
    }
    return status;
  }

  async shutdown() {
    if (this.ingestionClient) {
      console.log("[cardmint_analytics] Shutting down PostHog client...");
      await this.ingestionClient.shutdown();
    }
  }
}

export const posthogProxy = new PostHogProxyService();
