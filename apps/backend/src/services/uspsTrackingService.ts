import { runtimeConfig } from "../config.js";
import type { Logger } from "pino";

const DEFAULT_USPS_TOKEN_URL = "https://apis.usps.com/oauth2/v3/token";
const DEFAULT_USPS_TRACKING_BASE_URL = "https://apis.usps.com/tracking/v3/tracking";

export interface UspsTrackingResult {
  status: string;
  deliveredAt: number | null;
  lastEventAt: number | null;
  raw: Record<string, unknown>;
}

export class UspsTrackingService {
  private token: string | null = null;
  private tokenExpiresAtMs: number | null = null;

  constructor(private logger: Logger) {}

  isConfigured(): boolean {
    return Boolean(
      runtimeConfig.uspsClientId &&
        runtimeConfig.uspsClientSecret &&
        (runtimeConfig.uspsOauthTokenUrl || DEFAULT_USPS_TOKEN_URL) &&
        (runtimeConfig.uspsTrackingBaseUrl || DEFAULT_USPS_TRACKING_BASE_URL)
    );
  }

  async getTrackingStatus(trackingNumber: string): Promise<UspsTrackingResult | null> {
    if (!this.isConfigured()) {
      this.logger.debug("USPS tracking not configured, skipping fallback");
      return null;
    }

    const token = await this.getAccessToken();
    if (!token) {
      return null;
    }

    const baseUrl = runtimeConfig.uspsTrackingBaseUrl || DEFAULT_USPS_TRACKING_BASE_URL;
    const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(trackingNumber)}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(runtimeConfig.uspsTrackingTimeoutMs),
      });

      const rawText = await response.text();
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, trackingNumber, body: rawText.slice(0, 500) },
          "USPS tracking request failed"
        );
        return null;
      }

      let payload: unknown;
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (err) {
        this.logger.warn(
          { trackingNumber, err, body: rawText.slice(0, 500) },
          "USPS tracking response was not JSON"
        );
        return null;
      }

      const parsed = parseUspsTrackingPayload(payload);
      if (!parsed) {
        this.logger.warn(
          { trackingNumber, payloadKeys: payload && typeof payload === "object" ? Object.keys(payload as any) : [] },
          "USPS tracking payload missing expected fields"
        );
        return null;
      }

      return parsed;
    } catch (err) {
      this.logger.warn({ err, trackingNumber }, "USPS tracking request error");
      return null;
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAtMs && now < this.tokenExpiresAtMs - 60_000) {
      return this.token;
    }

    const tokenUrl = runtimeConfig.uspsOauthTokenUrl || DEFAULT_USPS_TOKEN_URL;

    try {
      const body = new URLSearchParams();
      body.set("grant_type", "client_credentials");
      body.set("client_id", runtimeConfig.uspsClientId);
      body.set("client_secret", runtimeConfig.uspsClientSecret);
      if (runtimeConfig.uspsOauthScope) {
        body.set("scope", runtimeConfig.uspsOauthScope);
      }

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(runtimeConfig.uspsTrackingTimeoutMs),
      });

      const rawText = await response.text();
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, body: rawText.slice(0, 500) },
          "USPS token request failed"
        );
        return null;
      }

      let payload: any;
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (err) {
        this.logger.warn({ err, body: rawText.slice(0, 500) }, "USPS token response not JSON");
        return null;
      }

      if (!payload.access_token) {
        this.logger.warn({ payload }, "USPS token response missing access_token");
        return null;
      }

      this.token = payload.access_token as string;
      const expiresInSec = typeof payload.expires_in === "number" ? payload.expires_in : 900;
      this.tokenExpiresAtMs = now + expiresInSec * 1000;

      return this.token;
    } catch (err) {
      this.logger.warn({ err }, "USPS token request error");
      return null;
    }
  }
}

const USPS_STATUS_MAP: Array<{ match: RegExp; status: string }> = [
  { match: /delivered/i, status: "delivered" },
  { match: /out for delivery/i, status: "out_for_delivery" },
  { match: /in transit/i, status: "in_transit" },
  { match: /pre[-\s]?shipment/i, status: "pre_transit" },
  { match: /label created|shipping label created/i, status: "pre_transit" },
  { match: /accepted|shipment received|received by postal/i, status: "pre_transit" },
  { match: /return to sender|returned to sender/i, status: "return_to_sender" },
  { match: /exception|alert|undeliverable|insufficient address/i, status: "exception" },
];

function parseUspsTrackingPayload(payload: unknown): UspsTrackingResult | null {
  if (!payload || typeof payload !== "object") return null;

  const data = payload as Record<string, unknown>;
  const events = extractEvents(data);
  const statusText = firstString(
    data.statusCategory,
    data.status,
    data.statusSummary,
    data.trackingStatus,
    data.tracking_summary,
    data.summary,
    events[0]?.description,
    events[0]?.status
  );

  const normalizedStatus = normalizeUspsStatus(statusText || "");
  if (!normalizedStatus) {
    return null;
  }

  const deliveredAt = parseTimestamp(
    data.deliveredDate,
    data.deliveryDate,
    data.delivered_at,
    events.find((event) => /delivered/i.test(event.description || ""))?.timestamp
  );

  const lastEventAt = parseTimestamp(
    data.lastEventDate,
    data.last_event_at,
    events[0]?.timestamp
  );

  const raw = {
    statusCategory: data.statusCategory,
    status: data.status,
    statusSummary: data.statusSummary,
    trackingNumber: data.trackingNumber,
    events: events.slice(0, 2),
  };

  return {
    status: normalizedStatus,
    deliveredAt,
    lastEventAt,
    raw,
  };
}

function normalizeUspsStatus(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";

  for (const entry of USPS_STATUS_MAP) {
    if (entry.match.test(trimmed)) {
      return entry.status;
    }
  }

  return "unknown";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parseTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return Math.floor(parsed / 1000);
      }
    }
  }
  return null;
}

type TrackingEvent = { description?: string; status?: string; timestamp?: number | null };

function extractEvents(data: Record<string, unknown>): TrackingEvent[] {
  const candidates = [
    data.events,
    data.trackingEvents,
    data.trackEvents,
    data.event,
    data.tracking_events,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const mapped = candidate
        .map((event) => {
          if (!event || typeof event !== "object") return null;
          const entry = event as Record<string, unknown>;
          return {
            description: firstString(entry.description, entry.eventDescription, entry.event),
            status: firstString(entry.status, entry.eventStatus),
            timestamp: parseTimestamp(entry.timestamp, entry.eventDateTime, entry.eventTimestamp),
          };
        })
        .filter(Boolean) as TrackingEvent[];

      return mapped.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
  }

  return [];
}
