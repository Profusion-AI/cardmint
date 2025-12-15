-- CardMint Acceptance Gate (72-Card Baseline)
-- Validates extraction, retrieval, and schema health against ground truth
--
-- Usage: sqlite3 apps/backend/data/cardmint.db < scripts/validate/acceptance_72.sql
--
-- Expected ground truth: 72card-03nov.csv in workspace root

.mode column
.headers on

-- Ground Truth Import
-- Load the 72-card reference dataset from PriceCharting
CREATE TEMP TABLE IF NOT EXISTS ground_truth_raw (
  id TEXT,
  "product-name" TEXT,
  "console-name" TEXT,
  "price-in-pennies" TEXT,
  "include-string" TEXT,
  "condition-string" TEXT,
  "date-entered" TEXT
);

.mode csv
.import 72card-03nov.csv ground_truth_raw

-- Clean ground truth table (skip header, cast types)
CREATE TEMP TABLE ground_truth AS
SELECT
  ROW_NUMBER() OVER (ORDER BY ROWID) AS seq,
  CAST(id AS INTEGER) AS pricecharting_id,
  "product-name" AS expected_name,
  "console-name" AS expected_set,
  CAST("price-in-pennies" AS INTEGER) AS expected_price_pennies
FROM ground_truth_raw
WHERE id != 'id' AND id IS NOT NULL AND id != '';

.mode column

-- Ground truth presence notice (operator awareness)
SELECT 'Ground truth rows loaded: ' || (SELECT COUNT(*) FROM ground_truth) AS "Info";
SELECT CASE
  WHEN (SELECT COUNT(*) FROM ground_truth) = 0 THEN 'NOTE: No ground truth CSV found (72card-03nov.csv) — accuracy gates will show N/A/RED for dev DBs.'
  ELSE 'Ground truth present — accuracy gates active.'
END AS "Info";

-- Get most recent session for matching scans
-- Note: For baseline runs, we select the most recent 72 scans in chronological order
CREATE TEMP TABLE recent_session_scans AS
SELECT
  s.*,
  ROW_NUMBER() OVER (ORDER BY s.created_at) AS seq
FROM (
  SELECT * FROM scans
  WHERE status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')
  ORDER BY created_at DESC
  LIMIT 72
) s
ORDER BY s.created_at ASC;

.print "╔════════════════════════════════════════════════════════════════╗"
.print "║          CARDMINT ACCEPTANCE GATE - 72-CARD BASELINE          ║"
.print "╚════════════════════════════════════════════════════════════════╝"
.print ""

-- ==================================================================
-- 1. SCHEMA HEALTH CHECKS
-- ==================================================================
.print "═══ SCHEMA HEALTH =══"
.print ""

-- Check required tables exist
SELECT
  'Required tables: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('scans', 'operator_sessions')) = 2
    THEN '✓ PASS'
    ELSE '✗ FAIL (missing scans or operator_sessions table)'
  END AS "Status";

-- Check required columns on scans table
SELECT
  'Path separation columns: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM pragma_table_info('scans') WHERE name IN ('raw_image_path', 'processed_image_path')) = 2
    THEN '✓ PASS'
    ELSE '✗ FAIL (missing raw_image_path or processed_image_path)'
  END AS "Status";

-- Check for orphaned CAPTURING jobs
SELECT
  'No orphaned CAPTURING: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE status = 'CAPTURING') = 0
    THEN '✓ PASS'
    ELSE '⚠ WARNING - ' || (SELECT COUNT(*) FROM scans WHERE status = 'CAPTURING') || ' stuck jobs'
  END AS "Status";

-- Check session integrity
SELECT
  'Session integrity: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE session_id IS NULL) = 0
    THEN '✓ PASS'
    ELSE '⚠ WARNING - ' || (SELECT COUNT(*) FROM scans WHERE session_id IS NULL) || ' scans without session'
  END AS "Status";

.print ""

-- ==================================================================
-- 2. PATH INTEGRITY
-- ==================================================================
.print "═══ PATH INTEGRITY =══"
.print ""

