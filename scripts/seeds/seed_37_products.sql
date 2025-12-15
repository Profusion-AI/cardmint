-- 37-Card Backfill Pilot Seed (with FK dependencies)
-- Generated: 2025-10-30
-- Source: 20-card CSV (NM) + 17 additional (4 LP, 4 MP, 3 HP, 2 DMG, 4 NM)

-- DEPENDENCY ORDER:
-- 1. cm_sets (parent)
-- 2. cm_cards (depends on cm_sets)
-- 3. products (depends on cm_cards)

-- ==========================
-- STEP 1: cm_sets
-- ==========================

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'BS',
  'Battle Styles',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'CEL',
  'Celebrations',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'CZ',
  'Crown Zenith',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'ES',
  'Evolving Skies',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'FST',
  'Fusion Strike',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'OBF',
  'Obsidian Flames',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'PAL',
  'Paldea Evolved',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'SIT',
  'Silver Tempest',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_sets (
  cm_set_id, set_name, created_at, updated_at
) VALUES (
  'VV',
  'Vivid Voltage',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- ==========================
-- STEP 2: cm_cards
-- ==========================

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-111-base',
  'BS',
  '111',
  'Spearow',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-129-base',
  'BS',
  '129',
  'Level Ball',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-141-base',
  'BS',
  '141',
  'Single Strike Energy',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-17-base',
  'BS',
  '17',
  'Blipbug',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-45-base',
  'BS',
  '45',
  'Electivire',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-69-base',
  'BS',
  '69',
  'Cubone',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'BS-89-base',
  'BS',
  '89',
  'Zubat',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'CEL-5-base',
  'CEL',
  '5',
  'Pikachu',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'ES-32-base',
  'ES',
  '32',
  'Lotad',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'ES-54-base',
  'ES',
  '54',
  'Mareep',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'ES-57-base',
  'ES',
  '57',
  'Emolga',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'ES-68-base',
  'ES',
  '68',
  'Woobat',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-122-base',
  'VV',
  '122',
  'Excadrill',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-133-base',
  'VV',
  '133',
  'Taillow',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-157-base',
  'VV',
  '157',
  'Nessa',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-28-base',
  'VV',
  '28',
  'Magcargo',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-47-base',
  'VV',
  '47',
  'Jolteon',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-6-base',
  'VV',
  '6',
  'Yanma',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-74-base',
  'VV',
  '74',
  'Swoobat',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'VV-94-base',
  'VV',
  '94',
  'Rockruff',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'CZ-76-base',
  'CZ',
  '76',
  'Absol',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'CZ-GG16-base',
  'CZ',
  'GG16',
  'Absol',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'CZ-GG57-base',
  'CZ',
  'GG57',
  'Adaman',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'CZ-89-base',
  'CZ',
  '89',
  'Aggron',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'FST-164-base',
  'FST',
  '164',
  'Absol',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'FST-14-base',
  'FST',
  '14',
  'Accelgor',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'FST-224-base',
  'FST',
  '224',
  'Adventurer''s Discovery',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'FST-26-base',
  'FST',
  '26',
  'Appletun V',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'PAL-11-base',
  'PAL',
  '11',
  'Abomasnow',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'PAL-242-base',
  'PAL',
  '242',
  'Annihilape ex',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'PAL-209-base',
  'PAL',
  '209',
  'Arctibax',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'PAL-59-base',
  'PAL',
  '59',
  'Arctibax',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'SIT-173-base',
  'SIT',
  '173',
  'Alolan Vulpix V',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'SIT-33-base',
  'SIT',
  '33',
  'Alolan Vulpix V',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'SIT-143-base',
  'SIT',
  '143',
  'Altaria',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'OBF-135-base',
  'OBF',
  '135',
  'Absol ex',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR IGNORE INTO cm_cards (
  cm_card_id, cm_set_id, collector_no, card_name, lang, created_at, updated_at
) VALUES (
  'OBF-214-base',
  'OBF',
  '214',
  'Absol ex',
  'EN',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- ==========================
-- STEP 3: products
-- ==========================

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673291',
  'PKM:BS:111:base:EN',
  'PKM:BS:111:base:EN:NM',
  'BS-111-base',
  'Spearow',
  'Battle Styles',
  '111',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673309',
  'PKM:BS:129:base:EN',
  'PKM:BS:129:base:EN:NM',
  'BS-129-base',
  'Level Ball',
  'Battle Styles',
  '129',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673321',
  'PKM:BS:141:base:EN',
  'PKM:BS:141:base:EN:NM',
  'BS-141-base',
  'Single Strike Energy',
  'Battle Styles',
  '141',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673198',
  'PKM:BS:17:base:EN',
  'PKM:BS:17:base:EN:NM',
  'BS-17-base',
  'Blipbug',
  'Battle Styles',
  '17',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673226',
  'PKM:BS:45:base:EN',
  'PKM:BS:45:base:EN:NM',
  'BS-45-base',
  'Electivire',
  'Battle Styles',
  '45',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673249',
  'PKM:BS:69:base:EN',
  'PKM:BS:69:base:EN:NM',
  'BS-69-base',
  'Cubone',
  'Battle Styles',
  '69',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-1673269',
  'PKM:BS:89:base:EN',
  'PKM:BS:89:base:EN:NM',
  'BS-89-base',
  'Zubat',
  'Battle Styles',
  '89',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2618150',
  'PKM:CEL:5:base:EN',
  'PKM:CEL:5:base:EN:NM',
  'CEL-5-base',
  'Pikachu',
  'Celebrations',
  '5',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2512843',
  'PKM:ES:32:base:EN',
  'PKM:ES:32:base:EN:NM',
  'ES-32-base',
  'Lotad',
  'Evolving Skies',
  '32',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2512865',
  'PKM:ES:54:base:EN',
  'PKM:ES:54:base:EN:NM',
  'ES-54-base',
  'Mareep',
  'Evolving Skies',
  '54',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2512868',
  'PKM:ES:57:base:EN',
  'PKM:ES:57:base:EN:NM',
  'ES-57-base',
  'Emolga',
  'Evolving Skies',
  '57',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2512879',
  'PKM:ES:68:base:EN',
  'PKM:ES:68:base:EN:NM',
  'ES-68-base',
  'Woobat',
  'Evolving Skies',
  '68',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887668',
  'PKM:VV:122:base:EN',
  'PKM:VV:122:base:EN:NM',
  'VV-122-base',
  'Excadrill',
  'Vivid Voltage',
  '122',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887676',
  'PKM:VV:133:base:EN',
  'PKM:VV:133:base:EN:NM',
  'VV-133-base',
  'Taillow',
  'Vivid Voltage',
  '133',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-842151',
  'PKM:VV:157:base:EN',
  'PKM:VV:157:base:EN:NM',
  'VV-157-base',
  'Nessa',
  'Vivid Voltage',
  '157',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887584',
  'PKM:VV:28:base:EN',
  'PKM:VV:28:base:EN:NM',
  'VV-28-base',
  'Magcargo',
  'Vivid Voltage',
  '28',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887600',
  'PKM:VV:47:base:EN',
  'PKM:VV:47:base:EN:NM',
  'VV-47-base',
  'Jolteon',
  'Vivid Voltage',
  '47',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887562',
  'PKM:VV:6:base:EN',
  'PKM:VV:6:base:EN:NM',
  'VV-6-base',
  'Yanma',
  'Vivid Voltage',
  '6',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887625',
  'PKM:VV:74:base:EN',
  'PKM:VV:74:base:EN:NM',
  'VV-74-base',
  'Swoobat',
  'Vivid Voltage',
  '74',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-887644',
  'PKM:VV:94:base:EN',
  'PKM:VV:94:base:EN:NM',
  'VV-94-base',
  'Rockruff',
  'Vivid Voltage',
  '94',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4636972',
  'PKM:CZ:76:base:EN',
  'PKM:CZ:76:base:EN:NM',
  'CZ-76-base',
  'Absol',
  'Crown Zenith',
  '76',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4637072',
  'PKM:CZ:GG16:base:EN',
  'PKM:CZ:GG16:base:EN:NM',
  'CZ-GG16-base',
  'Absol',
  'Crown Zenith',
  'GG16',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4637113',
  'PKM:CZ:GG57:base:EN',
  'PKM:CZ:GG57:base:EN:NM',
  'CZ-GG57-base',
  'Adaman',
  'Crown Zenith',
  'GG57',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4636985',
  'PKM:CZ:89:base:EN',
  'PKM:CZ:89:base:EN:NM',
  'CZ-89-base',
  'Aggron',
  'Crown Zenith',
  '89',
  'NM',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2771193',
  'PKM:FST:164:base:EN',
  'PKM:FST:164:base:EN:LP',
  'FST-164-base',
  'Absol',
  'Fusion Strike',
  '164',
  'LP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2771043',
  'PKM:FST:14:base:EN',
  'PKM:FST:14:base:EN:LP',
  'FST-14-base',
  'Accelgor',
  'Fusion Strike',
  '14',
  'LP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2771250',
  'PKM:FST:224:base:EN',
  'PKM:FST:224:base:EN:LP',
  'FST-224-base',
  'Adventurer''s Discovery',
  'Fusion Strike',
  '224',
  'LP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-2771055',
  'PKM:FST:26:base:EN',
  'PKM:FST:26:base:EN:LP',
  'FST-26-base',
  'Appletun V',
  'Fusion Strike',
  '26',
  'LP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5287300',
  'PKM:PAL:11:base:EN',
  'PKM:PAL:11:base:EN:MP',
  'PAL-11-base',
  'Abomasnow',
  'Paldea Evolved',
  '11',
  'MP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5287531',
  'PKM:PAL:242:base:EN',
  'PKM:PAL:242:base:EN:MP',
  'PAL-242-base',
  'Annihilape ex',
  'Paldea Evolved',
  '242',
  'MP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5287498',
  'PKM:PAL:209:base:EN',
  'PKM:PAL:209:base:EN:MP',
  'PAL-209-base',
  'Arctibax',
  'Paldea Evolved',
  '209',
  'MP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5287348',
  'PKM:PAL:59:base:EN',
  'PKM:PAL:59:base:EN:MP',
  'PAL-59-base',
  'Arctibax',
  'Paldea Evolved',
  '59',
  'MP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4277294',
  'PKM:SIT:173:base:EN',
  'PKM:SIT:173:base:EN:HP',
  'SIT-173-base',
  'Alolan Vulpix V',
  'Silver Tempest',
  '173',
  'HP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4277152',
  'PKM:SIT:33:base:EN',
  'PKM:SIT:33:base:EN:HP',
  'SIT-33-base',
  'Alolan Vulpix V',
  'Silver Tempest',
  '33',
  'HP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-4277264',
  'PKM:SIT:143:base:EN',
  'PKM:SIT:143:base:EN:HP',
  'SIT-143-base',
  'Altaria',
  'Silver Tempest',
  '143',
  'HP',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5605653',
  'PKM:OBF:135:base:EN',
  'PKM:OBF:135:base:EN:DMG',
  'OBF-135-base',
  'Absol ex',
  'Obsidian Flames',
  '135',
  'DMG',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT OR REPLACE INTO products (
  product_uid, product_sku, listing_sku, cm_card_id,
  card_name, set_name, collector_no, condition_bucket,
  pricing_status, pricing_source, pricing_updated_at,
  market_price, launch_price, pricing_channel, total_quantity, staging_ready,
  created_at, updated_at
) VALUES (
  'ppt-5605732',
  'PKM:OBF:214:base:EN',
  'PKM:OBF:214:base:EN:DMG',
  'OBF-214-base',
  'Absol ex',
  'Obsidian Flames',
  '214',
  'DMG',
  'missing',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- ==========================
-- VERIFICATION
-- ==========================

SELECT '37-card pilot seeded' AS message, COUNT(*) AS count
FROM products WHERE product_uid LIKE 'ppt-%';

SELECT condition_bucket, COUNT(*) AS count
FROM products WHERE product_uid LIKE 'ppt-%'
GROUP BY condition_bucket ORDER BY condition_bucket;
