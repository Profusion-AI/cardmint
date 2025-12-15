#!/bin/bash
# 5-Card Smoke Test Validation Script
# Validates all critical fixes from Run #2/3 bug fixes
#
# Prerequisites:
# - Backend running (npm run dev:backend)
# - Active RUNNING session created
# - 5 cards captured via operator UI
#
# Usage: ./scripts/validate_smoke_test.sh

set -euo pipefail

DB_PATH="apps/backend/data/cardmint.db"
CORRECTED_DIR="apps/backend/data/corrected-images"
PROCESSED_DIR="apps/backend/images/incoming"

echo "=================================="
echo "5-Card Smoke Test Validation"
echo "=================================="
echo ""

# Get most recent session timestamp for filtering
LATEST_SESSION_START=$(sqlite3 "$DB_PATH" "SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1" 2>/dev/null || echo "0")

if [ "$LATEST_SESSION_START" = "0" ]; then
    echo "❌ ERROR: No active session found. Please start a session first."
    exit 1
fi

echo "📅 Latest session started at: $LATEST_SESSION_START"
echo ""

# ============================================
# Test 1: Database Schema Validation
# ============================================
echo "Test 1: Database Schema Validation"
echo "-----------------------------------"

# Check all required fields are present in scans table
REQUIRED_FIELDS="id session_id raw_image_path processed_image_path extracted_json timings_json"
SCHEMA=$(sqlite3 "$DB_PATH" "PRAGMA table_info(scans);" | awk -F'|' '{print $2}')

ALL_FIELDS_PRESENT=true
for field in $REQUIRED_FIELDS; do
    if ! echo "$SCHEMA" | grep -q "^$field$"; then
        echo "❌ Missing field: $field"
        ALL_FIELDS_PRESENT=false
    fi
done

if [ "$ALL_FIELDS_PRESENT" = true ]; then
    echo "✅ All required fields present in scans table"
else
    echo "❌ Schema validation failed"
    exit 1
fi
echo ""

# ============================================
# Test 2: Processed Paths Populated
# ============================================
echo "Test 2: Processed Paths Populated"
echo "----------------------------------"

sqlite3 "$DB_PATH" <<'SQL'
.mode box
.headers on
SELECT
  substr(id, 1, 8) as job_id,
  CASE
    WHEN processed_image_path IS NULL THEN '❌ NULL'
    WHEN processed_image_path LIKE '%/incoming/%' THEN '✅ Valid'
    ELSE '⚠️  Unexpected'
  END as processed_path_status,
  substr(processed_image_path, -30) as path_suffix
FROM scans
WHERE created_at > (SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1)
ORDER BY created_at DESC
LIMIT 5;
SQL

# Count non-NULL processed paths
NULL_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND processed_image_path IS NULL;")
TOTAL_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START;")

if [ "$NULL_COUNT" -eq 0 ] && [ "$TOTAL_COUNT" -ge 1 ]; then
    echo "✅ Processed paths: $TOTAL_COUNT/$TOTAL_COUNT populated (100%)"
elif [ "$TOTAL_COUNT" -eq 0 ]; then
    echo "⚠️  No scans found in latest session. Please capture cards first."
    exit 1
else
    echo "❌ Processed paths: $((TOTAL_COUNT - NULL_COUNT))/$TOTAL_COUNT populated ($(( (TOTAL_COUNT - NULL_COUNT) * 100 / TOTAL_COUNT ))%)"
    echo "   Expected: 100%"
fi
echo ""

# ============================================
# Test 3: Session UUID Format Validation
# ============================================
echo "Test 3: Session UUID Format Validation"
echo "--------------------------------------"

sqlite3 "$DB_PATH" <<'SQL'
.mode box
.headers on
SELECT
  substr(s.id, 1, 8) as job_id,
  substr(s.session_id, 1, 13) as session_prefix,
  CASE
    WHEN s.session_id LIKE '%-%-%-%-%' THEN '✅ UUID'
    WHEN s.session_id LIKE '2025%T%' THEN '❌ Timestamp'
    ELSE '⚠️  Unknown'
  END as format,
  CASE
    WHEN os.id IS NOT NULL THEN '✅ Joined'
    ELSE '❌ No match'
  END as join_status
