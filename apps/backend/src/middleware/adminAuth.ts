/**
 * Admin Authentication Middleware
 *
 * Provides Bearer token authentication for admin API endpoints.
 * Added in response to Codex review (Dec 2025) - security hardening.
 *
 * Usage:
 *   import { requireAdminAuth } from "../middleware/adminAuth";
 *   app.post("/api/cm-admin/...", requireAdminAuth, handler);
 */

import type { Request, Response, NextFunction } from "express";
import { runtimeConfig } from "../config";

const logger = {
  warn: (data: object, msg: string) => console.warn(`[adminAuth] ${msg}`, JSON.stringify(data)),
  info: (data: object, msg: string) => console.log(`[adminAuth] ${msg}`, JSON.stringify(data)),
};

let didWarnMissingDisplayToken = false;

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing or malformed.
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return null;
  }

  return parts[1];
}

/**
 * Middleware: Require valid admin API key.
 *
 * Checks Authorization: Bearer <CARDMINT_ADMIN_API_KEY>
 * Rejects with 401 if missing/invalid.
 * Logs attempts (without leaking token values).
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = runtimeConfig.cardmintAdminApiKey;

  // If no admin key is configured, reject all requests (fail closed)
  if (!configuredKey) {
    logger.warn(
      { path: req.path, method: req.method, ip: req.ip },
      "Admin auth rejected: CARDMINT_ADMIN_API_KEY not configured"
    );
    res.status(503).json({
      error: "ADMIN_AUTH_NOT_CONFIGURED",
      message: "Admin API authentication is not configured on this server",
    });
    return;
  }

  const providedToken = extractBearerToken(req);

  if (!providedToken) {
    logger.warn(
      { path: req.path, method: req.method, ip: req.ip },
      "Admin auth rejected: missing or malformed Authorization header"
    );
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Missing or malformed Authorization header. Expected: Bearer <token>",
    });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedToken, configuredKey)) {
    logger.warn(
      { path: req.path, method: req.method, ip: req.ip },
      "Admin auth rejected: invalid token"
    );
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid admin API key",
    });
    return;
  }

  // Auth successful
  next();
}

/**
 * Middleware: Require internal endpoint access.
 *
 * Two-layer protection:
 * 1. Check actual TCP peer is localhost (req.socket.remoteAddress)
 * 2. Require X-CardMint-Internal header with CAPTURE_INTERNAL_KEY
 *
 * This prevents both spoofed X-Forwarded-For and network-level attacks.
 */
export function requireInternalAccess(req: Request, res: Response, next: NextFunction): void {
  // Layer A: Check actual TCP peer address (not proxied IP)
  const remoteAddress = req.socket?.remoteAddress ?? "";
  const isLocalhost = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";

  if (!isLocalhost) {
    logger.warn(
      { path: req.path, method: req.method, remoteAddress },
      "Internal access rejected: not from localhost"
    );
    res.status(403).json({
      error: "FORBIDDEN",
      message: "This endpoint is only accessible from localhost",
    });
    return;
  }

  // Layer B: Require internal secret header
  const configuredKey = runtimeConfig.captureInternalKey;

  // If no internal key is configured, still allow localhost access (backward compat)
  // but log a warning
  if (!configuredKey) {
    logger.warn(
      { path: req.path },
      "Internal endpoint accessed without CAPTURE_INTERNAL_KEY configured (allowed for backward compat)"
    );
    next();
    return;
  }

  const providedKey = req.headers["x-cardmint-internal"] as string | undefined;

  if (!providedKey) {
    logger.warn(
      { path: req.path, method: req.method },
      "Internal access rejected: missing X-CardMint-Internal header"
    );
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Missing X-CardMint-Internal header",
    });
    return;
  }

  if (!timingSafeEqual(providedKey, configuredKey)) {
    logger.warn(
      { path: req.path, method: req.method },
      "Internal access rejected: invalid internal key"
    );
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid internal key",
    });
    return;
  }

  next();
}

/**
 * Middleware: Require display token for stock-summary endpoints.
 *
 * Checks X-CardMint-Display-Token header.
 */
export function requireDisplayToken(req: Request, res: Response, next: NextFunction): void {
  const configuredToken = runtimeConfig.displayToken;

  // If no display token is configured, allow access (for dev/backward compat)
  if (!configuredToken) {
    if (!didWarnMissingDisplayToken && runtimeConfig.cardmintEnv === "production") {
      didWarnMissingDisplayToken = true;
      logger.warn(
        { env: runtimeConfig.cardmintEnv },
        "DISPLAY_TOKEN not configured; stock display endpoints are unprotected",
      );
    }
    next();
    return;
  }

  const providedToken = req.headers["x-cardmint-display-token"] as string | undefined;

  if (!providedToken) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Missing X-CardMint-Display-Token header",
    });
    return;
  }

  if (!timingSafeEqual(providedToken, configuredToken)) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Invalid display token",
    });
    return;
  }

  next();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ (b.charCodeAt(i % b.length) || 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
