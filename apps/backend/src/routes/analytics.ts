/**
 * Analytics Router
 *
 * Dec 2025: PostHog proxy for Operator Workbench analytics tab.
 * Proxies PostHog API queries to avoid exposing credentials to the frontend.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { TERMINAL_STATES } from "../domain/job";

interface PostHogConfig {
  apiKey: string;
  personalApiKey: string;
  host: string;
  projectId: string;
}

function normalizePostHogApiHost(rawHost: string): string {
  const fallback = "https://us.posthog.com";
  const trimmed = rawHost.trim();
  if (!trimmed) return fallback;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return fallback;
    }
  }

  // PostHog capture commonly uses `*.i.posthog.com` (ingestion). The API endpoints live on the app host.
  // Map ingestion hosts to their corresponding app hosts to prevent silent 404s.
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

function getPostHogConfig(): PostHogConfig | null {
  const apiKey = process.env.POSTHOG_API_KEY ?? "";
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY ?? "";
  const host = normalizePostHogApiHost(process.env.POSTHOG_HOST ?? "https://us.posthog.com");
  const projectId = process.env.POSTHOG_PROJECT_ID ?? "";

  if (!apiKey || !personalApiKey || !projectId) {
    return null;
  }

  return { apiKey, personalApiKey, host, projectId };
}

export function registerAnalyticsRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, sessionService } = ctx;

  const terminalStatusPlaceholders = TERMINAL_STATES.map(() => "?").join(", ");

  const requireActiveOperatorSession = (res: Response): boolean => {
    const activeSession = sessionService.getActiveSession();
    if (!activeSession || activeSession.status !== "RUNNING") {
      res.status(409).json({
        ok: false,
        error: "Session not active",
        message: "Start a session (RUNNING state) before using analytics",
        current_status: activeSession?.status ?? "PREP",
      });
      return false;
    }
    return true;
  };

  // Check PostHog configuration status
  app.get("/api/analytics/status", (_req: Request, res: Response) => {
    if (!requireActiveOperatorSession(res)) return;
    const config = getPostHogConfig();
    res.json({
      configured: config !== null,
      host: config?.host ?? null,
      projectId: config?.projectId ? `${config.projectId.slice(0, 4)}...` : null,
    });
  });

  // Get daily pulse metrics (local DB stats + PostHog insights)
  app.get("/api/analytics/pulse", async (_req: Request, res: Response) => {
    if (!requireActiveOperatorSession(res)) return;
    try {
      const config = getPostHogConfig();
      const now = new Date();
      // scans.created_at is INTEGER epoch millis (see apps/backend/cardmint_dev.db schema)
      const todayStartEpochMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      // Local metrics from cardmint_dev.db
      const scansToday = db
        .prepare(
          `SELECT COUNT(*) as count FROM scans
           WHERE created_at >= ?`
        )
        .get(todayStartEpochMs) as { count: number };

      const acceptedToday = db
        .prepare(
          `SELECT COUNT(*) as count FROM scans
           WHERE status = 'ACCEPTED' AND created_at >= ?`
        )
        .get(todayStartEpochMs) as { count: number };

      const totalScans = db
        .prepare(`SELECT COUNT(*) as count FROM scans`)
        .get() as { count: number };

      const totalAccepted = db
        .prepare(`SELECT COUNT(*) as count FROM scans WHERE status = 'ACCEPTED'`)
        .get() as { count: number };

      const queueDepth = db
        .prepare(
          `SELECT COUNT(*) as count FROM scans
           WHERE status NOT IN (${terminalStatusPlaceholders})`
        )
        .get(...TERMINAL_STATES) as { count: number };

      const pathACount = db
        .prepare(
          `SELECT COUNT(*) as count FROM scans
           WHERE inference_path = 'openai' AND created_at >= ?`
        )
        .get(todayStartEpochMs) as { count: number };

      const pathBCount = db
        .prepare(
          `SELECT COUNT(*) as count FROM scans
           WHERE inference_path = 'lmstudio' AND created_at >= ?`
        )
        .get(todayStartEpochMs) as { count: number };

      // Calculate acceptance rate
      const acceptanceRateToday =
        scansToday.count > 0
          ? Math.round((acceptedToday.count / scansToday.count) * 100)
          : 0;

      const acceptanceRateAllTime =
        totalScans.count > 0
          ? Math.round((totalAccepted.count / totalScans.count) * 100)
          : 0;

      // PostHog funnel data (if configured)
      let funnelData = null;
      if (config) {
        try {
          funnelData = await fetchPostHogFunnel(config, logger);
        } catch (err) {
          logger.warn({ err }, "Failed to fetch PostHog funnel data");
        }
      }

      res.json({
        ok: true,
        local: {
          scansToday: scansToday.count,
          acceptedToday: acceptedToday.count,
          acceptanceRateToday,
          totalScans: totalScans.count,
          totalAccepted: totalAccepted.count,
          acceptanceRateAllTime,
          queueDepth: queueDepth.count,
          pathAToday: pathACount.count,
          pathBToday: pathBCount.count,
        },
        posthog: funnelData,
        timestamp: now.toISOString(),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to fetch analytics pulse");
      res.status(500).json({ ok: false, error: "Failed to fetch analytics" });
    }
  });

  // Proxy PostHog insights query
  app.get("/api/analytics/funnel", async (_req: Request, res: Response) => {
    if (!requireActiveOperatorSession(res)) return;
    const config = getPostHogConfig();

    if (!config) {
      return res.status(503).json({
        ok: false,
        configured: false,
        message: "PostHog not configured. Set POSTHOG_API_KEY, POSTHOG_PERSONAL_API_KEY, and POSTHOG_PROJECT_ID.",
      });
    }

    try {
      const funnelData = await fetchPostHogFunnel(config, logger);
      res.json({
        ok: true,
        configured: true,
        ...funnelData,
      });
    } catch (error) {
      logger.error({ err: error }, "PostHog funnel query failed");
      res.status(502).json({
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : "PostHog query failed",
      });
    }
  });

  // Get recent events from PostHog
  app.get("/api/analytics/events", async (req: Request, res: Response) => {
    if (!requireActiveOperatorSession(res)) return;
    const config = getPostHogConfig();

    if (!config) {
      return res.status(503).json({
        ok: false,
        configured: false,
        message: "PostHog not configured",
      });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const event = req.query.event as string | undefined;

    try {
      const url = new URL(`${config.host}/api/projects/${config.projectId}/events`);
      url.searchParams.set("limit", String(limit));
      if (event) {
        url.searchParams.set("event", event);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${config.personalApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`PostHog API error: ${response.status}`);
      }

      const data = await response.json();
      res.json({
        ok: true,
        configured: true,
        events: data.results ?? [],
        next: data.next ?? null,
      });
    } catch (error) {
      logger.error({ err: error }, "PostHog events query failed");
      res.status(502).json({
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : "PostHog query failed",
      });
    }
  });
}

async function fetchPostHogFunnel(
  config: PostHogConfig,
  logger: AppContext["logger"]
): Promise<{
  steps: Array<{ name: string; count: number; conversionRate: number }>;
  period: string;
  lastUpdated: string;
  source: "posthog";
} | null> {
  // Minimal funnel-like view: event volume per step (last 7 days).
  // NOTE: This is not a true PostHog funnel query (which would require Query/Insights API wiring).
  const funnelEvents = [
    "product_viewed",
    "product_added_to_cart",
    "checkout_started",
    "checkout_completed",
  ];

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Fetch counts for each event type
  const steps: Array<{ name: string; count: number; conversionRate: number }> = [];

  for (const eventName of funnelEvents) {
    try {
      const queryUrl = new URL(`${config.host}/api/projects/${config.projectId}/events`);
      queryUrl.searchParams.set("event", eventName);
      queryUrl.searchParams.set("after", weekAgo.toISOString());
      queryUrl.searchParams.set("limit", "1");

      const response = await fetch(queryUrl.toString(), {
        headers: {
          Authorization: `Bearer ${config.personalApiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        logger.warn({ eventName, status: response.status }, "Failed to fetch event count");
        steps.push({ name: eventName, count: 0, conversionRate: 0 });
        continue;
      }

      // PostHog doesn't give us a direct count endpoint in the basic API
      // Prefer DRF-style pagination count when available.
      const data = await response.json();
      const count = typeof data.count === "number" ? data.count : (data.results?.length ?? 0);

      // Calculate conversion rate from previous step
      const prevCount = steps.length > 0 ? steps[steps.length - 1].count : count;
      const conversionRate = prevCount > 0 ? Math.round((count / prevCount) * 100) : 100;

      steps.push({
        name: eventName,
        count,
        conversionRate,
      });
    } catch (err) {
      logger.warn({ err, eventName }, "Error fetching event");
      steps.push({ name: eventName, count: 0, conversionRate: 0 });
    }
  }

  return {
    steps,
    period: "last_7_days",
    lastUpdated: now.toISOString(),
    source: "posthog",
  };
}
