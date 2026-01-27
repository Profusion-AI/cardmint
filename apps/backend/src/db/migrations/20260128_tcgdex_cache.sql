-- TCGDex card data cache (split identity vs pricing TTL)
--
-- Identity data (card name, image URL, HP, rarity) cached for 7 days.
-- Price data cached for 24 hours (separate timestamp).

CREATE TABLE IF NOT EXISTS tcgdex_cache (
  cache_key TEXT PRIMARY KEY,           -- "tcgdex:{setId}:{cardNumber}"
  tcgdex_card_id TEXT NOT NULL,         -- e.g., "base5-45"
  name TEXT NOT NULL,
  image_url TEXT,
  hp INTEGER,
  rarity TEXT,
  set_id TEXT,
  set_name TEXT,
  -- Pricing (separate TTL)
  market_price_cents INTEGER,           -- From tcgplayer.prices.unlimited.market
  price_label TEXT,                     -- e.g., "TCGPlayer unlimited market"
  price_cached_at INTEGER,              -- Separate timestamp for pricing
  -- Identity caching
  cached_at INTEGER NOT NULL,
  ttl_hours INTEGER DEFAULT 168         -- 7 days for identity
);

CREATE INDEX IF NOT EXISTS idx_tcgdex_cache_cached_at ON tcgdex_cache(cached_at);
CREATE INDEX IF NOT EXISTS idx_tcgdex_cache_price_cached_at ON tcgdex_cache(price_cached_at);
