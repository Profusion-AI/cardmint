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

// In-memory state store for OAuth state validation
// Simple implementation; production could use Redis for multi-instance
const stateStore = new Map<string, { createdAt: number; returnTo?: string }>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of stateStore) {
    if (now - data.createdAt > STATE_TTL_MS) {
      stateStore.delete(state);
    }
  }
}, 60_000); // Every minute

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

    // Generate and store state
    const state = generateState();
    stateStore.set(state, {
      createdAt: Date.now(),
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
      logger.warn(
        { error, error_description },
        "OAuth callback received error from WorkOS"
      );
      return res.redirect(`/login?error=${encodeURIComponent(String(error))}`);
    }

    // Validate state
    if (!state || typeof state !== "string") {
      logger.warn({}, "OAuth callback missing state parameter");
      return res.redirect("/login?error=invalid_state");
    }

    const storedState = stateStore.get(state);
    if (!storedState) {
      logger.warn({}, "OAuth callback state not found or expired");
      return res.redirect("/login?error=invalid_state");
    }

    // Consume state (single use)
    stateStore.delete(state);

    // Validate code
    if (!code || typeof code !== "string") {
      logger.warn({}, "OAuth callback missing authorization code");
      return res.redirect("/login?error=missing_code");
    }

    // Exchange code for tokens
    const workos = await getWorkOS();
    if (!workos) {
      return res.redirect("/login?error=auth_unavailable");
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
      const returnTo = storedState.returnTo || "/account";
      res.redirect(returnTo);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to exchange authorization code"
      );
      return res.redirect("/login?error=auth_failed");
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
