#!/usr/bin/env bash
#
# validate_image_readiness.sh
# Validates that staged products have published CDN images
#
# Usage:
#   scripts/validate/validate_image_readiness.sh --db apps/backend/cardmint_dev.db

set -euo pipefail

DB_PATH=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --db <path-to-db>"
      exit 1
      ;;
  esac
done

if [[ -z "$DB_PATH" ]]; then
  echo "ERROR: --db required"
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: Database not found at $DB_PATH"
  exit 1
fi

echo "=============================================="
echo "  CardMint Image Readiness Validation"
echo "=============================================="
echo "Database: $DB_PATH"
echo ""

# Check 1: Staged products have cdn_image_url
echo "[1/3] Checking staged products have cdn_image_url..."
MISSING_CDN=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM products WHERE staging_ready=1 AND cdn_image_url IS NULL;")

if [[ "$MISSING_CDN" -gt 0 ]]; then
  echo "  ❌ FAIL: $MISSING_CDN staged products missing cdn_image_url"
  sqlite3 -header -column "$DB_PATH" \
    "SELECT product_uid, product_sku, card_name, pricing_status
     FROM products
     WHERE staging_ready=1 AND cdn_image_url IS NULL
     LIMIT 5;" || true
  exit 1
else
  echo "  ✅ PASS: All staged products have cdn_image_url"
fi

# Check 2: Sample CDN URLs are reachable (HTTP 200)
echo ""
echo "[2/3] Checking CDN URL reachability (sampling 5 URLs)..."
SAMPLE_URLS=$(sqlite3 "$DB_PATH" \
  "SELECT cdn_image_url FROM products WHERE staging_ready=1 AND cdn_image_url IS NOT NULL LIMIT 5;" | tr '\n' ' ')

if [[ -z "$SAMPLE_URLS" ]]; then
  echo "  ⚠️  SKIP: No CDN URLs found to test"
else
  CDN_FAILURES=0
  for url in $SAMPLE_URLS; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$url" || echo "000")
    if [[ "$HTTP_CODE" == "200" ]]; then
      echo "  ✅ $url → $HTTP_CODE"
    else
      echo "  ❌ $url → $HTTP_CODE"
      CDN_FAILURES=$((CDN_FAILURES + 1))
    fi
  done

  if [[ "$CDN_FAILURES" -gt 0 ]]; then
    echo "  ❌ FAIL: $CDN_FAILURES/$(($(echo $SAMPLE_URLS | wc -w))) CDN URLs unreachable"
    exit 1
  else
    echo "  ✅ PASS: All sampled CDN URLs reachable"
  fi
fi

# Check 3: Listing assets exist on filesystem (local dev only)
echo ""
echo "[3/3] Checking local listing assets exist..."
LISTING_DIR="$REPO_ROOT/apps/backend/images/listing"

if [[ ! -d "$LISTING_DIR" ]]; then
  echo "  ⚠️  SKIP: Listing directory not found (expected for production)"
else
  MISSING_FILES=0
  SAMPLE_PRODUCTS=$(sqlite3 "$DB_PATH" \
    "SELECT product_uid FROM products WHERE staging_ready=1 LIMIT 5;")

  if [[ -z "$SAMPLE_PRODUCTS" ]]; then
    echo "  ⚠️  SKIP: No staged products to check"
  else
    while IFS= read -r product_uid; do
      EXPECTED_PATH="$LISTING_DIR/$product_uid/front.jpg"
      if [[ -f "$EXPECTED_PATH" ]]; then
        echo "  ✅ $product_uid/front.jpg exists"
      else
        echo "  ❌ $product_uid/front.jpg missing"
        MISSING_FILES=$((MISSING_FILES + 1))
      fi
    done <<< "$SAMPLE_PRODUCTS"

    if [[ "$MISSING_FILES" -gt 0 ]]; then
      echo "  ❌ FAIL: $MISSING_FILES listing assets missing"
      exit 1
    else
      echo "  ✅ PASS: All sampled listing assets exist"
    fi
  fi
fi

echo ""
echo "=============================================="
echo "  ✅ Image Readiness: GREEN"
echo "=============================================="
exit 0
