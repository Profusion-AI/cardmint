/**
 * CSRF Protection Middleware (P1.2)
 *
 * Implements double-submit cookie pattern for state-changing operations.
 * Protects POST/PUT/PATCH/DELETE requests on protected routes.
 *
 * Pattern:
 * 1. Server generates CSRF token and sets it as a cookie
 * 2. Client reads token from cookie and includes in X-CSRF-Token header
 * 3. Server validates header matches cookie
 *
 * Why double-submit instead of synchronizer token?
 * - Stateless (no server-side token storage)
 * - Works with multiple backend instances
 * - Simpler to implement with SPA architecture
 */

import type { Request, Response, NextFunction } from "express";
import { runtimeConfig } from "../config";
import crypto from "crypto";

const logger = {
  warn: (data: object, msg: string) => console.warn(`[csrfProtection] ${msg}`, JSON.stringify(data)),
  debug: (data: object, msg: string) => {
    if (runtimeConfig.cardmintEnv !== "production") {
      console.log(`[csrfProtection] ${msg}`, JSON.stringify(data));
    }
  },
};

// Constants
const CSRF_COOKIE_NAME = "cm_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_TOKEN_LENGTH = 32; // 256 bits

// Methods that require CSRF protection
const PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Generate a cryptographically secure CSRF token.
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString("base64url");
}

/**
 * Extract CSRF token from request cookie.
 */
function getCsrfTokenFromCookie(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").reduce(
    (acc, cookie) => {
      const [name, ...valueParts] = cookie.trim().split("=");
      if (name) {
        acc[name] = valueParts.join("=");
      }
      return acc;
    },
    {} as Record<string, string>
  );

  return cookies[CSRF_COOKIE_NAME] || null;
}

/**
 * Extract CSRF token from request header.
 */
function getCsrfTokenFromHeader(req: Request): string | null {
  return (req.headers[CSRF_HEADER_NAME] as string) || null;
}

/**
 * Set CSRF cookie on response.
 * Called on initial page load or when cookie is missing.
 */
export function setCsrfCookie(res: Response, token: string): void {
  const isProduction = runtimeConfig.cardmintEnv === "production";

  const cookieOptions = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    "SameSite=Strict",
    // NOT HttpOnly - client JS needs to read it
  ];

  if (isProduction) {
    cookieOptions.push("Secure");
  }

  // Append to existing Set-Cookie headers (don't overwrite session cookie)
  const existingCookies = res.getHeader("Set-Cookie");
  const newCookie = cookieOptions.join("; ");

  if (existingCookies) {
    if (Array.isArray(existingCookies)) {
      res.setHeader("Set-Cookie", [...existingCookies, newCookie]);
    } else {
      res.setHeader("Set-Cookie", [existingCookies as string, newCookie]);
    }
  } else {
    res.setHeader("Set-Cookie", newCookie);
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to maintain constant time
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Middleware: Require CSRF token for state-changing requests.
 *
 * For GET/HEAD/OPTIONS requests:
 * - Ensures CSRF cookie exists (sets one if missing)
 *
 * For POST/PUT/PATCH/DELETE requests:
 * - Validates X-CSRF-Token header matches cookie
 * - Returns 403 if validation fails
 *
 * Usage:
 *   import { csrfProtection } from "../middleware/csrfProtection";
 *   app.use("/api/account", csrfProtection, accountRoutes);
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // Skip if WorkOS is disabled (no sessions = no CSRF needed)
  if (!runtimeConfig.workosEnabled) {
    next();
    return;
  }

  const method = req.method.toUpperCase();

  // For safe methods, ensure CSRF cookie exists
  if (!PROTECTED_METHODS.has(method)) {
    const existingToken = getCsrfTokenFromCookie(req);
    if (!existingToken) {
      const newToken = generateCsrfToken();
      setCsrfCookie(res, newToken);
      logger.debug({ path: req.path }, "Generated new CSRF token");
    }
    next();
    return;
  }

  // For state-changing methods, validate CSRF token
  const cookieToken = getCsrfTokenFromCookie(req);
  const headerToken = getCsrfTokenFromHeader(req);

  if (!cookieToken) {
    logger.warn(
      { path: req.path, method: req.method },
      "CSRF validation failed: missing cookie token"
    );
    res.status(403).json({
      error: "CSRF_VALIDATION_FAILED",
      message: "CSRF token missing. Please refresh and try again.",
    });
    return;
  }

  if (!headerToken) {
    logger.warn(
      { path: req.path, method: req.method },
      "CSRF validation failed: missing header token"
    );
    res.status(403).json({
      error: "CSRF_VALIDATION_FAILED",
      message: "CSRF token required in X-CSRF-Token header",
    });
    return;
  }

  if (!timingSafeEqual(cookieToken, headerToken)) {
    logger.warn(
      { path: req.path, method: req.method },
      "CSRF validation failed: token mismatch"
    );
    res.status(403).json({
      error: "CSRF_VALIDATION_FAILED",
      message: "CSRF token invalid. Please refresh and try again.",
    });
    return;
  }

  logger.debug({ path: req.path, method: req.method }, "CSRF validation passed");
  next();
}

/**
 * Endpoint handler: Get a fresh CSRF token.
 *
 * SPA can call this endpoint to get a CSRF token before making state-changing requests.
 * The token is returned in both the response body and as a cookie.
 *
 * Usage:
 *   app.get("/api/csrf-token", getCsrfTokenHandler);
 */
export function getCsrfTokenHandler(req: Request, res: Response): void {
  // Skip if WorkOS is disabled
  if (!runtimeConfig.workosEnabled) {
    res.json({ ok: true, csrf_token: null, message: "CSRF protection disabled" });
    return;
  }

  // Check for existing token in cookie
  let token = getCsrfTokenFromCookie(req);

  if (!token) {
    token = generateCsrfToken();
    setCsrfCookie(res, token);
  }

  res.json({
    ok: true,
    csrf_token: token,
  });
}
