/**
 * Print Queue Routes (Phase 5)
 *
 * Two audiences:
 * - Admin dashboard (EverShop) via /api/cm-admin/print-queue/* (Bearer auth)
 * - Local print agent via /api/print-agent/* (X-Print-Agent-Token auth)
 */

import { Router, type Express, type Request, type Response } from "express";
import type { AppContext } from "../app/context.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import { requirePrintAgentAuth } from "../middleware/printAgentAuth.js";
import { PrintQueueRepository } from "../repositories/printQueueRepository.js";
import { MarketplaceService } from "../services/marketplace/marketplaceService.js";
import { runtimeConfig } from "../config.js";
import type { ShippingMethod } from "../domain/shipping.js";
import { formatTcgplayerOrderNumber } from "../utils/orderNumberFormat.js";

export function registerPrintQueueRoutes(app: Express, ctx: AppContext): void {
  const { db, logger, stripeService, easyPostService } = ctx;
  const printQueueRepo = new PrintQueueRepository(db, logger);
  const marketplaceService = new MarketplaceService(db, logger);

  type ParcelPreset = {
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    baseWeightOz: number;
    maxCards: number;
  };

  function selectParcelPreset(itemCount: number): { key: string; preset: ParcelPreset } {
    const presets = runtimeConfig.parcelPresets as Record<string, ParcelPreset>;
    if (itemCount <= presets.singlecard.maxCards) return { key: "singlecard", preset: presets.singlecard };
    if (itemCount <= presets["multicard-bubble"].maxCards) return { key: "multicard-bubble", preset: presets["multicard-bubble"] };
    return { key: "multicard-box", preset: presets["multicard-box"] };
  }

  function pickCheapest(rates: Array<{ rate: string }>): { rate: string } | null {
    if (rates.length === 0) return null;
    return rates.reduce((best, candidate) => {
      const bestPrice = Number.parseFloat(best.rate);
      const candPrice = Number.parseFloat(candidate.rate);
      if (!Number.isFinite(bestPrice)) return candidate;
      if (!Number.isFinite(candPrice)) return best;
      return candPrice < bestPrice ? candidate : best;
    });
  }

  function chooseMarketplaceRate(rates: Array<{ id: string; carrier: string; service: string; rate: string }>): { id: string; carrier: string; service: string; rate: string } | null {
    const usps = rates.filter((r) => r.carrier === "USPS");
    const groundAdv = usps.filter((r) => r.service === "GroundAdvantage");
    const ups = rates.filter((r) => r.carrier === "UPS");
    return (
      (pickCheapest(groundAdv) as any) ||
      (pickCheapest(usps) as any) ||
      (pickCheapest(ups) as any) ||
      (pickCheapest(rates) as any)
    );
  }

  function acquireFulfillmentLock(sessionId: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const staleBefore = now - 300;
    const result = db
      .prepare(
        `
        UPDATE fulfillment
        SET label_purchase_in_progress = 1,
            label_purchase_locked_at = ?,
            updated_at = ?
        WHERE stripe_session_id = ?
          AND (
            label_purchase_in_progress = 0
            OR label_purchase_locked_at IS NULL
            OR label_purchase_locked_at < ?
          )
      `
      )
      .run(now, now, sessionId, staleBefore);
    return result.changes === 1;
  }

  function releaseFulfillmentLock(sessionId: string): void {
    db.prepare(
      `UPDATE fulfillment
       SET label_purchase_in_progress = 0,
           label_purchase_locked_at = NULL,
           updated_at = strftime('%s', 'now')
       WHERE stripe_session_id = ?`
    ).run(sessionId);
  }

  function acquireMarketplaceLock(shipmentId: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    const staleBefore = now - 300;
    const result = db
      .prepare(
        `
        UPDATE marketplace_shipments
        SET label_purchase_in_progress = 1,
            label_purchase_locked_at = ?,
            updated_at = strftime('%s', 'now')
        WHERE id = ?
          AND (
            label_purchase_in_progress = 0
            OR label_purchase_locked_at IS NULL
            OR label_purchase_locked_at < ?
          )
      `
      )
      .run(now, shipmentId, staleBefore);
    return result.changes === 1;
  }

  function releaseMarketplaceLock(shipmentId: number): void {
    marketplaceService.releaseLabelPurchaseLock(shipmentId);
  }

  // ---------------------------------------------------------------------------
  // Admin endpoints (EverShop)
  // ---------------------------------------------------------------------------
  const adminRouter = Router();
  app.use("/api/cm-admin/print-queue", adminRouter);
  adminRouter.use(requireAdminAuth);

  adminRouter.get("/stats", (_req: Request, res: Response) => {
    const statusCounts = printQueueRepo.getStatusCounts();
    const needsReview = printQueueRepo.getNeedsReviewCount();

    const latestAgent = db
      .prepare(
        `
        SELECT agent_id, last_seen_at, hostname, version, printer_name, auto_print
        FROM print_agent_heartbeats
        ORDER BY last_seen_at DESC
        LIMIT 1
      `
      )
      .get() as
      | {
          agent_id: string;
          last_seen_at: number;
          hostname: string | null;
          version: string | null;
          printer_name: string | null;
          auto_print: number;
        }
      | undefined;

    res.json({
      ok: true,
      statusCounts,
      needsReview,
      latestAgent: latestAgent
        ? {
            agentId: latestAgent.agent_id,
            lastSeenAt: latestAgent.last_seen_at,
            hostname: latestAgent.hostname,
            version: latestAgent.version,
            printerName: latestAgent.printer_name,
            autoPrint: !!latestAgent.auto_print,
          }
        : null,
    });
  });

  adminRouter.get("/", (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const reviewStatus = req.query.reviewStatus as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;

    const allowedStatus = new Set(["pending", "downloading", "ready", "printing", "printed", "failed"]);
    const allowedReview = new Set(["needs_review", "reviewed"]);

    const result = printQueueRepo.list({
      status: status && allowedStatus.has(status) ? (status as any) : undefined,
      reviewStatus: reviewStatus && allowedReview.has(reviewStatus) ? (reviewStatus as any) : undefined,
      limit,
      offset,
    });

    const marketplaceLookup = db.prepare(`
      SELECT
        mo.source as source,
        mo.external_order_id as external_order_id,
        mo.display_order_number as display_order_number,
        mo.customer_name as customer_name,
        ms.tracking_number as tracking_number
      FROM marketplace_shipments ms
      JOIN marketplace_orders mo ON ms.marketplace_order_id = mo.id
      WHERE ms.id = ?
    `);

    const stripeLookup = db.prepare(`
      SELECT
        COALESCE(o.order_number, NULL) as order_number,
        f.tracking_number as tracking_number,
        f.stripe_session_id as stripe_session_id
      FROM fulfillment f
      LEFT JOIN orders o ON f.stripe_session_id = o.stripe_session_id
      WHERE f.id = ?
    `);

    const items = result.rows.map((row) => {
      if (row.shipment_type === "marketplace") {
        const mp = marketplaceLookup.get(row.shipment_id) as
          | {
              source: string;
              external_order_id: string;
              display_order_number: string;
              customer_name: string;
              tracking_number: string | null;
            }
          | undefined;
        const orderNumber = mp
          ? mp.source === "tcgplayer"
            ? formatTcgplayerOrderNumber(mp.external_order_id)
            : mp.display_order_number
          : null;
        return {
          id: row.id,
          shipmentType: row.shipment_type,
          shipmentId: row.shipment_id,
          orderNumber,
          customerName: mp?.customer_name ?? null,
          trackingNumber: mp?.tracking_number ?? null,
          status: row.status,
          reviewStatus: row.review_status,
          printCount: row.print_count,
          attempts: row.attempts,
          lastAttemptAt: row.last_attempt_at,
          errorMessage: row.error_message,
          localPath: row.label_local_path,
          createdAt: row.created_at,
          archivedAt: row.archived_at,
          printedAt: row.printed_at,
        };
      }

      const stripe = stripeLookup.get(row.shipment_id) as
        | { order_number: string | null; tracking_number: string | null; stripe_session_id: string }
        | undefined;
      return {
        id: row.id,
        shipmentType: row.shipment_type,
        shipmentId: row.shipment_id,
        orderNumber: stripe?.order_number ?? null,
        customerName: null,
        trackingNumber: stripe?.tracking_number ?? null,
        status: row.status,
        reviewStatus: row.review_status,
        printCount: row.print_count,
        attempts: row.attempts,
        lastAttemptAt: row.last_attempt_at,
        errorMessage: row.error_message,
        localPath: row.label_local_path,
        createdAt: row.created_at,
        archivedAt: row.archived_at,
        printedAt: row.printed_at,
      };
    });

    res.json({ ok: true, items, total: result.total, limit, offset });
  });

  adminRouter.post("/:id/reprint", (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });

    const result = printQueueRepo.requestReprint(queueId);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    return res.json({ ok: true, status: result.status });
  });

  adminRouter.post("/:id/mark-reviewed", (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });

    const ok = printQueueRepo.markReviewed(queueId);
    if (!ok) return res.status(404).json({ ok: false, error: "Queue item not found" });
    return res.json({ ok: true });
  });

  /**
   * POST /api/cm-admin/print-queue/:id/repurchase-label
   * Explicit repurchase/new-label action (may create a new charge).
   * This is intentionally separate from "Reprint" to avoid double-charges.
   */
  adminRouter.post("/:id/repurchase-label", async (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    const { confirm, repurchaseReason, rateId, overrideManualReview, overrideReason } = req.body as {
      confirm?: boolean;
      repurchaseReason?: string;
      rateId?: string; // REQUIRED for purchase (manual rate selection - CEO decision 2026-01-03)
      overrideManualReview?: boolean;
      overrideReason?: string;
    };

    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });
    if (!confirm) {
      return res.status(400).json({
        ok: false,
        error: "CONFIRM_REQUIRED",
        message: "confirm=true is required to repurchase a label (may create a new charge)",
      });
    }
    if (!repurchaseReason || typeof repurchaseReason !== "string" || repurchaseReason.trim().length < 5) {
      return res.status(400).json({
        ok: false,
        error: "REASON_REQUIRED",
        message: "repurchaseReason is required (min 5 chars) for audit logging",
      });
    }

    const queueRow = printQueueRepo.getById(queueId);
    if (!queueRow) return res.status(404).json({ ok: false, error: "Queue item not found" });

    // Marketplace repurchase
    if (queueRow.shipment_type === "marketplace") {
      const shipmentId = queueRow.shipment_id;
      if (!acquireMarketplaceLock(shipmentId)) {
        return res.status(409).json({ ok: false, error: "PURCHASE_IN_PROGRESS" });
      }

      try {
        const shipmentData = marketplaceService.getShipmentWithDecryptedAddress(shipmentId);
        if (!shipmentData || !shipmentData.order) {
          return res.status(404).json({ ok: false, error: "Shipment not found" });
        }

        if (["shipped", "in_transit", "delivered"].includes(shipmentData.status)) {
          return res.status(400).json({
            ok: false,
            error: "INVALID_STATUS",
            message: `Cannot repurchase label for shipment with status '${shipmentData.status}'`,
          });
        }

        if (!shipmentData.decryptedAddress) {
          return res.status(400).json({
            ok: false,
            error: "ADDRESS_EXPIRED",
            message: "Shipping address has expired or been purged (PII retention policy)",
          });
        }

        const itemCount = marketplaceService.getShipmentItemCount(shipmentData, shipmentData.order);
        const selected = selectParcelPreset(itemCount);
        const presetKey = shipmentData.parcel_preset_key ?? selected.key;
        const parcelWeightOz = shipmentData.parcel_weight_oz ?? selected.preset.baseWeightOz;

        const orderValueCents = shipmentData.order.product_value_cents;
        const insuredValueCents = orderValueCents >= 5000 ? Math.min(orderValueCents, 10000) : null;
        const insuranceAmountDollars = insuredValueCents ? insuredValueCents / 100 : 0;

        const parcel = {
          length: selected.preset.lengthIn,
          width: selected.preset.widthIn,
          height: selected.preset.heightIn,
          weight: parcelWeightOz,
        };

        const toAddress = {
          name: shipmentData.decryptedAddress.name,
          street1: shipmentData.decryptedAddress.street1,
          street2: shipmentData.decryptedAddress.street2,
          city: shipmentData.decryptedAddress.city,
          state: shipmentData.decryptedAddress.state,
          zip: shipmentData.decryptedAddress.zip,
          country: shipmentData.decryptedAddress.country || "US",
        };

        // Two-phase repurchase flow (CEO decision 2026-01-03: manual rate selection required)
        // Phase 1: If no rateId, create shipment and return rates for manual selection
        // Phase 2: If rateId provided, purchase label with that rate

        // Check if we have a valid easypost_shipment_id to reuse (from phase 1)
        const existingEasypostId = shipmentData.easypost_shipment_id;

        if (!rateId) {
          // Phase 1: Create new shipment and return rates for manual selection
          const createResult = await easyPostService.createMarketplaceShipment(toAddress, parcel, insuranceAmountDollars);
          if (!createResult.success || !createResult.shipment || !createResult.rates) {
            return res.status(400).json({ ok: false, error: createResult.errorCode || "EASYPOST_ERROR", message: createResult.error });
          }

          if (createResult.rates.length === 0) {
            return res.status(400).json({ ok: false, error: "NO_RATES", message: "No rates returned from EasyPost" });
          }

          // Store the new shipment ID for phase 2
          marketplaceService.updateShipmentEasypostShipment(
            shipmentId,
            createResult.shipment.id,
            presetKey,
            parcelWeightOz,
            insuredValueCents,
            itemCount
          );

          // Return rates for manual selection (release lock - operator will call again with rateId)
          releaseMarketplaceLock(shipmentId);
          return res.json({
            ok: true,
            needsRateSelection: true,
            shipmentType: "marketplace",
            shipmentId,
            easypostShipmentId: createResult.shipment.id,
            rates: createResult.rates.map((r: any) => ({
              id: r.id,
              carrier: r.carrier,
              service: r.service,
              rate: r.rate,
              deliveryDays: r.delivery_days,
            })),
          });
        }

        // Phase 2: rateId provided - purchase label
        if (!existingEasypostId) {
          return res.status(400).json({
            ok: false,
            error: "NO_SHIPMENT",
            message: "No EasyPost shipment found. Call without rateId first to get rates.",
          });
        }

        const labelResult = await easyPostService.purchaseMarketplaceLabel(existingEasypostId, rateId);
        if (!labelResult.success) {
          return res.status(400).json({ ok: false, error: labelResult.errorCode || "EASYPOST_ERROR", message: labelResult.error });
        }
        if (!labelResult.trackingNumber || !labelResult.labelUrl) {
          return res.status(500).json({ ok: false, error: "EASYPOST_INCOMPLETE", message: "EasyPost returned incomplete label data" });
        }

        const labelCostCents = labelResult.shipment?.selected_rate?.rate
          ? Math.round(Number.parseFloat(labelResult.shipment.selected_rate.rate) * 100)
          : null;

        const shipmentTracker = (labelResult.shipment as any)?.tracker;
        const trackingUrl =
          shipmentTracker?.public_url ||
          (labelResult.carrier === "USPS"
            ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${labelResult.trackingNumber}`
            : null);

        // Handle idempotent return (label was already purchased)
        if (labelResult.alreadyPurchased) {
          logger.info(
            { queueId, shipmentId, trackingNumber: labelResult.trackingNumber },
            "printQueue.marketplace.label.idempotent_return"
          );

          return res.json({
            ok: true,
            repurchased: false,
            alreadyPurchased: true,
            shipmentType: "marketplace",
            shipmentId,
            trackingNumber: labelResult.trackingNumber,
            labelUrl: labelResult.labelUrl,
            carrier: labelResult.carrier,
            service: labelResult.service,
            labelCostCents,
          });
        }

        marketplaceService.updateShipmentLabelPurchased(
          shipmentId,
          labelResult.trackingNumber,
          trackingUrl,
          labelResult.labelUrl,
          labelCostCents ?? 0,
          labelResult.carrier || null,
          labelResult.service || null,
          rateId
        );

        // Reset queue state for the new label URL
        printQueueRepo.upsertForShipment({ shipmentType: "marketplace", shipmentId, labelUrl: labelResult.labelUrl });

        logger.warn(
          { queueId, shipmentId, repurchaseReason: repurchaseReason.trim(), labelCostCents },
          "printQueue.marketplace.repurchase"
        );

        return res.json({
          ok: true,
          repurchased: true,
          alreadyPurchased: false,
          shipmentType: "marketplace",
          shipmentId,
          trackingNumber: labelResult.trackingNumber,
          labelUrl: labelResult.labelUrl,
          carrier: labelResult.carrier,
          service: labelResult.service,
          labelCostCents,
        });
      } finally {
        releaseMarketplaceLock(shipmentId);
      }
    }

    // Stripe repurchase
    const fulfillment = db
      .prepare("SELECT * FROM fulfillment WHERE id = ?")
      .get(queueRow.shipment_id) as any;

    if (!fulfillment) return res.status(404).json({ ok: false, error: "Fulfillment not found" });

    if (["shipped", "delivered"].includes(fulfillment.status)) {
      return res.status(400).json({ ok: false, error: "INVALID_STATUS", message: `Cannot repurchase label for status '${fulfillment.status}'` });
    }

    // Manual review gate (same semantics as /fulfillment/:sessionId/label)
    if (fulfillment.requires_manual_review && !fulfillment.manual_review_completed_at) {
      if (!overrideManualReview) {
        return res.status(403).json({
          ok: false,
          error: "MANUAL_REVIEW_REQUIRED",
          message: "Order requires manual review before label repurchase",
          hint: "Complete manual review first, OR pass overrideManualReview=true with overrideReason",
        });
      }

      if (!overrideReason || typeof overrideReason !== "string" || overrideReason.trim().length < 5) {
        return res.status(400).json({
          ok: false,
          error: "OVERRIDE_REASON_REQUIRED",
          message: "overrideReason is required when using overrideManualReview (min 5 chars)",
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const overrideNote = `OVERRIDE: ${overrideReason.trim()} [by print-queue repurchase at ${new Date().toISOString()}]`;
      db.prepare(
        `UPDATE fulfillment SET
          manual_review_completed_at = ?,
          manual_review_by = ?,
          manual_review_notes = ?,
          updated_at = ?
        WHERE stripe_session_id = ?`
      ).run(now, "print-queue", overrideNote, now, fulfillment.stripe_session_id);
    }

    const sessionId = fulfillment.stripe_session_id as string;
    if (!acquireFulfillmentLock(sessionId)) {
      return res.status(409).json({ ok: false, error: "PURCHASE_IN_PROGRESS" });
    }

    try {
      const session = await stripeService.getCheckoutSession(sessionId);
      if (!session) return res.status(404).json({ ok: false, error: "Stripe session not found" });

      const shippingDetails = session.shipping_details ?? session.customer_details;
      if (!shippingDetails?.address) {
        return res.status(400).json({ ok: false, error: "NO_SHIPPING_ADDRESS", message: "No shipping address on Stripe session" });
      }

      const toAddress = {
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

      // Two-phase repurchase flow (CEO decision 2026-01-03: manual rate selection required)
      // Check if we have a valid easypost_shipment_id to reuse (from phase 1)
      const existingEasypostId = fulfillment.easypost_shipment_id as string | null;

      if (!rateId) {
        // Phase 1: Create new shipment and return rates for manual selection
        const createResult = await easyPostService.createShipment(
          toAddress,
          fulfillment.item_count,
          fulfillment.shipping_method as ShippingMethod
        );

        if (!createResult.success || !createResult.shipment || !createResult.compatibleRates) {
          return res.status(400).json({ ok: false, error: createResult.errorCode || "EASYPOST_ERROR", message: createResult.error });
        }

        if (createResult.compatibleRates.length === 0) {
          return res.status(400).json({ ok: false, error: "NO_RATES", message: "No compatible rates returned from EasyPost" });
        }

        // Store the new shipment ID for phase 2
        const nowTs = Math.floor(Date.now() / 1000);
        db.prepare(
          `UPDATE fulfillment SET easypost_shipment_id = ?, updated_at = ? WHERE id = ?`
        ).run(createResult.shipment.id, nowTs, fulfillment.id);

        // Return rates for manual selection (release lock - operator will call again with rateId)
        releaseFulfillmentLock(sessionId);
        return res.json({
          ok: true,
          needsRateSelection: true,
          shipmentType: "stripe",
          shipmentId: fulfillment.id,
          easypostShipmentId: createResult.shipment.id,
          rates: createResult.compatibleRates.map((r: any) => ({
            id: r.id,
            carrier: r.carrier,
            service: r.service,
            rate: r.rate,
            deliveryDays: r.delivery_days,
          })),
        });
      }

      // Phase 2: rateId provided - purchase label
      if (!existingEasypostId) {
        return res.status(400).json({
          ok: false,
          error: "NO_SHIPMENT",
          message: "No EasyPost shipment found. Call without rateId first to get rates.",
        });
      }

      const labelResult = await easyPostService.purchaseLabel(
        existingEasypostId,
        rateId,
        fulfillment.shipping_method as ShippingMethod
      );

      if (!labelResult.success) {
        return res.status(400).json({ ok: false, error: labelResult.errorCode || "EASYPOST_ERROR", message: labelResult.error });
      }

      if (!labelResult.trackingNumber || !labelResult.labelUrl) {
        return res.status(500).json({ ok: false, error: "EASYPOST_INCOMPLETE", message: "EasyPost returned incomplete label data" });
      }

      const now = Math.floor(Date.now() / 1000);
      const labelCostCents = labelResult.shipment?.selected_rate
        ? Math.round(Number.parseFloat(labelResult.shipment.selected_rate.rate) * 100)
        : null;

      // Handle idempotent return (label was already purchased)
      if (labelResult.alreadyPurchased) {
        logger.info(
          { queueId, fulfillmentId: fulfillment.id, sessionId, trackingNumber: labelResult.trackingNumber },
          "printQueue.stripe.label.idempotent_return"
        );

        return res.json({
          ok: true,
          repurchased: false,
          alreadyPurchased: true,
          shipmentType: "stripe",
          shipmentId: fulfillment.id,
          trackingNumber: labelResult.trackingNumber,
          labelUrl: labelResult.labelUrl,
          carrier: labelResult.carrier,
          service: labelResult.service,
          labelCostCents,
        });
      }

      db.prepare(
        `UPDATE fulfillment SET
          status = 'label_purchased',
          carrier = ?,
          tracking_number = ?,
          tracking_url = ?,
          easypost_shipment_id = ?,
          easypost_rate_id = ?,
          easypost_service = ?,
          label_url = ?,
          label_cost_cents = ?,
          label_purchased_at = ?,
          label_purchase_in_progress = 0,
          label_purchase_locked_at = NULL,
          updated_at = ?
        WHERE id = ?`
      ).run(
        labelResult.carrier ?? "USPS",
        labelResult.trackingNumber,
        `https://tools.usps.com/go/TrackConfirmAction?tLabels=${labelResult.trackingNumber}`,
        existingEasypostId,
        rateId,
        labelResult.service ?? null,
        labelResult.labelUrl,
        labelCostCents,
        now,
        now,
        fulfillment.id
      );

      // Reset queue state for the new label URL
      printQueueRepo.upsertForShipment({ shipmentType: "stripe", shipmentId: fulfillment.id, labelUrl: labelResult.labelUrl });

      logger.warn(
        { queueId, fulfillmentId: fulfillment.id, sessionId, repurchaseReason: repurchaseReason.trim(), labelCostCents },
        "printQueue.stripe.repurchase"
      );

      return res.json({
        ok: true,
        repurchased: true,
        alreadyPurchased: false,
        shipmentType: "stripe",
        shipmentId: fulfillment.id,
        trackingNumber: labelResult.trackingNumber,
        labelUrl: labelResult.labelUrl,
        carrier: labelResult.carrier,
        service: labelResult.service,
        labelCostCents,
      });
    } finally {
      releaseFulfillmentLock(sessionId);
    }
  });

  // ---------------------------------------------------------------------------
  // Print agent endpoints (Fedora workstation)
  // ---------------------------------------------------------------------------
  const agentRouter = Router();
  app.use("/api/print-agent", agentRouter);
  agentRouter.use(requirePrintAgentAuth);

  // Heartbeat: agent posts last-seen for 24/7 ops visibility
  agentRouter.post("/heartbeat", (req: Request, res: Response) => {
    const { agentId, hostname, version, printerName, autoPrint } = req.body as {
      agentId?: string;
      hostname?: string;
      version?: string;
      printerName?: string;
      autoPrint?: boolean;
    };

    if (!agentId || typeof agentId !== "string") {
      return res.status(400).json({ ok: false, error: "agentId is required" });
    }

    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `
      INSERT INTO print_agent_heartbeats (
        agent_id, last_seen_at, hostname, version, printer_name, auto_print, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        hostname = excluded.hostname,
        version = excluded.version,
        printer_name = excluded.printer_name,
        auto_print = excluded.auto_print,
        updated_at = excluded.updated_at
    `
    ).run(
      agentId,
      now,
      hostname ?? null,
      version ?? null,
      printerName ?? null,
      autoPrint ? 1 : 0,
      now,
      now
    );

    res.json({ ok: true, now });
  });

  // Recover stale downloads/prints before claims (crash/offline recovery)
  agentRouter.post("/recover-stuck", (req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    const thresholdSec = Math.min(Math.max(parseInt(String((req.body as any)?.thresholdSec ?? 300), 10) || 300, 60), 3600);
    printQueueRepo.recoverStuckJobs(now, thresholdSec);
    res.json({ ok: true });
  });

  // Claim next pending download job
  agentRouter.post("/print-queue/claim-download", (_req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    // Auto-recover stale jobs with a conservative default (10 minutes)
    printQueueRepo.recoverStuckJobs(now, 600);

    const job = printQueueRepo.claimNextDownload(now);
    if (!job) return res.json({ ok: true, job: null });

    return res.json({
      ok: true,
      job: {
        id: job.id,
        shipmentType: job.shipment_type,
        shipmentId: job.shipment_id,
        labelUrl: job.label_url,
      },
    });
  });

  // Mark download complete (archives PDF path)
  agentRouter.post("/print-queue/:id/download-complete", (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    const { localPath } = req.body as { localPath?: string };
    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });
    if (!localPath || typeof localPath !== "string") {
      return res.status(400).json({ ok: false, error: "localPath is required" });
    }

    const now = Math.floor(Date.now() / 1000);
    const ok = printQueueRepo.markDownloadComplete({ queueId, localPath, archivedAt: now });
    if (!ok) return res.status(409).json({ ok: false, error: "QUEUE_STATE_MISMATCH" });
    return res.json({ ok: true });
  });

  // Claim next ready-to-print job
  agentRouter.post("/print-queue/claim-print", (_req: Request, res: Response) => {
    const now = Math.floor(Date.now() / 1000);
    printQueueRepo.recoverStuckJobs(now, 600);

    const job = printQueueRepo.claimNextPrint(now);
    if (!job) return res.json({ ok: true, job: null });

    return res.json({
      ok: true,
      job: {
        id: job.id,
        shipmentType: job.shipment_type,
        shipmentId: job.shipment_id,
        localPath: job.label_local_path,
      },
    });
  });

  agentRouter.post("/print-queue/:id/print-complete", (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    const { printerJobId } = req.body as { printerJobId?: string };
    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });

    const now = Math.floor(Date.now() / 1000);
    const ok = printQueueRepo.markPrintComplete({ queueId, printedAt: now, printerJobId: printerJobId ?? null });
    if (!ok) return res.status(409).json({ ok: false, error: "QUEUE_STATE_MISMATCH" });
    return res.json({ ok: true });
  });

  agentRouter.post("/print-queue/:id/fail", (req: Request, res: Response) => {
    const queueId = parseInt(req.params.id, 10);
    const { errorMessage } = req.body as { errorMessage?: string };
    if (isNaN(queueId)) return res.status(400).json({ ok: false, error: "Invalid queue ID" });
    if (!errorMessage || typeof errorMessage !== "string") {
      return res.status(400).json({ ok: false, error: "errorMessage is required" });
    }

    const now = Math.floor(Date.now() / 1000);
    const ok = printQueueRepo.markFailed({ queueId, message: errorMessage, nowSec: now });
    if (!ok) return res.status(404).json({ ok: false, error: "Queue item not found" });
    return res.json({ ok: true });
  });
}