-- Processed path populated when processing occurred
SELECT
  'Processed paths populated: ' ||
  CASE
    WHEN (
      SELECT COUNT(*) FROM scans
      WHERE json_extract(timings_json, '$.processing_ms') > 0
        AND (processed_image_path IS NULL OR processed_image_path = '')
    ) = 0
    THEN '✓ PASS'
    WHEN (
      SELECT COUNT(*) FROM scans
      WHERE json_extract(timings_json, '$.processing_ms') > 0
        AND (processed_image_path IS NULL OR processed_image_path = '')
    ) <= 5
    THEN '⚠ WARNING - ' || (
      SELECT COUNT(*) FROM scans
      WHERE json_extract(timings_json, '$.processing_ms') > 0
        AND (processed_image_path IS NULL OR processed_image_path = '')
    ) || ' missing (legacy data OK)'
    ELSE '✗ FAIL - ' || (
      SELECT COUNT(*) FROM scans
      WHERE json_extract(timings_json, '$.processing_ms') > 0
        AND (processed_image_path IS NULL OR processed_image_path = '')
    ) || ' missing processed paths'
  END AS "Status";

-- Raw path always populated for completed jobs
SELECT
  'Raw paths populated: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE status != 'CAPTURING' AND (raw_image_path IS NULL OR raw_image_path = '')) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (SELECT COUNT(*) FROM scans WHERE status != 'CAPTURING' AND raw_image_path IS NULL) || ' missing raw paths'
  END AS "Status";

.print ""

-- ==================================================================
-- 3. EXTRACTION ACCURACY (Card Names)
-- ==================================================================
.print "═══ EXTRACTION ACCURACY =══"
.print ""

-- Helper: Normalize card names for fuzzy matching
-- Strips card numbers (#NN), variants ([Reverse Holo]), whitespace, case
CREATE TEMP TABLE normalized_ground_truth AS
SELECT
  seq,
  pricecharting_id,
  expected_name,
  expected_set,
  expected_price_pennies,
  -- Normalize: lowercase, strip #NN suffix, strip [Variant] suffix, remove spaces/punctuation
  LOWER(
    TRIM(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        -- Remove card number suffix (#123)
        CASE
          WHEN expected_name LIKE '%#%'
          THEN SUBSTR(expected_name, 1, INSTR(expected_name, '#') - 1)
          ELSE expected_name
        END,
        '[reverse holo]', ''), '[poke ball]', ''), ',', ''), '  ', ' '), '  ', ' ')
    )
  ) AS normalized_name
FROM ground_truth;

CREATE TEMP TABLE normalized_extractions AS
SELECT
  s.id AS scan_id,
  s.seq,
  json_extract(s.extracted_json, '$.card_name') AS extracted_name,
  json_extract(s.extracted_json, '$.set_name') AS extracted_set,
  -- Normalize extracted name same way
  LOWER(
    TRIM(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        CASE
          WHEN json_extract(s.extracted_json, '$.card_name') LIKE '%#%'
          THEN SUBSTR(json_extract(s.extracted_json, '$.card_name'), 1,
                      INSTR(json_extract(s.extracted_json, '$.card_name'), '#') - 1)
          ELSE json_extract(s.extracted_json, '$.card_name')
        END,
        '[reverse holo]', ''), '[poke ball]', ''), ',', ''), '  ', ' '), '  ', ' ')
    )
  ) AS normalized_name
FROM recent_session_scans s
WHERE s.status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED');

-- Match scans to ground truth by normalized name (not sequence)
CREATE TEMP TABLE extraction_matches AS
SELECT
  e.scan_id,
  e.seq,
  e.extracted_name,
  g.expected_name,
  g.pricecharting_id AS expected_pc_id,
  e.normalized_name AS extracted_normalized,
  g.normalized_name AS expected_normalized,
  -- Fuzzy match: normalized names equal
  CASE
    WHEN e.normalized_name = g.normalized_name
    THEN 1
    ELSE 0
  END AS name_match
