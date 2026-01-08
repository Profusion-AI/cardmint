/**
 * Fulfillment Routes - Operator endpoints for shipping label generation
 *
 * **SECURITY:** All endpoints require Bearer auth (CARDMINT_ADMIN_API_KEY).
 * Mounted at /api/cm-admin/fulfillment/* (not /api/fulfillment).
 *
 * POST /api/cm-admin/fulfillment/:sessionId/rates           - Get EasyPost rates for an order
 * POST /api/cm-admin/fulfillment/:sessionId/label           - Purchase shipping label
 * PATCH /api/cm-admin/fulfillment/:sessionId/status         - Update fulfillment status
 * POST /api/cm-admin/fulfillment/:sessionId/review          - Complete manual review
 * POST /api/cm-admin/fulfillment/:sessionId/resend-tracking - Resend tracking email (PR3)
 * GET /api/cm-admin/fulfillment/:sessionId                  - Get fulfillment details
 * GET /api/cm-admin/fulfillment                             - List pending fulfillments
 *
 * Guardrails (per Kyle's requirements):
 * - Auth required: Bearer token validated via requireAdminAuth middleware
 * - Operator ID: X-CardMint-Operator header (or Basic Auth username for backward compat)
 * - Audit logging: Every action logged with operatorId, clientIp, userAgent
 * - Method matching: Only allow rates compatible with checkout shipping method
 * - Manual review gate: Block label purchase if requires_manual_review=1 unless override
 * - Override gating: overrideManualReview requires operatorId + overrideReason
 * - Idempotency: Safe to retry label purchase (stores shipment ID, checks status)
 * - PII: Never persist shipping address (fetched from Stripe at label time)
 */

import { Router, type Express, type Request, type Response } from "express";
import type { AppContext } from "../app/context.js";
import type { ShippingMethod } from "../domain/shipping.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import type { EasyPostAddress } from "../services/easyPostService.js";
import { PrintQueueRepository } from "../repositories/printQueueRepository.js";
import { decryptJson } from "../utils/encryption.js";
import { formatTcgplayerOrderNumber } from "../utils/orderNumberFormat.js";

interface FulfillmentRow {
  id: number;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  item_count: number;
  original_subtotal_cents: number;
  final_subtotal_cents: number;
  shipping_method: ShippingMethod;
  shipping_cost_cents: number;
  requires_manual_review: number;
  manual_review_completed_at: number | null;
  manual_review_notes: string | null;
  manual_review_by: string | null;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shippo_transaction_id: string | null;
  shippo_rate_id: string | null;
  easypost_shipment_id: string | null;
  easypost_rate_id: string | null;
  easypost_service: string | null;
  label_url: string | null;
  label_cost_cents: number | null;
  label_purchased_at: number | null;
  shipped_at: number | null;
  estimated_delivery_date: string | null;
  delivered_at: number | null;
  exception_type: string | null;
  exception_notes: string | null;
  exception_at: number | null;
  // Phase 5: Concurrency lock for label purchase (prevents double-spend)
  label_purchase_in_progress: number;
  label_purchase_locked_at: number | null;
  created_at: number;
  updated_at: number;
  // PR3: Added from LEFT JOIN with orders table
  order_number: string | null;
  order_uid: string | null;
}

/**
 * Unified fulfillment row from marketplace_shipments + marketplace_orders JOIN
 */
interface MarketplaceShipmentRow {
  // From marketplace_shipments
  shipment_id: number;
  shipment_sequence: number;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  label_cost_cents: number | null;
  label_purchased_at: number | null;
  shipment_status: string;
  shipped_at: number | null;
  delivered_at: number | null;
  exception_type: string | null;
  exception_notes: string | null;
  shipment_created_at: number;
  is_external: number; // 0 = CardMint-fulfilled, 1 = External/TCGPlayer-fulfilled
  // From marketplace_orders
  order_id: number;
  source: string;
  external_order_id: string;
  display_order_number: string;
  customer_name: string;
  order_date: number;
  item_count: number;
  product_value_cents: number;
  shipping_fee_cents: number;
  shipping_method: string | null;
  order_status: string;
  import_format: string | null; // 'shipping_export' | 'orderlist'
}

interface MarketplaceOrderDetailRow {
  id: number;
  source: "tcgplayer" | "ebay";
  external_order_id: string;
  display_order_number: string;
  customer_name: string;
  order_date: number;
  item_count: number;
  product_value_cents: number;
  shipping_fee_cents: number;
  shipping_method: string | null;
  status: string;
  import_format: string | null;
  created_at: number;
  updated_at: number;
}

interface MarketplaceShipmentDetailRow {
  id: number;
  marketplace_order_id: number;
  shipment_sequence: number;
  shipping_address_encrypted: string | null;
  shipping_zip: string | null;
  address_expires_at: number | null;
  easypost_shipment_id: string | null;
  easypost_rate_id: string | null;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  label_cost_cents: number | null;
  label_purchased_at: number | null;
  status: string;
  shipped_at: number | null;
  delivered_at: number | null;
  exception_type: string | null;
  exception_notes: string | null;
  tracking_match_confidence: string | null;
  tracking_matched_at: number | null;
  tracking_matched_by: string | null;
  is_external: number;
  created_at: number;
  updated_at: number;
}

interface MarketplaceShippingAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/**
 * Unified response shape for dashboard (works for both Stripe and marketplace)
 */
interface UnifiedFulfillment {
  id: string;                    // 'stripe:{sessionId}' or 'mp:{shipmentId}'
  source: "cardmint" | "tcgplayer" | "ebay";
  orderNumber: string;
  customerName: string | null;   // Available for marketplace, null for CardMint (PII)
  itemCount: number;
  valueCents: number;
  shippingCostCents: number;
  shippingMethod: string | null;
  status: string;
  isExternal: boolean;           // True = External fulfillment (no CardMint label), false = CardMint-fulfilled
  importFormat?: string | null;  // 'shipping_export' | 'orderlist' (for marketplace debugging)
  shipping: {
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    service: string | null;
    labelUrl: string | null;
    labelCostCents: number | null;
    labelPurchasedAt: number | null;
  };
  timeline: {
    createdAt: number;
    shippedAt: number | null;
    deliveredAt: number | null;
  };
  exception: {
    type: string | null;
    notes: string | null;
  } | null;
  sourceRef: {
    stripeSessionId?: string;
    marketplaceOrderId?: number;
    shipmentId?: number;
    externalOrderId?: string;
  };
}

// Statuses visible in admin list (includes worker-managed statuses)
const FILTER_STATUSES = ["pending", "processing", "reviewed", "label_purchased", "shipped", "delivered", "exception"];

// Statuses operators can manually set via PATCH (excludes `processing` - worker-only)
const OPERATOR_SETTABLE_STATUSES = ["pending", "reviewed", "label_purchased", "shipped", "delivered", "exception"];

/**
 * Extract operator ID from Basic Auth header
 * Returns null if missing or invalid
 */
function extractBasicAuthUser(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [username] = decoded.split(":");
    return username || null;
  } catch {
    return null;
  }
}

/**
 * Get client IP from request (handles X-Forwarded-For behind nginx)
 */
function extractClientIp(
  xForwardedFor: string | undefined,
  remoteAddress: string | undefined
): string | null {
  if (xForwardedFor) {
    return xForwardedFor.split(",")[0].trim();
  }
  return remoteAddress || null;
}

/**
 * Register fulfillment routes on the Express app
 * All routes mounted under /api/cm-admin/fulfillment (operator-only)
 */
