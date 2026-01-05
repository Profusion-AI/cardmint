/**
 * Print Agent Authentication Middleware
 *
 * Provides header token authentication for the local print agent.
 *
 * Auth header:
 *   X-Print-Agent-Token: <PRINT_AGENT_TOKEN>
 */

import type { Request, Response, NextFunction } from "express";
import { runtimeConfig } from "../config.js";
import { verifyUnkeyKey } from "../services/unkeyAuth.js";

const logger = {
  warn: (data: object, msg: string) => console.warn(`[printAgentAuth] ${msg}`, JSON.stringify(data)),
};

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
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

export function requirePrintAgentAuth(req: Request, res: Response, next: NextFunction): void {
  const providedToken = req.headers["x-print-agent-token"] as string | undefined;
  if (!providedToken) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing X-Print-Agent-Token header" });
    return;
  }

  const mode = runtimeConfig.printAgentAuthMode;
  const configuredToken = runtimeConfig.printAgentToken;
  const hasStatic = !!configuredToken;
  const hasUnkey = !!runtimeConfig.unkeyRootKey;

  if (mode === "static") {
    if (!hasStatic) {
      logger.warn(
        { path: req.path, method: req.method, ip: req.ip },
        "Print agent auth rejected: PRINT_AGENT_TOKEN not configured"
      );
      res.status(503).json({
        error: "PRINT_AGENT_AUTH_NOT_CONFIGURED",
        message: "Print agent authentication is not configured on this server",
      });
      return;
    }

    if (!timingSafeEqual(providedToken, configuredToken)) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid print agent token" });
      return;
    }

    next();
    return;
  }

  if (mode === "unkey") {
    if (!hasUnkey) {
      logger.warn(
        { path: req.path, method: req.method, ip: req.ip },
        "Print agent auth rejected: UNKEY_ROOT_KEY not configured"
      );
      res.status(503).json({
        error: "PRINT_AGENT_AUTH_NOT_CONFIGURED",
        message: "Print agent authentication is not configured on this server",
      });
      return;
    }

    void (async () => {
      const result = await verifyUnkeyKey({
        key: providedToken,
        permissions: runtimeConfig.unkeyPrintAgentPermission || undefined,
        ip: req.ip,
        path: req.path,
      });

      if (!result.ok) {
        const status = result.status === 429 ? 429 : 503;
        logger.warn(
          { path: req.path, method: req.method, ip: req.ip, reason: result.error, status: result.status },
          "Print agent auth rejected: Unkey verification error"
        );
        res.status(status).json({
          error: result.error === "RATE_LIMITED" ? "RATE_LIMITED" : "PRINT_AGENT_AUTH_VERIFY_ERROR",
          message: result.error === "RATE_LIMITED" ? "Too many requests" : "Print agent authentication failed verification",
        });
        return;
      }

      if (!result.data.valid) {
        logger.warn(
          { path: req.path, method: req.method, ip: req.ip, code: result.data.code },
          "Print agent auth rejected: invalid key"
        );
        res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid print agent token" });
        return;
      }

      next();
    })();

    return;
  }

  // dual: accept either static token or Unkey key
  if (!hasStatic && !hasUnkey) {
    logger.warn(
      { path: req.path, method: req.method, ip: req.ip },
      "Print agent auth rejected: no auth provider configured"
    );
    res.status(503).json({
      error: "PRINT_AGENT_AUTH_NOT_CONFIGURED",
      message: "Print agent authentication is not configured on this server",
    });
    return;
  }

  if (hasStatic && timingSafeEqual(providedToken, configuredToken)) {
    next();
    return;
  }

  if (!hasUnkey) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid print agent token" });
    return;
  }

  void (async () => {
    const result = await verifyUnkeyKey({
      key: providedToken,
      permissions: runtimeConfig.unkeyPrintAgentPermission || undefined,
      ip: req.ip,
      path: req.path,
    });

    if (!result.ok) {
      const status = result.status === 429 ? 429 : 503;
      logger.warn(
        { path: req.path, method: req.method, ip: req.ip, reason: result.error, status: result.status },
        "Print agent auth rejected: Unkey verification error"
      );
      res.status(status).json({
        error: result.error === "RATE_LIMITED" ? "RATE_LIMITED" : "PRINT_AGENT_AUTH_VERIFY_ERROR",
        message: result.error === "RATE_LIMITED" ? "Too many requests" : "Print agent authentication failed verification",
      });
      return;
    }

    if (!result.data.valid) {
      logger.warn(
        { path: req.path, method: req.method, ip: req.ip, code: result.data.code },
        "Print agent auth rejected: invalid key"
      );
      res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid print agent token" });
      return;
    }

    next();
  })();
}
