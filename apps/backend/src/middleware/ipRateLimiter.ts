/**
 * IP-based rate limiter middleware for claim endpoints.
 * Prevents order enumeration via timing attacks by limiting requests per IP.
 *
 * Uses in-memory sliding window - simple and sufficient for current scale.
 * If horizontal scaling needed, replace with Redis-based limiter.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// Map of IP -> rate limit entry, keyed by endpoint prefix
const ipLimits = new Map<string, RateLimitEntry>();

// Cleanup interval handle
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Check if an IP is within rate limits.
 * @param ip Client IP address
 * @param endpoint Endpoint identifier (e.g., "claim/initiate")
 * @param maxRequests Maximum requests per window
 * @param windowSeconds Window duration in seconds
 * @returns true if allowed, false if rate limited
 */
export function checkIpRateLimit(
  ip: string,
  endpoint: string,
  maxRequests: number,
  windowSeconds: number
): boolean {
  const key = `${ip}:${endpoint}`;
  const now = Math.floor(Date.now() / 1000);
  const entry = ipLimits.get(key);

  // No entry or window expired - reset
  if (!entry || now - entry.windowStart >= windowSeconds) {
    ipLimits.set(key, { count: 1, windowStart: now });
    return true;
  }

  // Already at limit
  if (entry.count >= maxRequests) {
    return false;
  }

  // Increment and allow
  entry.count++;
  return true;
}

/**
 * Start periodic cleanup of stale entries (prevents memory bloat).
 * Call once at server startup.
 * @param intervalMs Cleanup interval in milliseconds (default 60s)
 * @param maxAgeSeconds Max age of entries to keep (default 300s / 5 min)
 */
export function startIpRateLimitCleanup(
  intervalMs = 60_000,
  maxAgeSeconds = 300
): void {
  if (cleanupInterval) return; // Already running

  cleanupInterval = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const threshold = now - maxAgeSeconds;

    for (const [key, entry] of ipLimits.entries()) {
      if (entry.windowStart < threshold) {
        ipLimits.delete(key);
      }
    }
  }, intervalMs);

  // Don't keep process alive just for cleanup
  cleanupInterval.unref();
}

/**
 * Stop the cleanup interval (for graceful shutdown / testing).
 */
export function stopIpRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Clear all rate limit entries (for testing).
 */
export function clearIpRateLimits(): void {
  ipLimits.clear();
}