FROM scans s
LEFT JOIN operator_sessions os ON s.session_id = os.id
WHERE s.created_at > (SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1)
ORDER BY s.created_at DESC
LIMIT 5;
SQL

# Count UUID format vs timestamp format
UUID_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND session_id LIKE '%-%-%-%-%';")
TIMESTAMP_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND session_id LIKE '2025%T%';")

if [ "$UUID_COUNT" -eq "$TOTAL_COUNT" ] && [ "$TIMESTAMP_COUNT" -eq 0 ]; then
    echo "✅ Session IDs: $UUID_COUNT/$TOTAL_COUNT use UUID format (100%)"
else
    echo "❌ Session IDs: $UUID_COUNT UUID, $TIMESTAMP_COUNT timestamp format"
    echo "   Expected: All UUID format"
fi
echo ""

# ============================================
# Test 3b: Capture UID Validation
# ============================================
echo "Test 3b: Capture UID Validation"
echo "--------------------------------"

sqlite3 "$DB_PATH" <<'SQL'
.mode box
.headers on
SELECT
  substr(s.id, 1, 8) as job_id,
  substr(s.session_id, 1, 13) as session_prefix,
  CASE
    WHEN s.capture_uid IS NOT NULL THEN '✅ ' || substr(s.capture_uid, 1, 15)
    ELSE '❌ NULL'
  END as capture_uid
FROM scans s
WHERE s.created_at > (SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1)
ORDER BY s.created_at DESC
LIMIT 5;
SQL

# Count capture_uid population
CAPTURE_UID_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND capture_uid IS NOT NULL;")
CAPTURE_UID_PCT=$(( CAPTURE_UID_COUNT * 100 / TOTAL_COUNT ))

if [ "$CAPTURE_UID_COUNT" -eq "$TOTAL_COUNT" ]; then
    echo "✅ Capture UIDs: $CAPTURE_UID_COUNT/$TOTAL_COUNT populated (100%)"
else
    echo "⚠️  Capture UIDs: $CAPTURE_UID_COUNT/$TOTAL_COUNT populated ($CAPTURE_UID_PCT%)"
    echo "   Expected: 100% for Pi5 captures, but acceptable if using non-Pi5 driver"
fi
echo ""

# ============================================
# Test 4: Set Name Extraction Coverage
# ============================================
echo "Test 4: Set Name Extraction Coverage"
echo "------------------------------------"

sqlite3 "$DB_PATH" <<'SQL'
.mode box
.headers on
SELECT
  substr(id, 1, 8) as job_id,
  json_extract(extracted_json, '$.card_name') as card_name,
  json_extract(extracted_json, '$.set_number') as set_num,
  CASE
    WHEN json_extract(extracted_json, '$.set_name') IS NOT NULL
    THEN '✅ ' || substr(json_extract(extracted_json, '$.set_name'), 1, 15)
    ELSE '❌ NULL'
  END as set_name
FROM scans
WHERE created_at > (SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1)
ORDER BY created_at DESC
LIMIT 5;
SQL

# Count set_name coverage
SET_NAME_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND json_extract(extracted_json, '\$.set_name') IS NOT NULL;")
COVERAGE_PCT=$(( SET_NAME_COUNT * 100 / TOTAL_COUNT ))

if [ "$COVERAGE_PCT" -ge 40 ]; then
    echo "✅ Set name coverage: $SET_NAME_COUNT/$TOTAL_COUNT populated ($COVERAGE_PCT%)"
else
    echo "⚠️  Set name coverage: $SET_NAME_COUNT/$TOTAL_COUNT populated ($COVERAGE_PCT%)"
    echo "   Expected: ≥40%, but acceptable if model struggles with set names"
fi
echo ""

# ============================================
# Test 5: Retry Rate Analysis
# ============================================
echo "Test 5: Path A Retry Rate"
echo "-------------------------"

