import crypto from "crypto";

import { runtimeConfig } from "../config";

type UnkeyVerifyKeyResponse = {
  meta?: { requestId?: string };
  data?: {
    valid: boolean;
    code?: string;
    keyId?: string;
    permissions?: string[];
    roles?: string[];
    meta?: Record<string, unknown>;
  };
};

type CachedResult = {
  expiresAtMs: number;
  data: NonNullable<UnkeyVerifyKeyResponse["data"]>;
};

type FailureRecord = {
  count: number;
  lastFailureAt: number;
  lastIp?: string;
};

type RateRecord = {
  timestamps: number[];
  flaggedAt?: number;
  lastLoggedIp?: string;
};

// Verification result cache (valid results only)
const verifyCache = new Map<string, CachedResult>();

// Security: Track auth failures per key (elevated rejections detection)
const failureTracker = new Map<string, FailureRecord>();

// Security: Track request rate per key (spam detection)
const rateTracker = new Map<string, RateRecord>();

// Security: Blocked keys (spam flagged)
const blockedKeys = new Map<string, { blockedAt: number; reason: string }>();

// Safe parseInt with NaN fallback to prevent disabling rate limits via invalid env vars
function safeParseInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Constants - env-configurable to avoid self-DoS during legitimate bursts
const FAILURE_WARN_THRESHOLD = 3;
const FAILURE_RESET_MS = 60_000; // Reset failure count after 1 minute of no failures
const RATE_WINDOW_MS = 10_000; // 10 second window for rate tracking
const RATE_WARN_THRESHOLD = safeParseInt(process.env.UNKEY_RATE_WARN_THRESHOLD, 50); // Warn at 50 req/10s = 5/sec
const RATE_BLOCK_THRESHOLD = safeParseInt(process.env.UNKEY_RATE_BLOCK_THRESHOLD, 200); // Block at 200 req/10s = 20/sec
const BLOCK_DURATION_MS = safeParseInt(process.env.UNKEY_BLOCK_DURATION_MS, 60_000); // Block for 1 minute

// Map size limits to prevent memory exhaustion from random token attacks
const MAX_TRACKER_SIZE = 10_000;
const MAX_CACHE_SIZE = 5_000;

const logger = {
  warn: (msg: string, data?: object) =>
    console.warn(`[unkeyAuth] ${msg}`, data ? JSON.stringify(data) : ""),
  error: (msg: string, data?: object) =>
    console.error(`[unkeyAuth] ${msg}`, data ? JSON.stringify(data) : ""),
  info: (msg: string, data?: object) =>
    console.log(`[unkeyAuth] ${msg}`, data ? JSON.stringify(data) : ""),
};

/**
 * Evict oldest entries from a Map if it exceeds max size (LRU-style based on insertion order).
 * Maps iterate in insertion order, so oldest entries are first.
 */
function evictOldestIfNeeded<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const toEvict = map.size - maxSize;
  let evicted = 0;
  for (const key of map.keys()) {
    if (evicted >= toEvict) break;
    map.delete(key);
    evicted++;
  }
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getKeyHash(key: string): string {
  return sha256Hex(key).slice(0, 16); // Short hash for logging (don't log full key)
}

function getVerifyCacheKey(key: string, permissions: string | null): string {
  return sha256Hex(`${key}\n${permissions ?? ""}`);
}

/**
 * Track auth failure for a key. Logs warning after 3+ failures.
 */
function trackFailure(keyHash: string, ip?: string, code?: string): void {
  const now = Date.now();
  const existing = failureTracker.get(keyHash);

  if (existing && now - existing.lastFailureAt > FAILURE_RESET_MS) {
    // Reset if last failure was too long ago
    failureTracker.delete(keyHash);
  }

  const record = failureTracker.get(keyHash) || { count: 0, lastFailureAt: 0 };
  record.count++;
  record.lastFailureAt = now;
  if (ip) record.lastIp = ip;
  failureTracker.set(keyHash, record);
  evictOldestIfNeeded(failureTracker, MAX_TRACKER_SIZE);

  if (record.count >= FAILURE_WARN_THRESHOLD) {
    logger.warn("Elevated rejections detected", {
      keyHash,
      failureCount: record.count,
      code,
      ip: ip || "unknown",
      action: "monitoring",
    });
  }
}

/**
 * Track request rate for a key. Returns true if request should be blocked.
 */
