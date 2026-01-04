/**
 * HTTP Application Factory
 *
 * Phase 2 of server.ts decomposition (Nov 2025).
 * Creates the Express app with core middleware and registers feature routers.
 */

import express, { type Express, type Request, type Response } from "express";
import type { AppContext } from "./context";
import { runtimeConfig } from "../config";

// Route registrars
import { registerMasterSetRoutes } from "../routes/masterSets";
import { registerCanonicalSetRoutes } from "../routes/canonicalSets";
import { registerMetricsRoutes } from "../routes/metrics";
import { registerProductRoutes } from "../routes/products";
import { registerJobActionRoutes } from "../routes/jobActions";
import { registerPricingRoutes } from "../routes/pricing";
import { registerEvershopRoutes } from "../routes/evershop";
import { registerOperatorSessionRoutes } from "../routes/operatorSessions";
import { registerInventoryRoutes } from "../routes/inventory";
import { registerCaptureAndJobsRoutes } from "../routes/captureAndJobs";
import { registerPublicFeedRoutes } from "../routes/publicFeed";
import { registerScanRoutes } from "../routes/scans";
import { registerStripeRoutes } from "../routes/stripe";
import { registerVaultRoutes } from "../routes/vault";
import { registerSyncRoutes } from "../routes/sync";
import { registerWebhookRoutes } from "../routes/webhooks";
import { registerSubscribeRoutes } from "../routes/subscribe";
import { registerAnalyticsRoutes } from "../routes/analytics";
import { registerPrivacyRoutes } from "../routes/privacy";
import { registerCartRoutes } from "../routes/cart";
import { registerStockDisplayRoutes } from "../routes/stockDisplay";
import { registerFulfillmentRoutes } from "../routes/fulfillment";
import { registerCaptureSettingsRoutes } from "../routes/captureSettings";
import { registerCalibrationRoutes } from "../routes/calibration";
import { registerOrderRoutes } from "../routes/orders";
import { registerMarketplaceRoutes } from "../routes/marketplace";
import { registerPrintQueueRoutes } from "../routes/printQueue";

/**
 * Create and configure the Express application.
 * Core middleware applied here; routes registered via feature modules.
 */
export function createApp(ctx: AppContext): Express {
  const app = express();

  // Trust the first proxy hop (nginx) so req.ip reflects the real client IP.
  // Avoid manually trusting X-Forwarded-For in route handlers.
  app.set("trust proxy", 1);

  // Raw body parser for webhook routes (must come before json parser)
  // These endpoints require the unparsed body for signature verification
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use("/api/webhooks/evershop", express.raw({ type: "application/json" }));
  app.use((req, res, next) => {
    if (req.originalUrl === "/api/webhooks/stripe" || req.originalUrl === "/api/webhooks/evershop") {
      return next();
    }
    return express.json({ limit: "5mb" })(req, res, next);
  });

  // CORS middleware for dev environment only (nginx handles CORS in production)
  // In production, skip this middleware to avoid duplicate Access-Control-Allow-Origin headers
  if (runtimeConfig.cardmintEnv !== "production") {
    app.use((req: Request, res: Response, next) => {
      const allowedOrigins = new Set([
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ]);
      const origin = req.headers.origin as string | undefined;
      if (origin && allowedOrigins.has(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
      } else {
        res.header("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
      }
      res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.header("Access-Control-Allow-Credentials", "true");

      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }

      next();
    });
  }

  // Robots guardrails: keep /api/* dark to crawlers
  app.use("/api", (_req: Request, res: Response, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  // Register feature routes (before X-Robots-Tag middleware for correct ordering)
  registerMasterSetRoutes(app, ctx);
  registerCanonicalSetRoutes(app, ctx);
  registerMetricsRoutes(app, ctx);
  registerProductRoutes(app, ctx);
  registerJobActionRoutes(app, ctx);
  registerPricingRoutes(app, ctx);
  registerEvershopRoutes(app, ctx);
  registerOperatorSessionRoutes(app, ctx);
  registerInventoryRoutes(app, ctx);
  registerCaptureAndJobsRoutes(app, ctx);
  registerPublicFeedRoutes(app, ctx);
  registerScanRoutes(app, ctx);
  registerStripeRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerCartRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerSubscribeRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerPrivacyRoutes(app, ctx);
  registerStockDisplayRoutes(app, ctx);
  registerFulfillmentRoutes(app, ctx);
  registerCaptureSettingsRoutes(app, ctx);
  registerCalibrationRoutes(app, ctx);
  registerOrderRoutes(app, ctx);
  registerMarketplaceRoutes(app, ctx);
  registerPrintQueueRoutes(app, ctx);

  return app;
}
