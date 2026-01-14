/**
 * WorkOS Auth Routes (P1.2)
 *
 * Handles WorkOS AuthKit OAuth flow:
 * - /api/auth/workos/login - Redirect to WorkOS AuthKit
 * - /api/auth/workos/callback - Handle OAuth callback
 * - /api/auth/workos/logout - Clear session
 * - /api/auth/workos/me - Get current user (protected)
 *
 * IMPORTANT: These endpoints (/api/auth/workos/*) must remain accessible
 * even when perimeter auth (Cloudflare Access, Nginx Basic Auth) protects /admin/*.
 * Blocking these endpoints causes OAuth deadlock.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import {
  type AuthenticatedRequest,
  type WorkOSSession,
  requireWorkOSAuth,
  optionalWorkOSAuth,
  setSessionCookie,
  clearSessionCookie,
  isWorkOSConfigured,
  getSessionFromRequest,
} from "../middleware/workosAuth";
import { getCsrfTokenHandler, generateCsrfToken, setCsrfCookie } from "../middleware/csrfProtection";
import crypto from "crypto";

// Lazy-load WorkOS SDK to avoid import errors when not configured
let workosClient: import("@workos-inc/node").WorkOS | null = null;

async function getWorkOS(): Promise<import("@workos-inc/node").WorkOS | null> {
  if (!runtimeConfig.workosApiKey) {
    return null;
  }

  if (!workosClient) {
    try {
      const { WorkOS } = await import("@workos-inc/node");
      workosClient = new WorkOS(runtimeConfig.workosApiKey);
    } catch (err) {
      console.error("[auth] Failed to initialize WorkOS client:", err);
      return null;
    }
  }

  return workosClient;
}

const logger = {
  warn: (data: object, msg: string) => console.warn(`[auth] ${msg}`, JSON.stringify(data)),
  info: (data: object, msg: string) => console.log(`[auth] ${msg}`, JSON.stringify(data)),
  error: (data: object, msg: string) => console.error(`[auth] ${msg}`, JSON.stringify(data)),
  debug: (data: object, msg: string) => {
    if (runtimeConfig.cardmintEnv !== "production") {
      console.log(`[auth] ${msg}`, JSON.stringify(data));
    }
  },
};

// OAuth state validation must survive restarts and cannot rely on in-memory stores.
// Use a short-lived, signed HttpOnly cookie to correlate the callback with the login request.
const OAUTH_STATE_COOKIE_NAME = "cm_workos_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type OAuthStatePayload = {
  state: string;
  createdAtMs: number;
  returnTo?: string;
};

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader.split(";").reduce(
    (acc, cookie) => {
      const [name, ...valueParts] = cookie.trim().split("=");
      if (name) {
        acc[name] = valueParts.join("=");
      }
      return acc;
    },
    {} as Record<string, string>
  );
}

function signCookieValue(value: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function setOAuthStateCookie(res: Response, payload: OAuthStatePayload): void {
  const secret = runtimeConfig.workosCookieSecret;
  if (!secret) {
    return;
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signCookieValue(encodedPayload, secret);
  const cookieValue = `${encodedPayload}.${signature}`;

  const isProduction = runtimeConfig.cardmintEnv === "production";
  const cookieOptions = [
    `${OAUTH_STATE_COOKIE_NAME}=${cookieValue}`,
    `Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`,
    "Path=/api/auth/workos",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (isProduction) {
    cookieOptions.push("Secure");
  }

  res.append("Set-Cookie", cookieOptions.join("; "));
}

function clearOAuthStateCookie(res: Response): void {
  const isProduction = runtimeConfig.cardmintEnv === "production";
  const cookieOptions = [
    `${OAUTH_STATE_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/api/auth/workos",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (isProduction) {
    cookieOptions.push("Secure");
  }

  res.append("Set-Cookie", cookieOptions.join("; "));
}

function getOAuthStateFromRequest(req: Request): OAuthStatePayload | null {
  const secret = runtimeConfig.workosCookieSecret;
  if (!secret) return null;

  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies[OAUTH_STATE_COOKIE_NAME];
  if (!raw) return null;

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSig = signCookieValue(encodedPayload, secret);
  if (signature.length !== expectedSig.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expectedSig, "utf8"))) {
    return null;
  }

  try {
    const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const payload = JSON.parse(json) as OAuthStatePayload;

    if (!payload?.state || typeof payload.state !== "string") return null;
    if (!payload.createdAtMs || typeof payload.createdAtMs !== "number") return null;

    if (Date.now() - payload.createdAtMs > OAUTH_STATE_TTL_MS) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a secure state parameter for OAuth.
 */