function checkRateLimit(keyHash: string, ip?: string): { blocked: boolean; reason?: string } {
  const now = Date.now();

  // Check if key is currently blocked
  const blocked = blockedKeys.get(keyHash);
  if (blocked) {
    if (now - blocked.blockedAt < BLOCK_DURATION_MS) {
      return { blocked: true, reason: blocked.reason };
    }
    // Block expired, remove it
    blockedKeys.delete(keyHash);
    logger.info("Key unblocked after timeout", { keyHash });
  }

  // Track request timestamps
  const record = rateTracker.get(keyHash) || { timestamps: [] };

  // Remove timestamps outside the window
  record.timestamps = record.timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  record.timestamps.push(now);
  rateTracker.set(keyHash, record);
  evictOldestIfNeeded(rateTracker, MAX_TRACKER_SIZE);

  const requestCount = record.timestamps.length;

  // Check if we should warn (before blocking threshold)
  if (requestCount >= RATE_WARN_THRESHOLD && requestCount < RATE_BLOCK_THRESHOLD && record.lastLoggedIp !== ip) {
    record.lastLoggedIp = ip;
    logger.warn("High request rate detected", {
      keyHash,
      requestCount,
      warnThreshold: RATE_WARN_THRESHOLD,
      blockThreshold: RATE_BLOCK_THRESHOLD,
      windowMs: RATE_WINDOW_MS,
      ip: ip || "unknown",
    });
  }

  // Check if we should block
  if (requestCount >= RATE_BLOCK_THRESHOLD) {
    const reason = `Rate limit exceeded: ${requestCount} requests in ${RATE_WINDOW_MS / 1000}s`;
    blockedKeys.set(keyHash, { blockedAt: now, reason });
    evictOldestIfNeeded(blockedKeys, MAX_TRACKER_SIZE);
    logger.error("SPAM DETECTED - Key blocked", {
      keyHash,
      requestCount,
      windowMs: RATE_WINDOW_MS,
      ip: ip || "unknown",
      blockDurationMs: BLOCK_DURATION_MS,
    });
    return { blocked: true, reason };
  }

  return { blocked: false };
}

/**
 * Clean up old tracking data periodically (call from a timer or on each request)
 */
function cleanupTrackers(): void {
  const now = Date.now();

  // Clean up old failure records
  for (const [keyHash, record] of failureTracker.entries()) {
    if (now - record.lastFailureAt > FAILURE_RESET_MS * 2) {
      failureTracker.delete(keyHash);
    }
  }

  // Clean up old rate records
  for (const [keyHash, record] of rateTracker.entries()) {
    if (record.timestamps.length === 0 || now - Math.max(...record.timestamps) > RATE_WINDOW_MS * 2) {
      rateTracker.delete(keyHash);
    }
  }

  // Clean up expired blocks
  for (const [keyHash, block] of blockedKeys.entries()) {
    if (now - block.blockedAt > BLOCK_DURATION_MS) {
      blockedKeys.delete(keyHash);
    }
  }
}

// Run cleanup every 60 seconds
setInterval(cleanupTrackers, 60_000);

export type VerifyOptions = {
  key: string;
  permissions?: string;
  /** Request IP for security logging */
  ip?: string;
  /** Request path for security logging */
  path?: string;
};

export async function verifyUnkeyKey(options: VerifyOptions): Promise<
  | { ok: true; data: NonNullable<UnkeyVerifyKeyResponse["data"]> }
  | { ok: false; error: string; status?: number }
> {
  const { key, permissions, ip, path } = options;
  const keyHash = getKeyHash(key);

  if (!runtimeConfig.unkeyRootKey) {
    return { ok: false, error: "UNKEY_NOT_CONFIGURED" };
  }

  // Security: Check rate limit before processing
  const rateCheck = checkRateLimit(keyHash, ip);
  if (rateCheck.blocked) {
    logger.warn("Request blocked due to rate limit", { keyHash, ip, path, reason: rateCheck.reason });
    return { ok: false, error: "RATE_LIMITED", status: 429 };
  }

  const cacheTtlMs = Math.max(0, runtimeConfig.unkeyVerifyCacheTtlMs);
  const cacheKey = getVerifyCacheKey(key, permissions ?? null);
  const cached = verifyCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return { ok: true, data: cached.data };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(250, runtimeConfig.unkeyVerifyTimeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const apiBase = runtimeConfig.unkeyApiUrl.replace(/\/+$/, "");
    const response = await fetch(`${apiBase}/v2/keys.verifyKey`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeConfig.unkeyRootKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        key,
        ...(permissions ? { permissions } : {}),
      }),
      signal: controller.signal,
    });

    const status = response.status;
    let parsed: UnkeyVerifyKeyResponse;
    try {
      parsed = (await response.json()) as UnkeyVerifyKeyResponse;
    } catch {
      return { ok: false, status, error: "UNKEY_BAD_RESPONSE" };
    }

    if (!response.ok) {
      return { ok: false, status, error: "UNKEY_HTTP_ERROR" };
    }

    const data = parsed.data;
    if (!data || typeof data.valid !== "boolean") {
      return { ok: false, status, error: "UNKEY_BAD_RESPONSE" };
    }

    // Security: Track failures for elevated rejections detection
    if (!data.valid) {
      trackFailure(keyHash, ip, data.code);
    }

    // Only cache valid results - invalid keys (missing permissions, revoked, etc.)
    // should be re-verified each time to allow quick permission updates
    if (cacheTtlMs > 0 && data.valid) {
      verifyCache.set(cacheKey, { data, expiresAtMs: Date.now() + cacheTtlMs });
      evictOldestIfNeeded(verifyCache, MAX_CACHE_SIZE);
    }

    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check if a key is currently blocked (for external use)
 */
export function isKeyBlocked(key: string): boolean {
  const keyHash = getKeyHash(key);
  const blocked = blockedKeys.get(keyHash);
  if (!blocked) return false;
  if (Date.now() - blocked.blockedAt > BLOCK_DURATION_MS) {
    blockedKeys.delete(keyHash);
    return false;
  }
  return true;
}

/**
 * Manually unblock a key (for admin use)
 */
export function unblockKey(key: string): void {
  const keyHash = getKeyHash(key);
  blockedKeys.delete(keyHash);
  logger.info("Key manually unblocked", { keyHash });
}
