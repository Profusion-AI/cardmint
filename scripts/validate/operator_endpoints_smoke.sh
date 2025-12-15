#!/usr/bin/env bash
#
# Smoke validation for operator enrichment endpoints.
# Safe to run repeatedly; defaults to read-only checks that do not consume PPT credits.
# Set CARDMINT_SMOKE_ENABLE_ENRICH=1 to exercise /api/operator/enrich/ppt (may incur one PPT credit).
#
# Environment overrides:
#   CARDMINT_API_BASE        Base URL for backend (default http://127.0.0.1:4000)
#   CARDMINT_SQLITE_PATH     Path to SQLite database (default apps/backend/cardmint_dev.db)
#   CARDMINT_SMOKE_PRODUCT   Product UID to use (overrides auto-detected canonical product)
#   CARDMINT_SMOKE_UNKNOWN   Product UID expected to be UNKNOWN_* (overrides auto-detected unmatched product)
#   CARDMINT_SMOKE_EXPECT_CSV=1  Assert enrichment response uses CSV fallback
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BASE_URL="${CARDMINT_API_BASE:-http://127.0.0.1:4000}"
DB_PATH="${CARDMINT_SQLITE_PATH:-${REPO_ROOT}/apps/backend/cardmint_dev.db}"
ENABLE_ENRICH="${CARDMINT_SMOKE_ENABLE_ENRICH:-0}"
EXPECT_CSV="${CARDMINT_SMOKE_EXPECT_CSV:-0}"
CANONICAL_UID="${CARDMINT_SMOKE_PRODUCT:-}"
UNKNOWN_UID="${CARDMINT_SMOKE_UNKNOWN:-}"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

log() {
  echo "[INFO] $*"
}

warn() {
  echo "[WARN] $*" >&2
  WARN_COUNT=$((WARN_COUNT + 1))
}

fail() {
  echo "[FAIL] $*" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

pass() {
  echo "[PASS] $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}

require_binary() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    fail "Missing required dependency: ${name}"
    exit 1
  fi
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    fail "Expected file not found: ${path}"
    exit 1
  fi
}

require_binary curl
require_binary jq
require_binary sqlite3
require_file "$DB_PATH"

log "Using backend base URL: ${BASE_URL}"
log "Using SQLite database: ${DB_PATH}"

discover_canonical_product() {
  sqlite3 "$DB_PATH" <<"SQL" | head -n 1
SELECT product_uid
FROM products
WHERE cm_card_id NOT LIKE 'UNKNOWN_%'
  AND product_uid IS NOT NULL
ORDER BY COALESCE(pricing_status, '') = 'fresh' DESC,
         pricing_updated_at DESC,
         created_at DESC
LIMIT 1;
SQL
}

discover_unknown_product() {
  sqlite3 "$DB_PATH" <<"SQL" | head -n 1
SELECT product_uid
FROM products
WHERE cm_card_id LIKE 'UNKNOWN_%'
ORDER BY created_at DESC
LIMIT 1;
SQL
}

if [ -z "$CANONICAL_UID" ]; then
  CANONICAL_UID="$(discover_canonical_product || true)"
fi

if [ -z "$CANONICAL_UID" ]; then
  fail "Could not locate canonical product_uid automatically. Set CARDMINT_SMOKE_PRODUCT."
  exit 1
fi

log "Canonical product for quote/enrich checks: ${CANONICAL_UID}"

if [ -z "$UNKNOWN_UID" ]; then
  UNKNOWN_UID="$(discover_unknown_product || true)"
fi

if [ -n "$UNKNOWN_UID" ]; then
  log "Unknown product for negative quote test: ${UNKNOWN_UID}"
else
  warn "No UNKNOWN_* product found in database; unmatched queue checks will be informational only."
fi

http_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  if [ -z "$body" ]; then
    curl -sS -w "\n%{http_code}" -X "$method" "$url"
  else
    curl -sS -w "\n%{http_code}" -H "Content-Type: application/json" -X "$method" "$url" -d "$body"
  fi
}

split_response() {
  local raw="$1"
  local http_code="${raw##*$'\n'}"
  local payload="${raw%$'\n'*}"
  echo "$payload"
  echo "$http_code"
}

