/**
 * Fulfillment Routes - Operator endpoints for shipping label generation
 *
 * **SECURITY:** All endpoints require Basic Auth (operator-only).
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
 * - Auth required: All handlers require Basic Auth (operator identity)
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
import type { EasyPostAddress } from "../services/easyPostService.js";

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
  created_at: number;
  updated_at: number;
  // PR3: Added from LEFT JOIN with orders table
  order_number: string | null;
  order_uid: string | null;
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

  // Mount at /api/cm-admin/fulfillment/* (NOT /api/fulfillment - that would be public)
  app.use("/api/cm-admin/fulfillment", router);

  /**
   * Auth middleware applied to all routes
   * Extracts operator ID, client IP, user agent for audit logging
   * Rejects with 401 if Basic Auth is missing or invalid
   */
  router.use((req: Request, res: Response, next) => {
    const operatorId = extractBasicAuthUser(req.headers.authorization);
    if (!operatorId) {
      logger.warn(
        {
          clientIp: extractClientIp(req.headers["x-forwarded-for"] as string, req.socket.remoteAddress),
          userAgent: req.headers["user-agent"],
          path: req.path,
          method: req.method,
        },
        "fulfillment.auth.rejected"
      );
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Basic Auth required for fulfillment operations",
      });
    }

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

      // Purchase label via EasyPost (includes method matching validation)
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
