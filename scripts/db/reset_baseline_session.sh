#!/usr/bin/env bash
# Reset dev database for a Fresh Baseline Scan Session
#
# Safety rails:
# - Requires --confirm flag
# - Requires DEV_MODE=true in apps/backend/.env
# - Preserves reference datasets and import job history
# - Uses DELETE + VACUUM instead of DROP/CREATE to avoid schema churn

set -euo pipefail

CONFIRM="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRM="true"; shift ;;
    -h|--help)
      echo "Usage: $0 --confirm"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$CONFIRM" != "true" ]]; then
  echo "ERROR: This is a destructive operation. Re-run with --confirm." >&2
  exit 2
fi

# Load backend env
if [[ -f "apps/backend/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source apps/backend/.env; set +a
else
  echo "ERROR: apps/backend/.env not found." >&2
  exit 2
fi

# Ensure DEV_MODE=true (never run against prod DB)
if [[ "${DEV_MODE:-}" != "true" ]]; then
  echo "ERROR: DEV_MODE must be true in apps/backend/.env to run this reset." >&2
  exit 2
fi

# Resolve DB path (relative to workspace)
DB_PATH="${SQLITE_DB:-apps/backend/data/cardmint_dev.db}"
if [[ ! "$DB_PATH" =~ ^apps/backend ]]; then
  # Default to placing DB inside apps/backend
  DB_PATH="apps/backend/${DB_PATH}"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 2
fi

# Backup
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_PATH="${DB_PATH}.backup.${TS}"
cp -f "$DB_PATH" "$BACKUP_PATH"
echo "Backup created: $BACKUP_PATH"

# Tables to flush (order chosen to minimize FK churn)
READONLY_TABLES=(
  reference_datasets
  pricecharting_cards pricecharting_cards_fts
  cm_sets cm_cards cm_cards_fts cm_pricecharting_bridge cm_tcgplayer_bridge
  ppt_price_cache ppt_quota_log
  evershop_import_jobs
)

TARGET_TABLES=(
  scan_metrics
  scan_events
  scans
  items
  products
  operator_session_events
  operator_sessions
)

SQL=$(cat <<'EOSQL'
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
-- Flush target tables (DELETE, not DROP)
DELETE FROM scan_metrics;
DELETE FROM scan_events;
DELETE FROM scans;
DELETE FROM items;
DELETE FROM products;
DELETE FROM operator_session_events;
DELETE FROM operator_sessions;
COMMIT;
VACUUM;
PRAGMA foreign_keys = ON;
EOSQL
)

sqlite3 "$DB_PATH" <<SQL
$SQL
SQL

echo "Database reset complete. Ready for fresh baseline session."

