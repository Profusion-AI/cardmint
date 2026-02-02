/**
 * Marketplace Routes - Operator endpoints for TCGPlayer/eBay order management
 *
 * **SECURITY:** All endpoints require Bearer Auth (CARDMINT_ADMIN_API_KEY).
 * Operator identity for audit logging via X-CardMint-Operator header.
 * Mounted at /api/cm-admin/marketplace/* (not /api/marketplace).
 *
 * POST /api/cm-admin/marketplace/import/tcgplayer       - Import TCGPlayer CSV
 * POST /api/cm-admin/marketplace/import/easypost-tracking - Link EasyPost tracking
 * GET /api/cm-admin/marketplace/stats                   - Get fulfillment stats
 * GET /api/cm-admin/marketplace/orders                  - List marketplace orders
 * GET /api/cm-admin/marketplace/orders/:orderId         - Get order with shipments
 * GET /api/cm-admin/marketplace/unmatched-tracking      - List pending tracking
 * POST /api/cm-admin/marketplace/unmatched-tracking/:id/resolve - Resolve tracking
 * POST /api/cm-admin/marketplace/shipments/:id/rates    - Get EasyPost rates
 * POST /api/cm-admin/marketplace/shipments/:id/label    - Purchase label
 * PATCH /api/cm-admin/marketplace/shipments/:id/status  - Update status
 * POST /api/cm-admin/marketplace/rematch                - Manual re-match unmatched tracking
 *
 * Guardrails:
 * - Auth required: All handlers require Bearer Auth (CARDMINT_ADMIN_API_KEY)
 * - Audit logging: Every action logged with operatorId, clientIp, userAgent
 * - Dry-run default: Imports default to dryRun=true
 * - Idempotency: CSV imports skip duplicates via UNIQUE constraints
 * - PII: Addresses stored encrypted, never logged
 */

import { Router, type Express, type Request, type Response } from "express";
import type { AppContext } from "../app/context.js";
import { MarketplaceService } from "../services/marketplace/marketplaceService.js";
import { TcgplayerImporter } from "../services/marketplace/tcgplayerImporter.js";
import { EasypostTrackingLinker } from "../services/marketplace/easypostTrackingLinker.js";
import { PullSheetImporter } from "../services/marketplace/pullSheetImporter.js";
import { EasyPostService, type EasyPostAddress, type EasyPostParcel } from "../services/easyPostService.js";
import { UspsTrackingService } from "../services/uspsTrackingService.js";
import { detectCsvFormat, extractHeadersFromCsv, getFormatDisplayName } from "../services/marketplace/csvFormatDetector.js";
import { runtimeConfig } from "../config.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import { PrintQueueRepository } from "../repositories/printQueueRepository.js";
import { processLabelForPL60, getCachedLabel } from "../services/labelProcessingService.js";
import { formatTcgplayerOrderNumber } from "../utils/orderNumberFormat.js";
import { isRefundEligible, type MarketplaceShipmentForRefund } from "../utils/refundEligibility.js";

// Max CSV size (10MB)
const MAX_CSV_SIZE = 10 * 1024 * 1024;

// Allowed URL schemes for operator-provided label URLs
const ALLOWED_LABEL_URL_SCHEMES = ["https:", "http:"];

/**
 * Validate that a URL uses an allowed scheme (prevents javascript:, data:, etc.)
 * Returns true if valid, false if invalid.
 */
function isValidLabelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_LABEL_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

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
 * Get human-readable message for refund rejection reason
 */
function getRefundRejectionMessage(reason: string): string {
  const messages: Record<string, string> = {
    NO_EASYPOST_SHIPMENT: "No EasyPost shipment ID found. Label may not have been purchased via EasyPost.",
    REFUND_ALREADY_SUBMITTED: "A refund has already been submitted for this label.",
    REFUND_ALREADY_REFUNDED: "This label has already been refunded.",
    REFUND_ALREADY_REJECTED: "A previous refund was rejected. Contact support if you believe this is an error.",
    LABEL_PURCHASED: "Label is eligible for refund (not yet scanned by carrier).",
    PRE_TRANSIT: "Label is eligible for refund (carrier has not yet scanned the package).",
    STATUS_UNKNOWN: "Label status is unknown. Refund may be possible if carrier has not scanned.",
    SHIPMENT_IN_TRANSIT: "Cannot refund: package is in transit with the carrier.",
    SHIPMENT_DELIVERED: "Cannot refund: package has been delivered.",
    CARRIER_STATUS_IN_TRANSIT: "Cannot refund: carrier shows package in transit.",
    CARRIER_STATUS_OUT_FOR_DELIVERY: "Cannot refund: carrier shows package out for delivery.",
    CARRIER_STATUS_DELIVERED: "Cannot refund: carrier shows package delivered.",
    EASYPOST_TIMEOUT: "Timed out while checking EasyPost status. Please try again.",
    EASYPOST_ERROR: "Error communicating with EasyPost. Please try again.",
    EASYPOST_SHIPMENT_NOT_FOUND: "EasyPost shipment not found. The label may have already been voided.",
    INVALID_STATUS_PENDING: "No label has been purchased yet (status is pending).",
  };

  return messages[reason] || `Refund not eligible: ${reason}`;
}

interface AuditContext {
  operatorId: string;
  clientIp: string | null;
  userAgent: string | null;
}

/**
 * Register marketplace routes on the Express app
 * All routes mounted under /api/cm-admin/marketplace (operator-only)
 */
