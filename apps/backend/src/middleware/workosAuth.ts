/**
 * WorkOS Authentication Middleware (P1.2)
 *
 * Provides session-based authentication for consumer-facing account/community surfaces.
 * Uses encrypted cookies for session storage and WorkOS for identity verification.
 *
 * IMPORTANT: This middleware ONLY protects /account/* and /community/* routes.
 * It MUST NOT be applied to checkout, vault, storefront, or admin routes.
 *
 * Kill-switch: Set WORKOS_ENABLED=false to bypass entirely.
 */

import type { Request, Response, NextFunction } from "express";
import { runtimeConfig } from "../config";
import crypto from "crypto";

const logger = {
  warn: (data: object, msg: string) => console.warn(`[workosAuth] ${msg}`, JSON.stringify(data)),
  info: (data: object, msg: string) => console.log(`[workosAuth] ${msg}`, JSON.stringify(data)),
  debug: (data: object, msg: string) => {
    if (runtimeConfig.cardmintEnv !== "production") {
      console.log(`[workosAuth] ${msg}`, JSON.stringify(data));
    }
  },
};

/**
 * Session data stored in encrypted cookie.
 */
export interface WorkOSSession {
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
  organizationId?: string;
}

/**
 * Authenticated request with user context.
 */
export interface AuthenticatedRequest extends Request {
  workosUser?: {
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    organizationId?: string;
  };
  workosSession?: WorkOSSession;
}

// Encryption constants
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive encryption key from cookie secret.
 * Uses HKDF-like derivation for consistent key generation.
 */
function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt session data for cookie storage.
 */
export function encryptSession(session: WorkOSSession, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(session);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: base64(iv + authTag + encrypted)
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64url");
}

/**
 * Decrypt session data from cookie.
 * Returns null if decryption fails (invalid/tampered cookie).
 */
