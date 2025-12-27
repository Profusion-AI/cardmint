#!/bin/bash
# Regenerate Atlas schema baseline from current dev database
# Owner: Claude Code | Created: 2025-12-26
#
# Usage: ./scripts/regenerate-baseline.sh
#
# This script extracts the schema from cardmint_dev.db and filters out:
# - FTS virtual tables and related triggers
# - schema_migrations table (created by migrate.ts)
# - SQLite internal tables

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${BACKEND_DIR}/cardmint_dev.db"
OUTPUT_PATH="${BACKEND_DIR}/db/atlas/schema.sql"

if [ ! -f "$DB_PATH" ]; then
  echo "Error: Database not found at $DB_PATH"
  exit 1
fi

# Create awk filter script
AWK_FILTER=$(cat << 'AWKSCRIPT'
BEGIN {
  in_trigger = 0
  in_fts_virtual = 0
  buffer = ""
}

# Start of a CREATE TRIGGER - buffer it
/^CREATE TRIGGER/ {
  buffer = $0
  in_trigger = 1
  next
}

# Inside a trigger - accumulate
in_trigger {
  buffer = buffer "\n" $0
  # End of trigger
  if (/^END;/) {
    in_trigger = 0
    # Check if this trigger references _fts - if not, print it
    if (buffer !~ /_fts/) {
      print buffer
    }
    buffer = ""
  }
  next
}

# Start of CREATE VIRTUAL TABLE with fts - skip until semicolon
/^CREATE VIRTUAL TABLE.*_fts/ {
  in_fts_virtual = 1
  next
}

in_fts_virtual {
  if (/;[[:space:]]*$/) {
    in_fts_virtual = 0
  }
  next
}

# Skip schema_migrations
/^CREATE TABLE schema_migrations/ {
  # Skip until we see a closing );
  while ((getline line) > 0) {
    if (line ~ /\);[[:space:]]*$/) break
  }
  next
}

# Skip sqlite internal tables
/^CREATE TABLE sqlite_/ { next }

# Print everything else that's not FTS related
!/_fts/ { print }
AWKSCRIPT
)

echo "Extracting schema from $DB_PATH..."

# Generate header
cat > "$OUTPUT_PATH" << HEADER
-- CardMint SQLite Schema Baseline
-- Owner: Claude Code | Generated: 2025-12-26 | Updated: $(date +%Y-%m-%d)
--
-- This is the source of truth for Atlas drift detection.
--
-- REGENERATION COMMAND:
--   cd apps/backend && ./scripts/regenerate-baseline.sh
--
-- EXCLUDED from baseline (intentionally):
--   - schema_migrations: Created dynamically by migrate.ts
--   - *_fts* virtual tables and triggers: SQLite FTS internal tables
--   - sqlite_* tables: SQLite internal tables
--
-- Protected columns (require SYNC-COLUMN-JUSTIFICATION in PR):
--   products: evershop_sync_state, sync_version, evershop_uuid, evershop_product_id, public_sku
--   items: sync_version, last_synced_at
--   sync_events: entire table
--   sync_leader: entire table

HEADER

# Extract and filter schema
sqlite3 "$DB_PATH" ".schema" | awk "$AWK_FILTER" >> "$OUTPUT_PATH"

# Validate output
echo "Validating schema..."
if sqlite3 :memory: < "$OUTPUT_PATH" 2>&1; then
  echo "✅ Schema baseline updated: $OUTPUT_PATH"
  echo "   Lines: $(wc -l < "$OUTPUT_PATH")"
  echo "   Tables: $(grep -c "CREATE TABLE" "$OUTPUT_PATH")"
  echo "   Indexes: $(grep -c "CREATE INDEX" "$OUTPUT_PATH")"
  echo "   Triggers: $(grep -c "CREATE TRIGGER" "$OUTPUT_PATH")"
else
  echo "❌ Schema validation failed!"
  exit 1
fi

# Verify protected columns
echo ""
echo "Verifying protected columns..."
for col in evershop_sync_state sync_version evershop_uuid public_sku evershop_product_id; do
  if grep -q "$col" "$OUTPUT_PATH"; then
    echo "  ✅ $col"
  else
    echo "  ❌ $col MISSING - CRITICAL ERROR"
    exit 1
  fi
done

echo ""
echo "Done! Commit the updated schema.sql with your migration."
