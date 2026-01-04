/**
 * CardMint Backend Proxy Service
 *
 * Proxies requests from EverShop admin to CardMint backend.
 * Uses Bearer auth with CARDMINT_ADMIN_API_KEY (matching backend requireAdminAuth middleware).
 * Operator identity sent via X-CardMint-Operator header for audit logging.
 *
 * Environment:
 *   CARDMINT_BACKEND_URL: Backend base URL (default: http://localhost:4000)
 *   CARDMINT_ADMIN_API_KEY: Bearer token for admin API auth (REQUIRED)
 *   CARDMINT_PROXY_OPERATOR: Operator identity for audit logging (default: evershop)
 */

const BACKEND_URL = process.env.CARDMINT_BACKEND_URL || "http://localhost:4000";
const ADMIN_API_KEY = process.env.CARDMINT_ADMIN_API_KEY;
const PROXY_OPERATOR = process.env.CARDMINT_PROXY_OPERATOR || "evershop";

// Security: Fail-fast if CARDMINT_ADMIN_API_KEY not configured
const isProduction = process.env.NODE_ENV === "production" || process.env.CARDMINT_ENV === "production";
if (isProduction && !ADMIN_API_KEY) {
  throw new Error(
    "[BackendProxy] FATAL: CARDMINT_ADMIN_API_KEY must be set in production. " +
    "This is required for Bearer auth to the CardMint backend."
  );
}

// Development warning
if (!ADMIN_API_KEY) {
  console.warn(
    "[BackendProxy] WARNING: CARDMINT_ADMIN_API_KEY not set. " +
    "Backend requests will fail with 401/503. Set the same key used for CARDMINT_ADMIN_API_KEY in the backend."
  );
}

/**
 * Build headers for backend requests
 * - Bearer auth for authentication
 * - X-CardMint-Operator for audit logging
 */
function buildHeaders(contentType = null) {
  const headers = {
    Accept: "application/json",
    "X-CardMint-Operator": PROXY_OPERATOR,
  };

  if (ADMIN_API_KEY) {
    headers.Authorization = `Bearer ${ADMIN_API_KEY}`;
  }

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

/**
 * Proxy a GET request to CardMint backend
 * @param {string} path - API path (e.g., "/api/cm-admin/fulfillment/unified")
 * @param {Record<string, string>} query - Query parameters
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function proxyGet(path, query = {}) {
  try {
    const url = new URL(path, BACKEND_URL);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: buildHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || data.message || "Unknown error" };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    console.error("[BackendProxy] GET error:", error.message);
    return { ok: false, status: 502, error: error.message };
  }
}

/**
 * Proxy a POST request to CardMint backend
 * @param {string} path - API path
 * @param {any} body - Request body (will be JSON stringified)
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function proxyPost(path, body = {}) {
  try {
    const url = new URL(path, BACKEND_URL);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders("application/json"),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || data.message || "Unknown error" };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    console.error("[BackendProxy] POST error:", error.message);
    return { ok: false, status: 502, error: error.message };
  }
}

/**
 * Proxy a PATCH request to CardMint backend
 * @param {string} path - API path
 * @param {any} body - Request body
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function proxyPatch(path, body = {}) {
  try {
    const url = new URL(path, BACKEND_URL);

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: buildHeaders("application/json"),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || data.message || "Unknown error" };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    console.error("[BackendProxy] PATCH error:", error.message);
    return { ok: false, status: 502, error: error.message };
  }
}

export const backendProxy = {
  get: proxyGet,
  post: proxyPost,
  patch: proxyPatch,
};
