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
  const configuredToken = runtimeConfig.printAgentToken;

  if (!configuredToken) {
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

  const provided = req.headers["x-print-agent-token"] as string | undefined;
  if (!provided) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing X-Print-Agent-Token header" });
    return;
  }

  if (!timingSafeEqual(provided, configuredToken)) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid print agent token" });
    return;
  }

  next();
}