FROM normalized_extractions e
LEFT JOIN normalized_ground_truth g ON e.normalized_name = g.normalized_name;

-- Summary statistics
SELECT
  printf('Extraction accuracy: %d/%d (%.1f%%)',
    SUM(name_match),
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 0.0 ELSE 100.0 * SUM(name_match) / COUNT(*) END
  ) AS "Status",
  CASE
    WHEN COUNT(*) = 0 THEN 'N/A'
    WHEN 100.0 * SUM(name_match) / COUNT(*) >= 80 THEN '✓ PASS'
    WHEN 100.0 * SUM(name_match) / COUNT(*) >= 65 THEN '⚠ YELLOW'
    ELSE '✗ RED'
  END AS "Gate"
FROM extraction_matches;

.print ""
.print "Mismatches (extracted ≠ expected, after normalization):"
SELECT
  substr(extracted_name, 1, 25) AS "Extracted",
  substr(expected_name, 1, 25) AS "Expected",
  substr(extracted_normalized, 1, 20) AS "Normalized Extracted",
  substr(expected_normalized, 1, 20) AS "Normalized Expected"
FROM extraction_matches
WHERE name_match = 0
ORDER BY scan_id;

.print ""

-- ==================================================================
-- 4. RETRIEVAL ACCURACY (PriceCharting IDs)
-- ==================================================================
.print "═══ RETRIEVAL ACCURACY =══"
.print ""

-- Check if correct PC ID appears in top-3 candidates
-- Join via extraction_matches (already has name-based ground truth linkage)
CREATE TEMP TABLE retrieval_matches AS
SELECT
  s.id AS scan_id,
  s.seq,
  s.top3_json,
  em.expected_pc_id,
  em.expected_name,
  em.extracted_name,
  -- Normalize ground truth ID with pricecharting:: prefix
  'pricecharting::' || CAST(em.expected_pc_id AS TEXT) AS normalized_expected_id,
  -- Extract candidate IDs (parse JSON array)
  json_extract(s.top3_json, '$[0].id') AS cand1_id,
  json_extract(s.top3_json, '$[1].id') AS cand2_id,
  json_extract(s.top3_json, '$[2].id') AS cand3_id,
  -- Check top-1 match (with normalized ID)
  CASE
    WHEN json_extract(s.top3_json, '$[0].id') = ('pricecharting::' || CAST(em.expected_pc_id AS TEXT))
    THEN 1
    ELSE 0
  END AS is_top1,
  -- Check top-3 match (with normalized ID)
  CASE
    WHEN json_extract(s.top3_json, '$[0].id') = ('pricecharting::' || CAST(em.expected_pc_id AS TEXT)) OR
         json_extract(s.top3_json, '$[1].id') = ('pricecharting::' || CAST(em.expected_pc_id AS TEXT)) OR
         json_extract(s.top3_json, '$[2].id') = ('pricecharting::' || CAST(em.expected_pc_id AS TEXT))
    THEN 1
    ELSE 0
  END AS in_top3
FROM recent_session_scans s
JOIN extraction_matches em ON s.id = em.scan_id
WHERE s.status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')
  AND s.top3_json IS NOT NULL
  AND em.name_match = 1;  -- Only check retrieval for cards we extracted correctly

-- Summary statistics
SELECT
  printf('Top-3 retrieval: %d/%d (%.1f%%)',
    SUM(in_top3),
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 0.0 ELSE 100.0 * SUM(in_top3) / COUNT(*) END
  ) AS "Status",
  CASE
    WHEN COUNT(*) = 0 THEN 'N/A'
    WHEN 100.0 * SUM(in_top3) / COUNT(*) >= 75 THEN '✓ PASS'
    WHEN 100.0 * SUM(in_top3) / COUNT(*) >= 60 THEN '⚠ YELLOW'
    ELSE '✗ RED'
  END AS "Gate"
FROM retrieval_matches;