run_quote_success() {
  local raw payload status ready
  raw="$(http_request GET "${BASE_URL}/api/operator/enrich/ppt/quote?product_uid=${CANONICAL_UID}")" || {
    fail "Quote endpoint request failed (network error)"
    return
  }
  read -r payload status < <(split_response "$raw")
  if [ "$status" != "200" ]; then
    fail "Quote endpoint returned HTTP ${status}"
    echo "$payload" >&2
    return
  fi
  ready="$(echo "$payload" | jq -r '.ready_for_enrichment // empty')"
  cm_card_id="$(echo "$payload" | jq -r '.cm_card_id // empty')"
  if [ -z "$cm_card_id" ]; then
    fail "Quote payload missing cm_card_id"
    return
  fi
  pass "Quote endpoint returned 200 with cm_card_id=${cm_card_id} (ready_for_enrichment=${ready})"
}

run_quote_unknown() {
  if [ -z "$UNKNOWN_UID" ]; then
    warn "Skipping UNKNOWN_* quote test (no unmatched products present)"
    return
  fi
  local raw payload status code
  raw="$(http_request GET "${BASE_URL}/api/operator/enrich/ppt/quote?product_uid=${UNKNOWN_UID}")" || {
    fail "Quote endpoint (UNKNOWN) request failed"
    return
  }
  read -r payload status < <(split_response "$raw")
  if [ "$status" != "400" ]; then
    fail "Quote endpoint expected 400 for UNKNOWN product (got ${status})"
    echo "$payload" >&2
    return
  fi
  code="$(echo "$payload" | jq -r '.error // empty')"
  if [ "$code" != "PRODUCT_NOT_CANONICALIZED" ]; then
    fail "Quote UNKNOWN error code mismatch (expected PRODUCT_NOT_CANONICALIZED, got ${code})"
    return
  fi
  pass "Quote endpoint correctly rejects UNKNOWN product (HTTP 400, PRODUCT_NOT_CANONICALIZED)"
}

run_unmatched_queue() {
  local raw payload status bad_entries
  raw="$(http_request GET "${BASE_URL}/api/operator/queue/unmatched")" || {
    fail "Unmatched queue request failed"
    return
  }
  read -r payload status < <(split_response "$raw")
  if [ "$status" != "200" ]; then
    fail "Unmatched queue returned HTTP ${status}"
    echo "$payload" >&2
    return
  fi
  bad_entries="$(echo "$payload" | jq '[.products[] | select((.cm_card_id | test("^UNKNOWN_") | not))] | length')"
  if [ "$bad_entries" != "0" ]; then
    fail "Unmatched queue returned ${bad_entries} entries without UNKNOWN_* cm_card_id"
    return
  fi
  total="$(echo "$payload" | jq '.products | length')"
  pass "Unmatched queue responded with ${total} products (all cm_card_id prefixed UNKNOWN_)"
}

run_enrich() {
  if [ "$ENABLE_ENRICH" != "1" ]; then
    warn "Skipping enrichment call (set CARDMINT_SMOKE_ENABLE_ENRICH=1 to execute; may consume PPT credit)"
    return
  fi
  local raw payload status source fallback staging_ready
  body=$(jq -n --arg product_uid "$CANONICAL_UID" '{product_uid: $product_uid}')
  raw="$(http_request POST "${BASE_URL}/api/operator/enrich/ppt" "$body")" || {
    fail "Enrichment request failed"
    return
  }
  read -r payload status < <(split_response "$raw")
  if [ "$status" != "200" ]; then
    fail "Enrichment endpoint returned HTTP ${status}"
    echo "$payload" >&2
    return
  fi
  source="$(echo "$payload" | jq -r '.pricing_source // empty')"
  staging_ready="$(echo "$payload" | jq -r '.staging_ready // empty')"
  if [ -z "$source" ]; then
    fail "Enrichment payload missing pricing_source"
    return
  fi
  if [ "$EXPECT_CSV" = "1" ] && [ "$source" != "csv" ]; then
    fail "Expected CSV fallback (pricing_source=csv) but received ${source}"
    return
  fi
  pass "Enrichment succeeded (pricing_source=${source}, staging_ready=${staging_ready})"
}

run_quote_success
run_quote_unknown
run_unmatched_queue
run_enrich

TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT))
echo
echo "Summary: ${PASS_COUNT} passed, ${WARN_COUNT} warnings, ${FAIL_COUNT} failed (total checks: ${TOTAL})"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi

exit 0
