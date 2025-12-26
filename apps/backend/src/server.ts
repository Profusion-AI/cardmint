/**
 * CardMint Backend Server (Entry Point)
 *
 * Thin shell: context creation, dev/health middleware, startup/shutdown.
 * Route registration lives in ./app/http.ts; feature routers in ./routes/*.
 */

import "./migrate";
import { type Request, type Response } from "express";
import { createContext, runtimeConfig } from "./app/context";
import { createApp } from "./app/http";

const ctx = await createContext();

// Destructure services needed for server-level operations (health, shutdown)
const {
  logger,
  db,
  queue,
  captureAdapter,
  jobWorker,
  sftpWatcher,
  priceChartingRepo,
  emailOutboxWorker,
  autoFulfillmentWorker,
} = ctx;

// Create Express app with core middleware and extracted routes
const app = createApp(ctx);


// Dev endpoint gating middleware
app.use("/api/test", (req: Request, res: Response, next) => {
  const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
  const devModeEnabled = runtimeConfig.devMode;

  if (!isLoopback && !devModeEnabled) {
    logger.warn({ ip: req.ip, path: req.path }, "Dev endpoint access denied (not loopback, DEV_MODE=false)");
    return res.status(403).json({
      error: "Development endpoints restricted",
      message: "Access only from loopback (127.0.0.1) or set DEV_MODE=true",
    });
  }

  next();
});

app.get("/health", async (_req: Request, res: Response) => {
  const depth = queue.getQueueDepth();
  const driverHealth = await captureAdapter.health();

  res.json({
    status: "ok",
    queueDepth: depth,
    warning: depth >= runtimeConfig.queueWarnDepth,
    captureDriver: {
      name: captureAdapter.getDriverName(),
      status: driverHealth.status,
      ...(driverHealth.details && { details: driverHealth.details }),
    },
  });
});

// Async server initialization to load CSV corpus before accepting requests
(async () => {
  // Ingest PriceCharting CSV corpus for operator-triggered enrichment fallback
  // Without this, getPriceFromCSV() immediately returns null (corpusLoaded === false)
  logger.info("Loading PriceCharting CSV corpus for operator-triggered enrichment...");
  await priceChartingRepo.ensureIngested();
  logger.info("PriceCharting CSV corpus loaded successfully");

  const port = runtimeConfig.port;
  // Bind to all interfaces for local dev (ESP32 stock display needs network access)
  // TODO: Revert to 127.0.0.1 for prod or use BIND_HOST env var
  const bindHost = process.env.BIND_HOST || "0.0.0.0";
  const server = app.listen(port, bindHost, () => {
    logger.info({ port, host: bindHost }, `CardMint backend listening`);
  });

  const shutdown = async () => {
    logger.info("Received termination signal, initiating graceful shutdown");

    // Block new capture requests
    ctx.setShuttingDown(true);
    logger.info("Capture intake paused (new /api/capture and /api/upload requests will return 503)");

    // Stop job worker (drains current job if any)
    const queueDepthBefore = queue.getQueueDepth();
    logger.info(
      { queueDepth: queueDepthBefore, timeoutMs: runtimeConfig.gracefulShutdownMs },
      "Draining job worker, waiting for in-flight jobs to complete",
    );

    try {
      await jobWorker.stop();
      const queueDepthAfter = queue.getQueueDepth();
      logger.info(
        { queueDepthBefore, queueDepthAfter },
        "Job worker drained successfully",
      );
    } catch (error) {
      logger.error({ err: error }, "Error during job worker shutdown");
    }

    // Stop SFTP watcher if running
    if (sftpWatcher) {
      try {
        sftpWatcher.stop();
        logger.info("SFTP watch-folder ingestion stopped");
      } catch (error) {
        logger.error({ err: error }, "Error stopping SFTP watcher");
      }
    }

    // Stop email outbox worker
    try {
      emailOutboxWorker.stop();
      logger.info("Email outbox worker stopped");
    } catch (error) {
      logger.error({ err: error }, "Error stopping email outbox worker");
    }

    // Stop auto-fulfillment worker
    try {
      autoFulfillmentWorker.stop();
      logger.info("Auto-fulfillment worker stopped");
    } catch (error) {
      logger.error({ err: error }, "Error stopping auto-fulfillment worker");
    }

    // Close HTTP server
    server.close(() => {
      logger.info("HTTP server closed");
      db.close();
      logger.info("Database connection closed, graceful shutdown complete");
      process.exit(0);
    });

    // Force exit after timeout (configurable via GRACEFUL_SHUTDOWN_MS)
    setTimeout(() => {
      logger.warn(
        { timeoutMs: runtimeConfig.gracefulShutdownMs },
        "Graceful shutdown timeout exceeded, forcing exit",
      );
      process.exit(1);
    }, runtimeConfig.gracefulShutdownMs);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})().catch((error) => {
  logger.fatal({ err: error }, "Fatal error during server startup");
  process.exit(1);
});