SELECT
  printf('Top-1 accuracy: %d/%d (%.1f%%)',
    SUM(is_top1),
    COUNT(*),
    100.0 * SUM(is_top1) / COUNT(*)
  ) AS "Status",
  CASE
    WHEN 100.0 * SUM(is_top1) / COUNT(*) >= 60 THEN '✓ PASS'
    WHEN 100.0 * SUM(is_top1) / COUNT(*) >= 45 THEN '⚠ YELLOW'
    ELSE '✗ RED'
  END AS "Gate"
FROM retrieval_matches;

.print ""
.print "Retrieval misses (expected ID not in top-3, among correctly extracted cards):"
SELECT
  substr(extracted_name, 1, 20) AS "Extracted",
  substr(expected_name, 1, 20) AS "Expected Card",
  expected_pc_id AS "Expected ID",
  substr(cand1_id, 16, 10) AS "Got #1",
  substr(cand2_id, 16, 10) AS "Got #2",
  substr(cand3_id, 16, 10) AS "Got #3"
FROM retrieval_matches
WHERE in_top3 = 0
ORDER BY scan_id;

.print ""

-- ==================================================================
-- 5. TIMING SANITY
-- ==================================================================
.print "═══ TIMING SANITY =══"
.print ""

-- Inference time distribution
SELECT
  printf('Inference time: %d-%d ms (median: %d ms)',
    MIN(CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER)),
    MAX(CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER)),
    (SELECT CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER)
     FROM scans
     WHERE json_extract(timings_json, '$.infer_ms') IS NOT NULL
     ORDER BY json_extract(timings_json, '$.infer_ms')
     LIMIT 1 OFFSET (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.infer_ms') IS NOT NULL) / 2)
  ) AS "Status"
FROM scans
WHERE json_extract(timings_json, '$.infer_ms') IS NOT NULL;

-- Processing time distribution (Stage 2)
SELECT
  printf('Processing time: %d-%d ms (median: %d ms)',
    MIN(CAST(json_extract(timings_json, '$.processing_ms') AS INTEGER)),
    MAX(CAST(json_extract(timings_json, '$.processing_ms') AS INTEGER)),
    (SELECT CAST(json_extract(timings_json, '$.processing_ms') AS INTEGER)
     FROM scans
     WHERE json_extract(timings_json, '$.processing_ms') IS NOT NULL
       AND json_extract(timings_json, '$.processing_ms') > 0
     ORDER BY json_extract(timings_json, '$.processing_ms')
     LIMIT 1 OFFSET (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.processing_ms') > 0) / 2)
  ) AS "Status"
FROM scans
WHERE json_extract(timings_json, '$.processing_ms') IS NOT NULL
  AND json_extract(timings_json, '$.processing_ms') > 0;

-- Total preprocessing (distortion + processing)
SELECT
  printf('Preprocessing total: %d-%d ms (median: %d ms)',
    MIN(CAST(json_extract(timings_json, '$.preprocessing_ms') AS INTEGER)),
    MAX(CAST(json_extract(timings_json, '$.preprocessing_ms') AS INTEGER)),
    (SELECT CAST(json_extract(timings_json, '$.preprocessing_ms') AS INTEGER)
     FROM scans
     WHERE json_extract(timings_json, '$.preprocessing_ms') IS NOT NULL
       AND json_extract(timings_json, '$.preprocessing_ms') > 0
     ORDER BY json_extract(timings_json, '$.preprocessing_ms')
     LIMIT 1 OFFSET (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.preprocessing_ms') > 0) / 2)
  ) AS "Status"
FROM scans
WHERE json_extract(timings_json, '$.preprocessing_ms') IS NOT NULL
  AND json_extract(timings_json, '$.preprocessing_ms') > 0;

-- Check for unreasonable values
SELECT
  'No timing anomalies: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans
          WHERE CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER) < 0
             OR CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER) > 300000) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (SELECT COUNT(*) FROM scans
          WHERE CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER) < 0
             OR CAST(json_extract(timings_json, '$.infer_ms') AS INTEGER) > 300000) || ' anomalies'
  END AS "Status";

