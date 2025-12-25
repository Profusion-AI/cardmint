/**
 * Order Routes
 *
 * Dec 2025: Public endpoints for customer order lookup.
 * Returns order number and status - no PII stored or returned.
 *
 * Note: orders.status is currently always "confirmed" at creation.
 * Status updates (processing → shipped → delivered) will be wired to
 * fulfillment events in a future PR when EasyPost tracking integration ships.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";

interface OrderRow {
  order_uid: string;
  order_number: string;
  stripe_session_id: string;
  item_count: number;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  status: string;
  created_at: number;
}

interface OrderResponse {
  ok: boolean;
  order?: {
    orderNumber: string;
    itemCount: number;
    subtotalCents: number;
    shippingCents: number;
    totalCents: number;
    status: string;
    createdAt: string;
  };
  error?: string;
  pending?: boolean;
}

export function registerOrderRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  /**
   * GET /api/orders/by-session/:stripeSessionId
   *
   * Public endpoint for CheckoutSuccess page to fetch order details.
   * Returns 404 with { pending: true } if order not yet created (webhook race).
   *
   * No auth required - Stripe session ID is unguessable (256-bit entropy).
   */
  app.get("/api/orders/by-session/:stripeSessionId", (req: Request, res: Response) => {
    const { stripeSessionId } = req.params;

    // Validate session ID format (Stripe session IDs start with cs_)
    if (!stripeSessionId || !stripeSessionId.startsWith("cs_")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid session ID format",
      } as OrderResponse);
    }

    try {
      const row = db
        .prepare(
          `SELECT order_uid, order_number, stripe_session_id, item_count,
                  subtotal_cents, shipping_cents, total_cents, status, created_at
           FROM orders
           WHERE stripe_session_id = ?`
        )
        .get(stripeSessionId) as OrderRow | undefined;

      if (!row) {
        // Order not found - could be webhook hasn't processed yet
        // Return 404 with pending flag so frontend knows to poll
        logger.debug({ stripeSessionId }, "Order lookup: not found (pending webhook?)");
        return res.status(404).json({
          ok: false,
          pending: true,
          error: "Order not found - may still be processing",
        } as OrderResponse);
      }

      const response: OrderResponse = {
        ok: true,
        order: {
          orderNumber: row.order_number,
          itemCount: row.item_count,
          subtotalCents: row.subtotal_cents,
          shippingCents: row.shipping_cents,
          totalCents: row.total_cents,
          status: row.status,
          createdAt: new Date(row.created_at * 1000).toISOString(),
        },
      };

      // Cache for 5 minutes (order data is immutable after creation)
      // Use 'private' since lookup is by secret session ID - prevent shared cache exposure
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json(response);
    } catch (error) {
      logger.error({ err: error, stripeSessionId }, "Failed to fetch order by session");
      res.status(500).json({
        ok: false,
        error: "Failed to fetch order",
      } as OrderResponse);
    }
  });
}