function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function registerAuthRoutes(app: Express, ctx: AppContext): void {
  const log = ctx.logger.child({ module: "auth-routes" });

  /**
   * GET /api/auth/workos/status
   * Check if WorkOS auth is enabled and configured.
   * Public endpoint - no auth required.
   */
  app.get("/api/auth/workos/status", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      enabled: runtimeConfig.workosEnabled,
      configured: isWorkOSConfigured(),
    });
  });

  /**
   * GET /api/auth/workos/nginx-auth
   * Internal helper for nginx `auth_request` to gate protected routes (e.g. /admin/*).
   *
   * Returns:
   * - 204 if a valid, non-expired WorkOS session cookie is present
   * - 401 otherwise
   *
   * This endpoint intentionally avoids redirects or JSON bodies so nginx can make a simple allow/deny decision.
   */
  app.get("/api/auth/workos/nginx-auth", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    if (!runtimeConfig.workosEnabled || !isWorkOSConfigured()) {
      return res.sendStatus(401);
    }

    const session = getSessionFromRequest(req);
    if (!session) {
      return res.sendStatus(401);
    }

    const now = Math.floor(Date.now() / 1000);
    const bufferSeconds = 60;
    if (session.expiresAt <= now + bufferSeconds) {
      return res.sendStatus(401);
    }

    return res.sendStatus(204);
  });

  /**
   * GET /api/auth/workos/login
   * Redirect to WorkOS AuthKit for authentication.
   *
   * Query params:
   * - return_to: URL to redirect after login (validated against allowlist)
   * - screen_hint: "sign-up" or "sign-in" (default: "sign-in")
   */
  app.get("/api/auth/workos/login", async (req: Request, res: Response) => {
    // Check if WorkOS is enabled
    if (!runtimeConfig.workosEnabled) {
      return res.status(503).json({
        error: "AUTH_DISABLED",
        message: "Authentication is currently disabled",
      });
    }

    // Check if WorkOS is configured
    if (!isWorkOSConfigured()) {
      return res.status(503).json({
        error: "AUTH_NOT_CONFIGURED",
        message: "Authentication is not configured on this server",
      });
    }

    const workos = await getWorkOS();
    if (!workos) {
      return res.status(503).json({
        error: "AUTH_INIT_FAILED",
        message: "Failed to initialize authentication service",
      });
    }

    // Parse query params
    const returnTo = req.query.return_to as string | undefined;
    const screenHint = (req.query.screen_hint as string) || "sign-in";

    // Generate and persist state for callback validation
    const state = generateState();
    setOAuthStateCookie(res, {
      state,
      createdAtMs: Date.now(),
      returnTo: validateReturnTo(returnTo),
    });

    // Generate authorization URL
    const authUrl = workos.userManagement.getAuthorizationUrl({
      clientId: runtimeConfig.workosClientId,
      redirectUri: runtimeConfig.workosRedirectUri,
      provider: "authkit",
      state,
      screenHint: screenHint === "sign-up" ? "sign-up" : "sign-in",
    });

    logger.info({ screenHint, hasReturnTo: !!returnTo }, "Redirecting to WorkOS AuthKit");

    res.redirect(authUrl);
  });

  /**
   * GET /api/auth/workos/callback
   * Handle OAuth callback from WorkOS AuthKit.
   *
   * Query params:
   * - code: Authorization code from WorkOS
   * - state: State parameter for CSRF validation
   * - error: Error code if auth failed
   * - error_description: Error description if auth failed
   */
  app.get("/api/auth/workos/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors
    if (error) {
      logger.warn({ error }, "OAuth callback received error from WorkOS");
      clearOAuthStateCookie(res);
      return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
    }

    // Validate state
    if (!state || typeof state !== "string") {
      logger.warn({}, "OAuth callback missing state parameter");
      clearOAuthStateCookie(res);
      return res.redirect("/?auth_error=invalid_state");
    }

    const storedState = getOAuthStateFromRequest(req);
    if (!storedState || storedState.state !== state) {
      logger.warn({}, "OAuth callback state not found, mismatched, or expired");
      clearOAuthStateCookie(res);
      return res.redirect("/?auth_error=invalid_state");
    }

    // Consume state (single use)
    clearOAuthStateCookie(res);

    // Validate code
    if (!code || typeof code !== "string") {
      logger.warn({}, "OAuth callback missing authorization code");
      return res.redirect("/?auth_error=missing_code");
    }

    // Exchange code for tokens
    const workos = await getWorkOS();
    if (!workos) {
      return res.redirect("/?auth_error=auth_unavailable");
    }

    try {
      const authResponse = await workos.userManagement.authenticateWithCode({
        code,
        clientId: runtimeConfig.workosClientId,
      });

      const { user, accessToken, refreshToken, organizationId } = authResponse;

      // Calculate expiration (default 1 hour if not provided)
      // WorkOS access tokens typically expire in 1 hour
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      // Create session
      const session: WorkOSSession = {
        userId: user.id,
        email: user.email,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        accessToken,
        refreshToken: refreshToken ?? "",
        expiresAt,
        organizationId: organizationId ?? undefined,
      };

      // Set session cookie
      setSessionCookie(res, session);

      // Set CSRF cookie for SPA
      const csrfToken = generateCsrfToken();
      setCsrfCookie(res, csrfToken);

      logger.info(
        { userId: user.id },
        "User authenticated successfully"
      );

      // Redirect to return URL or default
      const returnTo = storedState.returnTo || "/";
      res.redirect(returnTo);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to exchange authorization code"
      );
      return res.redirect("/?auth_error=auth_failed");
    }
  });

  /**
   * POST /api/auth/workos/logout
   * Clear session and redirect to home.
   *
   * Accepts both GET (for simple links) and POST (for CSRF-protected logout).
   */
  const handleLogout = (_req: Request, res: Response) => {
    clearSessionCookie(res);
    logger.debug({}, "User logged out");

    // For API calls, return JSON
    if (_req.headers.accept?.includes("application/json")) {
      return res.json({ ok: true, message: "Logged out successfully" });
    }

    // For browser requests, redirect
    res.redirect("/");
  };

  app.get("/api/auth/workos/logout", handleLogout);
  app.post("/api/auth/workos/logout", handleLogout);

  /**
   * GET /api/auth/workos/me
   * Get current authenticated user info.
   * Uses optional auth so it can return { authenticated: false } cleanly.
   */
  app.get(
    "/api/auth/workos/me",
    optionalWorkOSAuth,
    (req: AuthenticatedRequest, res: Response) => {
      // If WorkOS is disabled, return null user (kill-switch bypass)
      if (!runtimeConfig.workosEnabled) {
        return res.json({
          ok: true,
          authenticated: false,
          user: null,
        });
      }

      if (!req.workosUser) {
        return res.json({
          ok: true,
          authenticated: false,
          user: null,
        });
      }

      res.json({
        ok: true,
        authenticated: true,
        user: {
          id: req.workosUser.userId,
          email: req.workosUser.email,
          firstName: req.workosUser.firstName,
          lastName: req.workosUser.lastName,
          organizationId: req.workosUser.organizationId,
        },
      });
    }
  );

  /**
   * GET /api/csrf-token
   * Get a fresh CSRF token for SPA.
   */
  app.get("/api/csrf-token", getCsrfTokenHandler);
}

/**
 * Validate return_to URL against allowlist.
 * Returns validated URL or undefined if invalid.
 */
function validateReturnTo(url: string | undefined): string | undefined {
  if (!url) return undefined;

  // Must be a relative path (no protocol/host hijacking)
  if (url.startsWith("/") && !url.startsWith("//")) {
    return url;
  }

  // Or a full URL on our domain
  try {
    const parsed = new URL(url);
    const allowedHosts = ["cardmintshop.com", "www.cardmintshop.com", "localhost"];
    if (allowedHosts.includes(parsed.hostname.toLowerCase())) {
      return url;
    }
  } catch {
    // Invalid URL
  }

  return undefined;
}
