-- CardMint Extraction Acceptance Gate (20-Card Baseline)
-- Validates extraction accuracy and core health only (no products/PPT/staging gates).
--
-- Usage:
--   sqlite3 apps/backend/cardmint_dev.db < scripts/validate/acceptance_extraction.sql
--
-- Inputs (workspace root):
--   - baseline_expected.csv          (expected Name, HP, Collector No, Set Name)
--   - ground_truth_set_mapping.csv   (set-name synonym mapping)

.mode column
.headers on

-- Baseline presence notice
SELECT 'Baseline session id: ' || IFNULL((SELECT id FROM operator_sessions WHERE baseline = 1 ORDER BY created_at DESC LIMIT 1), 'NONE') AS "Info";
SELECT CASE
  WHEN (SELECT COUNT(*) FROM operator_sessions WHERE baseline = 1) = 0 THEN 'ERROR: No baseline session found. Run Fresh Baseline Scan Session and finalize before running acceptance.'
  ELSE 'Baseline present — accuracy gates active.'
END AS "Info";

-- Build baseline scan window (all scans from baseline session, chronological)
-- Note: Evaluates ALL accepted scans in baseline session to match generated baseline_expected.csv
DROP TABLE IF EXISTS baseline_scans;
CREATE TEMP TABLE baseline_scans AS
SELECT
  s.*,
  ROW_NUMBER() OVER (ORDER BY s.created_at) AS seq
FROM scans s
JOIN operator_sessions os ON s.session_id = os.id
WHERE os.baseline = 1
  AND s.status IN ('OPERATOR_PENDING', 'ACCEPTED', 'FLAGGED')
ORDER BY s.created_at ASC;

.print "╔════════════════════════════════════════════════════════════════╗"
.print "║        CARDMINT EXTRACTION GATE - BASELINE VALIDATION         ║"
.print "╚════════════════════════════════════════════════════════════════╝"
.print ""

-- ==================================================================
-- 1. SCHEMA HEALTH CHECKS
-- ==================================================================
.print "═══ SCHEMA HEALTH =══"
.print ""

SELECT
  'Required tables: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('scans', 'operator_sessions')) = 2
    THEN '✓ PASS'
    ELSE '✗ FAIL (missing scans or operator_sessions table)'
  END AS "Status";

SELECT
  'Path separation columns: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM pragma_table_info('scans') WHERE name IN ('raw_image_path', 'processed_image_path')) = 2
    THEN '✓ PASS'
    ELSE '✗ FAIL (missing raw_image_path or processed_image_path)'
  END AS "Status";

SELECT
  'No orphaned CAPTURING: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE status = 'CAPTURING') = 0
    THEN '✓ PASS'
    ELSE '⚠ WARNING - ' || (SELECT COUNT(*) FROM scans WHERE status = 'CAPTURING') || ' stuck jobs'
  END AS "Status";

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

SELECT
  'Raw paths populated: ' ||
  CASE
    WHEN (SELECT COUNT(*) FROM scans WHERE status != 'CAPTURING' AND (raw_image_path IS NULL OR raw_image_path = '')) = 0
    THEN '✓ PASS'
    ELSE '✗ FAIL - ' || (SELECT COUNT(*) FROM scans WHERE status != 'CAPTURING' AND raw_image_path IS NULL) || ' missing raw paths'
  END AS "Status";

.print ""

-- ==================================================================
-- 3. TRUTH CORE ACCURACY (Extraction)
-- ==================================================================
.print "═══ TRUTH CORE ACCURACY (MVP) =══"
.print ""

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

DROP TABLE IF EXISTS expected_can;
CREATE TEMP TABLE expected_can AS
WITH cleaned AS (
  SELECT 
    TRIM(REPLACE(REPLACE(REPLACE(REPLACE(
      LOWER(name),
      '(reverse holo)', ''),
      '(holo)', ''),
      '(full art)', ''),
      '(first edition)', ''
    )) AS name,
    collector_no,
    TRIM(REPLACE(REPLACE(REPLACE(
      LOWER(set_name),
      '(reverse holo)', ''), '(holo)', ''), '(full art)', '')) AS set_name
  FROM expected_norm
), canon AS (
  SELECT
    name,
    collector_no,
    COALESCE((SELECT canonical FROM set_map sm WHERE sm.canonical=set_name OR sm.synonyms LIKE '%'||set_name||'%' LIMIT 1), set_name) AS set_name
  FROM cleaned
)
SELECT
  name,
  collector_no,
  CASE WHEN set_name = 'base set [shadowless]' THEN 'base set' ELSE set_name END AS set_name
FROM canon;

DROP TABLE IF EXISTS accepted_can;
CREATE TEMP TABLE accepted_can AS
WITH cleaned AS (
  SELECT
    TRIM(REPLACE(REPLACE(REPLACE(REPLACE(
      LOWER(accepted_name),
      '(reverse holo)', ''),
      '(holo)', ''),
      '(full art)', ''),
      '(first edition)', ''
    )) AS name,
    LOWER(TRIM(accepted_collector_no)) AS raw_no,
    TRIM(REPLACE(REPLACE(REPLACE(
      LOWER(accepted_set_name),
      '(reverse holo)', ''), '(holo)', ''), '(full art)', '')) AS raw_set
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
-- 4. TIMING SANITY
-- ==================================================================
.print "═══ TIMING SANITY =══"
.print ""

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
-- 5. PATH A RETRY METRICS (Baseline only)
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
.print "╔════════════════════════════════════════════════════════════════╗"
.print "║                        EXTRACTION STATUS                       ║"
.print "╚════════════════════════════════════════════════════════════════╝"
.print ""
.print "Acceptance thresholds (recommended ≥20 cards):"
.print "  PASS: Schema health all green, Truth triplet ≥80%"
.print "  YELLOW: Truth triplet 65-79% (acceptable for tuning)"
.print "  RED: Below yellow thresholds (requires investigation)"
.print ""
.print "Next steps:"
.print "  1. Review any RED/YELLOW gates above"
.print "  2. Check mismatch details for patterns"
.print "  3. Re-run after remediation to confirm improvements"
.print ""
