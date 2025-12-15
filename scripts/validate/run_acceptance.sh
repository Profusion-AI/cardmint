#!/usr/bin/env bash
# CardMint Acceptance Gate Wrapper
# Runs acceptance SQL against a chosen SQLite DB, prints output, and exits non-zero on FAIL/RED gates.
# Usage:
#   scripts/validate/run_acceptance.sh [--db <path>] [--size 20|72] [--sql <file>]

set -euo pipefail

DB_PATH=""
SIZE="20"
SQL_FILE=""
MODE="baseline" # baseline | csv
ALLOW_CSV_FALLBACK="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_PATH=${2:-}
      shift 2
      ;;
    --size)
      SIZE=${2:-20}
      shift 2
      ;;
    --sql)
      SQL_FILE=${2:-}
      shift 2
      ;;
    --mode)
      MODE=${2:-baseline}
      shift 2
      ;;
    --allow-csv-fallback)
      ALLOW_CSV_FALLBACK="true"
      shift 1
      ;;
    -h|--help)
      echo "Usage: $0 [--db <path>] [--size 20|72] [--sql <file>]"; exit 0;
      ;;
    *)
      echo "Unknown argument: $1" >&2; exit 2;
      ;;
  esac
done

# Auto-detect DB if not provided
detect_db() {
  local candidates=(
    "apps/backend/cardmint_dev.db"
    "apps/backend/data/cardmint_dev.db"
    "apps/backend/cardmint.db"
    "apps/backend/data/cardmint.db"
  )
  for p in "${candidates[@]}"; do
    if [[ -f "$p" ]] && [[ $(stat -c%s "$p" 2>/dev/null || echo 0) -ge 1024 ]]; then
      echo "$p"; return 0;
    fi
  done
  return 1
}

if [[ -z "$DB_PATH" ]]; then
  if ! DB_PATH=$(detect_db); then
    echo "ERROR: Could not find a suitable SQLite DB. Pass --db <path>." >&2
    exit 2
  fi
fi

# Pick SQL file
if [[ -z "$SQL_FILE" ]]; then
  if [[ "$MODE" == "csv" ]]; then
    if [[ "$ALLOW_CSV_FALLBACK" != "true" ]]; then
      echo "ERROR: CSV fallback mode requires --allow-csv-fallback (QA-only)." >&2
      exit 2
    fi
    if [[ "$SIZE" == "72" ]]; then
      SQL_FILE="scripts/validate/acceptance_csv_72.sql"
    else
      SQL_FILE="scripts/validate/acceptance_csv_20.sql"
    fi
  else
    if [[ "$SIZE" == "72" ]]; then
      SQL_FILE="scripts/validate/acceptance_72.sql"
    else
      SQL_FILE="scripts/validate/acceptance.sql"
    fi
  fi
fi

if [[ ! -f "$SQL_FILE" ]]; then
  echo "ERROR: SQL file not found: $SQL_FILE" >&2
  exit 2
fi

echo "Running acceptance gate: DB=$DB_PATH, SQL=$SQL_FILE" >&2
TMP_OUT=$(mktemp)

set +e
sqlite3 "$DB_PATH" < "$SQL_FILE" | tee "$TMP_OUT"
SQL_EXIT=$?
set -e

if [[ $SQL_EXIT -ne 0 ]]; then
  echo "sqlite3 returned non-zero exit ($SQL_EXIT). Failing." >&2
  rm -f "$TMP_OUT"
  exit $SQL_EXIT
fi

# Baseline missing guard (baseline scripts print an ERROR line)
if grep -q "^ERROR: No baseline session found" "$TMP_OUT"; then
  echo "Acceptance: FAIL (no baseline session)" >&2
  rm -f "$TMP_OUT"
  exit 1
fi

FAIL_COUNT=$(grep -c "✗ FAIL" "$TMP_OUT" || true)
RED_COUNT=$(grep -c "✗ RED" "$TMP_OUT" || true)
WARN_COUNT=$(grep -c "⚠" "$TMP_OUT" || true)

rm -f "$TMP_OUT"

if (( FAIL_COUNT > 0 || RED_COUNT > 0 )); then
  echo "Acceptance: FAIL (fail=$FAIL_COUNT, red=$RED_COUNT, warn=$WARN_COUNT)" >&2
  exit 1
fi

if (( WARN_COUNT > 0 )); then
  echo "Acceptance: WARNING (warn=$WARN_COUNT)" >&2
else
  echo "Acceptance: PASS" >&2
fi

exit 0
