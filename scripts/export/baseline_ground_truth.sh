#!/usr/bin/env bash
# Export ground truth CSV from the finalized Baseline Session
# Columns: scan_id, pricecharting_id, expected_name, expected_set, expected_price_pennies, scan_created_at

set -euo pipefail

# Load backend env for DB path
if [[ -f "apps/backend/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source apps/backend/.env; set +a
fi

DB_PATH="${SQLITE_DB:-apps/backend/data/cardmint_dev.db}"
if [[ ! "$DB_PATH" =~ ^apps/backend ]]; then
  DB_PATH="apps/backend/${DB_PATH}"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 2
fi

OUT_DIR="exports"
mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d)
OUT_FILE="$OUT_DIR/baseline-ground-truth-${STAMP}.csv"

SQL=$(cat <<'EOSQL'
.mode csv
.headers on
-- Verify baseline exists
SELECT 'baseline_session_id', (SELECT id FROM operator_sessions WHERE baseline = 1 ORDER BY created_at DESC LIMIT 1);

-- Export ground truth joined to products and PriceCharting bridge
SELECT
  s.id AS scan_id,
  pcb.pricecharting_id AS pricecharting_id,
  p.card_name AS expected_name,
  p.set_name AS expected_set,
  CAST(ROUND(p.market_price * 100) AS INTEGER) AS expected_price_pennies,
  s.created_at AS scan_created_at
FROM scans s
JOIN operator_sessions os ON s.session_id = os.id
LEFT JOIN items i ON s.item_uid = i.item_uid
LEFT JOIN products p ON i.product_uid = p.product_uid
LEFT JOIN cm_pricecharting_bridge pcb ON p.cm_card_id = pcb.cm_card_id
WHERE os.baseline = 1
ORDER BY s.created_at ASC;
EOSQL
)

sqlite3 "$DB_PATH" <<SQL > "$OUT_FILE"
$SQL
SQL

echo "Exported baseline ground truth to $OUT_FILE"

