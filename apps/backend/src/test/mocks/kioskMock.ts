/**
 * Mock Kiosk Agent for local development and testing.
 * Emulates RPi5 kiosk API without hardware dependency.
 *
 * SAFETY: Guarded by NODE_ENV check - never runs in production.
 *
 * Endpoints:
 * - POST /capture: Returns deterministic ULID-based capture result
 * - GET /health: Returns mock spool telemetry
 */

import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";

if (process.env.NODE_ENV === "production") {
  throw new Error("Kiosk mock server cannot run in production");
}

const app = express();
app.use(express.json());

// Mock state
let captureCount = 0;
let mockSpoolPairs = 0; // Default: no offline queue backlog
let mockStatus = "healthy"; // Can be: healthy, degraded, offline

/**
 * Generate monotonic ULID-style identifier for ordering tests.
 * Format: timestamp(10) + random(16) = 26 chars base32
 */
function generateUlid(): string {
  const timestamp = Date.now();
  const timestampPart = timestamp.toString(36).padStart(10, "0");
  const randomPart = randomBytes(8).toString("hex").slice(0, 16);
  return `${timestampPart}${randomPart}`.toUpperCase();
}

app.post("/capture", (req: Request, res: Response) => {
  captureCount++;
  const uid = req.body?.uid || generateUlid();
  const profile = req.body?.profile;

  // Simulate capture latency (10-50ms)
  const latency = Math.floor(Math.random() * 40) + 10;

  setTimeout(() => {
    res.json({
      ok: true,
      uid,
      local: {
        img: `/var/cardmint/captures/${uid}.jpg`,
        meta: `/var/cardmint/captures/${uid}.json`,
      },
      profile: profile || null,
      timestamp: Date.now() / 1000,
    });
  }, latency);
});

// Test endpoints to simulate different states
app.post("/test/set-spool", (req: Request, res: Response) => {
  mockSpoolPairs = req.body?.queued_pairs ?? 0;
  res.json({ ok: true, queued_pairs: mockSpoolPairs });
});

app.post("/test/set-status", (req: Request, res: Response) => {
  mockStatus = req.body?.status ?? "healthy";
  res.json({ ok: true, status: mockStatus });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: mockStatus,
    service: "cardmint-camera-agent-mock",
    version: "0.5.0-mock",
    camera_status: "ready",
    camera_info: {
      sensor: "IMX477-MOCK",
      preview_resolution: "1280x720",
      still_resolution: "4056x3040",
    },
    spool: {
      enabled: true,
      dir: "/var/cardmint/spool",
      queued_pairs: mockSpoolPairs,
      bytes: mockSpoolPairs * 2 * 1024 * 1024, // ~2MB per pair
    },
    sftp: {
      host: "127.0.0.1",
      status: "configured",
    },
    stats: {
      captures_total: captureCount,
    },
  });
});

const PORT = Number.parseInt(process.env.KIOSK_MOCK_PORT || "8001", 10);

// Auto-start when run directly
app.listen(PORT, () => {
  console.log(`[MOCK] Kiosk agent mock listening on http://localhost:${PORT}`);
  console.log("[MOCK] Endpoints: POST /capture, GET /health");
  console.log("[MOCK] Safety: NODE_ENV !== production enforced");
});

export default app;
