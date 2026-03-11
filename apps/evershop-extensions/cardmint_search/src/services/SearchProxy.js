/**
 * CardMint Search Proxy Service
 *
 * Proxies requests from EverShop admin to the CardMint search app.
 * Uses x-search-api-key header auth.
 *
 * Environment:
 *   CARDMINT_SEARCH_URL: Search app base URL (default: http://localhost:4310)
 *   SEARCH_APP_API_KEY: API key for x-search-api-key header (REQUIRED)
 */

const SEARCH_URL = process.env.CARDMINT_SEARCH_URL || "http://localhost:4310";
const SEARCH_API_KEY = process.env.SEARCH_APP_API_KEY;

const isProduction = process.env.NODE_ENV === "production" || process.env.CARDMINT_ENV === "production";
if (isProduction && !SEARCH_API_KEY) {
  throw new Error(
    "[SearchProxy] FATAL: SEARCH_APP_API_KEY must be set in production. " +
    "This is required for x-search-api-key auth to the search app."
  );
}

if (!SEARCH_API_KEY) {
  console.warn(
    "[SearchProxy] WARNING: SEARCH_APP_API_KEY not set. " +
    "Search app requests will fail with 401. Set the same key used in /etc/cardmint-search-app.env."
  );
}

function buildHeaders(contentType = null) {
  const headers = {
    Accept: "application/json",
  };

  if (SEARCH_API_KEY) {
    headers["x-search-api-key"] = SEARCH_API_KEY;
  }

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

/**
 * Proxy a GET request to the search app
 * @param {string} path - API path (e.g., "/health")
 * @param {Record<string, string>} query - Query parameters
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function proxyGet(path, query = {}) {
  try {
    const url = new URL(path, SEARCH_URL);
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
      return {
        ok: false,
        status: response.status,
        error: data.error || data.message || "Unknown error",
        data,
      };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    console.error("[SearchProxy] GET error:", error.message);
    return { ok: false, status: 502, error: error.message, data: null };
  }
}

/**
 * Proxy a POST request with JSON body to the search app
 * @param {string} path - API path (e.g., "/api/search")
 * @param {any} body - JSON body to send
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string}>}
 */
export async function proxyPost(path, body = {}) {
  try {
    const url = new URL(path, SEARCH_URL);

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders("application/json"),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data.error || data.message || "Unknown error",
        data,
      };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    console.error("[SearchProxy] POST error:", error.message);
    return { ok: false, status: 502, error: error.message, data: null };
  }
}
