-- Gate 00: DB Identity Check
-- Verifies we're running against the correct CardMint operational database
-- Fails fast if pointed at canonical.db or other non-operational DBs

-- Check for required CardMint tables
SELECT CASE
  WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='items') = 0
  THEN 'FAIL: items table not found'
  WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='products') = 0
  THEN 'FAIL: products table not found'
  WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='stripe_webhook_events') = 0
  THEN 'FAIL: stripe_webhook_events table not found - not an operational CardMint DB'
  WHEN (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='fulfillment') = 0
  THEN 'FAIL: fulfillment table not found - run migration 20251218_fulfillment_table.sql'
  ELSE 'PASS: CardMint operational database verified'
END as gate_00_result;

-- Check for Stripe columns on items table (confirms operational vs canonical)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM pragma_table_info('items') WHERE name='checkout_session_id') = 0
  THEN 'FAIL: items.checkout_session_id column missing - not an operational DB'
  ELSE 'PASS: Stripe columns present on items table'
END as stripe_columns_check;