export function registerFulfillmentRoutes(app: Express, ctx: AppContext): void {
  const router = Router();
  const { db, logger, stripeService, easyPostService, emailOutboxRepo } = ctx;
  const printQueueRepo = new PrintQueueRepository(db, logger);

  // Mount at /api/cm-admin/fulfillment/* (NOT /api/fulfillment - that would be public)
  app.use("/api/cm-admin/fulfillment", router);

  /**
   * Auth middleware applied to all routes (two-layer):
   * 1. requireAdminAuth - validates Bearer token against CARDMINT_ADMIN_API_KEY
   * 2. Audit context - extracts operator ID, client IP, user agent for logging
   *
   * Operator ID can be provided via:
   * - X-CardMint-Operator header (preferred)
   * - Basic Auth username (backward compat for audit logging only)
   * Defaults to "unknown" if neither provided.
   */
  router.use(requireAdminAuth);

  router.use((req: Request, res: Response, next) => {
    // Extract operator identity (for audit logging only - auth already validated)
    const basicAuthUser = extractBasicAuthUser(req.headers.authorization);
    const operatorHeader = req.headers["x-cardmint-operator"] as string | undefined;
    const operatorId = operatorHeader || basicAuthUser || "unknown";

    // Attach audit context to request for handlers
    (req as any).auditContext = {
      operatorId,
      clientIp: extractClientIp(req.headers["x-forwarded-for"] as string, req.socket.remoteAddress),
      userAgent: req.headers["user-agent"] ?? null,
    };

    next();
  });

  /**
   * GET /api/cm-admin/fulfillment
   * List fulfillments with optional status filter
   */
  router.get("/", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    logger.info(
      { operatorId, clientIp, userAgent, action: "list", status, limit, offset },
      "fulfillment.list"
    );

    // PR3: LEFT JOIN to orders table for order_number (gracefully handles pre-orders-table records)
    let query = `
      SELECT f.*, o.order_number, o.order_uid
      FROM fulfillment f
      LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
    `;
    const params: (string | number)[] = [];

    if (status && FILTER_STATUSES.includes(status)) {
      query += " WHERE f.status = ?";
      params.push(status);
    }

    query += " ORDER BY f.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const rows = db.prepare(query).all(...params) as FulfillmentRow[];
      const countQuery = status
        ? "SELECT COUNT(*) as total FROM fulfillment WHERE status = ?"
        : "SELECT COUNT(*) as total FROM fulfillment";
      const countRow = status
        ? (db.prepare(countQuery).get(status) as { total: number })
        : (db.prepare(countQuery).get() as { total: number });

      res.json({
        fulfillments: rows.map(formatFulfillmentResponse),
        total: countRow.total,
        limit,
        offset,
      });
    } catch (err) {
      logger.error({ err, operatorId }, "Failed to list fulfillments");
      res.status(500).json({ error: "Failed to list fulfillments" });
    }
  });

  /**
   * GET /api/cm-admin/fulfillment/unified
   * Combined view of Stripe fulfillment + marketplace shipments
   *
   * Query params:
   * - source: 'all' | 'cardmint' | 'tcgplayer' | 'ebay' (default: 'all')
   * - status: filter by status (pending, shipped, delivered, etc.)
   * - limit: max results (default: 50, max: 100)
   * - offset: pagination offset (default: 0)
   *
   * Returns unified response shape for dashboard consumption.
   */
  router.get("/unified", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const source = (req.query.source as string) || "all";
    let status = req.query.status as string | undefined;
    if (status === "all" || status === "any" || status === "") {
      status = undefined;
    }
    const requestedLimit = parseInt(req.query.limit as string);
    const limit = Math.min(!isNaN(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50, 100);
    const requestedOffset = parseInt(req.query.offset as string);
    const offset = !isNaN(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

    logger.info(
      { operatorId, clientIp, userAgent, action: "unified.list", source, status, limit, offset },
      "fulfillment.unified.list"
    );

    try {
      const validSources = new Set(["all", "cardmint", "tcgplayer", "ebay"]);
      if (!validSources.has(source)) {
        return res.status(400).json({
          error: "BAD_REQUEST",
          message: "source must be one of: all, cardmint, tcgplayer, ebay",
        });
      }

      // Union of Stripe fulfillment statuses + marketplace shipment statuses.
      // Note: Status filtering is strict to avoid accidentally ignoring filters.
      const validUnifiedStatuses = new Set([
        "pending",
        "processing",
        "reviewed",
        "label_purchased",
        "shipped",
        "in_transit",
        "delivered",
        "exception",
      ]);
      if (status && !validUnifiedStatuses.has(status)) {
        return res.status(400).json({
          error: "BAD_REQUEST",
          message:
            "status must be one of: pending, processing, reviewed, label_purchased, shipped, in_transit, delivered, exception",
        });
      }

      const results: UnifiedFulfillment[] = [];
      let stripeTotal = 0;
      let marketplaceTotal = 0;
      const maxFetch = offset + limit;

      // Query Stripe fulfillments (source='cardmint' or 'all')
      if (source === "all" || source === "cardmint") {
        // If a marketplace-only status is requested, Stripe should contribute zero rows.
        if (status && !FILTER_STATUSES.includes(status)) {
          stripeTotal = 0;
        } else {
        let stripeQuery = `
          SELECT f.*, o.order_number, o.order_uid
          FROM fulfillment f
          LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
        `;
        const stripeParams: (string | number)[] = [];

        if (status && FILTER_STATUSES.includes(status)) {
          stripeQuery += " WHERE f.status = ?";
          stripeParams.push(status);
        }

        // Fetch only what we need for merged pagination: top (offset+limit) from each source.
        const stripeRows = db
          .prepare(stripeQuery + " ORDER BY f.created_at DESC LIMIT ?")
          .all(...stripeParams, maxFetch) as FulfillmentRow[];

        // Count for this source
        const stripeCountQuery = status
          ? "SELECT COUNT(*) as total FROM fulfillment WHERE status = ?"
          : "SELECT COUNT(*) as total FROM fulfillment";
        const stripeCountRow = status
          ? (db.prepare(stripeCountQuery).get(status) as { total: number })
          : (db.prepare(stripeCountQuery).get() as { total: number });
        stripeTotal = stripeCountRow.total;

        // Transform Stripe rows to unified shape
        for (const row of stripeRows) {
          results.push(formatStripeToUnified(row));
        }
        }
      }

      // Query marketplace shipments (source='tcgplayer', 'ebay', or 'all')
      if (source === "all" || source === "tcgplayer" || source === "ebay") {
        let mpQuery = `
          SELECT
            ms.id as shipment_id,
            ms.shipment_sequence,
            ms.carrier,
            ms.service,
            ms.tracking_number,
            ms.tracking_url,
            ms.label_url,
            ms.label_cost_cents,
            ms.label_purchased_at,
            ms.status as shipment_status,
            ms.shipped_at,
            ms.delivered_at,
            ms.exception_type,
            ms.exception_notes,
            ms.created_at as shipment_created_at,
            ms.is_external,
            mo.id as order_id,
            mo.source,
            mo.external_order_id,
            mo.display_order_number,
            mo.customer_name,
            mo.order_date,
            mo.item_count,
            mo.product_value_cents,
            mo.shipping_fee_cents,
            mo.shipping_method,
            mo.status as order_status,
            mo.import_format
          FROM marketplace_shipments ms
          JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
        `;
        const mpParams: (string | number)[] = [];
        const conditions: string[] = [];

        // Filter by source if specific marketplace requested
        if (source !== "all") {
          conditions.push("mo.source = ?");
          mpParams.push(source);
        }

        // Filter by status (match against shipment status)
        if (status) {
          // Map common statuses to marketplace shipment statuses
          const mpStatusMap: Record<string, string[]> = {
            pending: ["pending"],
            label_purchased: ["label_purchased"],
            shipped: ["shipped", "in_transit"],
            delivered: ["delivered"],
            exception: ["exception"],
          };
          const mappedStatuses = mpStatusMap[status] || [status];
          conditions.push(`ms.status IN (${mappedStatuses.map(() => "?").join(", ")})`);
          mpParams.push(...mappedStatuses);
        }

        if (conditions.length > 0) {
          mpQuery += " WHERE " + conditions.join(" AND ");
        }

        mpQuery += " ORDER BY ms.created_at DESC LIMIT ?";

        const mpRows = db.prepare(mpQuery).all(...mpParams, maxFetch) as MarketplaceShipmentRow[];

        // Count for marketplace sources
        let mpCountQuery = "SELECT COUNT(*) as total FROM marketplace_shipments ms JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id";
        const mpCountParams: (string | number)[] = [];
        const countConditions: string[] = [];

        if (source !== "all") {
          countConditions.push("mo.source = ?");
          mpCountParams.push(source);
        }
        if (status) {
          const mpStatusMap: Record<string, string[]> = {
            pending: ["pending"],
            label_purchased: ["label_purchased"],
            shipped: ["shipped", "in_transit"],
            delivered: ["delivered"],
            exception: ["exception"],
          };
          const mappedStatuses = mpStatusMap[status] || [status];
          countConditions.push(`ms.status IN (${mappedStatuses.map(() => "?").join(", ")})`);
          mpCountParams.push(...mappedStatuses);
        }

        if (countConditions.length > 0) {
          mpCountQuery += " WHERE " + countConditions.join(" AND ");
        }

        const mpCountRow = db.prepare(mpCountQuery).get(...mpCountParams) as { total: number };
        marketplaceTotal = mpCountRow.total;

        // Transform marketplace rows to unified shape
        for (const row of mpRows) {
          results.push(formatMarketplaceToUnified(row));
        }
      }

      // Sort combined results by createdAt descending
      results.sort((a, b) => b.timeline.createdAt - a.timeline.createdAt);

      // Apply pagination to merged results
      const paginatedResults = results.slice(offset, offset + limit);

      res.json({
        fulfillments: paginatedResults,
        total: stripeTotal + marketplaceTotal,
        counts: {
          cardmint: source === "all" || source === "cardmint" ? stripeTotal : 0,
          marketplace: source === "all" || source === "tcgplayer" || source === "ebay" ? marketplaceTotal : 0,
        },
        limit,
        offset,
      });
    } catch (err) {
      logger.error({ err, operatorId, source, status }, "Failed to list unified fulfillments");
      res.status(500).json({ error: "Failed to list unified fulfillments" });
    }
  });

  /**
   * GET /api/cm-admin/fulfillment/orders/:source/:id
   * Order drill-in details for the EverShop fulfillment dashboard.
   *
   * source:
   * - cardmint: id = Stripe session id
   * - marketplace: id = marketplace_orders.id
   *
   * Guardrails:
   * - Bearer auth required (operator-only)
   * - No address/PII written to logs
   */
  router.get("/orders/:source/:id", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const source = req.params.source as string;
    const id = req.params.id as string;

    logger.info(
      {
        operatorId,
        clientIp,
        userAgent,
        action: "order.details",
        source,
        idHint: source === "cardmint" ? id.slice(-8) : id,
      },
      "fulfillment.order.details"
    );

    if (source !== "cardmint" && source !== "marketplace") {
      return res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        message: "source must be one of: cardmint, marketplace",
      });
    }

    try {
      if (source === "cardmint") {
        const sessionId = id;

        const row = db
          .prepare(
            `
            SELECT f.*, o.order_number, o.order_uid
            FROM fulfillment f
            LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
            WHERE f.stripe_session_id = ?
          `
          )
          .get(sessionId) as FulfillmentRow | undefined;

        if (!row) {
          return res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Order not found" });
        }

        const orderNumber = row.order_number ?? `Session: ${row.stripe_session_id.slice(-8)}`;
        const discountCents = Math.max(0, row.original_subtotal_cents - row.final_subtotal_cents);
        const totals = {
          productCents: row.final_subtotal_cents,
          shippingCents: row.shipping_cost_cents,
          discountCents: discountCents > 0 ? discountCents : null,
          taxCents: null as number | null,
          totalCents: row.final_subtotal_cents + row.shipping_cost_cents,
        };

        let buyerName: string | null = null;
        let buyerEmail: string | null = null;
        let buyerPhone: string | null = null;
        let address: any = null;
        let paymentMethod: string | null = null;
        let items: Array<{
          title: string | null;
          sku: string | null;
          quantity: number;
          unitPriceCents: number | null;
          lineTotalCents: number | null;
          imageUrl: string | null;
        }> = [];

        const hasShipmentData = !!row.label_purchased_at || !!row.tracking_number;

        if (stripeService.isConfigured()) {
          try {
            const session = await stripeService.getCheckoutSession(sessionId);
            const shippingDetails = session.shipping_details ?? session.customer_details;

            buyerName = shippingDetails?.name ?? null;
            buyerPhone = shippingDetails?.phone ?? null;
            buyerEmail = session.customer_details?.email ?? null;

            if (hasShipmentData && shippingDetails?.address) {
              address = {
                line1: shippingDetails.address.line1,
                line2: shippingDetails.address.line2 ?? null,
                city: shippingDetails.address.city,
                state: shippingDetails.address.state,
                postalCode: shippingDetails.address.postal_code,
                country: shippingDetails.address.country,
              };
            }

            const paymentIntent = session.payment_intent as any;
            const paymentTypes = paymentIntent?.payment_method_types;
            paymentMethod = Array.isArray(paymentTypes) && paymentTypes.length > 0 ? String(paymentTypes[0]) : null;

            // Tax/discount details (best-effort; UI should degrade gracefully)
            const taxCents = session.total_details?.amount_tax ?? null;
            totals.taxCents = typeof taxCents === "number" ? taxCents : null;

            const lineItems = await stripeService.listCheckoutSessionLineItems(sessionId);
            items = (lineItems.data || []).map((li: any) => {
              const product = li?.price?.product && typeof li.price.product === "object" ? li.price.product : null;
              const metadata = product?.metadata ?? {};
              const sku =
                (metadata.canonical_sku as string | undefined) ||
                (metadata.product_sku as string | undefined) ||
                (metadata.public_sku as string | undefined) ||
                (metadata.item_uid as string | undefined) ||
                (metadata.product_uid as string | undefined) ||
                null;

              return {
                title: li.description ?? product?.name ?? null,
                sku,
                quantity: typeof li.quantity === "number" ? li.quantity : 1,
                unitPriceCents: li?.price?.unit_amount ?? null,
                lineTotalCents: li?.amount_total ?? null,
                imageUrl: Array.isArray(product?.images) && product.images.length > 0 ? product.images[0] : null,
              };
            });
          } catch (err) {
            logger.warn(
              { operatorId, sessionIdHint: sessionId.slice(-8), err: (err as Error).message },
              "fulfillment.order.details.stripe_fetch_failed"
            );
          }
        }

        return res.json({
          ok: true,
          source: "cardmint",
          order: {
            orderNumber,
            status: row.status,
            orderDate: row.created_at,
            updatedAt: row.updated_at,
            paymentMethod,
            totals,
          },
          buyer: {
            name: buyerName,
            email: buyerEmail,
            phone: buyerPhone,
          },
          shipping: {
            shippingType: row.shipping_method,
            address,
            addressAvailable: !!address,
            addressReason: address
              ? null
              : hasShipmentData
                ? "Address not available from Stripe session."
                : "Address withheld until label purchase (PII guardrail).",
          },
          items,
          shipments: [
            {
              carrier: row.carrier,
              service: row.easypost_service,
              trackingNumber: row.tracking_number,
              trackingUrl: row.tracking_url,
              labelUrl: row.label_url,
              labelPurchasedAt: row.label_purchased_at,
              status: row.status,
              provenance: row.label_url ? "easypost_label" : row.tracking_number ? "csv_upload" : "none",
            },
          ],
        });
      }

      // marketplace
      const orderId = parseInt(id, 10);
      if (isNaN(orderId)) {
        return res.status(400).json({ ok: false, error: "BAD_REQUEST", message: "id must be an integer for marketplace" });
      }

      const order = db
        .prepare("SELECT * FROM marketplace_orders WHERE id = ?")
        .get(orderId) as MarketplaceOrderDetailRow | undefined;

      if (!order) {
        return res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Order not found" });
      }

      const shipments = db
        .prepare("SELECT * FROM marketplace_shipments WHERE marketplace_order_id = ? ORDER BY shipment_sequence")
        .all(orderId) as MarketplaceShipmentDetailRow[];

      const shipmentsWithAddress = shipments.map((s) => {
        const decryptedAddress = safeDecryptMarketplaceAddress(s.shipping_address_encrypted);
        return {
          shipmentSequence: s.shipment_sequence,
          carrier: s.carrier,
          service: s.service,
          trackingNumber: s.tracking_number,
          trackingUrl: s.tracking_url,
          labelUrl: s.label_url,
          labelPurchasedAt: s.label_purchased_at,
          status: s.status,
          shippedAt: s.shipped_at,
          deliveredAt: s.delivered_at,
          exception: s.exception_type ? { type: s.exception_type, notes: s.exception_notes ?? null } : null,
          address: decryptedAddress,
          provenance: s.label_url ? "easypost_label" : s.tracking_number ? "csv_upload" : "none",
        };
      });

      const primaryShipment = shipmentsWithAddress[0] ?? null;

      const derivedStatus = deriveMarketplaceOrderStatus(shipments.map((s) => s.status));
      const totals = {
        productCents: order.product_value_cents,
        shippingCents: order.shipping_fee_cents,
        discountCents: null as number | null,
        taxCents: null as number | null,
        totalCents: order.product_value_cents + order.shipping_fee_cents,
      };

      const address = primaryShipment?.address ?? null;
      const addressAvailable = !!address;
      const addressReason =
        addressAvailable
          ? null
          : order.import_format === "orderlist"
            ? "Order List imports do not include addresses. Import TCGPlayer Shipping Export or EasyPost Shipments export to attach an address."
            : "Address not yet available.";

      // Try to get real items from marketplace_order_items (Pull Sheet import)
      // Primary query: by marketplace_order_id (items attached to order)
      let orderItems = db
        .prepare(`
          SELECT * FROM marketplace_order_items
          WHERE marketplace_order_id = ?
          ORDER BY id
        `)
        .all(orderId) as Array<{
          id: number;
          product_name: string;
          tcgplayer_sku_id: string | null;
          set_name: string | null;
          card_number: string | null;
          condition: string | null;
          rarity: string | null;
          product_line: string | null;
          quantity: number;
          unit_price_cents: number | null;
          price_confidence: "exact" | "estimated" | "unavailable";
          image_url: string | null;
        }>;

      // Fallback: query by (source, external_order_id) for Pull Sheet-first scenario
      // where items may not yet be attached to the order
      if (orderItems.length === 0) {
        orderItems = db
          .prepare(`
            SELECT * FROM marketplace_order_items
            WHERE source = ? AND external_order_id = ?
            ORDER BY id
          `)
          .all(order.source, order.external_order_id) as typeof orderItems;
      }

      let items: Array<{
        title: string | null;
        sku: string | null;
        quantity: number;
        unitPriceCents: number | null;
        lineTotalCents: number | null;
        imageUrl: string | null;
        // Extended fields for card data
        setName?: string | null;
        cardNumber?: string | null;
        condition?: string | null;
        rarity?: string | null;
        productLine?: string | null;
        priceConfidence?: "exact" | "estimated" | "unavailable";
      }>;

      if (orderItems.length > 0) {
        // Use real card data from Pull Sheet
        items = orderItems.map((item) => ({
          title: item.product_name,
          sku: item.tcgplayer_sku_id,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          lineTotalCents:
            item.unit_price_cents !== null
              ? item.unit_price_cents * item.quantity
              : null,
          imageUrl: item.image_url,
          // Extended card fields
          setName: item.set_name,
          cardNumber: item.card_number,
          condition: item.condition,
          rarity: item.rarity,
          productLine: item.product_line,
          priceConfidence: item.price_confidence,
        }));
      } else {
        // Fallback: placeholder item (no Pull Sheet imported)
        items = [
          {
            title: `${order.source.toUpperCase()} order (line item details unavailable)`,
            sku: null,
            quantity: order.item_count ?? 1,
            unitPriceCents:
              order.item_count && order.item_count > 0
                ? Math.round(order.product_value_cents / order.item_count)
                : null,
            lineTotalCents: order.product_value_cents,
            imageUrl: null,
          },
        ];
      }

      return res.json({
        ok: true,
        source: "marketplace",
        order: {
          orderNumber:
            order.source === "tcgplayer"
              ? formatTcgplayerOrderNumber(order.external_order_id)
              : order.display_order_number,
          status: derivedStatus,
          orderDate: order.order_date,
          updatedAt: order.updated_at,
          paymentMethod: null,
          totals,
        },
        buyer: {
          name: order.customer_name ?? null,
          email: null,
          phone: null,
        },
        shipping: {
          shippingType: order.shipping_method,
          address,
          addressAvailable,
          addressReason,
        },
        items,
        shipments: shipmentsWithAddress,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, operatorId, source }, "fulfillment.order.details.failed");
      return res.status(500).json({ ok: false, error: "INTERNAL_ERROR", message: "Failed to load order details" });
    }
  });

  /**
   * GET /api/cm-admin/fulfillment/:sessionId
   * Get fulfillment details (without shipping address - PII protection)
   */
  router.get("/:sessionId", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, action: "get" },
      "fulfillment.get"
    );

    try {
      // PR3: LEFT JOIN to orders table for order_number
      const row = db
        .prepare(`
          SELECT f.*, o.order_number, o.order_uid
          FROM fulfillment f
          LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
          WHERE f.stripe_session_id = ?
        `)
        .get(sessionId) as FulfillmentRow | undefined;

      if (!row) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      res.json({ fulfillment: formatFulfillmentResponse(row) });
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to get fulfillment");
      res.status(500).json({ error: "Failed to get fulfillment" });
    }
  });

  /**
   * POST /api/cm-admin/fulfillment/:sessionId/rates
   * Get EasyPost shipping rates for an order
   *
   * Fetches shipping address from Stripe (not persisted).
   * Only returns rates compatible with the checkout shipping method.
   */
  router.post("/:sessionId/rates", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, action: "rates" },
      "fulfillment.rates.start"
    );

    // Check EasyPost configuration
    if (!easyPostService.isConfigured()) {
      const status = easyPostService.getConfigStatus();
      return res.status(503).json({
        error: "EasyPost not configured",
        missing: status.missing,
      });
    }

    try {
      // Get fulfillment record
      const fulfillment = db
        .prepare("SELECT * FROM fulfillment WHERE stripe_session_id = ?")
        .get(sessionId) as FulfillmentRow | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      // Block if worker is processing (prevent operator interference)
      if (fulfillment.status === "processing") {
        return res.status(409).json({
          error: "Order is currently being processed by auto-fulfillment worker",
          hint: "Wait for worker to complete or reset status to 'pending' first",
          status: fulfillment.status,
        });
      }

      // Check if label already purchased
      if (fulfillment.status === "label_purchased" || fulfillment.tracking_number) {
        return res.status(400).json({
          error: "Label already purchased",
          trackingNumber: fulfillment.tracking_number,
          labelUrl: fulfillment.label_url,
        });
      }

      // Fetch shipping address from Stripe (not persisted per PII requirement)
      const session = await stripeService.getCheckoutSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Stripe session not found" });
      }

      const shippingDetails = session.shipping_details ?? session.customer_details;
      if (!shippingDetails?.address) {
        return res.status(400).json({ error: "No shipping address on Stripe session" });
      }

      const toAddress: EasyPostAddress = {
        name: shippingDetails.name ?? undefined,
        street1: shippingDetails.address.line1 ?? "",
        street2: shippingDetails.address.line2 ?? undefined,
        city: shippingDetails.address.city ?? "",
        state: shippingDetails.address.state ?? "",
        zip: shippingDetails.address.postal_code ?? "",
        country: shippingDetails.address.country ?? "US",
        phone: shippingDetails.phone ?? undefined,
        email: session.customer_details?.email ?? undefined,
      };

      // Create EasyPost shipment and get rates
      const result = await easyPostService.createShipment(
        toAddress,
        fulfillment.item_count,
        fulfillment.shipping_method as ShippingMethod
      );

      if (!result.success) {
        return res.status(400).json({
          error: result.error,
          errorCode: result.errorCode,
        });
      }

      // Store shipment ID for later label purchase (idempotency)
      if (result.shipment) {
        db.prepare(
          "UPDATE fulfillment SET easypost_shipment_id = ?, updated_at = strftime('%s', 'now') WHERE stripe_session_id = ?"
        ).run(result.shipment.id, sessionId);
      }

      logger.info(
        {
          operatorId,
          clientIp,
          sessionId,
          shipmentId: result.shipment?.id,
          ratesCount: result.compatibleRates?.length,
          shippingMethod: fulfillment.shipping_method,
          action: "rates",
        },
        "fulfillment.rates.success"
      );

      res.json({
        shipmentId: result.shipment?.id,
        shippingMethod: fulfillment.shipping_method,
        itemCount: fulfillment.item_count,
        rates: result.compatibleRates?.map((rate) => ({
          id: rate.id,
          carrier: rate.carrier,
          service: rate.service,
          rate: rate.rate,
          deliveryDays: rate.delivery_days ?? rate.est_delivery_days,
          deliveryDate: rate.delivery_date,
        })),
        // Include customer name for label preview (but not full address)
        customerName: toAddress.name,
      });
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to get EasyPost rates");
      res.status(500).json({ error: "Failed to get shipping rates" });
    }
  });

  /**
   * POST /api/cm-admin/fulfillment/:sessionId/label
   * Purchase a shipping label
   *
   * Guardrails:
   * - Manual review gate: blocks if requires_manual_review=1 unless override=true
   * - Override requires: overrideReason (string) explaining why override is needed
   * - Method matching: validates rate matches checkout shipping method
   * - Idempotency: safe to retry (checks if already purchased)
   */
  router.post("/:sessionId/label", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;
    const { rateId, overrideManualReview, overrideReason } = req.body as {
      rateId: string;
      overrideManualReview?: boolean;
      overrideReason?: string;
    };

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, rateId, action: "label", overrideManualReview },
      "fulfillment.label.start"
    );

    if (!rateId) {
      return res.status(400).json({ error: "rateId is required" });
    }

    // Check EasyPost configuration
    if (!easyPostService.isConfigured()) {
      const status = easyPostService.getConfigStatus();
      return res.status(503).json({
        error: "EasyPost not configured",
        missing: status.missing,
      });
    }

    try {
      // Get fulfillment record
      const fulfillment = db
        .prepare("SELECT * FROM fulfillment WHERE stripe_session_id = ?")
        .get(sessionId) as FulfillmentRow | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      // GUARDRAIL: Block if worker is processing (race condition prevention)
      if (fulfillment.status === "processing") {
        return res.status(409).json({
          error: "Order is currently being processed by auto-fulfillment worker",
          hint: "Wait for worker to complete or reset status to 'pending' first",
          status: fulfillment.status,
        });
      }

      // GUARDRAIL: Manual review gate
      if (fulfillment.requires_manual_review && !fulfillment.manual_review_completed_at) {
        if (!overrideManualReview) {
          return res.status(403).json({
            error: "Order requires manual review before label purchase",
            requiresManualReview: true,
            hint: "Complete manual review first, OR pass overrideManualReview=true with overrideReason",
          });
        }

        // GUARDRAIL: Override requires explicit reason
        if (!overrideReason || typeof overrideReason !== "string" || overrideReason.trim().length < 5) {
          return res.status(400).json({
            error: "overrideReason is required when using overrideManualReview",
            hint: "Provide a reason (min 5 chars) explaining why manual review is being bypassed",
          });
        }

        // Record override in fulfillment record
        const now = Math.floor(Date.now() / 1000);
        const overrideNote = `OVERRIDE: ${overrideReason.trim()} [by ${operatorId} at ${new Date().toISOString()}]`;

        db.prepare(
          `UPDATE fulfillment SET
            manual_review_completed_at = ?,
            manual_review_by = ?,
            manual_review_notes = ?,
            updated_at = ?
          WHERE stripe_session_id = ?`
        ).run(now, operatorId, overrideNote, now, sessionId);

        logger.warn(
          {
            operatorId,
            clientIp,
            sessionId,
            overrideReason: overrideReason.trim(),
            action: "label.override",
          },
          "fulfillment.label.manual_review_override"
        );
      }

      // Check for existing shipment ID (from rates call)
      const shipmentId = fulfillment.easypost_shipment_id;
      if (!shipmentId) {
        return res.status(400).json({
          error: "No EasyPost shipment created. Call POST /rates first.",
        });
      }

      // GUARDRAIL: Idempotency - check if label already purchased
      if (fulfillment.tracking_number && fulfillment.label_url) {
        // Phase 5: ensure print queue row exists (idempotent retries should not re-enqueue)
        printQueueRepo.upsertForShipment({
          shipmentType: "stripe",
          shipmentId: fulfillment.id,
          labelUrl: fulfillment.label_url,
        });

        logger.info(
          { operatorId, sessionId, action: "label.idempotent" },
          "fulfillment.label.already_purchased"
        );
        return res.json({
          success: true,
          alreadyPurchased: true,
          trackingNumber: fulfillment.tracking_number,
          labelUrl: fulfillment.label_url,
          carrier: fulfillment.carrier,
          service: fulfillment.easypost_service,
        });
      }

      // Concurrency guard: prevent double-spend on concurrent label purchase attempts.
      // Uses a DB-level lock flag with stale-lock recovery.
      const nowLock = Math.floor(Date.now() / 1000);
      const staleBefore = nowLock - 300; // 5 minutes

      const lockResult = db
        .prepare(
          `
          UPDATE fulfillment
          SET label_purchase_in_progress = 1,
              label_purchase_locked_at = ?,
              updated_at = ?
          WHERE stripe_session_id = ?
            AND tracking_number IS NULL
            AND (
              label_purchase_in_progress = 0
              OR label_purchase_locked_at IS NULL
              OR label_purchase_locked_at < ?
            )
        `
        )
        .run(nowLock, nowLock, sessionId, staleBefore);

      let lockAcquired = lockResult.changes === 1;

      if (!lockAcquired) {
        // Determine if it was purchased between our initial read and lock attempt
        const current = db
          .prepare("SELECT * FROM fulfillment WHERE stripe_session_id = ?")
          .get(sessionId) as FulfillmentRow | undefined;

        if (current?.tracking_number && current.label_url) {
          // Phase 5: ensure print queue row exists
          printQueueRepo.upsertForShipment({
            shipmentType: "stripe",
            shipmentId: current.id,
            labelUrl: current.label_url,
          });

          return res.json({
            success: true,
            alreadyPurchased: true,
            trackingNumber: current.tracking_number,
            labelUrl: current.label_url,
            carrier: current.carrier,
            service: current.easypost_service,
          });
        }

        return res.status(409).json({
          error: "PURCHASE_IN_PROGRESS",
          message: "Another label purchase is in progress for this order. Please retry in a few seconds.",
        });
      }

      // Purchase label via EasyPost (includes method matching validation)
      try {
        const result = await easyPostService.purchaseLabel(
          shipmentId,
          rateId,
          fulfillment.shipping_method as ShippingMethod
        );

        if (!result.success) {
          return res.status(400).json({
            error: result.error,
            errorCode: result.errorCode,
          });
        }

        if (!result.trackingNumber || !result.labelUrl) {
          logger.error(
            { operatorId, sessionId, hasTracking: !!result.trackingNumber, hasLabelUrl: !!result.labelUrl },
            "fulfillment.label.incomplete_response"
          );
          return res.status(500).json({
            error: "EASYPOST_INCOMPLETE",
            message: "EasyPost returned incomplete label data (missing tracking number or label URL)",
          });
        }

        // Update fulfillment record
        const now = Math.floor(Date.now() / 1000);
        const labelCostCents = result.shipment?.selected_rate
          ? Math.round(parseFloat(result.shipment.selected_rate.rate) * 100)
          : null;

        db.prepare(
          `UPDATE fulfillment SET
            status = 'label_purchased',
            carrier = ?,
            tracking_number = ?,
            tracking_url = ?,
            easypost_rate_id = ?,
            easypost_service = ?,
            label_url = ?,
            label_cost_cents = ?,
            label_purchased_at = ?,
            label_purchase_in_progress = 0,
            label_purchase_locked_at = NULL,
            updated_at = ?
          WHERE stripe_session_id = ?`
        ).run(
          result.carrier ?? "USPS",
          result.trackingNumber,
          `https://tools.usps.com/go/TrackConfirmAction?tLabels=${result.trackingNumber}`,
          rateId,
          result.service,
          result.labelUrl,
          labelCostCents,
          now,
          now,
          sessionId
        );

        // Phase 5: enqueue for immediate archival/print (all purchased labels)
        printQueueRepo.upsertForShipment({
          shipmentType: "stripe",
          shipmentId: fulfillment.id,
          labelUrl: result.labelUrl,
        });

        logger.info(
          {
            operatorId,
            clientIp,
            sessionId,
            trackingNumber: result.trackingNumber,
            carrier: result.carrier,
            service: result.service,
            labelCostCents,
            alreadyPurchased: result.alreadyPurchased,
            action: "label.purchased",
          },
          "fulfillment.label.success"
        );

        res.json({
          success: true,
          alreadyPurchased: result.alreadyPurchased ?? false,
          trackingNumber: result.trackingNumber,
          labelUrl: result.labelUrl,
          carrier: result.carrier,
          service: result.service,
          labelCostCents,
        });
      } finally {
        if (lockAcquired) {
          // Always release lock on exit (success or error).
          db.prepare(
            `UPDATE fulfillment
             SET label_purchase_in_progress = 0,
                 label_purchase_locked_at = NULL,
                 updated_at = strftime('%s', 'now')
             WHERE stripe_session_id = ?`
          ).run(sessionId);
        }
      }
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to purchase label");
      res.status(500).json({ error: "Failed to purchase shipping label" });
    }
  });

  /**
   * PATCH /api/cm-admin/fulfillment/:sessionId/status
   * Update fulfillment status (for operator workflow)
   */
  router.patch("/:sessionId/status", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;
    const { status, notes } = req.body as {
      status: string;
      notes?: string;
    };

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, status, action: "status" },
      "fulfillment.status.start"
    );

    if (!status || !OPERATOR_SETTABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${OPERATOR_SETTABLE_STATUSES.join(", ")}`,
        hint: status === "processing" ? "'processing' is worker-managed and cannot be set manually" : undefined,
      });
    }

    try {
      const fulfillment = db
        .prepare("SELECT * FROM fulfillment WHERE stripe_session_id = ?")
        .get(sessionId) as FulfillmentRow | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      const now = Math.floor(Date.now() / 1000);
      const updates: string[] = ["status = ?", "updated_at = ?"];
      const params: (string | number | null)[] = [status, now];

      // Handle status-specific fields
      if (status === "reviewed" && fulfillment.requires_manual_review) {
        updates.push("manual_review_completed_at = ?", "manual_review_by = ?");
        params.push(now, operatorId);
        if (notes) {
          updates.push("manual_review_notes = ?");
          params.push(notes);
        }
      }

      if (status === "shipped") {
        updates.push("shipped_at = ?");
        params.push(now);
      }

      if (status === "delivered") {
        updates.push("delivered_at = ?");
        params.push(now);
      }

      if (status === "exception") {
        updates.push("exception_at = ?");
        params.push(now);
        if (notes) {
          updates.push("exception_notes = ?");
          params.push(notes);
        }
      }

      params.push(sessionId);

      db.prepare(`UPDATE fulfillment SET ${updates.join(", ")} WHERE stripe_session_id = ?`).run(
        ...params
      );

      logger.info(
        { operatorId, clientIp, sessionId, status, action: "status.updated" },
        "fulfillment.status.success"
      );

      res.json({ success: true, status });
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to update fulfillment status");
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  /**
   * POST /api/cm-admin/fulfillment/:sessionId/review
   * Complete manual review for high-value orders
   */
  router.post("/:sessionId/review", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;
    const { approved, notes } = req.body as {
      approved: boolean;
      notes?: string;
    };

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, approved, action: "review" },
      "fulfillment.review.start"
    );

    if (typeof approved !== "boolean") {
      return res.status(400).json({ error: "approved (boolean) is required" });
    }

    try {
      const fulfillment = db
        .prepare("SELECT * FROM fulfillment WHERE stripe_session_id = ?")
        .get(sessionId) as FulfillmentRow | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      if (!fulfillment.requires_manual_review) {
        return res.status(400).json({ error: "Order does not require manual review" });
      }

      if (fulfillment.manual_review_completed_at) {
        return res.status(400).json({ error: "Manual review already completed" });
      }

      const now = Math.floor(Date.now() / 1000);
      const newStatus = approved ? "reviewed" : "exception";
      const reviewNotes = approved ? notes : `REJECTED: ${notes ?? "No reason provided"}`;

      db.prepare(
        `UPDATE fulfillment SET
          status = ?,
          manual_review_completed_at = ?,
          manual_review_notes = ?,
          manual_review_by = ?,
          updated_at = ?
        WHERE stripe_session_id = ?`
      ).run(newStatus, now, reviewNotes ?? null, operatorId, now, sessionId);

      logger.info(
        { operatorId, clientIp, sessionId, approved, action: approved ? "review.approved" : "review.rejected" },
        approved ? "fulfillment.review.approved" : "fulfillment.review.rejected"
      );

      res.json({
        success: true,
        status: newStatus,
        approved,
      });
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to complete manual review");
      res.status(500).json({ error: "Failed to complete review" });
    }
  });

  /**
   * POST /api/cm-admin/fulfillment/:sessionId/resend-tracking
   * Manually resend or enqueue tracking email
   *
   * PR3: Status-based behavior:
   * - null (not found): Enqueue new email → 200
   * - failed: Reset via resetForResend() → 200
   * - pending: Already queued → 202
   * - sending: In progress → 409
   * - sent: Already sent → 409 (unless ?force=true)
   */
  router.post("/:sessionId/resend-tracking", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;
    const force = req.query.force === "true";

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, force, action: "resend-tracking" },
      "fulfillment.resend-tracking.start"
    );

    try {
      // 1. Get fulfillment record with order info
      const fulfillment = db
        .prepare(`
          SELECT f.*, o.order_number, o.order_uid, o.subtotal_cents, o.shipping_cents, o.total_cents
          FROM fulfillment f
          LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
          WHERE f.stripe_session_id = ?
        `)
        .get(sessionId) as (FulfillmentRow & {
          subtotal_cents: number | null;
          shipping_cents: number | null;
          total_cents: number | null;
        }) | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      // 2. Validate status - must have tracking
      const validStatuses = ["label_purchased", "shipped", "delivered"];
      if (!validStatuses.includes(fulfillment.status)) {
        return res.status(400).json({
          error: "INVALID_STATUS",
          message: `Cannot resend tracking email for status '${fulfillment.status}'. Must be: ${validStatuses.join(", ")}`,
        });
      }

      // 3. Validate tracking number exists
      if (!fulfillment.tracking_number) {
        return res.status(400).json({
          error: "NO_TRACKING",
          message: "Fulfillment has no tracking number",
        });
      }

      // 4. Check existing email status
      const existingEmail = emailOutboxRepo.getBySessionAndType(sessionId, "order_confirmed_tracking");

      // 5. Handle based on status
      if (existingEmail) {
        switch (existingEmail.status) {
          case "pending":
            logger.info({ sessionId, emailUid: existingEmail.email_uid }, "Tracking email already pending");
            return res.status(202).json({
              success: true,
              message: "Tracking email already pending",
              emailUid: existingEmail.email_uid,
            });

          case "sending":
            logger.info({ sessionId, emailUid: existingEmail.email_uid }, "Tracking email currently sending");
            return res.status(409).json({
              error: "EMAIL_IN_PROGRESS",
              message: "Tracking email is currently being sent",
              emailUid: existingEmail.email_uid,
            });

          case "sent":
            if (!force) {
              logger.info({ sessionId, emailUid: existingEmail.email_uid }, "Tracking email already sent");
              return res.status(409).json({
                error: "EMAIL_ALREADY_SENT",
                message: "Tracking email was already sent. Use ?force=true to resend.",
                emailUid: existingEmail.email_uid,
                sentAt: existingEmail.sent_at,
              });
            }
            // Force resend: reset to pending (preserves audit history instead of delete)
            const now = Math.floor(Date.now() / 1000);
            db.prepare(`
              UPDATE email_outbox
              SET status = 'pending',
                  sent_at = NULL,
                  retry_count = 0,
                  next_retry_at = NULL,
                  last_error = 'Force resend by operator',
                  sending_started_at = NULL,
                  updated_at = ?
              WHERE email_uid = ?
            `).run(now, existingEmail.email_uid);
            logger.info(
              { sessionId, emailUid: existingEmail.email_uid, operatorId, force: true },
              "Reset sent email for force resend"
            );
            // Log to order_events
            if (fulfillment.order_uid) {
              db.prepare(`
                INSERT INTO order_events (order_uid, event_type, new_value, actor, created_at)
                VALUES (?, 'email_resend_triggered', ?, ?, ?)
              `).run(
                fulfillment.order_uid,
                JSON.stringify({ email_uid: existingEmail.email_uid, type: "order_confirmed_tracking", action: "force_resend" }),
                `operator:${operatorId}`,
                now
              );
            }
            return res.json({
              success: true,
              message: "Tracking email reset for resend",
              emailUid: existingEmail.email_uid,
            });

          case "failed":
            // Reset failed email to pending
            const wasReset = emailOutboxRepo.resetForResend(existingEmail.email_uid);
            if (wasReset) {
              logger.info(
                { sessionId, emailUid: existingEmail.email_uid, operatorId },
                "Reset failed tracking email for resend"
              );
              // Log to order_events
              if (fulfillment.order_uid) {
                const now = Math.floor(Date.now() / 1000);
                db.prepare(`
                  INSERT INTO order_events (order_uid, event_type, new_value, actor, created_at)
                  VALUES (?, 'email_resend_triggered', ?, ?, ?)
                `).run(
                  fulfillment.order_uid,
                  JSON.stringify({ email_uid: existingEmail.email_uid, type: "order_confirmed_tracking", action: "reset_failed" }),
                  `operator:${operatorId}`,
                  now
                );
              }
              return res.json({
                success: true,
                message: "Failed tracking email reset for retry",
                emailUid: existingEmail.email_uid,
              });
            }
            // Shouldn't happen, but fall through to enqueue new
            break;
        }
      }

      // 6. Enqueue new tracking email
      // Get item details from Stripe session metadata + DB
      const session = await stripeService.getCheckoutSession(sessionId);

      // Parse item_uids from session metadata (guard against malformed/legacy data)
      let itemUids: string[] = [];
      try {
        itemUids = session.metadata?.item_uids
          ? JSON.parse(session.metadata.item_uids)
          : session.metadata?.item_uid
            ? [session.metadata.item_uid]
            : [];
      } catch {
        logger.warn({ sessionId, metadata: session.metadata }, "Failed to parse item_uids from session metadata");
        // Fall through with empty array - will use fallback item
      }

      const items: Array<{ name: string; priceCents: number; imageUrl: string | null }> = [];
      for (const itemUid of itemUids) {
        const item = db
          .prepare(`
            SELECT p.name, i.price_cents, p.master_front_cdn_url as image_url
            FROM items i
            JOIN products p ON i.product_uid = p.product_uid
            WHERE i.item_uid = ?
          `)
          .get(itemUid) as { name: string; price_cents: number; image_url: string | null } | undefined;

        if (item) {
          items.push({
            name: item.name,
            priceCents: item.price_cents,
            imageUrl: item.image_url,
          });
        }
      }

      // Fallback if no items found
      if (items.length === 0) {
        items.push({
          name: "Pokemon Card",
          priceCents: session.amount_subtotal ?? 0,
          imageUrl: null,
        });
      }

      const templateData = {
        orderNumber: fulfillment.order_number ?? `Session: ${sessionId.slice(-8)}`,
        trackingNumber: fulfillment.tracking_number,
        trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${fulfillment.tracking_number}`,
        carrier: fulfillment.carrier ?? "USPS",
        items,
        // Use final_subtotal_cents (post-discount) for accurate customer-facing totals
        subtotalCents: fulfillment.subtotal_cents ?? fulfillment.final_subtotal_cents,
        shippingCents: fulfillment.shipping_cents ?? fulfillment.shipping_cost_cents,
        totalCents: fulfillment.total_cents ?? (fulfillment.final_subtotal_cents + fulfillment.shipping_cost_cents),
      };

      const emailUid = emailOutboxRepo.enqueue({
        stripeSessionId: sessionId,
        emailType: "order_confirmed_tracking",
        templateData,
      });

      if (emailUid) {
        logger.info(
          { sessionId, emailUid, orderNumber: fulfillment.order_number, operatorId },
          "Tracking email enqueued by operator"
        );

        // Log to order_events
        if (fulfillment.order_uid) {
          const now = Math.floor(Date.now() / 1000);
          db.prepare(`
            INSERT INTO order_events (order_uid, event_type, new_value, actor, created_at)
            VALUES (?, 'email_resend_triggered', ?, ?, ?)
          `).run(
            fulfillment.order_uid,
            JSON.stringify({ email_uid: emailUid, type: "order_confirmed_tracking", action: "enqueued" }),
            `operator:${operatorId}`,
            now
          );
        }

        return res.json({
          success: true,
          message: "Tracking email enqueued",
          emailUid,
        });
      } else {
        // Shouldn't happen with the status checks above, but handle gracefully
        return res.status(409).json({
          error: "EMAIL_ALREADY_EXISTS",
          message: "Tracking email already exists in outbox",
        });
      }
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to resend tracking email");
      res.status(500).json({ error: "Failed to resend tracking email" });
    }
  });

  /**
   * GET /api/cm-admin/fulfillment/:sessionId/customer
   * Fetch customer shipping details from Stripe (on-demand PII lookup)
   *
   * Returns customer name and shipping address for label verification.
   * NOT stored in DB - fetched live from Stripe to maintain PII protection.
   */
  router.get("/:sessionId/customer", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext;
    const { sessionId } = req.params;

    logger.info(
      { operatorId, clientIp, userAgent, sessionId, action: "customer.lookup" },
      "fulfillment.customer.lookup"
    );

    try {
      // Verify fulfillment exists
      const fulfillment = db
        .prepare("SELECT id FROM fulfillment WHERE stripe_session_id = ?")
        .get(sessionId) as { id: number } | undefined;

      if (!fulfillment) {
        return res.status(404).json({ error: "Fulfillment not found" });
      }

      // Fetch from Stripe (live lookup, not stored)
      const session = await stripeService.getCheckoutSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Stripe session not found" });
      }

      const shippingDetails = session.shipping_details ?? session.customer_details;
      if (!shippingDetails) {
        return res.status(404).json({ error: "No customer details on Stripe session" });
      }

      // Return customer info (audit logged but not persisted)
      res.json({
        customerName: shippingDetails.name ?? null,
        email: session.customer_details?.email ?? null,
        phone: shippingDetails.phone ?? null,
        address: shippingDetails.address
          ? {
              line1: shippingDetails.address.line1,
              line2: shippingDetails.address.line2 ?? null,
              city: shippingDetails.address.city,
              state: shippingDetails.address.state,
              postalCode: shippingDetails.address.postal_code,
              country: shippingDetails.address.country,
            }
          : null,
      });
    } catch (err) {
      logger.error({ err, sessionId, operatorId }, "Failed to fetch customer details");
      res.status(500).json({ error: "Failed to fetch customer details" });
    }
  });
}

