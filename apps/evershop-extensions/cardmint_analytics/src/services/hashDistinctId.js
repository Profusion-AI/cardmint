import crypto from "crypto";

/**
 * Hash an email address for use as a PostHog distinct_id.
 * Uses SHA-256 with a salt prefix to prevent rainbow table attacks
 * while maintaining consistency for the same email across sessions.
 *
 * Per docs/analytics/pii-masking.md: distinct IDs should be hashed
 * to prevent PII exposure in analytics data.
 *
 * @param {string} email - Raw email address
 * @returns {string} Hashed email prefixed with "customer:"
 */
export function hashEmail(email) {
  if (!email || typeof email !== "string") return null;
  // Use a consistent prefix to prevent rainbow tables
  // while allowing cross-session identification
  const hash = crypto
    .createHash("sha256")
    .update(`cardmint:${email.toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 16); // First 16 chars is sufficient for uniqueness
  return `customer:${hash}`;
}

/**
 * Get a distinct_id for PostHog tracking.
 * Prioritizes hashed email over visitor_id for cross-device tracking.
 *
 * @param {Object} data - Event data containing customer_email or visitor_id
 * @returns {string|null} Distinct ID or null if no identifier available
 */
export function getDistinctId(data) {
  if (data.customer_email) {
    return hashEmail(data.customer_email);
  }
  if (data.visitor_id) {
    // visitor_id is already anonymous, no hashing needed
    return `visitor:${data.visitor_id}`;
  }
  return null;
}