sqlite3 "$DB_PATH" <<'SQL'
.mode box
.headers on
SELECT
  substr(id, 1, 8) as job_id,
  json_extract(timings_json, '$.inference_ms') as infer_ms,
  CASE
    WHEN json_extract(timings_json, '$.retried_once') = 1 THEN '⚠️  Retried'
    ELSE '✅ First attempt'
  END as retry_status
FROM scans
WHERE created_at > (SELECT started_at FROM operator_sessions ORDER BY started_at DESC LIMIT 1)
ORDER BY created_at DESC
LIMIT 5;
SQL

# Calculate retry rate
RETRY_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM scans WHERE created_at > $LATEST_SESSION_START AND json_extract(timings_json, '\$.retried_once') = 1;")
RETRY_PCT=$(( RETRY_COUNT * 100 / TOTAL_COUNT ))

if [ "$RETRY_PCT" -le 20 ]; then
    echo "✅ Retry rate: $RETRY_COUNT/$TOTAL_COUNT ($RETRY_PCT%)"
elif [ "$RETRY_PCT" -le 60 ]; then
    echo "⚠️  Retry rate: $RETRY_COUNT/$TOTAL_COUNT ($RETRY_PCT%)"
    echo "   Acceptable but monitor for patterns"
else
    echo "❌ Retry rate: $RETRY_COUNT/$TOTAL_COUNT ($RETRY_PCT%)"
    echo "   Expected: <60%"
fi
echo ""

# ============================================
# Test 6: File System Consistency
# ============================================
echo "Test 6: File System Consistency"
echo "-------------------------------"

# Check corrected images directory
if [ -d "$CORRECTED_DIR" ]; then
    CORRECTED_COUNT=$(find "$CORRECTED_DIR" -name "corrected_*.jpg" -type f | wc -l)
    echo "Corrected images directory: $CORRECTED_COUNT files"
    if [ "$CORRECTED_COUNT" -ge "$TOTAL_COUNT" ]; then
        echo "✅ Corrected images: $CORRECTED_COUNT files found (≥ $TOTAL_COUNT scans)"
    else
        echo "⚠️  Corrected images: $CORRECTED_COUNT files found (expected ≥ $TOTAL_COUNT)"
    fi
else
    echo "❌ Corrected images directory not found: $CORRECTED_DIR"
fi

# Check processed images directory
if [ -d "$PROCESSED_DIR" ]; then
    PROCESSED_COUNT=$(find "$PROCESSED_DIR" -name "*-front.jpg" -type f | wc -l)
    echo "Processed images directory: $PROCESSED_COUNT files"
    if [ "$PROCESSED_COUNT" -ge "$TOTAL_COUNT" ]; then
        echo "✅ Processed images: $PROCESSED_COUNT files found (≥ $TOTAL_COUNT scans)"
    else
        echo "⚠️  Processed images: $PROCESSED_COUNT files found (expected ≥ $TOTAL_COUNT)"
    fi
else
    echo "❌ Processed images directory not found: $PROCESSED_DIR"
fi
echo ""

# ============================================
# Test 7: Image Dimensions Verification
# ============================================
echo "Test 7: Image Dimensions (1024px Portrait)"
echo "------------------------------------------"

# Get list of processed images from latest session
PROCESSED_IMAGES=$(sqlite3 "$DB_PATH" "SELECT processed_image_path FROM scans WHERE created_at > $LATEST_SESSION_START AND processed_image_path IS NOT NULL ORDER BY created_at DESC LIMIT 5;")

if [ -z "$PROCESSED_IMAGES" ]; then
    echo "⚠️  No processed images found in database"
