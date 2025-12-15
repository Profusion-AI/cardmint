#!/bin/bash
# Reset database for 72-card baseline run
# Creates backup and clears scan/session data while preserving reference corpus
#
# Usage: bash scripts/validate/reset_for_72card_baseline.sh
#
# IMPORTANT: Review backup location before proceeding

set -e

# Read database path from .env or use default
if [ -f "apps/backend/.env" ] && grep -q "SQLITE_DB=" apps/backend/.env; then
  DB_FILE=$(grep "SQLITE_DB=" apps/backend/.env | cut -d '=' -f2)
  DB_PATH="apps/backend/$DB_FILE"
else
  # Fallback to default
  DB_PATH="apps/backend/cardmint_dev.db"
fi

BACKUP_PATH="${DB_PATH%.db}-backup-20251103.db"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║     CARDMINT 72-CARD BASELINE - DATABASE RESET                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
  echo "✗ Database not found at $DB_PATH"
  exit 1
fi

echo "Database: $DB_PATH"
echo "Backup:   $BACKUP_PATH"
echo ""

# Check current row counts
echo "═══ CURRENT DATABASE STATE =══"
sqlite3 "$DB_PATH" <<SQL
SELECT 'Scans: ' || COUNT(*) FROM scans;
SELECT 'Operator sessions: ' || COUNT(*) FROM operator_sessions;
SELECT 'Products: ' || COUNT(*) FROM products;
SELECT 'Items: ' || COUNT(*) FROM items;
SELECT 'Scan events: ' || COUNT(*) FROM scan_events;
SELECT 'PriceCharting corpus: ' || COUNT(*) FROM pricecharting_cards;
SQL
echo ""

# Confirm with user
read -p "Proceed with backup and clear? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "✗ Aborted by user"
  exit 0
fi

echo ""
echo "═══ CREATING BACKUP =══"
cp "$DB_PATH" "$BACKUP_PATH"
echo "✓ Backup created: $BACKUP_PATH"
BACKUP_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
echo "  Size: $BACKUP_SIZE"
echo ""

echo "═══ CLEARING TABLES =══"
sqlite3 "$DB_PATH" <<SQL
-- Disable foreign keys temporarily for clean delete
PRAGMA foreign_keys = OFF;

-- Delete dependent tables first
DELETE FROM scan_events;
DELETE FROM scan_metrics;
DELETE FROM items;
DELETE FROM products;

-- Delete core tables
DELETE FROM scans;
DELETE FROM operator_session_events;
DELETE FROM operator_sessions;

-- Re-enable foreign keys
PRAGMA foreign_keys = ON;

-- Verify cleanup
SELECT 'Scans remaining: ' || COUNT(*) FROM scans;
SELECT 'Sessions remaining: ' || COUNT(*) FROM operator_sessions;
SELECT 'Products remaining: ' || COUNT(*) FROM products;
SELECT 'Items remaining: ' || COUNT(*) FROM items;

-- Verify corpus preserved
SELECT 'PriceCharting corpus preserved: ' || COUNT(*) || ' rows' FROM pricecharting_cards;
SQL

echo ""
echo "═══ VACUUM DATABASE =══"
sqlite3 "$DB_PATH" "VACUUM;"
echo "✓ Database vacuumed"
echo ""

NEW_SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    RESET COMPLETE                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Database size: $NEW_SIZE"
echo "Backup:        $BACKUP_PATH ($BACKUP_SIZE)"
echo ""
echo "Next steps:"
echo "  1. Kyle: Create 72card-03nov.csv in workspace root"
echo "  2. Kyle: Scan 72 cards via operator workbench"
echo "  3. Run: sqlite3 $DB_PATH < scripts/validate/acceptance_72.sql"
echo ""