/**
 * Format fulfillment row for API response
 */
function formatFulfillmentResponse(row: FulfillmentRow) {
  return {
    id: row.id,
    // PR3: Human-readable order number from orders table (null for pre-orders-table records)
    orderNumber: row.order_number ?? null,
    orderUid: row.order_uid ?? null,
    stripeSessionId: row.stripe_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    itemCount: row.item_count,
    originalSubtotalCents: row.original_subtotal_cents,
    finalSubtotalCents: row.final_subtotal_cents,
    shippingMethod: row.shipping_method,
    shippingCostCents: row.shipping_cost_cents,
    requiresManualReview: !!row.requires_manual_review,
    manualReview: row.requires_manual_review
      ? {
          completed: !!row.manual_review_completed_at,
          completedAt: row.manual_review_completed_at,
          notes: row.manual_review_notes,
          by: row.manual_review_by,
        }
      : null,
    status: row.status,
    shipping: {
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      service: row.easypost_service,
      labelUrl: row.label_url,
      labelCostCents: row.label_cost_cents,
      labelPurchasedAt: row.label_purchased_at,
    },
    timeline: {
      createdAt: row.created_at,
      shippedAt: row.shipped_at,
      estimatedDeliveryDate: row.estimated_delivery_date,
      deliveredAt: row.delivered_at,
    },
    exception: row.exception_type
      ? {
          type: row.exception_type,
          notes: row.exception_notes,
          at: row.exception_at,
        }
      : null,
    easypost: {
      shipmentId: row.easypost_shipment_id,
      rateId: row.easypost_rate_id,
    },
  };
}