export function registerMarketplaceRoutes(app: Express, ctx: AppContext): void {
  const router = Router();
  const { db, logger } = ctx;

  // Initialize services
  const marketplaceService = new MarketplaceService(db, logger);
  const tcgplayerImporter = new TcgplayerImporter(marketplaceService, logger);
  const easypostTrackingLinker = new EasypostTrackingLinker(marketplaceService, logger);
  const pullSheetImporter = new PullSheetImporter(marketplaceService, logger);
  const easyPostService = new EasyPostService(logger);
  const uspsTrackingService = new UspsTrackingService(logger);
  const printQueueRepo = new PrintQueueRepository(db, logger);

  // Mount at /api/cm-admin/marketplace/* (NOT /api/marketplace - that would be public)
  app.use("/api/cm-admin/marketplace", router);

  /**
   * Auth middleware applied to all routes (two-layer):
   * 1. requireAdminAuth - validates Bearer token against CARDMINT_ADMIN_API_KEY
   * 2. Audit context - extracts operator ID, client IP, user agent for logging
   *
   * Operator ID can be provided via:
   * - Basic Auth username (for backward compat)
   * - X-CardMint-Operator header
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
    } as AuditContext;

    next();
  });

  // ============================================================================
  // Import Endpoints
  // ============================================================================

  /**
   * POST /api/cm-admin/marketplace/import/tcgplayer
   * Import TCGPlayer Shipping Export CSV
   *
   * Body: { csvData: string, dryRun?: boolean, fileName?: string }
   * Returns: { batchId, dryRun, imported, skipped, errors, preview? }
   */
  router.post("/import/tcgplayer", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const { csvData, dryRun = true, fileName } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "import.tcgplayer", dryRun, fileName },
      "marketplace.import.tcgplayer.start"
    );

    // Validate input
    if (!csvData || typeof csvData !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "csvData is required and must be a string",
      });
    }

    if (csvData.length > MAX_CSV_SIZE) {
      return res.status(400).json({
        error: "PAYLOAD_TOO_LARGE",
        message: `CSV data exceeds maximum size of ${MAX_CSV_SIZE / 1024 / 1024}MB`,
      });
    }

    try {
      const result = await tcgplayerImporter.import(
        csvData,
        operatorId,
        fileName || null,
        dryRun
      );

      // After actual import (not dry-run), re-match unmatched tracking
      // Run re-match if new orders imported OR there's pending unmatched tracking
      // (allows duplicate uploads to still trigger re-match for previously unmatched entries)
      let reMatchResult: { matched: number; details: Array<{ trackingNumber: string; orderNumber: string }> } | null = null;
      if (!dryRun && (result.imported > 0 || marketplaceService.hasUnmatchedTracking())) {
        reMatchResult = marketplaceService.reMatchUnmatchedTracking();
        logger.info(
          { operatorId, reMatched: reMatchResult.matched, details: reMatchResult.details },
          "marketplace.import.tcgplayer.rematch"
        );
      }

      logger.info(
        {
          operatorId,
          batchId: result.batchId,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors.length,
          reMatched: reMatchResult?.matched ?? 0,
          dryRun,
        },
        "marketplace.import.tcgplayer.complete"
      );

      res.json({
        ...result,
        reMatched: reMatchResult?.matched ?? 0,
        reMatchDetails: reMatchResult?.details ?? [],
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, fileName },
        "marketplace.import.tcgplayer.failed"
      );
      res.status(400).json({
        error: "IMPORT_FAILED",
        message: error.message,
      });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/import/easypost-tracking
   * Link EasyPost tracking export to marketplace orders
   *
   * Body: { csvData: string, dryRun?: boolean, fileName?: string }
   * Returns: { batchId, dryRun, autoLinked, queued, unmatched, errors, preview? }
   */
  router.post("/import/easypost-tracking", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const { csvData, dryRun = true, fileName } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "import.easypost-tracking", dryRun, fileName },
      "marketplace.import.easypost-tracking.start"
    );

    // Validate input
    if (!csvData || typeof csvData !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "csvData is required and must be a string",
      });
    }

    if (csvData.length > MAX_CSV_SIZE) {
      return res.status(400).json({
        error: "PAYLOAD_TOO_LARGE",
        message: `CSV data exceeds maximum size of ${MAX_CSV_SIZE / 1024 / 1024}MB`,
      });
    }

    try {
      const result = await easypostTrackingLinker.link(
        csvData,
        operatorId,
        fileName || null,
        dryRun
      );

      logger.info(
        {
          operatorId,
          batchId: result.batchId,
          autoLinked: result.autoLinked,
          queued: result.queued,
          unmatched: result.unmatched,
          errors: result.errors.length,
          dryRun,
        },
        "marketplace.import.easypost-tracking.complete"
      );

      res.json(result);
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, fileName },
        "marketplace.import.easypost-tracking.failed"
      );
      res.status(400).json({
        error: "IMPORT_FAILED",
        message: error.message,
      });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/import/unified
   * Unified CSV import endpoint with auto-format detection.
   * Accepts: TCGPlayer Shipping Export, TCGPlayer Order List, EasyPost Tracking
   *
   * Body: { csvData: string, dryRun?: boolean, fileName?: string }
   * Returns: { ok, format, formatDisplayName, ...format-specific results }
   */
  router.post("/import/unified", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const { csvData, dryRun = true, fileName } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "import.unified", dryRun, fileName },
      "marketplace.import.unified.start"
    );

    // Validate input
    if (!csvData || typeof csvData !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "csvData is required and must be a string",
      });
    }

    if (csvData.length > MAX_CSV_SIZE) {
      return res.status(400).json({
        error: "PAYLOAD_TOO_LARGE",
        message: `CSV data exceeds maximum size of ${MAX_CSV_SIZE / 1024 / 1024}MB`,
      });
    }

    // Detect CSV format from headers
    const headers = extractHeadersFromCsv(csvData);
    const format = detectCsvFormat(headers);

    if (format === "unknown") {
      logger.warn(
        { operatorId, headers: headers.slice(0, 10), fileName },
        "marketplace.import.unified.unknown_format"
      );
      return res.status(400).json({
        ok: false,
        error: "UNKNOWN_FORMAT",
        message: "Unrecognized CSV format. Expected TCGPlayer Shipping Export, TCGPlayer Order List, or EasyPost Tracking CSV.",
        detectedHeaders: headers.slice(0, 10), // First 10 headers for debugging
      });
    }

    logger.info(
      { operatorId, format, formatDisplayName: getFormatDisplayName(format), fileName },
      "marketplace.import.unified.format_detected"
    );

    try {
      let result: any;
      let reMatchResult: { matched: number; details: Array<{ trackingNumber: string; orderNumber: string }> } | null = null;

      switch (format) {
        case "tcgplayer_shipping":
          result = await tcgplayerImporter.import(csvData, operatorId, fileName || null, dryRun);
          // Re-match unmatched tracking after shipping export import
          if (!dryRun && (result.imported > 0 || result.upgraded > 0 || marketplaceService.hasUnmatchedTracking())) {
            reMatchResult = marketplaceService.reMatchUnmatchedTracking();
          }
          break;

        case "tcgplayer_orderlist":
          result = await tcgplayerImporter.importOrderList(csvData, operatorId, fileName || null, dryRun);
          // Re-match unmatched tracking after order list import
          if (!dryRun && (result.imported > 0 || marketplaceService.hasUnmatchedTracking())) {
            reMatchResult = marketplaceService.reMatchUnmatchedTracking();
          }
          break;

        case "tcgplayer_pullsheet":
          result = await pullSheetImporter.import(csvData, operatorId, fileName || null, dryRun);
          // No re-match needed: Pull Sheet imports items, not orders
          // Items will be attached to existing orders during import
          break;

        case "easypost_tracking":
          result = await easypostTrackingLinker.link(csvData, operatorId, fileName || null, dryRun);
          break;
      }

      logger.info(
        {
          operatorId,
          format,
          dryRun,
          imported: result.imported ?? 0,
          upgraded: result.upgraded ?? 0,
          skipped: result.skipped ?? 0,
          autoLinked: result.autoLinked ?? 0,
          queued: result.queued ?? 0,
          unmatched: result.unmatched ?? 0,
          errors: result.errors?.length ?? 0,
          reMatched: reMatchResult?.matched ?? 0,
        },
        "marketplace.import.unified.complete"
      );

      res.json({
        ok: true,
        format,
        formatDisplayName: getFormatDisplayName(format),
        ...result,
        reMatched: reMatchResult?.matched ?? 0,
        reMatchDetails: reMatchResult?.details ?? [],
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, format, fileName },
        "marketplace.import.unified.failed"
      );
      res.status(400).json({
        ok: false,
        error: "IMPORT_FAILED",
        format,
        formatDisplayName: getFormatDisplayName(format),
        message: error.message,
      });
    }
  });

  // ============================================================================
  // Stats Endpoint
  // ============================================================================

  /**
   * GET /api/cm-admin/marketplace/stats
   * Get fulfillment dashboard stats (combined CardMint + Marketplace).
   *
   * Returns: {
   *   pendingLabels: number,     // Shipments awaiting label purchase
   *   unmatchedTracking: number, // Unmatched tracking entries pending resolution
   *   exceptions: number,        // Shipments with exception status
   *   shippedToday: number       // Shipments marked shipped today (CST)
   * }
   */
  router.get("/stats", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;

    logger.info(
      { operatorId, clientIp, userAgent, action: "get.stats" },
      "marketplace.stats.request"
    );

    try {
      const stats = marketplaceService.getFulfillmentStats();
      res.json(stats);
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message, operatorId }, "marketplace.stats.failed");
      res.status(500).json({ error: "Failed to get fulfillment stats" });
    }
  });

  // ============================================================================
  // Order Endpoints
  // ============================================================================

  /**
   * GET /api/cm-admin/marketplace/orders
   * List marketplace orders with optional filters
   *
   * Query: ?source=tcgplayer|ebay|all&status=pending&limit=20&offset=0
   * Returns: { orders, total, limit, offset }
   */
  router.get("/orders", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const source = (req.query.source as string) || "all";
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    logger.info(
      { operatorId, clientIp, userAgent, action: "list.orders", source, status, limit, offset },
      "marketplace.orders.list"
    );

    try {
      const validSources = ["tcgplayer", "ebay", "all"];
      const validStatuses = ["pending", "processing", "shipped", "delivered", "exception", "cancelled"];

      const options: any = { limit, offset };
      if (validSources.includes(source) && source !== "all") {
        options.source = source;
      }
      if (status && validStatuses.includes(status)) {
        options.status = status;
      }

      const { orders, total } = marketplaceService.listOrders(options);

      res.json({ orders, total, limit, offset });
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message, operatorId }, "marketplace.orders.list.failed");
      res.status(500).json({ error: "Failed to list orders" });
    }
  });

  /**
   * GET /api/cm-admin/marketplace/orders/:orderId
   * Get order details with shipments
   * Does NOT return decrypted address by default (PII protection)
   *
   * Returns: { order, shipments }
   */
  router.get("/orders/:orderId", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const orderId = parseInt(req.params.orderId, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "get.order", orderId },
      "marketplace.orders.get"
    );

    if (isNaN(orderId)) {
      return res.status(400).json({ error: "Invalid order ID" });
    }

    try {
      const order = marketplaceService.getOrderById(orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const shipments = marketplaceService.getShipmentsByOrderId(orderId);

      // Strip encrypted address from response (PII protection)
      const safeShipments = shipments.map((s) => ({
        ...s,
        shipping_address_encrypted: undefined,
      }));

      res.json({ order, shipments: safeShipments });
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message, operatorId, orderId }, "marketplace.orders.get.failed");
      res.status(500).json({ error: "Failed to get order" });
    }
  });

  // ============================================================================
  // Unmatched Tracking Endpoints
  // ============================================================================

  /**
   * GET /api/cm-admin/marketplace/unmatched-tracking
   * List pending unmatched tracking entries
   *
   * Query: ?limit=20&offset=0
   * Returns: { unmatched, total }
   */
  router.get("/unmatched-tracking", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    logger.info(
      { operatorId, clientIp, userAgent, action: "list.unmatched", limit, offset },
      "marketplace.unmatched.list"
    );

    try {
      const unmatched = marketplaceService.listUnmatchedTracking(limit, offset);
      // Count total pending (excluding terminal tracking statuses)
      const countRow = db
        .prepare(`
          SELECT COUNT(*) as total FROM unmatched_tracking
          WHERE resolution_status = 'pending'
            AND (COALESCE(usps_status, easypost_status) IS NULL
                 OR COALESCE(usps_status, easypost_status) NOT IN ('delivered', 'in_transit', 'out_for_delivery', 'return_to_sender'))
        `).get() as { total: number };

      res.json({ unmatched, total: countRow.total, limit, offset });
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message, operatorId }, "marketplace.unmatched.list.failed");
      res.status(500).json({ error: "Failed to list unmatched tracking" });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/unmatched-tracking/:id/resolve
   * Resolve an unmatched tracking entry
   *
   * Body: { action: 'match'|'ignore'|'manual_entry', shipmentId?: number }
   * Returns: { success: true }
   */
  router.post("/unmatched-tracking/:id/resolve", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const unmatchedId = parseInt(req.params.id, 10);
    const { action, shipmentId } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "resolve.unmatched", unmatchedId, resolveAction: action, shipmentId },
      "marketplace.unmatched.resolve.start"
    );

    if (isNaN(unmatchedId)) {
      return res.status(400).json({ error: "Invalid unmatched tracking ID" });
    }

    const validActions = ["match", "ignore", "manual_entry"];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `action must be one of: ${validActions.join(", ")}`,
      });
    }

    // Parse and validate shipmentId when action is 'match'
    let parsedShipmentId: number | null = null;
    if (action === "match") {
      if (shipmentId === undefined || shipmentId === null || shipmentId === "") {
        return res.status(400).json({
          error: "BAD_REQUEST",
          message: "shipmentId is required when action is 'match'",
        });
      }
      parsedShipmentId = parseInt(String(shipmentId), 10);
      if (isNaN(parsedShipmentId) || parsedShipmentId <= 0) {
        return res.status(400).json({
          error: "BAD_REQUEST",
          message: "shipmentId must be a positive integer",
        });
      }
      // Verify shipment exists before resolving
      const shipment = marketplaceService.getShipmentById(parsedShipmentId);
      if (!shipment) {
        return res.status(400).json({
          error: "BAD_REQUEST",
          message: `Shipment with ID ${parsedShipmentId} not found`,
        });
      }
    }

    // Map action to resolution_status value
    const resolutionStatus = action === "match" ? "matched" : action === "ignore" ? "ignored" : "manual_entry";

    try {
      marketplaceService.resolveUnmatchedTracking(
        unmatchedId,
        resolutionStatus,
        parsedShipmentId,
        operatorId
      );

      logger.info(
        { operatorId, unmatchedId, action, shipmentId },
        "marketplace.unmatched.resolve.complete"
      );

      res.json({ success: true });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, unmatchedId },
        "marketplace.unmatched.resolve.failed"
      );
      res.status(500).json({ error: "Failed to resolve unmatched tracking" });
    }
  });

  // ============================================================================
  // Shipment Endpoints
  // ============================================================================

  /**
   * PATCH /api/cm-admin/marketplace/shipments/:id/status
   * Update shipment status and optional label URL (for operator-uploaded labels).
   *
   * Body: {
   *   status: 'pending'|'label_purchased'|'shipped'|'in_transit'|'delivered'|'exception',
   *   notes?: string,
   *   labelUrl?: string  // Optional: operator-uploaded label URL
   * }
   * Returns: { ok: true, shipmentId, status, shippedAt?, deliveredAt? }
   */
  router.patch("/shipments/:id/status", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const { status, notes, labelUrl } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "update.shipment.status", shipmentId, status, hasLabelUrl: !!labelUrl },
      "marketplace.shipment.status.start"
    );

    if (isNaN(shipmentId)) {
      return res.status(400).json({ error: "Invalid shipment ID" });
    }

    const validStatuses = ["pending", "label_purchased", "shipped", "in_transit", "delivered", "exception"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    try {
      // Verify shipment exists
      const shipment = marketplaceService.getShipmentById(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Update status (automatically propagates to child shipments)
      marketplaceService.updateShipmentStatus(shipmentId, status);

      // Handle labelUrl if provided (supports operator-uploaded labels)
      if (labelUrl && typeof labelUrl === "string") {
        // Validate URL scheme to prevent javascript:, data:, etc.
        if (!isValidLabelUrl(labelUrl)) {
          return res.status(400).json({
            error: "BAD_REQUEST",
            message: "labelUrl must use https:// or http:// scheme",
          });
        }
        marketplaceService.updateShipmentLabelUrl(shipmentId, labelUrl);
        // Phase 5: enqueue for immediate archival/print
        printQueueRepo.upsertForShipment({
          shipmentType: "marketplace",
          shipmentId,
          labelUrl,
        });
        logger.info(
          { operatorId, shipmentId, labelUrl: "updated" },
          "marketplace.shipment.labelUrl.updated"
        );
      }

      // Handle exception notes if status is exception
      if (status === "exception" && notes) {
        db.prepare("UPDATE marketplace_shipments SET exception_notes = ? WHERE id = ?").run(notes, shipmentId);
      }

      // Get updated shipment for response
      const updatedShipment = marketplaceService.getShipmentById(shipmentId);

      logger.info(
        { operatorId, shipmentId, status, notes: notes ? "provided" : "none", labelUrl: labelUrl ? "provided" : "none" },
        "marketplace.shipment.status.complete"
      );

      res.json({
        ok: true,
        shipmentId,
        status,
        shippedAt: updatedShipment?.shipped_at,
        deliveredAt: updatedShipment?.delivered_at,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.status.failed"
      );
      res.status(500).json({ error: "Failed to update shipment status" });
    }
  });

  /**
   * PATCH /api/cm-admin/marketplace/shipments/:id/pwe
   * Toggle stamp-based Plain White Envelope (PWE) workflow for a shipment.
   *
   * Body: { isPwe: boolean }
   * Returns: { ok: true, shipmentId, isPwe }
   */
  router.patch("/shipments/:id/pwe", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const { isPwe } = req.body || {};

    logger.info(
      { operatorId, clientIp, userAgent, action: "update.shipment.pwe", shipmentId, isPwe },
      "marketplace.shipment.pwe.start"
    );

    if (isNaN(shipmentId)) {
      return res.status(400).json({ error: "Invalid shipment ID" });
    }

    if (typeof isPwe !== "boolean") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "isPwe must be boolean",
      });
    }

    try {
      const shipment = marketplaceService.getShipmentById(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      marketplaceService.updateShipmentPwe(shipmentId, isPwe);

      logger.info({ operatorId, shipmentId, isPwe }, "marketplace.shipment.pwe.complete");

      res.json({ ok: true, shipmentId, isPwe });
    } catch (err) {
      const error = err as Error;
      logger.error({ err: error.message, operatorId, shipmentId }, "marketplace.shipment.pwe.failed");
      res.status(500).json({ error: "Failed to update PWE flag" });
    }
  });

  // ============================================================================
  // Rates & Label Endpoints (Phase 4)
  // ============================================================================

  /**
   * Parcel preset type
   */
  type ParcelPreset = {
    lengthIn: number;
    widthIn: number;
    heightIn: number;
    baseWeightOz: number;
    maxCards: number;
  };

  /**
   * Select parcel preset based on item count.
   * Returns preset key and dimensions/weight.
   */
  function selectParcelPreset(itemCount: number): {
    key: string;
    preset: ParcelPreset;
  } {
    const presets = runtimeConfig.parcelPresets;
    if (itemCount <= presets.singlecard.maxCards) {
      return { key: "singlecard", preset: presets.singlecard as ParcelPreset };
    }
    if (itemCount <= presets["multicard-bubble"].maxCards) {
      return { key: "multicard-bubble", preset: presets["multicard-bubble"] as ParcelPreset };
    }
    return { key: "multicard-box", preset: presets["multicard-box"] as ParcelPreset };
  }

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/rates
   * Get EasyPost rates for a shipment.
   *
   * Body: {
   *   customWeightOz?: number,    // Override preset weight
   *   parcelPreset?: string,      // Override auto-selected preset ("singlecard" | "multicard-bubble" | "multicard-box")
   *   parcelLength?: number,      // Override preset length (inches)
   *   parcelWidth?: number,       // Override preset width (inches)
   *   parcelHeight?: number,      // Override preset height (inches)
   * }
   * Returns: { ok, shipmentId, easypostShipmentId, parcelPreset, parcelLength, parcelWidth, parcelHeight, parcelWeightOz, insuredValueCents, rates }
   */
  router.post("/shipments/:id/rates", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const { customWeightOz, parcelPreset: requestedPreset, parcelLength, parcelWidth, parcelHeight } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "get.rates", shipmentId, customWeightOz, requestedPreset, parcelLength, parcelWidth, parcelHeight },
      "marketplace.shipment.rates.start"
    );

    if (isNaN(shipmentId)) {
      return res.status(400).json({ error: "Invalid shipment ID" });
    }

    // Validate parcel preset if provided
    const validPresets = Object.keys(runtimeConfig.parcelPresets);
    if (requestedPreset && !validPresets.includes(requestedPreset)) {
      return res.status(400).json({
        error: "INVALID_PRESET",
        message: `Invalid parcel preset '${requestedPreset}'. Valid presets: ${validPresets.join(", ")}`,
      });
    }

    // Validate dimension bounds if provided (0.1" - 36")
    const validateDimension = (val: number | undefined, name: string): string | null => {
      if (val === undefined || val === null) return null;
      if (typeof val !== "number" || isNaN(val)) return `${name} must be a number`;
      if (val < 0.1 || val > 36) return `${name} must be between 0.1 and 36 inches`;
      return null;
    };
    const lengthErr = validateDimension(parcelLength, "parcelLength");
    const widthErr = validateDimension(parcelWidth, "parcelWidth");
    const heightErr = validateDimension(parcelHeight, "parcelHeight");
    if (lengthErr || widthErr || heightErr) {
      return res.status(400).json({
        error: "INVALID_DIMENSIONS",
        message: lengthErr || widthErr || heightErr,
      });
    }

    // Validate weight bounds if provided (0.1 - 1120 oz = 70 lbs)
    if (customWeightOz !== undefined && customWeightOz !== null) {
      if (typeof customWeightOz !== "number" || isNaN(customWeightOz)) {
        return res.status(400).json({ error: "INVALID_WEIGHT", message: "customWeightOz must be a number" });
      }
      if (customWeightOz < 0.1 || customWeightOz > 1120) {
        return res.status(400).json({ error: "INVALID_WEIGHT", message: "customWeightOz must be between 0.1 and 1120 oz" });
      }
    }

    // 1. Get shipment with decrypted address and order
    const shipmentData = marketplaceService.getShipmentWithDecryptedAddress(shipmentId);
    if (!shipmentData) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    // 2. Verify status is pending (can only get rates for pending shipments)
    if (shipmentData.status !== "pending") {
      return res.status(400).json({
        error: "INVALID_STATUS",
        message: `Cannot get rates for shipment with status '${shipmentData.status}'`,
      });
    }

    // 2b. Order List imports have no address; prompt to import Shipping Export CSV.
    // (If address exists, allow rates even if flag is stale.)
    if (shipmentData.is_external === 1 && !shipmentData.decryptedAddress) {
      return res.status(400).json({
        error: "MISSING_SHIPPING_EXPORT",
        message:
          "Missing shipping address (TCGPlayer Order List export has no address). Import the TCGPlayer Shipping Export CSV for this order to enable label purchase.",
      });
    }

    // 3. Check for expired/purged address
    if (!shipmentData.decryptedAddress) {
      return res.status(400).json({
        error: "ADDRESS_EXPIRED",
        message: "Shipping address has expired or been purged (PII retention policy)",
      });
    }

    if (!shipmentData.order) {
      return res.status(400).json({
        error: "ORDER_NOT_FOUND",
        message: "Associated order not found",
      });
    }

    // 4. Determine item count (per-shipment or fallback to order)
    const itemCount = marketplaceService.getShipmentItemCount(shipmentData, shipmentData.order);

    // 5. Select parcel preset: use requestedPreset if provided, else auto-select by item count
    let parcelPresetKey: string;
    let preset: ParcelPreset;
    if (requestedPreset) {
      parcelPresetKey = requestedPreset;
      preset = runtimeConfig.parcelPresets[requestedPreset as keyof typeof runtimeConfig.parcelPresets] as ParcelPreset;
    } else {
      const autoSelected = selectParcelPreset(itemCount);
      parcelPresetKey = autoSelected.key;
      preset = autoSelected.preset;
    }

    // 6. Calculate dimensions: use custom if provided, else preset defaults
    const finalLength = parcelLength ?? preset.lengthIn;
    const finalWidth = parcelWidth ?? preset.widthIn;
    const finalHeight = parcelHeight ?? preset.heightIn;

    // 7. Calculate weight: use customWeightOz if provided, else preset base weight
    const parcelWeightOz = customWeightOz != null && customWeightOz > 0
      ? customWeightOz
      : preset.baseWeightOz;

    // 8. Determine insurance: if order value >= $50, add coverage
    const orderValueCents = shipmentData.order.product_value_cents;
    const insuranceThresholdCents = 5000; // $50
    const maxInsuranceCents = 10000; // Cap at $100 coverage
    const insuredValueCents = orderValueCents >= insuranceThresholdCents
      ? Math.min(orderValueCents, maxInsuranceCents)
      : null;
    const insuranceAmountDollars = insuredValueCents ? insuredValueCents / 100 : 0;

    // 9. Build parcel object with final dimensions
    const parcel: EasyPostParcel = {
      length: finalLength,
      width: finalWidth,
      height: finalHeight,
      weight: parcelWeightOz,
    };

    // 10. Build address object for EasyPost
    const toAddress: EasyPostAddress = {
      name: shipmentData.decryptedAddress.name,
      street1: shipmentData.decryptedAddress.street1,
      street2: shipmentData.decryptedAddress.street2,
      city: shipmentData.decryptedAddress.city,
      state: shipmentData.decryptedAddress.state,
      zip: shipmentData.decryptedAddress.zip,
      country: shipmentData.decryptedAddress.country || "US",
    };

    // 11. Check idempotency: if easypost_shipment_id exists and parcel params unchanged, return cached rates
    // Create new shipment if any parcel override is provided (preset, dimensions, or weight)
    let easypostShipmentId = shipmentData.easypost_shipment_id;
    let rates;

    const parcelOverrideProvided = requestedPreset || parcelLength || parcelWidth || parcelHeight || customWeightOz;
    const weightChanged = shipmentData.parcel_weight_oz != null &&
      Math.abs(shipmentData.parcel_weight_oz - parcelWeightOz) > 0.01;

    // Helper to add recommended flag to rates (USPS Ground Advantage first, else cheapest USPS, else cheapest UPS)
    const addRecommendedFlag = (rateList: Array<{ id: string; carrier: string; service: string; rate: string; deliveryDays?: number; deliveryDate?: string }>) => {
      if (!rateList.length) return rateList;

      // Find recommended rate: cheapest USPS Ground Advantage, else cheapest USPS, else cheapest UPS
      let recommendedId: string | null = null;
      // EasyPost returns "GroundAdvantage" (no space)
      const uspsGroundAdvantage = rateList.filter(r => r.carrier === "USPS" && r.service.includes("GroundAdvantage"));
      const uspsRates = rateList.filter(r => r.carrier === "USPS");
      const upsRates = rateList.filter(r => r.carrier === "UPS");

      if (uspsGroundAdvantage.length > 0) {
        recommendedId = uspsGroundAdvantage.reduce((min, r) => parseFloat(r.rate) < parseFloat(min.rate) ? r : min).id;
      } else if (uspsRates.length > 0) {
        recommendedId = uspsRates.reduce((min, r) => parseFloat(r.rate) < parseFloat(min.rate) ? r : min).id;
      } else if (upsRates.length > 0) {
        recommendedId = upsRates.reduce((min, r) => parseFloat(r.rate) < parseFloat(min.rate) ? r : min).id;
      }

      return rateList.map(r => ({ ...r, recommended: r.id === recommendedId }));
    };

    // Fetch order items early - needed for both cached and new shipment responses
    const orderItems = marketplaceService.getItemsByOrderId(shipmentData.order.id);

    if (easypostShipmentId && !weightChanged && !parcelOverrideProvided) {
      // Fetch existing shipment rates from EasyPost
      const existingShipment = await easyPostService.getShipment(easypostShipmentId);
      if (existingShipment && existingShipment.rates) {
        const allowedCarriers = ["USPS", "UPS"];
        rates = existingShipment.rates
          .filter((rate) => allowedCarriers.includes(rate.carrier))
          .sort((a, b) => {
            if (a.carrier !== b.carrier) return a.carrier === "USPS" ? -1 : 1;
            return parseFloat(a.rate) - parseFloat(b.rate);
          });

        logger.info(
          { operatorId, shipmentId, easypostShipmentId, ratesCount: rates.length },
          "marketplace.shipment.rates.cached"
        );

        const mappedRates = rates.map((r) => ({
          id: r.id,
          carrier: r.carrier,
          service: r.service,
          rate: r.rate,
          deliveryDays: (r.delivery_days ?? r.est_delivery_days) || undefined,
          deliveryDate: r.delivery_date || undefined,
        }));

        return res.json({
          ok: true,
          shipmentId,
          easypostShipmentId,
          parcelPreset: parcelPresetKey,
          parcelLength: finalLength,
          parcelWidth: finalWidth,
          parcelHeight: finalHeight,
          parcelWeightOz,
          insuredValueCents,
          rates: addRecommendedFlag(mappedRates),
          items: orderItems.map((item) => ({
            productName: item.product_name,
            setName: item.set_name,
            cardNumber: item.card_number,
            quantity: item.quantity,
          })),
        });
      }
    }

    // 12. Create new EasyPost shipment with order context for label custom fields
    const orderNumber = formatTcgplayerOrderNumber(shipmentData.order.external_order_id);
    const firstItemDescription = orderItems.length > 0
      ? (orderItems.length > 1 ? `${orderItems[0].product_name} (+${orderItems.length - 1} more)` : orderItems[0].product_name)
      : undefined;

    const result = await easyPostService.createMarketplaceShipment(
      toAddress,
      parcel,
      insuranceAmountDollars,
      {
        orderNumber,
        productDescription: firstItemDescription,
        reference: `Shipment ${shipmentId}`,
      }
    );

    if (!result.success || !result.shipment) {
      logger.error(
        { operatorId, shipmentId, error: result.error, errorCode: result.errorCode },
        "marketplace.shipment.rates.failed"
      );
      return res.status(400).json({
        error: result.errorCode || "EASYPOST_ERROR",
        message: result.error,
      });
    }

    easypostShipmentId = result.shipment.id;
    rates = result.rates || [];

    // 13. Store audit fields on shipment
    marketplaceService.updateShipmentEasypostShipment(
      shipmentId,
      easypostShipmentId,
      parcelPresetKey,
      parcelWeightOz,
      insuredValueCents,
      itemCount
    );

    logger.info(
      {
        operatorId,
        shipmentId,
        easypostShipmentId,
        parcelPreset: parcelPresetKey,
        parcelLength: finalLength,
        parcelWidth: finalWidth,
        parcelHeight: finalHeight,
        parcelWeightOz,
        insuredValueCents,
        ratesCount: rates.length,
      },
      "marketplace.shipment.rates.complete"
    );

    const mappedRates = rates.map((r) => ({
      id: r.id,
      carrier: r.carrier,
      service: r.service,
      rate: r.rate,
      deliveryDays: (r.delivery_days ?? r.est_delivery_days) || undefined,
      deliveryDate: r.delivery_date || undefined,
    }));

    res.json({
      ok: true,
      shipmentId,
      easypostShipmentId,
      parcelPreset: parcelPresetKey,
      parcelLength: finalLength,
      parcelWidth: finalWidth,
      parcelHeight: finalHeight,
      parcelWeightOz,
      insuredValueCents,
      rates: addRecommendedFlag(mappedRates),
      items: orderItems.map((item) => ({
        productName: item.product_name,
        setName: item.set_name,
        cardNumber: item.card_number,
        quantity: item.quantity,
      })),
    });
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/label
   * Purchase shipping label for a shipment.
   * Idempotent: if label already purchased, returns existing data without re-buying.
   * Concurrent-safe: Uses label_purchase_in_progress lock to prevent double-spend.
   *
   * Body: { rateId: string }
   * Returns: { ok, shipmentId, trackingNumber, trackingUrl, labelUrl, labelCostCents, carrier, service }
   */
  router.post("/shipments/:id/label", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const { rateId } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "purchase.label", shipmentId, rateId },
      "marketplace.shipment.label.start"
    );

    if (isNaN(shipmentId)) {
      return res.status(400).json({ error: "Invalid shipment ID" });
    }

    if (!rateId || typeof rateId !== "string") {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "rateId is required",
      });
    }

    // 1. Get shipment
    const shipment = marketplaceService.getShipmentById(shipmentId);
    if (!shipment) {
      return res.status(404).json({ error: "Shipment not found" });
    }

    if (shipment.is_pwe === 1) {
      return res.status(400).json({
        error: "PWE_SHIPMENT",
        message:
          "This shipment is marked as PWE (stamp-based manual shipping). Undo PWE before purchasing a label.",
      });
    }

    // 1b. Order List imports have no address; prompt to import Shipping Export CSV.
    // If rates were already fetched (easypost_shipment_id exists), allow purchase.
    if (shipment.is_external === 1 && !shipment.easypost_shipment_id) {
      return res.status(400).json({
        error: "MISSING_SHIPPING_EXPORT",
        message:
          "Missing shipping address (TCGPlayer Order List export has no address). Import the TCGPlayer Shipping Export CSV for this order to enable label purchase.",
      });
    }

    // 2. Verify easypost_shipment_id exists (must call /rates first)
    if (!shipment.easypost_shipment_id) {
      return res.status(400).json({
        error: "RATES_NOT_FETCHED",
        message: "Must call /rates endpoint before purchasing label",
      });
    }

    // 3. Acquire lock (atomically checks idempotency + prevents concurrent purchase)
    const lockResult = marketplaceService.acquireLabelPurchaseLock(shipmentId);

      if (!lockResult.acquired) {
        if (lockResult.reason === "already_purchased" && lockResult.shipment) {
          // Phase 5: ensure print queue row exists (idempotent retries should not re-enqueue)
          if (lockResult.shipment.label_url) {
            printQueueRepo.upsertForShipment({
              shipmentType: "marketplace",
              shipmentId,
              labelUrl: lockResult.shipment.label_url,
            });
          }
          // Idempotent response - label already purchased
          logger.info(
            { operatorId, shipmentId, trackingNumber: lockResult.shipment.tracking_number },
            "marketplace.shipment.label.idempotent"
          );

        return res.json({
          ok: true,
          shipmentId,
          trackingNumber: lockResult.shipment.tracking_number,
          trackingUrl: lockResult.shipment.tracking_url,
          labelUrl: lockResult.shipment.label_url,
          labelCostCents: lockResult.shipment.label_cost_cents,
          carrier: lockResult.shipment.carrier,
          service: lockResult.shipment.service,
          alreadyPurchased: true,
        });
      }

      if (lockResult.reason === "in_progress") {
        // Another request is processing - return 409 Conflict
        logger.warn(
          { operatorId, shipmentId },
          "marketplace.shipment.label.concurrent"
        );

        return res.status(409).json({
          error: "PURCHASE_IN_PROGRESS",
          message: "Another label purchase is in progress for this shipment. Please retry in a few seconds.",
        });
      }
    }

    // 4. Lock acquired - proceed with EasyPost call
    // Use try/finally to ensure lock is always released
    try {
      // Per EasyPost API spec, insurance must be passed at buy time (not creation)
      const insuranceAmountDollars = shipment.insured_value_cents
        ? shipment.insured_value_cents / 100
        : undefined;

      const labelResult = await easyPostService.purchaseMarketplaceLabel(
        shipment.easypost_shipment_id!,
        rateId,
        insuranceAmountDollars
      );

      if (!labelResult.success) {
        logger.error(
          { operatorId, shipmentId, error: labelResult.error, errorCode: labelResult.errorCode },
          "marketplace.shipment.label.failed"
        );
        return res.status(400).json({
          error: labelResult.errorCode || "EASYPOST_ERROR",
          message: labelResult.error,
        });
      }

      // 5. Validate required fields from EasyPost response
      if (!labelResult.trackingNumber || !labelResult.labelUrl) {
        logger.error(
          { operatorId, shipmentId, hasTracking: !!labelResult.trackingNumber, hasLabel: !!labelResult.labelUrl },
          "marketplace.shipment.label.incomplete_response"
        );
        return res.status(500).json({
          error: "EASYPOST_INCOMPLETE",
          message: "EasyPost returned incomplete label data (missing tracking number or label URL)",
        });
      }

      // 6. Parse rate to cents
      const labelCostCents = labelResult.shipment?.selected_rate?.rate
        ? Math.round(parseFloat(labelResult.shipment.selected_rate.rate) * 100)
        : 0;

      // Build tracking URL - prefer carrier-native URLs (more reliable than EasyPost public page)
      // EasyPost's track.easypost.com sometimes returns ERR_EMPTY_RESPONSE
      // Fallback to EasyPost public_url for unknown carriers (e.g., Asendia, USPS International)
      const shipmentTracker = (labelResult.shipment as any)?.tracker;
      const trackingUrl = marketplaceService.generateTrackingUrl(
        labelResult.trackingNumber || "",
        labelResult.carrier || null
      ) || (shipmentTracker?.public_url ?? null);

      // 7. Store tracking/label info in database (use NULL not empty string)
      marketplaceService.updateShipmentLabelPurchased(
        shipmentId,
        labelResult.trackingNumber,
        trackingUrl || null,
        labelResult.labelUrl,
        labelCostCents,
        labelResult.carrier || null,
        labelResult.service || null,
        rateId
      );

      // Phase 5: enqueue for immediate archival/print (all purchased labels)
      printQueueRepo.upsertForShipment({
        shipmentType: "marketplace",
        shipmentId,
        labelUrl: labelResult.labelUrl,
      });

      // 8. Audit log (never log PII)
      logger.info(
        {
          operatorId,
          shipmentId,
          trackingNumber: labelResult.trackingNumber,
          carrier: labelResult.carrier,
          service: labelResult.service,
          labelCostCents,
          alreadyPurchased: labelResult.alreadyPurchased,
        },
        "marketplace.shipment.label.complete"
      );

      res.json({
        ok: true,
        shipmentId,
        trackingNumber: labelResult.trackingNumber,
        trackingUrl,
        labelUrl: labelResult.labelUrl,
        labelCostCents,
        carrier: labelResult.carrier,
        service: labelResult.service,
        alreadyPurchased: labelResult.alreadyPurchased || false,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.label.error"
      );
      res.status(500).json({
        error: "LABEL_PURCHASE_FAILED",
        message: error.message,
      });
    } finally {
      // 9. Always release lock
      marketplaceService.releaseLabelPurchaseLock(shipmentId);
    }
  });

  /**
   * GET /api/cm-admin/marketplace/shipments/:id/label/optimized
   * Get a PL-60 optimized label for thermal printing.
   *
   * Returns optimized label (812x1218, grayscale) for 4x6 thermal labels at 203 DPI.
   * Caches the result for fast subsequent access.
   *
   * Query params:
   * - format: "png" (default), "pdf" (print-ready), or "info" (returns metadata)
   *
   * PDF format creates a 4x6 inch PDF with the label embedded, which prints correctly
   * from native viewers (Fedora's image viewer ignores PNG DPI metadata).
   */
  router.get("/shipments/:id/label/optimized", async (req: Request, res: Response) => {
    const { operatorId } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const format = req.query.format as string || "png";

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    // Validate format parameter
    if (!["png", "pdf", "info"].includes(format)) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "Invalid format. Use 'png', 'pdf', or 'info'",
      });
    }

    try {
      // 1. Get shipment to find label URL
      const shipment = marketplaceService.getShipmentById(shipmentId) as any;
      if (!shipment) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Shipment not found" });
      }

      if (!shipment.label_url) {
        return res.status(400).json({
          error: "NO_LABEL",
          message: "No label has been purchased for this shipment yet",
        });
      }

      // 1b. Block access if label refund is pending or confirmed
      // Note: 'rejected' means refund failed, so label is still valid for printing
      if (shipment.refund_status === "submitted") {
        return res.status(409).json({
          error: "REFUND_PENDING",
          message: "Refund is pending. Check /refund/check to refresh status.",
        });
      }
      if (shipment.refund_status === "refunded") {
        return res.status(410).json({
          error: "LABEL_REFUNDED",
          message: "This label has been refunded and cannot be printed",
        });
      }
      // refund_status === "rejected" → label is still valid, allow printing

      // 2. If info requested, return metadata
      if (format === "info") {
        const cached = await getCachedLabel(shipmentId, "marketplace");
        return res.json({
          ok: true,
          shipmentId,
          hasLabel: true,
          originalUrl: shipment.label_url,
          optimizedCached: cached !== null,
          targetWidth: 812,
          targetHeight: 1218,
          targetDpi: 203,
          supportedFormats: ["png", "pdf"],
        });
      }

      // 3. Process and return optimized label (PNG or PDF)
      const outputFormat = format as "png" | "pdf";
      const processed = await processLabelForPL60(shipment.label_url, shipmentId, "marketplace", outputFormat);

      // 3b. Track label view (only for PNG/PDF, not info) - for Print → Reprint UI state
      // Best-effort atomic write - don't let this break label rendering
      if (!shipment.label_viewed_at) {
        try {
          db.prepare("UPDATE marketplace_shipments SET label_viewed_at = ? WHERE id = ? AND label_viewed_at IS NULL")
            .run(Math.floor(Date.now() / 1000), shipmentId);
        } catch (viewErr) {
          logger.warn({ err: (viewErr as Error).message, shipmentId }, "Failed to update label_viewed_at (non-blocking)");
        }
      }

      logger.info(
        { operatorId, shipmentId, format: outputFormat, size: processed.optimizedBuffer.length },
        "marketplace.shipment.label.optimized"
      );

      if (outputFormat === "pdf") {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="label_${shipmentId}_pl60.pdf"`);
      } else {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `inline; filename="label_${shipmentId}_pl60.png"`);
      }
      res.setHeader("Content-Length", processed.optimizedBuffer.length);
      res.setHeader("Cache-Control", "private, max-age=3600"); // Cache for 1 hour
      res.send(processed.optimizedBuffer);
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId, format },
        "marketplace.shipment.label.optimized.error"
      );
      res.status(500).json({
        error: "LABEL_PROCESSING_FAILED",
        message: error.message,
      });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/void
   * Request a refund/void for a purchased shipping label via EasyPost.
   * This is Step 1 of the two-step refund flow.
   *
   * Step 1: Sets refund_status = 'submitted', keeps label data intact.
   * Step 2: Use /refund/check to poll for final status and clear label if refunded.
   *
   * Guards:
   * - Uses isRefundEligible() which checks:
   *   - Must have easypost_shipment_id
   *   - refund_status must be null
   *   - Status is 'label_purchased' OR ('shipped' with EasyPost pre_transit)
   *
   * Returns: { ok, shipmentId, refundStatus, easypostStatus? }
   */
  router.post("/shipments/:id/void", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "void.label", shipmentId },
      "marketplace.shipment.void.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    try {
      // 1. Get shipment with cache columns for eligibility check
      const shipment = db.prepare(`
        SELECT id, status, easypost_shipment_id, refund_status,
               easypost_status_cached, easypost_status_cached_at
        FROM marketplace_shipments
        WHERE id = ?
      `).get(shipmentId) as MarketplaceShipmentForRefund | undefined;

      if (!shipment) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Shipment not found" });
      }

      // 2. Check refund eligibility (handles cache, live EasyPost calls, status validation)
      const eligibility = await isRefundEligible(shipment, easyPostService, db);

      if (!eligibility.eligible) {
        logger.warn(
          { operatorId, shipmentId, reason: eligibility.reason, easypostStatus: eligibility.easypostStatus },
          "marketplace.shipment.void.not_eligible"
        );
        return res.status(400).json({
          error: "NOT_ELIGIBLE",
          reason: eligibility.reason,
          easypostStatus: eligibility.easypostStatus ?? null,
          cached: eligibility.cached,
          message: getRefundRejectionMessage(eligibility.reason),
        });
      }

      // 3. Call EasyPost refund API
      const refundResult = await easyPostService.refundShipment(shipment.easypost_shipment_id!);

      if (!refundResult.success) {
        logger.error(
          { operatorId, shipmentId, error: refundResult.error },
          "marketplace.shipment.void.easypost_failed"
        );
        return res.status(400).json({
          error: "REFUND_FAILED",
          message: refundResult.error || "EasyPost refund request failed",
        });
      }

      // 4. Update refund status - keep label data intact until confirmed
      const refundStatus = refundResult.refundStatus || "submitted";
      marketplaceService.updateRefundStatus(shipmentId, refundStatus);

      logger.info(
        { operatorId, shipmentId, refundStatus, easypostStatus: eligibility.easypostStatus },
        "marketplace.shipment.void.complete"
      );

      res.json({
        ok: true,
        shipmentId,
        refundStatus,
        easypostStatus: eligibility.easypostStatus ?? null,
        message: "Refund submitted. Use /refund/check to poll for final status.",
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.void.error"
      );
      res.status(500).json({
        error: "VOID_ERROR",
        message: error.message,
      });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/refund/check
   * Poll EasyPost for current refund status and handle outcome.
   * This is Step 2 of the two-step refund flow.
   *
   * If refunded: Clears label data via resetShipmentToPending()
   * If rejected: Sets refund_status = 'rejected', label printing resumes
   * If submitted: No change, keep polling
   *
   * Returns: { ok, refundStatus, previousStatus, labelCleared }
   */
  router.post("/shipments/:id/refund/check", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "refund.check", shipmentId },
      "marketplace.shipment.refund.check.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    try {
      // 1. Get shipment
      const shipment = marketplaceService.getShipmentById(shipmentId) as any;
      if (!shipment) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Shipment not found" });
      }

      // 2. Must have pending refund to check
      if (!shipment.refund_status) {
        return res.status(400).json({
          error: "NO_PENDING_REFUND",
          message: "No refund has been requested for this shipment. Use /void first.",
        });
      }

      // 3. If already finalized, return current status
      if (shipment.refund_status === "refunded" || shipment.refund_status === "rejected") {
        return res.json({
          ok: true,
          shipmentId,
          refundStatus: shipment.refund_status,
          previousStatus: shipment.refund_status,
          labelCleared: shipment.refund_status === "refunded",
          message: `Refund already finalized as '${shipment.refund_status}'.`,
        });
      }

      // 4. Must have EasyPost shipment ID
      if (!shipment.easypost_shipment_id) {
        return res.status(400).json({
          error: "NO_EASYPOST_SHIPMENT",
          message: "No EasyPost shipment ID found.",
        });
      }

      // 5. Poll EasyPost for current status
      const statusResult = await easyPostService.getShipmentRefundStatus(shipment.easypost_shipment_id);

      if (!statusResult.success) {
        logger.warn(
          { operatorId, shipmentId, error: statusResult.error },
          "marketplace.shipment.refund.check.easypost_failed"
        );
        return res.status(502).json({
          error: "EASYPOST_ERROR",
          message: statusResult.error || "Failed to fetch refund status from EasyPost",
        });
      }

      const previousStatus = shipment.refund_status;
      const newRefundStatus = statusResult.refundStatus;
      let labelCleared = false;

      // 6. Handle status transitions
      if (newRefundStatus === "refunded") {
        // Refund confirmed - clear label data
        marketplaceService.updateRefundStatus(shipmentId, "refunded");
        marketplaceService.resetShipmentToPending(shipmentId);
        labelCleared = true;

        logger.info(
          { operatorId, shipmentId, previousStatus, newRefundStatus: "refunded" },
          "marketplace.shipment.refund.check.refunded"
        );
      } else if (newRefundStatus === "rejected") {
        // Refund rejected - label is still valid
        marketplaceService.updateRefundStatus(shipmentId, "rejected");

        logger.info(
          { operatorId, shipmentId, previousStatus, newRefundStatus: "rejected" },
          "marketplace.shipment.refund.check.rejected"
        );
      } else {
        // Still submitted - no change
        logger.debug(
          { operatorId, shipmentId, refundStatus: newRefundStatus },
          "marketplace.shipment.refund.check.still_pending"
        );
      }

      res.json({
        ok: true,
        shipmentId,
        refundStatus: newRefundStatus ?? previousStatus,
        previousStatus,
        trackingStatus: statusResult.trackingStatus,
        labelCleared,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.refund.check.error"
      );
      res.status(500).json({
        error: "REFUND_CHECK_ERROR",
        message: error.message,
      });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/refund
   * Back-compat wrapper: calls /void logic, then best-effort polls /refund/check once.
   * Preserves existing FE contract while we migrate to the two-step flow.
   *
   * Idempotent: if refund already submitted/refunded/rejected, returns current status.
   */
  router.post("/shipments/:id/refund", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "refund.backcompat", shipmentId },
      "marketplace.shipment.refund.backcompat.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    try {
      // 1. Get shipment with cache columns for eligibility check
      const shipment = db.prepare(`
        SELECT id, status, easypost_shipment_id, refund_status,
               easypost_status_cached, easypost_status_cached_at
        FROM marketplace_shipments
        WHERE id = ?
      `).get(shipmentId) as MarketplaceShipmentForRefund | undefined;

      if (!shipment) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Shipment not found" });
      }

      // 2. Idempotency: if already submitted/refunded/rejected, skip to poll
      let refundStatus = shipment.refund_status;
      let alreadySubmitted = false;

      if (refundStatus === "refunded") {
        // Already refunded - return success
        return res.json({
          ok: true,
          shipmentId,
          refundStatus: "refunded",
          labelCleared: true,
          message: "Label has already been refunded.",
        });
      }

      if (refundStatus === "rejected") {
        // Previously rejected - can try again via /void
        return res.status(400).json({
          error: "REFUND_REJECTED",
          refundStatus: "rejected",
          message: "A previous refund was rejected. Use /void to retry if conditions changed.",
        });
      }

      if (refundStatus === "submitted") {
        // Already submitted - skip to poll
        alreadySubmitted = true;
      } else {
        // 3. Check refund eligibility (same as /void)
        const eligibility = await isRefundEligible(shipment, easyPostService, db);

        if (!eligibility.eligible) {
          logger.warn(
            { operatorId, shipmentId, reason: eligibility.reason, easypostStatus: eligibility.easypostStatus },
            "marketplace.shipment.refund.backcompat.not_eligible"
          );
          return res.status(400).json({
            error: "NOT_ELIGIBLE",
            reason: eligibility.reason,
            easypostStatus: eligibility.easypostStatus ?? null,
            cached: eligibility.cached,
            message: getRefundRejectionMessage(eligibility.reason),
          });
        }

        // 4. Call EasyPost refund API (same as /void)
        const refundResult = await easyPostService.refundShipment(shipment.easypost_shipment_id!);

        if (!refundResult.success) {
          logger.error(
            { operatorId, shipmentId, error: refundResult.error },
            "marketplace.shipment.refund.backcompat.easypost_failed"
          );
          return res.status(400).json({
            error: "REFUND_FAILED",
            message: refundResult.error || "EasyPost refund request failed",
          });
        }

        // 5. Update refund status to submitted
        refundStatus = refundResult.refundStatus || "submitted";
        marketplaceService.updateRefundStatus(shipmentId, refundStatus);

        logger.info(
          { operatorId, shipmentId, refundStatus },
          "marketplace.shipment.refund.backcompat.submitted"
        );
      }

      // 6. Best-effort poll once with 3s timeout (non-blocking failure)
      let labelCleared = false;
      let finalStatus = refundStatus;

      // Guard: can't poll without EasyPost shipment ID
      if (!shipment.easypost_shipment_id) {
        logger.warn(
          { operatorId, shipmentId },
          "marketplace.shipment.refund.backcompat.no_easypost_id_for_poll"
        );
        return res.status(400).json({
          error: "NO_EASYPOST_SHIPMENT",
          refundStatus: finalStatus,
          message: "No EasyPost shipment ID found. Cannot poll for refund status.",
        });
      }

      try {
        const pollPromise = easyPostService.getShipmentRefundStatus(shipment.easypost_shipment_id);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
        const statusResult = await Promise.race([pollPromise, timeoutPromise]);

        if (statusResult && statusResult.success) {
          const newRefundStatus = statusResult.refundStatus;

          if (newRefundStatus === "refunded") {
            marketplaceService.updateRefundStatus(shipmentId, "refunded");
            marketplaceService.resetShipmentToPending(shipmentId);
            labelCleared = true;
            finalStatus = "refunded";

            logger.info(
              { operatorId, shipmentId, previousStatus: refundStatus, newRefundStatus: "refunded" },
              "marketplace.shipment.refund.backcompat.refunded"
            );
          } else if (newRefundStatus === "rejected") {
            marketplaceService.updateRefundStatus(shipmentId, "rejected");
            finalStatus = "rejected";

            logger.info(
              { operatorId, shipmentId, previousStatus: refundStatus, newRefundStatus: "rejected" },
              "marketplace.shipment.refund.backcompat.rejected"
            );
          } else {
            // Still submitted
            finalStatus = newRefundStatus ?? refundStatus;
          }
        } else {
          // Poll timed out or failed - return submitted status
          logger.debug(
            { operatorId, shipmentId, alreadySubmitted },
            "marketplace.shipment.refund.backcompat.poll_timeout"
          );
        }
      } catch (pollErr) {
        // Best-effort - don't fail the whole request
        logger.warn(
          { operatorId, shipmentId, err: (pollErr as Error).message },
          "marketplace.shipment.refund.backcompat.poll_error"
        );
      }

      // 7. Return result
      const message = finalStatus === "refunded"
        ? "Label refunded successfully."
        : finalStatus === "rejected"
          ? "Refund was rejected by the carrier."
          : "Refund submitted. Status may take a few minutes to finalize.";

      // ok: true for all outcomes (refunded/rejected/submitted) - FE uses refundStatus for display
      // ok: false is reserved for actual request failures (4xx/5xx errors above)
      res.json({
        ok: true,
        shipmentId,
        refundStatus: finalStatus,
        labelCleared,
        message,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.refund.backcompat.error"
      );
      res.status(500).json({
        error: "REFUND_ERROR",
        message: error.message,
      });
    }
  });

  // ============================================================================
  // Combined Shipment Endpoints
  // ============================================================================

  /**
   * GET /api/cm-admin/marketplace/shipments/:id/combine-candidates
   * Find eligible parent shipments for combining with a given child shipment.
   *
   * Returns shipments from the same buyer within the last 7 days that have tracking.
   *
   * Returns: { ok, candidates: [...] }
   */
  router.get("/shipments/:id/combine-candidates", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "combine-candidates", shipmentId },
      "marketplace.shipment.combine-candidates.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    try {
      const candidates = marketplaceService.getCombineCandidates(shipmentId);

      logger.info(
        { operatorId, shipmentId, candidateCount: candidates.length },
        "marketplace.shipment.combine-candidates.complete"
      );

      res.json({ ok: true, candidates });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.combine-candidates.failed"
      );
      res.status(500).json({ error: "Failed to get combine candidates" });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/combine
   * Combine a child shipment with a parent shipment.
   *
   * The child inherits tracking info and status from the parent.
   *
   * Body: { parentShipmentId: number, reason: string }
   * Returns: { ok, childShipmentId, parentShipmentId, inheritedTracking, addressMismatchWarning? }
   */
  router.post("/shipments/:id/combine", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const childShipmentId = parseInt(req.params.id, 10);
    const { parentShipmentId, reason } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "combine", childShipmentId, parentShipmentId },
      "marketplace.shipment.combine.start"
    );

    if (isNaN(childShipmentId) || childShipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    if (typeof parentShipmentId !== "number" || parentShipmentId <= 0) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "parentShipmentId is required and must be a positive integer",
      });
    }

    if (!reason || typeof reason !== "string" || reason.trim().length < 5) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "reason is required and must be at least 5 characters",
      });
    }

    try {
      const result = marketplaceService.combineShipment(
        childShipmentId,
        parentShipmentId,
        reason.trim(),
        operatorId
      );

      if (!result.ok) {
        logger.warn(
          { operatorId, childShipmentId, parentShipmentId, error: result.error, errorCode: result.errorCode },
          "marketplace.shipment.combine.validation_failed"
        );
        return res.status(400).json({
          error: result.errorCode,
          message: result.error,
        });
      }

      logger.info(
        {
          operatorId,
          childShipmentId,
          parentShipmentId,
          trackingNumber: result.inheritedTracking.trackingNumber,
          hasWarning: !!result.addressMismatchWarning,
        },
        "marketplace.shipment.combine.complete"
      );

      res.json(result);
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, childShipmentId, parentShipmentId },
        "marketplace.shipment.combine.failed"
      );
      res.status(500).json({ error: "Failed to combine shipments" });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/shipments/:id/uncombine
   * Uncombine a child shipment from its parent.
   *
   * Resets the child to pending status with no tracking.
   *
   * Returns: { ok: true }
   */
  router.post("/shipments/:id/uncombine", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);

    logger.info(
      { operatorId, clientIp, userAgent, action: "uncombine", shipmentId },
      "marketplace.shipment.uncombine.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    try {
      const result = marketplaceService.uncombineShipment(shipmentId);

      if (!result.ok) {
        logger.warn(
          { operatorId, shipmentId, error: result.error, errorCode: result.errorCode },
          "marketplace.shipment.uncombine.validation_failed"
        );
        return res.status(400).json({
          error: result.errorCode,
          message: result.error,
        });
      }

      logger.info(
        { operatorId, shipmentId },
        "marketplace.shipment.uncombine.complete"
      );

      res.json({ ok: true });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.uncombine.failed"
      );
      res.status(500).json({ error: "Failed to uncombine shipment" });
    }
  });

  /**
   * PATCH /api/cm-admin/marketplace/shipments/:id/tracking
   * Manual tracking number input with duplicate detection.
   *
   * If the tracking number already exists on another shipment, returns a suggestion
   * to combine the orders instead.
   *
   * Body: { trackingNumber: string, carrier?: string }
   * Returns: { ok, shipmentId, trackingNumber, duplicateDetected? }
   */
  router.patch("/shipments/:id/tracking", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const shipmentId = parseInt(req.params.id, 10);
    const { trackingNumber, carrier } = req.body;

    logger.info(
      { operatorId, clientIp, userAgent, action: "manual-tracking", shipmentId },
      "marketplace.shipment.tracking.start"
    );

    if (isNaN(shipmentId) || shipmentId <= 0) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid shipment ID" });
    }

    if (!trackingNumber || typeof trackingNumber !== "string" || trackingNumber.trim().length < 5) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: "trackingNumber is required and must be at least 5 characters",
      });
    }

    try {
      const result = marketplaceService.updateShipmentTrackingManual(
        shipmentId,
        trackingNumber.trim(),
        carrier?.trim()
      );

      if (!result.ok) {
        return res.status(400).json({
          error: result.errorCode,
          message: result.error,
        });
      }

      logger.info(
        {
          operatorId,
          shipmentId,
          trackingNumber: trackingNumber.trim(),
          hasDuplicate: !!result.duplicateDetected,
        },
        "marketplace.shipment.tracking.complete"
      );

      res.json({
        ok: true,
        shipmentId,
        trackingNumber: trackingNumber.trim(),
        duplicateDetected: result.duplicateDetected,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId, shipmentId },
        "marketplace.shipment.tracking.failed"
      );
      res.status(500).json({ error: "Failed to update tracking number" });
    }
  });

  // ============================================================================
  // Maintenance Endpoints
  // ============================================================================

  /**
   * POST /api/cm-admin/marketplace/rematch
   * Refresh tracking statuses from EasyPost (and USPS fallback) and re-match unmatched entries.
   *
   * Flow:
   * 1. Fetch current status from EasyPost for all pending unmatched tracking
   * 2. Optionally fetch USPS tracking for remaining unknown USPS entries
   * 3. Update local DB with fresh statuses and resolve by tracking number
   * 4. Re-attempt matching against marketplace orders
   *
   * Returns: { refreshed, statusUpdated, matched, details }
   */
  router.post("/rematch", async (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;
    const includeUspsFallback = Boolean((req.body as any)?.includeUspsFallback);

    logger.info(
      { operatorId, clientIp, userAgent, action: "refresh-tracking", includeUspsFallback },
      "marketplace.refresh.start"
    );

    try {
      // Step 1: Refresh statuses from EasyPost
      const refreshResult = await marketplaceService.refreshUnmatchedTrackingStatuses(easyPostService, {
        includeUspsFallback,
        uspsService: uspsTrackingService,
      });

      logger.info(
        {
          operatorId,
          refreshed: refreshResult.refreshed,
          updated: refreshResult.updated,
          errors: refreshResult.errors,
          uspsChecked: refreshResult.uspsChecked,
          uspsUpdated: refreshResult.uspsUpdated,
          uspsErrors: refreshResult.uspsErrors,
          autoResolved: refreshResult.autoResolved,
        },
        "marketplace.refresh.statuses.complete"
      );

      // Step 2: Re-match tracking to orders
      const matchResult = marketplaceService.reMatchUnmatchedTracking();

      logger.info(
        { operatorId, matched: matchResult.matched, details: matchResult.details },
        "marketplace.refresh.rematch.complete"
      );

      res.json({
        ok: true,
        // Refresh results
        checked: refreshResult.attempted,
        refreshed: refreshResult.refreshed,
        statusUpdated: refreshResult.updated + refreshResult.uspsUpdated,
        refreshErrors: refreshResult.errors,
        uspsChecked: refreshResult.uspsChecked,
        uspsUpdated: refreshResult.uspsUpdated,
        uspsErrors: refreshResult.uspsErrors,
        autoResolved: refreshResult.autoResolved,
        statusChanges: refreshResult.details,
        // Re-match results
        matched: matchResult.matched,
        matchDetails: matchResult.details,
      });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId },
        "marketplace.refresh.failed"
      );
      res.status(500).json({ error: "Failed to refresh tracking statuses" });
    }
  });

  /**
   * POST /api/cm-admin/marketplace/purge-expired-addresses
   * Manually trigger PII retention enforcement.
   * NULLs shipping_address_encrypted where address_expires_at < now.
   * Also runs automatically on startup.
   *
   * Returns: { purgedCount }
   */
  router.post("/purge-expired-addresses", (req: Request, res: Response) => {
    const { operatorId, clientIp, userAgent } = (req as any).auditContext as AuditContext;

    logger.info(
      { operatorId, clientIp, userAgent, action: "purge.addresses" },
      "marketplace.purge.start"
    );

    try {
      const purgedCount = marketplaceService.purgeExpiredAddresses();

      logger.info(
        { operatorId, purgedCount },
        "marketplace.purge.complete"
      );

      res.json({ purgedCount });
    } catch (err) {
      const error = err as Error;
      logger.error(
        { err: error.message, operatorId },
        "marketplace.purge.failed"
      );
      res.status(500).json({ error: "Failed to purge expired addresses" });
    }
  });

  // Run initial purge on startup (non-blocking)
  try {
    const purgedCount = marketplaceService.purgeExpiredAddresses();
    if (purgedCount > 0) {
      logger.info({ purgedCount }, "marketplace.startup.purge.complete");
    }
  } catch (err) {
    logger.error({ err }, "marketplace.startup.purge.failed");
  }
}
