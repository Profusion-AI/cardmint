#!/usr/bin/env bash
# Manifest Uniqueness Validation Script
#
# Validates that manifest-md5.csv contains no duplicate SKUs.
# Exit codes:
#   0 - All SKUs unique (success)
#   1 - Duplicates found (failure)
#   2 - Manifest file not found or empty

set -euo pipefail

MANIFEST_PATH="${1:-apps/backend/images/manifest-md5.csv}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== Manifest Uniqueness Validation ==="
echo "Manifest: $MANIFEST_PATH"
echo

# Check if manifest exists
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo -e "${RED}✗ Manifest file not found: $MANIFEST_PATH${NC}"
  exit 2
fi

# Check if manifest has content (more than just header)
LINE_COUNT=$(wc -l < "$MANIFEST_PATH")
if [[ $LINE_COUNT -le 1 ]]; then
  echo -e "${YELLOW}⚠ Manifest is empty (only header or no content)${NC}"
  exit 2
fi

# Extract SKUs (first column), skip header, count occurrences
TOTAL_ENTRIES=$((LINE_COUNT - 1))  # Subtract header row
UNIQUE_SKUS=$(tail -n +2 "$MANIFEST_PATH" | awk -F, '{print $1}' | sort -u | wc -l)
DUPLICATE_SKUS=$(tail -n +2 "$MANIFEST_PATH" | awk -F, '{print $1}' | sort | uniq -d)
DUPLICATE_COUNT=$(echo "$DUPLICATE_SKUS" | grep -c . || true)

echo "Total entries: $TOTAL_ENTRIES"
echo "Unique SKUs:   $UNIQUE_SKUS"
echo

if [[ $DUPLICATE_COUNT -eq 0 ]]; then
  echo -e "${GREEN}✓ All SKUs are unique (no duplicates found)${NC}"
  exit 0
else
  echo -e "${RED}✗ Found $DUPLICATE_COUNT duplicate SKU(s):${NC}"
  echo
  while IFS= read -r sku; do
    [[ -z "$sku" ]] && continue
    COUNT=$(tail -n +2 "$MANIFEST_PATH" | awk -F, -v s="$sku" '$1 == s' | wc -l)
    echo "  - $sku (appears $COUNT times)"

    # Show the conflicting entries
    tail -n +2 "$MANIFEST_PATH" | awk -F, -v s="$sku" '$1 == s {print "      " $0}'
  done <<< "$DUPLICATE_SKUS"

  echo
  echo -e "${RED}Manifest validation failed: duplicates must be resolved${NC}"
  exit 1
fi
