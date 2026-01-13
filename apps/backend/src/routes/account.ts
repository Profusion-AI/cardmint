/**
 * Account Routes (P1.2)
 *
 * Protected routes for authenticated user account management.
 * All routes require WorkOS authentication.
 *
 * Routes:
 * - GET /api/account/profile - Get user profile
 * - PATCH /api/account/profile - Update user profile (future)
 * - GET /api/account/orders - Get user's claimed orders (future)
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { runtimeConfig } from "../config";
import {
  type AuthenticatedRequest,
  requireWorkOSAuth,
} from "../middleware/workosAuth";
import { csrfProtection } from "../middleware/csrfProtection";

export function registerAccountRoutes(app: Express, ctx: AppContext): void {
  const log = ctx.logger.child({ module: "account-routes" });

  /**
   * GET /api/account/profile
   * Get authenticated user's profile.
   * Protected - requires WorkOS session.
   */
  app.get(
    "/api/account/profile",
    requireWorkOSAuth,
    (req: AuthenticatedRequest, res: Response) => {
      // Kill-switch bypass: return minimal response
      if (!runtimeConfig.workosEnabled) {
        return res.json({
          ok: true,
          message: "Account system disabled",
          profile: null,
        });
      }

      if (!req.workosUser) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authentication required",
        });
      }

      // Return user profile from session
      res.json({
        ok: true,
        profile: {
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
   * PATCH /api/account/profile
   * Update authenticated user's profile.
   * Protected - requires WorkOS session + CSRF token.
   *
   * Note: Profile updates go through WorkOS User Management API.
   * This is a placeholder for future implementation.
   */
  app.patch(
    "/api/account/profile",
    requireWorkOSAuth,
    csrfProtection,
    (req: AuthenticatedRequest, res: Response) => {
      // Kill-switch bypass
      if (!runtimeConfig.workosEnabled) {
        return res.status(503).json({
          error: "SERVICE_UNAVAILABLE",
          message: "Account system disabled",
        });
      }

      if (!req.workosUser) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authentication required",
        });
      }

      // Placeholder - profile updates not yet implemented
      res.status(501).json({
        error: "NOT_IMPLEMENTED",
        message: "Profile updates coming soon",
      });
    }
  );

  /**
   * GET /api/account/orders
   * Get authenticated user's claimed orders.
   * Protected - requires WorkOS session.
   *
   * Note: This will be implemented as part of P1.3 (Claim Order).
   * For now, returns empty array.
   */
  app.get(
    "/api/account/orders",
    requireWorkOSAuth,
    (req: AuthenticatedRequest, res: Response) => {
      // Kill-switch bypass
      if (!runtimeConfig.workosEnabled) {
        return res.json({
          ok: true,
          message: "Account system disabled",
          orders: [],
        });
      }

      if (!req.workosUser) {
        return res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authentication required",
        });
      }

      // Placeholder - order claiming not yet implemented (P1.3)
      // Will query orders WHERE claimed_by_identity = req.workosUser.userId
      res.json({
        ok: true,
        orders: [],
        message: "Order claiming coming in Phase 1.3",
      });
    }
  );
}