.print ""

-- ==================================================================
-- 6. PATH A RETRY METRICS (Run #2+ only)
-- ==================================================================
.print "═══ PATH A RETRY METRICS =══"
.print ""

SELECT
  printf('Path A retries: %d/%d scans (%.1f%%)',
    (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.retried_once') = 1),
    (SELECT COUNT(*) FROM scans WHERE status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')),
    100.0 * (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.retried_once') = 1) /
            (SELECT COUNT(*) FROM scans WHERE status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED'))
  ) AS "Status",
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.retried_once') = 1) = 0
    THEN '✓ No retries needed'
    WHEN 100.0 * (SELECT COUNT(*) FROM scans WHERE json_extract(timings_json, '$.retried_once') = 1) /
                 (SELECT COUNT(*) FROM scans WHERE status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')) < 15
    THEN '✓ Acceptable (<15%)'
    ELSE '⚠ High retry rate (≥15%)'
  END AS "Gate"
WHERE (SELECT COUNT(*) FROM scans WHERE status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')) > 0;

.print ""

-- ==================================================================
-- 7. STAGING_READY VALIDATION (Oct 31 Launch Week)
-- ==================================================================
.print "═══ STAGING_READY AUTOMATION =══"
.print ""

-- Check staging_ready predicate enforcement
SELECT
  'Staging-ready products: ' ||
  (SELECT COUNT(*) FROM products WHERE staging_ready = 1) || ' total' AS "Status",
  CASE
    WHEN (SELECT COUNT(*) FROM products WHERE staging_ready = 1) > 0
    THEN '✓ At least one product ready for staging'
    ELSE '⚠ No products marked staging_ready yet'
  END AS "Gate";

-- Validate predicate: staging_ready=1 requires market_price and pricing_status='fresh'
SELECT
  'Predicate enforcement: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM products
          WHERE staging_ready = 1
            AND (market_price IS NULL OR pricing_status != 'fresh')) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (SELECT COUNT(*) FROM products
          WHERE staging_ready = 1
            AND (market_price IS NULL OR pricing_status != 'fresh')) || ' invalid promotions'
  END AS "Status";

-- UNMATCHED GUARD: Verify no UNKNOWN_* products are staging_ready
SELECT
  'Unmatched guard: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM products
          WHERE staging_ready = 1
            AND cm_card_id LIKE 'UNKNOWN_%') = 0
    THEN '✓ PASS - No unmatched products staged'
    ELSE '✗ FAIL - ' || (SELECT COUNT(*) FROM products
          WHERE staging_ready = 1
            AND cm_card_id LIKE 'UNKNOWN_%') || ' unmatched products incorrectly staged'
  END AS "Status";

-- Check for products that SHOULD be staging_ready but aren't (excluding unmatched)
SELECT
  'Missed promotions: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM products
          WHERE staging_ready = 0
            AND market_price IS NOT NULL
            AND market_price > 0
            AND pricing_status = 'fresh'
            AND cm_card_id NOT LIKE 'UNKNOWN_%') = 0
    THEN '✓ PASS - All eligible products promoted'
    ELSE '⚠ ' || (SELECT COUNT(*) FROM products
          WHERE staging_ready = 0
            AND market_price IS NOT NULL
            AND market_price > 0
            AND pricing_status = 'fresh'
            AND cm_card_id NOT LIKE 'UNKNOWN_%') || ' products eligible but not promoted'
  END AS "Status";

.print ""
.print "Staging-ready breakdown by pricing source:"
SELECT
  COALESCE(pricing_source, 'null') AS "Pricing Source",
  COUNT(*) AS "Count",
  SUM(CASE WHEN staging_ready = 1 THEN 1 ELSE 0 END) AS "Staging Ready",
  printf('%.1f%%',
    100.0 * SUM(CASE WHEN staging_ready = 1 THEN 1 ELSE 0 END) / COUNT(*)
  ) AS "Ready %"
FROM products
GROUP BY pricing_source;

.print ""
.print "═══ MANUAL OVERRIDES POLICY =══"
.print ""

-- Count products with manual overrides present (reason code set)
SELECT
  'Manual overrides present: ' ||
  (SELECT COUNT(*) FROM products WHERE manual_reason_code IS NOT NULL) || ' total' AS "Status";

-- Validate reason code enum compliance (six-code enum)
SELECT
  'Reason code enum: ' ||
  CASE
    WHEN (
      SELECT COUNT(*) FROM products
      WHERE manual_reason_code IS NOT NULL
        AND manual_reason_code NOT IN (
          'PPT_OUTAGE_OR_RATE_LIMIT',
          'PPT_NO_MATCH_OR_INCOMPLETE_DATA',
          'VARIANT_MISMATCH_OR_EDGE_CASE',
          'CONDITION_DRIVEN_ADJUSTMENT',
          'MARKET_ANOMALY_OR_SUDDEN_SWING',
          'OTHER'
        )
    ) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (
      SELECT COUNT(*) FROM products
      WHERE manual_reason_code IS NOT NULL
        AND manual_reason_code NOT IN (
          'PPT_OUTAGE_OR_RATE_LIMIT',
          'PPT_NO_MATCH_OR_INCOMPLETE_DATA',
          'VARIANT_MISMATCH_OR_EDGE_CASE',
          'CONDITION_DRIVEN_ADJUSTMENT',
          'MARKET_ANOMALY_OR_SUDDEN_SWING',
          'OTHER'
        )
    ) || ' invalid reason codes'
  END AS "Status";

-- Validate note length: ≥15 chars required when reason code is set
SELECT
  'Override note length: ' ||
  CASE
    WHEN (
      SELECT COUNT(*) FROM products
      WHERE manual_reason_code IS NOT NULL
        AND (manual_note IS NULL OR LENGTH(TRIM(manual_note)) < 15)
    ) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (
      SELECT COUNT(*) FROM products
      WHERE manual_reason_code IS NOT NULL
        AND (manual_note IS NULL OR LENGTH(TRIM(manual_note)) < 15)
    ) || ' notes < 15 chars'
  END AS "Status";

-- Gating: accepted_without_canonical must never be promoted to staging_ready
SELECT
  'Accepted-without-canonical guard: ' ||
  CASE
    WHEN (
      SELECT COUNT(*) FROM products
      WHERE accepted_without_canonical = 1 AND staging_ready = 1
    ) = 0
    THEN '✓ PASS - None staged'
    ELSE '✗ FAIL - ' || (
      SELECT COUNT(*) FROM products
      WHERE accepted_without_canonical = 1 AND staging_ready = 1
    ) || ' incorrectly staged'
  END AS "Status";

.print ""
.print "Manual overrides (sample):"
SELECT
  product_sku AS "Product SKU",
  manual_reason_code AS "Reason",
  LENGTH(TRIM(COALESCE(manual_note, ''))) AS "Note Length",
  accepted_without_canonical AS "Accepted w/o Canonical",
  staging_ready AS "Staged"
FROM products
WHERE manual_reason_code IS NOT NULL
ORDER BY updated_at DESC
LIMIT 10;

.print ""
.print "═══ MANUAL OVERRIDE SUMMARY (Session Approx) =══"
-- Summary based on recent 72-ish flow context — use recent scans as a proxy
WITH recent_session_scans AS (
  SELECT s.*
  FROM scans s
  WHERE s.status IN ('OPERATOR_PENDING','ACCEPTED','FLAGGED')
  ORDER BY s.created_at DESC
  LIMIT 72
)
SELECT
  'accepted=' || (
    SELECT COUNT(*) FROM recent_session_scans WHERE status = 'ACCEPTED'
  ) || ', overrides=' || (
    SELECT COUNT(*)
    FROM recent_session_scans s
    LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
    WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
  ) || ', ratio=' || (
    CASE
      WHEN (
        SELECT COUNT(*) FROM recent_session_scans WHERE status = 'ACCEPTED'
      ) = 0 THEN '0.0%'
      ELSE printf('%.1f%%', 100.0 * (
        SELECT COUNT(*)
        FROM recent_session_scans s
        LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
        WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
      ) / (
        SELECT COUNT(*) FROM recent_session_scans WHERE status = 'ACCEPTED'
      ))
    END
  ) AS "Summary";

SELECT
  CASE
    WHEN (
      SELECT COUNT(*)
      FROM (
        SELECT s.*
        FROM scans s
        WHERE s.status IN ('OPERATOR_PENDING','ACCEPTED','FLAGGED')
        ORDER BY s.created_at DESC
        LIMIT 72
      ) s
      LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
      WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
    ) = 0
    THEN 'Override ratio gate: ✓ PASS (no overrides)'
    WHEN (
      (100.0 * (
        SELECT COUNT(*)
        FROM (
          SELECT s.*
          FROM scans s
          WHERE s.status IN ('OPERATOR_PENDING','ACCEPTED','FLAGGED')
          ORDER BY s.created_at DESC
          LIMIT 72
        ) s
        LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
        WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
      ) / NULLIF((
        SELECT COUNT(*) FROM (
          SELECT s.*
          FROM scans s
          WHERE s.status IN ('OPERATOR_PENDING','ACCEPTED','FLAGGED')
          ORDER BY s.created_at DESC
          LIMIT 72
        ) WHERE status = 'ACCEPTED'
      ), 0)) > 25.0
      OR (
        SELECT COUNT(*)
        FROM (
          SELECT s.*
          FROM scans s
          WHERE s.status IN ('OPERATOR_PENDING','ACCEPTED','FLAGGED')
          ORDER BY s.created_at DESC
          LIMIT 72
        ) s
        LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
        WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
      ) > 18
    )
    THEN 'Override ratio gate: ✗ FAIL (ratio>25% or >18 overrides)'
    ELSE 'Override ratio gate: ⚠ WARNING (within 25% threshold)'
  END AS "Gate";

.print "═══ MANUAL CANONICALIZATION QUEUE =══"
.print ""

-- Count products requiring manual canonicalization
SELECT
  'Unmatched products: ' ||
  (SELECT COUNT(*) FROM products WHERE cm_card_id LIKE 'UNKNOWN_%') || ' total' AS "Status",
  CASE
    WHEN (SELECT COUNT(*) FROM products WHERE cm_card_id LIKE 'UNKNOWN_%') = 0
    THEN '✓ All products canonically matched'
    ELSE '⚠ Manual canonicalization required'
  END AS "Gate";

-- Show unmatched product summary
.print ""
.print "Manual canonicalization queue (products needing operator review):"
SELECT
  product_sku AS "Product SKU",
  card_name AS "Card Name",
  COALESCE(pricing_source, 'none') AS "Pricing",
  staging_ready AS "Staged",
  cm_card_id AS "Fallback ID"
FROM products
WHERE cm_card_id LIKE 'UNKNOWN_%'
LIMIT 10;

.print ""

-- ==================================================================
-- 8. OVERALL SUMMARY
-- ==================================================================
.print "╔════════════════════════════════════════════════════════════════╗"
.print "║                      OVERALL GATE STATUS                      ║"
.print "╚════════════════════════════════════════════════════════════════╝"
.print ""
.print "Acceptance thresholds for 72-card baseline (legend):"
.print "  PASS: Schema health all green, extraction ≥80%, top-3 ≥75%, top-1 ≥60%"
.print "  YELLOW: Extraction 65-79%, top-3 60-74%, top-1 45-59% (acceptable for tuning)"
.print "  RED: Below yellow thresholds (requires investigation)"
.print ""
.print "Next steps:"
.print "  1. Review any red or yellow gates above"
.print "  2. Check mismatch details for patterns"
.print "  3. Run again after additional captures to compare improvements"
.print ""
