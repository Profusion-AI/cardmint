-- Seed 5 test products for PPT adapter validation
-- Date: 2025-10-28
-- Purpose: Create minimal product records to test pricing backfill

-- First, ensure we have cm_sets and cm_cards entries
INSERT OR IGNORE INTO cm_sets (cm_set_id, set_name, release_date, total_cards, created_at, updated_at)
VALUES
  ('BASE', 'Base Set', '1999-01-09', 102, strftime('%s', 'now'), strftime('%s', 'now')),
  ('VV', 'Vivid Voltage', '2020-11-13', 203, strftime('%s', 'now'), strftime('%s', 'now')),
  ('ES', 'Evolving Skies', '2021-08-27', 237, strftime('%s', 'now'), strftime('%s', 'now'));

-- Create test cm_cards
INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, hp_value, card_type,
  rarity, variant_bits, lang, created_at, updated_at
)
VALUES
  ('BASE-025-base', 'BASE', '25', 'Pikachu', 40, 'Pokemon', 'Common', 'base', 'EN', strftime('%s', 'now'), strftime('%s', 'now')),
  ('BASE-004-holo', 'BASE', '4', 'Charizard', 120, 'Pokemon', 'Rare Holo', 'holo', 'EN', strftime('%s', 'now'), strftime('%s', 'now')),
  ('VV-047-base', 'VV', '47', 'Jolteon', 90, 'Pokemon', 'Rare', 'base', 'EN', strftime('%s', 'now'), strftime('%s', 'now')),
  ('ES-057-base', 'ES', '57', 'Emolga', 70, 'Pokemon', 'Common', 'base', 'EN', strftime('%s', 'now'), strftime('%s', 'now')),
  ('BASE-063-holo', 'BASE', '63', 'Wigglytuff', 80, 'Pokemon', 'Rare Holo', 'holo', 'EN', strftime('%s', 'now'), strftime('%s', 'now'));

-- Create test products (5 cards for dry-run)
INSERT OR IGNORE INTO products (
  product_uid, cm_card_id, condition_bucket, product_sku, listing_sku,
  card_name, set_name, collector_no, hp_value, rarity,
  market_price, launch_price, pricing_channel, total_quantity,
  pricing_source, pricing_status, pricing_updated_at,
  staging_ready, created_at, updated_at
)
VALUES
  (
    'test-prod-001',
    'BASE-025-base',
    'NM',
    'PKM:BASE:025:base:EN',
    'PKM:BASE:025:base:EN:NM',
    'Pikachu',
    'Base Set',
    '25',
    40,
    'Common',
    NULL,  -- No pricing yet
    NULL,
    NULL,
    0,
    NULL,
    'missing',
    NULL,
    0,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  (
    'test-prod-002',
    'BASE-004-holo',
    'NM',
    'PKM:BASE:004:holo:EN',
    'PKM:BASE:004:holo:EN:NM',
    'Charizard',
    'Base Set',
    '4',
    120,
    'Rare Holo',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    'missing',
    NULL,
    0,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  (
    'test-prod-003',
    'VV-047-base',
    'LP',
    'PKM:VV:047:base:EN',
    'PKM:VV:047:base:EN:LP',
    'Jolteon',
    'Vivid Voltage',
    '47',
    90,
    'Rare',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    'missing',
    NULL,
    0,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  (
    'test-prod-004',
    'ES-057-base',
    'NM',
    'PKM:ES:057:base:EN',
    'PKM:ES:057:base:EN:NM',
    'Emolga',
    'Evolving Skies',
    '57',
    70,
    'Common',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    'missing',
    NULL,
    0,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  ),
  (
    'test-prod-005',
    'BASE-063-holo',
    'MP',
    'PKM:BASE:063:holo:EN',
    'PKM:BASE:063:holo:EN:MP',
    'Wigglytuff',
    'Base Set',
    '63',
    80,
    'Rare Holo',
    NULL,
    NULL,
    NULL,
    0,
    NULL,
    'missing',
    NULL,
    0,
    strftime('%s', 'now'),
    strftime('%s', 'now')
  );

-- Verify seeding
SELECT
  'Test products seeded:' AS message,
  COUNT(*) AS count
FROM products
WHERE product_uid LIKE 'test-prod-%';

SELECT
  product_sku,
  listing_sku,
  card_name,
  condition_bucket,
  hp_value,
  pricing_status
FROM products
WHERE product_uid LIKE 'test-prod-%';