else
    DIMENSION_PASS=0
    DIMENSION_FAIL=0

    while IFS= read -r img_path; do
        if [ -f "$img_path" ]; then
            # Use identify to get dimensions (requires ImageMagick)
            if command -v identify &> /dev/null; then
                DIMENSIONS=$(identify -format "%wx%h" "$img_path" 2>/dev/null || echo "unknown")
                WIDTH=$(echo "$DIMENSIONS" | cut -d'x' -f1)
                HEIGHT=$(echo "$DIMENSIONS" | cut -d'x' -f2)

                # Check if portrait and long edge is 1024
                if [ "$HEIGHT" -eq 1024 ] && [ "$WIDTH" -lt "$HEIGHT" ]; then
                    echo "✅ $(basename "$img_path"): ${WIDTH}x${HEIGHT} (portrait 1024px)"
                    DIMENSION_PASS=$((DIMENSION_PASS + 1))
                else
                    echo "❌ $(basename "$img_path"): ${WIDTH}x${HEIGHT} (expected portrait with height=1024)"
                    DIMENSION_FAIL=$((DIMENSION_FAIL + 1))
                fi
            else
                echo "⚠️  ImageMagick 'identify' not found; skipping dimension check"
                echo "   Install with: sudo dnf install ImageMagick"
                break
            fi
        else
            echo "❌ File not found: $img_path"
            DIMENSION_FAIL=$((DIMENSION_FAIL + 1))
        fi
    done <<< "$PROCESSED_IMAGES"

    if [ "$DIMENSION_FAIL" -eq 0 ] && [ "$DIMENSION_PASS" -gt 0 ]; then
        echo "✅ All images: Portrait 1024px ($DIMENSION_PASS/$DIMENSION_PASS)"
    elif [ "$DIMENSION_PASS" -gt 0 ]; then
        echo "⚠️  Dimension check: $DIMENSION_PASS pass, $DIMENSION_FAIL fail"
    fi
fi
echo ""

# ============================================
# Summary
# ============================================
echo "=================================="
echo "Smoke Test Summary"
echo "=================================="
echo ""
echo "Total scans in latest session: $TOTAL_COUNT"
echo ""

TESTS_PASSED=0
TESTS_WARNING=0
TESTS_FAILED=0

# Evaluate each test
[ "$NULL_COUNT" -eq 0 ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_FAILED=$((TESTS_FAILED + 1))
[ "$UUID_COUNT" -eq "$TOTAL_COUNT" ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_FAILED=$((TESTS_FAILED + 1))
[ "$CAPTURE_UID_COUNT" -eq "$TOTAL_COUNT" ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_WARNING=$((TESTS_WARNING + 1))
[ "$COVERAGE_PCT" -ge 40 ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_WARNING=$((TESTS_WARNING + 1))
[ "$RETRY_PCT" -le 20 ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || { [ "$RETRY_PCT" -le 60 ] && TESTS_WARNING=$((TESTS_WARNING + 1)) || TESTS_FAILED=$((TESTS_FAILED + 1)); }
[ "$CORRECTED_COUNT" -ge "$TOTAL_COUNT" ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_WARNING=$((TESTS_WARNING + 1))
[ "$PROCESSED_COUNT" -ge "$TOTAL_COUNT" ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_WARNING=$((TESTS_WARNING + 1))
[ "$DIMENSION_FAIL" -eq 0 ] && [ "$DIMENSION_PASS" -gt 0 ] && TESTS_PASSED=$((TESTS_PASSED + 1)) || TESTS_WARNING=$((TESTS_WARNING + 1))

echo "Tests passed:   $TESTS_PASSED"
echo "Tests warning:  $TESTS_WARNING"
echo "Tests failed:   $TESTS_FAILED"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo "✅ SMOKE TEST PASSED"
    echo ""
    echo "Ready to proceed with full 20-card validation run."
    exit 0
elif [ "$TESTS_FAILED" -le 1 ] && [ "$TESTS_WARNING" -le 2 ]; then
    echo "⚠️  SMOKE TEST PASSED WITH WARNINGS"
    echo ""
    echo "Minor issues detected but acceptable to proceed."
    echo "Monitor warnings during full 20-card run."
    exit 0
else
    echo "❌ SMOKE TEST FAILED"
    echo ""
    echo "Critical issues detected. Review failures before re-running."
    echo "Check backend logs for detailed error messages."
    exit 1
fi
