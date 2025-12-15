#!/bin/bash
# verify_stage2_guarantees.sh
#
# Stage 2 Verification Script
# Per Nov 18 hard rule: ALL ACCEPTED scans MUST have item_uid NOT NULL
# This script verifies Stage 2 guarantees before stage/prod promotion.
#
# Exit Codes:
#   0 - All checks passed (Stage 2 guarantees met)
#   1 - Stage 2 guarantees violated (orphaned accepted scans found)
#
# Usage:
#   scripts/validate/verify_stage2_guarantees.sh                    # Uses apps/backend/cardmint_dev.db
#   scripts/validate/verify_stage2_guarantees.sh /path/to/db.db    # Custom DB path

set -e

# Determine DB path
DB_PATH="${1:-apps/backend/cardmint_dev.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ ERROR: Database not found at $DB_PATH"
  exit 1
fi

echo "🔍 Verifying Stage 2 guarantees for $DB_PATH..."
echo ""

# Stage 2 Guarantee Check: ALL ACCEPTED scans must have item_uid NOT NULL
ORPHANED_COUNT=$(sqlite3 "$DB_PATH" <<EOF
SELECT COUNT(*)
FROM scans
WHERE status = 'ACCEPTED'
  AND item_uid IS NULL;
EOF
)

ACCEPTED_COUNT=$(sqlite3 "$DB_PATH" <<EOF
SELECT COUNT(*)
FROM scans
WHERE status = 'ACCEPTED';
EOF
)

WITH_INVENTORY_COUNT=$(sqlite3 "$DB_PATH" <<EOF
SELECT COUNT(*)
FROM scans
WHERE status = 'ACCEPTED'
  AND item_uid IS NOT NULL;
EOF
)

echo "📊 Stage 2 Inventory Stats:"
echo "   Total ACCEPTED scans:         $ACCEPTED_COUNT"
echo "   With inventory (item_uid):    $WITH_INVENTORY_COUNT"
echo "   Missing inventory (orphaned): $ORPHANED_COUNT"
echo ""

if [ "$ORPHANED_COUNT" -gt 0 ]; then
  echo "❌ FAILED: Stage 2 guarantees violated"
  echo ""
  echo "   $ORPHANED_COUNT accepted scans are missing inventory (item_uid IS NULL)"
  echo "   Per Nov 18 hard rule, ALL accepted scans must have Stage 2 inventory."
  echo ""
  echo "   Run backfill script to fix:"
  echo "   npm run backfill:accepted --confirm"
  echo ""
  echo "   Or investigate orphaned scans:"
  echo "   sqlite3 $DB_PATH \"SELECT id, accepted_name, accepted_collector_no, accepted_set_name FROM scans WHERE status='ACCEPTED' AND item_uid IS NULL;\""
  echo ""
  exit 1
fi

echo "✅ PASSED: All Stage 2 guarantees met"
echo "   All $ACCEPTED_COUNT accepted scans have inventory (item_uid NOT NULL)"
echo ""
exit 0