export function decryptSession(encrypted: string, secret: string): WorkOSSession | null {
  try {
    const key = deriveKey(secret);
    const combined = Buffer.from(encrypted, "base64url");

    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      return null;
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Check if session is expired (with 60-second buffer for token refresh).
 */
function isSessionExpired(session: WorkOSSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  const buffer = 60; // 60 second buffer
  return session.expiresAt <= now + buffer;
}

/**
 * Extract session from request cookies.
 */
export function getSessionFromRequest(req: Request): WorkOSSession | null {
  const cookieName = runtimeConfig.workosCookieName;
  const cookieSecret = runtimeConfig.workosCookieSecret;

  if (!cookieSecret) {
    return null;
  }

  // Parse cookies from header (simple parser, no dependency)
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

  const sessionCookie = cookies[cookieName];
  if (!sessionCookie) {
    return null;
  }

  return decryptSession(sessionCookie, cookieSecret);
}

/**
 * Set session cookie on response.
 */
export function setSessionCookie(res: Response, session: WorkOSSession): void {
  const cookieName = runtimeConfig.workosCookieName;
  const cookieSecret = runtimeConfig.workosCookieSecret;
  const maxAge = runtimeConfig.workosCookieMaxAgeSec;

  if (!cookieSecret) {
    logger.warn({}, "Cannot set session cookie: WORKOS_COOKIE_SECRET not configured");
    return;
  }

  const encrypted = encryptSession(session, cookieSecret);
  const isProduction = runtimeConfig.cardmintEnv === "production";

  // Set-Cookie with security flags (append to preserve other cookies)
  const cookieOptions = [
    `${cookieName}=${encrypted}`,
    `Max-Age=${maxAge}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (isProduction) {
    cookieOptions.push("Secure");
  }

  res.append("Set-Cookie", cookieOptions.join("; "));
}

/**
 * Clear session cookie and CSRF cookie on response.
 */
export function clearSessionCookie(res: Response): void {
  const cookieName = runtimeConfig.workosCookieName;
  const isProduction = runtimeConfig.cardmintEnv === "production";

  // Clear session cookie (append to preserve other cookies)
  const sessionCookieOptions = [
    `${cookieName}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (isProduction) {
    sessionCookieOptions.push("Secure");
  }

  res.append("Set-Cookie", sessionCookieOptions.join("; "));

  // Clear CSRF cookie as well (SameSite=Strict, NOT HttpOnly so JS can read)
  const csrfCookieOptions = [
    "cm_csrf=",
    "Max-Age=0",
    "Path=/",
    "SameSite=Strict",
  ];

  if (isProduction) {
    csrfCookieOptions.push("Secure");
  }

  res.append("Set-Cookie", csrfCookieOptions.join("; "));
}

/**
 * Middleware: Require WorkOS authentication.
 *
 * - If WORKOS_ENABLED=false, returns 503 AUTH_DISABLED (fail-closed).
 * - Validates session cookie and attaches user to request.
 * - Returns 401 if not authenticated.
 *
 * Usage:
 *   import { requireWorkOSAuth } from "../middleware/workosAuth";
 *   app.get("/api/account/profile", requireWorkOSAuth, handler);
 */
export function requireWorkOSAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // Kill-switch: fail-closed if WorkOS is disabled
  if (!runtimeConfig.workosEnabled) {
    logger.debug({ path: req.path }, "WorkOS disabled, rejecting auth");
    res.status(503).json({
      error: "AUTH_DISABLED",
      message: "Authentication is currently disabled",
    });
    return;
  }

  // Check configuration
  if (!runtimeConfig.workosCookieSecret) {
    logger.warn(
      { path: req.path },
      "WorkOS auth rejected: WORKOS_COOKIE_SECRET not configured"
    );
    res.status(503).json({
      error: "AUTH_NOT_CONFIGURED",
      message: "Authentication is not configured on this server",
    });
    return;
  }

  // Get session from cookie
  const session = getSessionFromRequest(req);

  if (!session) {
    logger.debug({ path: req.path }, "WorkOS auth rejected: no valid session");
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Authentication required",
      login_url: "/api/auth/workos/login",
    });
    return;
  }

  // Check if session is expired
  if (isSessionExpired(session)) {
    logger.debug(
      { path: req.path, userId: session.userId, expiresAt: session.expiresAt },
      "WorkOS auth rejected: session expired"
    );
    clearSessionCookie(res);
    res.status(401).json({
      error: "SESSION_EXPIRED",
      message: "Session has expired, please log in again",
      login_url: "/api/auth/workos/login",
    });
    return;
  }

  // Attach user to request
  req.workosUser = {
    userId: session.userId,
    email: session.email,
    firstName: session.firstName,
    lastName: session.lastName,
    organizationId: session.organizationId,
  };
  req.workosSession = session;

  logger.debug(
    { path: req.path, userId: session.userId },
    "WorkOS auth successful"
  );

  next();
}

/**
 * Middleware: Optional WorkOS authentication.
 *
 * Attaches user to request if authenticated, but allows unauthenticated access.
 * Useful for pages that show different content for logged-in users.
 *
 * Usage:
 *   import { optionalWorkOSAuth } from "../middleware/workosAuth";
 *   app.get("/api/feed", optionalWorkOSAuth, handler);
 */
export function optionalWorkOSAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // Kill-switch: bypass if WorkOS is disabled
  if (!runtimeConfig.workosEnabled) {
    next();
    return;
  }

  // Try to get session, but don't fail if missing
  const session = getSessionFromRequest(req);

  if (session && !isSessionExpired(session)) {
    req.workosUser = {
      userId: session.userId,
      email: session.email,
      firstName: session.firstName,
      lastName: session.lastName,
      organizationId: session.organizationId,
    };
    req.workosSession = session;
  }

  next();
}

/**
 * Check if WorkOS is properly configured.
 */
export function isWorkOSConfigured(): boolean {
  return !!(
    runtimeConfig.workosEnabled &&
    runtimeConfig.workosClientId &&
    runtimeConfig.workosApiKey &&
    runtimeConfig.workosCookieSecret
  );
}