/**
 * Format Stripe fulfillment row to unified response shape
 */
function formatStripeToUnified(row: FulfillmentRow): UnifiedFulfillment {
  return {
    id: `stripe:${row.stripe_session_id}`,
    source: "cardmint",
    orderNumber: row.order_number ?? `Session: ${row.stripe_session_id.slice(-8)}`,
    customerName: null, // PII - not stored, fetch from Stripe when needed
    itemCount: row.item_count,
    valueCents: row.final_subtotal_cents,
    shippingCostCents: row.shipping_cost_cents,
    shippingMethod: row.shipping_method,
    status: row.status,
    isExternal: false, // Stripe/CardMint orders are always internal
    shipping: {
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      service: row.easypost_service,
      labelUrl: row.label_url,
      labelCostCents: row.label_cost_cents,
      labelPurchasedAt: row.label_purchased_at,
    },
    timeline: {
      createdAt: row.created_at,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
    },
    exception: row.exception_type
      ? {
          type: row.exception_type,
          notes: row.exception_notes,
        }
      : null,
    sourceRef: {
      stripeSessionId: row.stripe_session_id,
    },
  };
}

/**
 * Format marketplace shipment row to unified response shape
 */
function formatMarketplaceToUnified(row: MarketplaceShipmentRow): UnifiedFulfillment {
  return {
    id: `mp:${row.shipment_id}`,
    source: row.source as "tcgplayer" | "ebay",
    orderNumber:
      row.source === "tcgplayer"
        ? formatTcgplayerOrderNumber(row.external_order_id)
        : row.display_order_number,
    customerName: row.customer_name,
    itemCount: row.item_count,
    valueCents: row.product_value_cents,
    shippingCostCents: row.shipping_fee_cents,
    shippingMethod: row.shipping_method,
    status: row.shipment_status,
    isExternal: row.is_external === 1, // External = TCGPlayer-fulfilled (no CardMint label)
    importFormat: row.import_format,
    shipping: {
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
      service: row.service,
      labelUrl: row.label_url,
      labelCostCents: row.label_cost_cents,
      labelPurchasedAt: row.label_purchased_at,
    },
    timeline: {
      createdAt: row.order_date,
      shippedAt: row.shipped_at,
      deliveredAt: row.delivered_at,
    },
    exception: row.exception_type
      ? {
          type: row.exception_type,
          notes: row.exception_notes,
        }
      : null,
    sourceRef: {
      marketplaceOrderId: row.order_id,
      shipmentId: row.shipment_id,
      externalOrderId: row.external_order_id,
    },
  };
}

function safeDecryptMarketplaceAddress(encrypted: string | null): MarketplaceShippingAddress | null {
  if (!encrypted) return null;
  try {
    return decryptJson<MarketplaceShippingAddress>(encrypted);
  } catch {
    return null;
  }
}

function deriveMarketplaceOrderStatus(statuses: string[]): string {
  if (statuses.includes("exception")) return "exception";
  if (statuses.length > 0 && statuses.every((s) => s === "delivered")) return "delivered";
  if (statuses.includes("in_transit")) return "in_transit";
  if (statuses.includes("shipped")) return "shipped";
  if (statuses.includes("label_purchased")) return "label_purchased";
  return "pending";
}
