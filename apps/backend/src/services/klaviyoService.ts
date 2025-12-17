/**
 * Klaviyo Service
 * Server-side event tracking for order and product events
 * Reference: docs/december/klaviyo-dec-integration.md
 */

import type { Database } from "better-sqlite3";
import type { Logger } from "pino";
import type Stripe from "stripe";
import { isIP } from "node:net";
import { runtimeConfig } from "../config";

const KLAVIYO_API_URL = "https://a.klaviyo.com/api/events";
const KLAVIYO_PROFILE_IMPORT_URL = "https://a.klaviyo.com/api/profile-import";
const KLAVIYO_REVISION = "2025-10-15";

export interface CardMintItemData {
  item_uid: string;
  product_uid: string;
  cm_card_id: string | null;
  canonical_sku: string | null;
  name: string;
  set_name: string | null;
  collector_no: string | null;
  condition: string | null;
  price_cents: number;
  image_url: string | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
}

interface KlaviyoEventLogRow {
  id: number;
  stripe_event_id: string;
  event_type: string;
  payload: string;
  status: string;
  response_code: number | null;
  error_message: string | null;
  created_at: number;
  sent_at: number | null;
}

export class KlaviyoService {
  private readonly apiKey: string;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger
  ) {
    this.apiKey = runtimeConfig.klaviyoPrivateApiKey;

    if (this.apiKey) {
      this.logger.info("Klaviyo service initialized");
    } else {
      this.logger.warn("Klaviyo API key not configured - email tracking disabled");
    }
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Track "Placed Order" event for a completed checkout session.
   * Includes all items in the order for aggregate metrics.
   * Supports Lot Builder discount tracking when lotDiscountInfo is provided.
   *
   * IMPORTANT: This should be called AFTER the sale is marked in DB.
   * Failures are logged but do not throw - webhook must always succeed.
   */
  async trackPlacedOrder(
    session: Stripe.Checkout.Session,
    items: CardMintItemData[],
    stripeEventId: string,
    lotDiscountInfo?: {
      discountPct: number;
      reasonCode: string;
      reasonTags: string[];
      reasonText: string;
    } | null
  ): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.debug("Klaviyo not configured, skipping Placed Order event");
      return;
    }

    const customerEmail = this.extractCustomerEmail(session);
    if (!customerEmail) {
      this.logger.warn(
        { sessionId: session.id },
        "No customer email found in session, skipping Klaviyo event"
      );
      return;
    }

    const valueCents = session.amount_total ?? 0;
    const valueMajor = valueCents / 100;
    const currency = (session.currency ?? "usd").toUpperCase();
    const timestamp = new Date((session.created ?? Date.now() / 1000) * 1000).toISOString();

    // Calculate subtotal before discount (sum of item prices)
    const subtotalBeforeDiscountCents = items.reduce((sum, item) => sum + item.price_cents, 0);

    const itemsPayload = items.map((item) => ({
      ItemUid: item.item_uid,
      ProductUid: item.product_uid,
      CmCardId: item.cm_card_id ?? "",
      CanonicalSku: item.canonical_sku ?? "",
      StripeProductId: item.stripe_product_id ?? `cm_item_${item.item_uid}`,
      StripePriceId: item.stripe_price_id ?? "",
      ProductName: item.name,
      SetName: item.set_name ?? "",
      CollectorNo: item.collector_no ?? "",
      Rarity: "", // Not currently tracked at item level
      Condition: item.condition ?? "",
      PriceCents: item.price_cents,
      ImageUrl: this.sanitizeImageUrl(item.image_url),
    }));

    // Build properties with optional Lot Builder discount fields
    const properties: Record<string, unknown> = {
      OrderId: session.id,
      ValueCents: valueCents,
      Currency: currency,
      ItemCount: items.length,
      SubtotalBeforeDiscountCents: subtotalBeforeDiscountCents,
      Items: itemsPayload,
    };

    // Add Lot Builder discount fields if present
    if (lotDiscountInfo && lotDiscountInfo.discountPct > 0) {
      properties.LotBuilderDiscountPct = lotDiscountInfo.discountPct;
      properties.LotBuilderReasonCode = lotDiscountInfo.reasonCode;
      properties.LotBuilderReasonTags = lotDiscountInfo.reasonTags;
      properties.LotBuilderReasonTagsCsv = lotDiscountInfo.reasonTags.join(",");
      properties.LotBuilderReasonText = lotDiscountInfo.reasonText.slice(0, 100); // Max 100 chars
    } else {
      properties.LotBuilderDiscountPct = 0;
    }

    const payload = {
      data: {
        type: "event",
        attributes: {
          metric: { data: { type: "metric", attributes: { name: "Placed Order" } } },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email: customerEmail,
                external_id: this.extractCustomerId(session) ?? undefined,
              },
            },
          },
          value: valueMajor,
          value_currency: currency,
          properties,
          unique_id: session.id,
          time: timestamp,
        },
      },
    };

    await this.sendEventWithLogging(stripeEventId, "Placed Order", payload);
  }

  /**
   * Track "Ordered Product" event for each item in an order.
   * Enables per-card analytics and recommendation flows.
   *
   * IMPORTANT: This should be called AFTER the sale is marked in DB.
   * Failures are logged but do not throw - webhook must always succeed.
   */
  async trackOrderedProduct(
    session: Stripe.Checkout.Session,
    item: CardMintItemData,
    stripeEventId: string,
    orderItemCount: number = 1
  ): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.debug("Klaviyo not configured, skipping Ordered Product event");
      return;
    }

    const customerEmail = this.extractCustomerEmail(session);
    if (!customerEmail) {
      this.logger.warn(
        { sessionId: session.id, itemUid: item.item_uid },
        "No customer email found in session, skipping Ordered Product event"
      );
      return;
    }

    const valueCents = item.price_cents;
    const valueMajor = valueCents / 100;
    const currency = (session.currency ?? "usd").toUpperCase();
    const timestamp = new Date((session.created ?? Date.now() / 1000) * 1000).toISOString();

    const payload = {
      data: {
        type: "event",
        attributes: {
          metric: { data: { type: "metric", attributes: { name: "Ordered Product" } } },
          profile: {
            data: {
              type: "profile",
              attributes: {
                email: customerEmail,
              },
            },
          },
          value: valueMajor,
          value_currency: currency,
          properties: {
            OrderId: session.id,
            ItemUid: item.item_uid,
            ProductUid: item.product_uid,
            CmCardId: item.cm_card_id ?? "",
            CanonicalSku: item.canonical_sku ?? "",
            StripeProductId: item.stripe_product_id ?? `cm_item_${item.item_uid}`,
            StripePriceId: item.stripe_price_id ?? "",
            ProductName: item.name,
            SetName: item.set_name ?? "",
            CollectorNo: item.collector_no ?? "",
            Rarity: "", // Not currently tracked at item level
            Condition: item.condition ?? "",
            PriceCents: valueCents,
            ImageUrl: this.sanitizeImageUrl(item.image_url),
            URL: this.buildProductUrl(item),
            WasPartOfLot: orderItemCount > 1,
            LotSize: orderItemCount,
          },
          unique_id: `${session.id}_${item.item_uid}`,
          time: timestamp,
        },
      },
    };

    await this.sendEventWithLogging(stripeEventId, "Ordered Product", payload);
  }

  /**
   * Phase 2: Sync a new email subscriber into Klaviyo.
   * - Upserts profile properties
   * - Subscribes profile to the configured list with marketing consent
   *
   * Fire-and-forget callers should never await this in a request/response path.
   */
  async syncSubscriber(email: string, source: string): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const listId = runtimeConfig.klaviyoSubscribeListId;
    if (!listId) {
      this.logger.warn("KLAVIYO_SUBSCRIBE_LIST_ID not configured - skipping subscriber sync");
      return;
    }

    const nowIso = new Date().toISOString();

    const profileId = await this.upsertProfile(email, {
      CmSubscribeSource: source,
      CmSubscribeAt: nowIso,
    });

    if (profileId) {
      await this.subscribeProfileToList(email, profileId, listId);
    } else {
      this.logger.error({ email: email.substring(0, 3) + "***" }, "klaviyo.profile.subscribe.skipped.no_profile_id");
    }
  }

  /**
   * Get pending/failed Klaviyo events for replay tooling.
   */
  getPendingEvents(): KlaviyoEventLogRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM klaviyo_event_log
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at ASC
    `);
    return stmt.all() as KlaviyoEventLogRow[];
  }

  /**
   * Replay a specific event by ID.
   * Returns true if successful, false otherwise.
   */
  async replayEvent(eventId: number): Promise<boolean> {
    const stmt = this.db.prepare(`SELECT * FROM klaviyo_event_log WHERE id = ?`);
    const row = stmt.get(eventId) as KlaviyoEventLogRow | undefined;

    if (!row) {
      this.logger.warn({ eventId }, "Event not found for replay");
      return false;
    }

    try {
      const payload = JSON.parse(row.payload);
      const result = await this.sendToKlaviyo(payload);

      this.updateEventStatus(
        row.id,
        result.success ? "sent" : "failed",
        result.statusCode,
        result.error
      );

      return result.success;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.updateEventStatus(row.id, "failed", null, errorMessage);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async sendEventWithLogging(
    stripeEventId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Log event to DB first (for replay capability)
    let logId: number | null = null;
    try {
      logId = this.logEvent(stripeEventId, eventType, payload, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { stripeEventId, eventType, err: message },
        "Failed to log Klaviyo event (will attempt send without replay record)"
      );
    }

    try {
      const result = await this.sendToKlaviyo(payload);

      if (logId !== null) {
        this.updateEventStatus(
          logId,
          result.success ? "sent" : "failed",
          result.statusCode,
          result.error
        );
      }

      if (result.success) {
        this.logger.info(
          { stripeEventId, eventType, logId },
          "Klaviyo event sent successfully"
        );
      } else {
        this.logger.error(
          { stripeEventId, eventType, logId, statusCode: result.statusCode, error: result.error },
          "Klaviyo event failed - logged for replay"
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (logId !== null) {
        this.updateEventStatus(logId, "failed", null, errorMessage);
      }
      this.logger.error(
        { stripeEventId, eventType, logId, err: error },
        "Klaviyo event failed (exception) - logged for replay"
      );
    }
  }

  private async sendToKlaviyo(
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; statusCode: number | null; error: string | null }> {
    return this.sendJsonApiRequest(KLAVIYO_API_URL, payload);
  }

  private async upsertProfile(email: string, properties: Record<string, unknown>): Promise<string | null> {
    const payload = {
      data: {
        type: "profile",
        attributes: {
          email,
          properties,
        },
      },
    };

    const result = await this.sendJsonApiRequest(KLAVIYO_PROFILE_IMPORT_URL, payload);
    if (result.success && result.body) {
      const profileId = (result.body as { data?: { id?: string } })?.data?.id ?? null;
      this.logger.info({ email: email.substring(0, 3) + "***", statusCode: result.statusCode, profileId }, "klaviyo.profile.upsert.ok");
      return profileId;
    } else {
      this.logger.error({ statusCode: result.statusCode, error: result.error }, "klaviyo.profile.upsert.failed");
      return null;
    }
  }

  private async subscribeProfileToList(email: string, profileId: string, listId: string): Promise<void> {
    const url = `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`;
    const payload = {
      data: [
        {
          type: "profile",
          id: profileId,
        },
      ],
    };

    const result = await this.sendJsonApiRequest(url, payload);
    if (result.success) {
      this.logger.info({ email: email.substring(0, 3) + "***", statusCode: result.statusCode, profileId }, "klaviyo.profile.subscribe.ok");
    } else {
      this.logger.error({ statusCode: result.statusCode, error: result.error, profileId }, "klaviyo.profile.subscribe.failed");
    }
  }

  private async sendJsonApiRequest(
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ success: boolean; statusCode: number | null; error: string | null; body?: unknown }> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.api+json",
          "content-type": "application/vnd.api+json",
          revision: KLAVIYO_REVISION,
          Authorization: `Klaviyo-API-Key ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const statusCode = response.status;

      // 204 No Content is success for relationship endpoints
      if (statusCode === 200 || statusCode === 201 || statusCode === 202 || statusCode === 204) {
        let body: unknown;
        if (statusCode !== 204) {
          try {
            body = await response.json();
          } catch {
            // Some endpoints return empty body on success
          }
        }
        return { success: true, statusCode, error: null, body };
      }

      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body read errors
      }

      return {
        success: false,
        statusCode,
        error: `HTTP ${statusCode}: ${errorBody.slice(0, 500)}`,
      };
    } catch (error) {
      return {
        success: false,
        statusCode: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private logEvent(
    stripeEventId: string,
    eventType: string,
    payload: Record<string, unknown>,
    now: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO klaviyo_event_log (stripe_event_id, event_type, payload, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    const result = stmt.run(stripeEventId, eventType, JSON.stringify(payload), now);
    return Number(result.lastInsertRowid);
  }

  private updateEventStatus(
    logId: number,
    status: string,
    responseCode: number | null,
    errorMessage: string | null
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const sentAt = status === "sent" ? now : null;
    const stmt = this.db.prepare(`
      UPDATE klaviyo_event_log
      SET status = ?, response_code = ?, error_message = ?, sent_at = ?
      WHERE id = ?
    `);
    stmt.run(status, responseCode, errorMessage, sentAt, logId);
  }

  private extractCustomerEmail(session: Stripe.Checkout.Session): string | null {
    // Try customer_email first (set on session creation)
    if (session.customer_email) {
      return session.customer_email;
    }

    // Try customer_details (populated after payment)
    if (session.customer_details?.email) {
      return session.customer_details.email;
    }

    // Try expanded customer object (check it's not a deleted customer)
    if (
      typeof session.customer === "object" &&
      session.customer &&
      "email" in session.customer &&
      session.customer.email
    ) {
      return session.customer.email;
    }

    return null;
  }

  private extractCustomerId(session: Stripe.Checkout.Session): string | null {
    if (typeof session.customer === "string") {
      return session.customer;
    }
    if (typeof session.customer === "object" && session.customer?.id) {
      return session.customer.id;
    }
    return null;
  }

  private sanitizeImageUrl(url: string | null): string {
    if (!url) return "";

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.logger.warn("Blocked invalid image URL from Klaviyo event");
      return "";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      this.logger.warn({ protocol: parsed.protocol }, "Blocked non-http(s) image URL from Klaviyo event");
      return "";
    }

    const rawHostname = parsed.hostname;
    const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localdomain")
    ) {
      this.logger.warn({ hostname: rawHostname }, "Blocked local hostname from Klaviyo event");
      return "";
    }

    const ipType = isIP(hostname);
    if (ipType === 4 && this.isPrivateIpv4(hostname)) {
      this.logger.warn({ hostname: rawHostname }, "Blocked private IPv4 address from Klaviyo event");
      return "";
    }

    if (ipType === 6 && this.isPrivateIpv6(hostname)) {
      this.logger.warn({ hostname: rawHostname }, "Blocked private IPv6 address from Klaviyo event");
      return "";
    }

    return url;
  }

  private isPrivateIpv4(ip: string): boolean {
    const parts = ip.split(".").map((value) => Number.parseInt(value, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return true;
    }

    const [a, b] = parts;

    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;

    return false;
  }

  private isPrivateIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();

    if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
    if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;

    // Unique local addresses: fc00::/7 (fc00..fdff)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

    // Link-local addresses: fe80::/10 (fe80..febf)
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true;
    }

    // IPv4-mapped IPv6: ::ffff:wxyz (where wxyz encodes the IPv4 address)
    if (normalized.startsWith("::ffff:") || normalized.startsWith("0:0:0:0:0:ffff:")) {
      const tail = normalized.split("ffff:")[1] ?? "";
      const parts = tail.split(":").filter(Boolean);
      if (parts.length < 2) return true;

      const hi = Number.parseInt(parts[0].padStart(4, "0"), 16);
      const lo = Number.parseInt(parts[1].padStart(4, "0"), 16);
      if (!Number.isFinite(hi) || !Number.isFinite(lo)) return true;

      const ipv4 = [
        (hi >> 8) & 0xff,
        hi & 0xff,
        (lo >> 8) & 0xff,
        lo & 0xff,
      ].join(".");

      return this.isPrivateIpv4(ipv4);
    }

    return false;
  }

  private buildProductUrl(item: CardMintItemData): string {
    // Build canonical product URL for cardmintshop.com
    // Format: /vault/{slug} where slug is derived from item data
    const baseUrl = "https://cardmintshop.com";

    // Simple slug: lowercase name with dashes, append item_uid suffix for uniqueness
    const namePart = item.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);

    const uidSuffix = item.item_uid.slice(0, 8);

    return `${baseUrl}/vault/${namePart}-${uidSuffix}`;
  }

  /**
   * Request deletion of a profile from Klaviyo.
   * Implements GDPR Article 17 (Right to Erasure) and CCPA deletion rights.
   * Uses Klaviyo's Data Privacy Deletion API.
   *
   * @param email - The email address to request deletion for
   * @returns Object with success status and message
   */
  async requestProfileDeletion(email: string): Promise<{ success: boolean; message: string }> {
    if (!this.isConfigured()) {
      return { success: false, message: "Klaviyo not configured" };
    }

    // Klaviyo's Data Privacy Deletion API endpoint
    const url = "https://a.klaviyo.com/api/data-privacy-deletion-jobs/";

    // Create deletion request per Klaviyo JSON:API spec
    const payload = {
      data: {
        type: "data-privacy-deletion-job",
        attributes: {
          profile: {
            data: {
              type: "profile",
              attributes: {
                email: email.toLowerCase().trim(),
              },
            },
          },
        },
      },
    };

    try {
      const result = await this.sendJsonApiRequest(url, payload);

      if (result.success) {
        this.logger.info(
          { email: email.substring(0, 3) + "***", statusCode: result.statusCode },
          "klaviyo.deletion.requested"
        );
        return {
          success: true,
          message: "Deletion request submitted to Klaviyo. Profile will be removed within 30 days.",
        };
      }

      // Handle specific error cases
      if (result.statusCode === 404) {
        // Profile not found - that's actually fine for deletion
        this.logger.info(
          { email: email.substring(0, 3) + "***" },
          "klaviyo.deletion.profile_not_found"
        );
        return {
          success: true,
          message: "No Klaviyo profile found for this email (already deleted or never created).",
        };
      }

      this.logger.error(
        { statusCode: result.statusCode, error: result.error },
        "klaviyo.deletion.failed"
      );
      return {
        success: false,
        message: `Deletion request failed: ${result.error ?? "Unknown error"}`,
      };
    } catch (error) {
      this.logger.error({ error }, "klaviyo.deletion.exception");
      return {
        success: false,
        message: error instanceof Error ? error.message : "Deletion request failed",
      };
    }
  }

  /**
   * Suppress a profile from all future communications without deleting data.
   * Use for unsubscribe requests that don't require full deletion.
   */
  async suppressProfile(email: string): Promise<{ success: boolean; message: string }> {
    if (!this.isConfigured()) {
      return { success: false, message: "Klaviyo not configured" };
    }

    // Use the suppressions API to add email to suppression list
    const url = "https://a.klaviyo.com/api/profile-suppression-bulk-create-jobs/";

    const payload = {
      data: {
        type: "profile-suppression-bulk-create-job",
        attributes: {
          profiles: {
            data: [
              {
                type: "profile",
                attributes: {
                  email: email.toLowerCase().trim(),
                },
              },
            ],
          },
        },
      },
    };

    try {
      const result = await this.sendJsonApiRequest(url, payload);

      if (result.success) {
        this.logger.info(
          { email: email.substring(0, 3) + "***", statusCode: result.statusCode },
          "klaviyo.suppression.ok"
        );
        return {
          success: true,
          message: "Email suppressed from all future Klaviyo communications.",
        };
      }

      this.logger.error(
        { statusCode: result.statusCode, error: result.error },
        "klaviyo.suppression.failed"
      );
      return {
        success: false,
        message: `Suppression request failed: ${result.error ?? "Unknown error"}`,
      };
    } catch (error) {
      this.logger.error({ error }, "klaviyo.suppression.exception");
      return {
        success: false,
        message: error instanceof Error ? error.message : "Suppression request failed",
      };
    }
  }
}
