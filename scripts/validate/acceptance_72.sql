-- CardMint Acceptance Gate (Baseline, 72-Card Window)
-- Validates extraction, retrieval, and schema health against operator-verified baseline
--
-- Usage: sqlite3 apps/backend/data/cardmint.db < scripts/validate/acceptance_72.sql
--
-- Ground truth source: Finalized Baseline Session in database (no CSV)

.mode column
.headers on

-- Baseline presence notice
SELECT 'Baseline session id: ' || IFNULL((SELECT id FROM operator_sessions WHERE baseline = 1 ORDER BY created_at DESC LIMIT 1), 'NONE') AS "Info";
SELECT CASE
  WHEN (SELECT COUNT(*) FROM operator_sessions WHERE baseline = 1) = 0 THEN 'ERROR: No baseline session found. Run Fresh Baseline Scan Session and finalize before running acceptance.'
  ELSE 'Baseline present — accuracy gates active.'
END AS "Info";

CREATE TEMP TABLE baseline_scans AS
SELECT
  s.*,
  ROW_NUMBER() OVER (ORDER BY s.created_at) AS seq
FROM (
  SELECT s.*
  FROM scans s
  JOIN operator_sessions os ON s.session_id = os.id
  WHERE os.baseline = 1
  ORDER BY s.created_at DESC
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
.print "═══ TRUTH CORE ACCURACY (MVP) =══"
.print ""

-- Import expected baseline CSV (workspace-root baseline_expected.csv)
DROP TABLE IF EXISTS baseline_expected_raw;
CREATE TEMP TABLE baseline_expected_raw (
  sequence_index TEXT,
  expected_name TEXT,
  expected_hp TEXT,
  expected_collector_no TEXT,
  expected_set_name TEXT,
  notes TEXT
);
.mode csv
.import baseline_expected.csv baseline_expected_raw
.mode column

DROP TABLE IF EXISTS expected_norm;
CREATE TEMP TABLE expected_norm AS
WITH cleaned AS (
  SELECT
    LOWER(TRIM(expected_name)) AS name,
    LOWER(TRIM(expected_collector_no)) AS raw_no,
    LOWER(TRIM(expected_set_name)) AS set_name
  FROM baseline_expected_raw
  WHERE sequence_index != 'sequence_index'
), numerators AS (
  SELECT
    name,
    CASE WHEN INSTR(raw_no,'/') > 0 THEN SUBSTR(raw_no,1,INSTR(raw_no,'/')-1) ELSE raw_no END AS num_only,
    set_name
  FROM cleaned
)
SELECT
  name,
  CASE WHEN num_only GLOB '[0-9]*' THEN LTRIM(num_only,'0') ELSE num_only END AS collector_no,
  set_name
FROM numerators;

-- Import set-name mapping (ground_truth_set_mapping.csv) to canonicalize synonyms
DROP TABLE IF EXISTS set_map_raw;
CREATE TEMP TABLE set_map_raw (
  canonical_set_name TEXT,
  synonyms TEXT,
  release_year TEXT,
  us_release_seq TEXT,
  set_size TEXT,
  set_size_incl_secrets TEXT,
  era TEXT
);
.mode csv
.import ground_truth_set_mapping.csv set_map_raw
.mode column

DROP TABLE IF EXISTS set_map;
CREATE TEMP TABLE set_map AS
SELECT LOWER(TRIM(canonical_set_name)) AS canonical,
       LOWER(TRIM(synonyms)) AS synonyms
FROM set_map_raw
WHERE canonical_set_name != 'canonical_set_name';

-- Canonicalize expected set names via mapping, also strip common variant hints
DROP TABLE IF EXISTS expected_can;
CREATE TEMP TABLE expected_can AS
WITH cleaned AS (
  SELECT 
    LOWER(TRIM(REPLACE(REPLACE(REPLACE(REPLACE(
      name,
      '(reverse holo)', ''),
      '(holo)', ''),
      '(full art)', ''),
      '(first edition)', ''
    ))) AS name,
    collector_no,
    LOWER(TRIM(REPLACE(REPLACE(REPLACE(set_name,
      '(reverse holo)', ''), '(holo)', ''), '(full art)', ''))) AS set_name
  FROM expected_norm
)
SELECT name,
       collector_no,
       CASE
         WHEN COALESCE((SELECT canonical FROM set_map sm WHERE sm.canonical=set_name OR sm.synonyms LIKE '%'||set_name||'%' LIMIT 1), set_name) = 'base set [shadowless]'
         THEN 'base set'
         ELSE COALESCE((SELECT canonical FROM set_map sm WHERE sm.canonical=set_name OR sm.synonyms LIKE '%'||set_name||'%' LIMIT 1), set_name)
       END AS set_name
FROM cleaned;

-- Build accepted truth for the 72-scan window; only consider ACCEPTED rows
DROP TABLE IF EXISTS accepted_can;
CREATE TEMP TABLE accepted_can AS
WITH cleaned AS (
  SELECT
    LOWER(TRIM(accepted_name)) AS name,
    LOWER(TRIM(accepted_collector_no)) AS raw_no,
    LOWER(TRIM(accepted_set_name)) AS raw_set
  FROM baseline_scans
  WHERE status='ACCEPTED'
), numerators AS (
  SELECT
    name,
    CASE WHEN INSTR(raw_no,'/') > 0 THEN SUBSTR(raw_no,1,INSTR(raw_no,'/')-1) ELSE raw_no END AS num_only,
    raw_set
  FROM cleaned
)
SELECT
  name,
  CASE WHEN num_only GLOB '[0-9]*' THEN LTRIM(num_only,'0') ELSE num_only END AS collector_no,
  CASE
    WHEN COALESCE((SELECT canonical FROM set_map sm WHERE sm.canonical=raw_set OR sm.synonyms LIKE '%'||raw_set||'%' LIMIT 1), raw_set) = 'base set [shadowless]'
    THEN 'base set'
    ELSE COALESCE((SELECT canonical FROM set_map sm WHERE sm.canonical=raw_set OR sm.synonyms LIKE '%'||raw_set||'%' LIMIT 1), raw_set)
  END AS set_name
FROM numerators;

-- Compute accuracy as fraction of accepted rows that find a matching expected triplet
DROP TABLE IF EXISTS triplet_matches;
CREATE TEMP TABLE triplet_matches AS
SELECT a.name, a.collector_no, a.set_name,
       CASE WHEN EXISTS(
         SELECT 1 FROM expected_can e
          WHERE e.name=a.name AND e.collector_no=a.collector_no AND e.set_name=a.set_name
       ) THEN 1 ELSE 0 END AS triplet_match,
       CASE WHEN EXISTS(
         SELECT 1 FROM expected_can e
          WHERE e.name=a.name AND e.collector_no=a.collector_no
       ) THEN 1 ELSE 0 END AS name_no_match,
       CASE WHEN EXISTS(
         SELECT 1 FROM expected_can e
          WHERE e.name=a.name
       ) THEN 1 ELSE 0 END AS name_match
FROM accepted_can a;

SELECT
  printf('Truth triplet accuracy: %d/%d (%.1f%%)',
    SUM(triplet_match),
    COUNT(*),
    CASE WHEN COUNT(*)=0 THEN 0.0 ELSE 100.0 * SUM(triplet_match) / COUNT(*) END
  ) AS "Status",
  CASE
    WHEN COUNT(*) = 0 THEN 'N/A'
    WHEN 100.0 * SUM(triplet_match) / COUNT(*) >= 80 THEN '✓ PASS'
    WHEN 100.0 * SUM(triplet_match) / COUNT(*) >= 65 THEN '⚠ YELLOW'
    ELSE '✗ RED'
  END AS "Gate"
FROM triplet_matches;

SELECT printf('Name+No accuracy: %d/%d (%.1f%%)', SUM(name_no_match), COUNT(*), CASE WHEN COUNT(*)=0 THEN 0.0 ELSE 100.0 * SUM(name_no_match)/COUNT(*) END) AS "Status" FROM triplet_matches;
SELECT printf('Name-only accuracy: %d/%d (%.1f%%)', SUM(name_match), COUNT(*), CASE WHEN COUNT(*)=0 THEN 0.0 ELSE 100.0 * SUM(name_match)/COUNT(*) END) AS "Status" FROM triplet_matches;

.print ""
.print "Mismatches (accepted ≠ expected; first 15)"
SELECT
  substr(a.name,1,24) AS accepted_name,
  substr(a.collector_no,1,8) AS accepted_no,
  substr(a.set_name,1,24) AS accepted_set
FROM accepted_can a
LEFT JOIN expected_can e
  ON (e.name=a.name AND e.collector_no=a.collector_no AND e.set_name=a.set_name)
WHERE e.name IS NULL
LIMIT 15;

.print ""

-- ==================================================================
-- 4. RETRIEVAL ACCURACY (PriceCharting IDs)
-- ==================================================================
.print "═══ RETRIEVAL ACCURACY =══"
.print ""
SELECT 'Top-3 retrieval: N/A (MVP extraction-first)' AS "Status", 'N/A' AS "Gate";
SELECT 'Top-1 accuracy: N/A (MVP extraction-first)' AS "Status", 'N/A' AS "Gate";
.print "Retrieval disabled for MVP; no misses to report."

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
.print "═══ MANUAL OVERRIDE SUMMARY (Baseline Window) =══"
-- Summary based on baseline_scans window (last 72, chronological)
WITH recent_session_scans AS (
  SELECT * FROM baseline_scans
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
      FROM baseline_scans s
      LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
      WHERE s.status = 'ACCEPTED' AND p.manual_reason_code IS NOT NULL
    ) = 0
    THEN 'Override ratio gate: ✓ PASS (no overrides)'
    WHEN (
      (100.0 * (
        SELECT COUNT(*)
        FROM baseline_scans s
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
.print "Acceptance thresholds for 72-card baseline:"
.print "  PASS: Schema health all green, Truth triplet ≥80%"
.print "  YELLOW: Truth triplet 65-79% (acceptable for tuning)"
.print "  RED: Below yellow thresholds (requires investigation)"
.print ""
.print "Next steps:"
.print "  1. Review any RED/YELLOW gates above"
.print "  2. Check mismatch details for patterns"
.print "  3. Run again after additional captures to compare improvements"
.print ""
