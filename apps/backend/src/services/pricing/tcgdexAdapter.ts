/**
 * TCGDex API Adapter
 *
 * Free API for Pokemon card data with images and TCGPlayer market prices.
 * Used as fallback when PPT is unavailable or fails.
 *
 * API: https://api.tcgdex.net/v2/en
 * Docs: https://tcgdex.dev/
 */

import type * as Database from "better-sqlite3";
import type { Logger } from "pino";

const TCGDEX_API_BASE = "https://api.tcgdex.net/v2/en";

// Cache TTLs (in hours)
const IDENTITY_CACHE_TTL_HOURS = 168; // 7 days for card identity + image
const PRICE_CACHE_TTL_HOURS = 24; // 24 hours for market prices

/**
 * TCGPlayer pricing structure within TCGDex API response.
 * Note: TCGDex nests this under `pricing.tcgplayer`, NOT `tcgplayer.prices`.
 */
interface TCGPlayerPriceEntry {
  productId?: number;
  lowPrice?: number;
  midPrice?: number;
  highPrice?: number;
  marketPrice?: number;
}

/**
 * Full pricing object from TCGDex API.
 * Path: card.pricing (NOT card.tcgplayer.prices)
 */
interface TCGDexPricing {
  cardmarket?: {
    updated?: string;
    unit?: string;
    idProduct?: number;
    avg?: number;
    low?: number;
    trend?: number;
    "avg-holo"?: number;
    "low-holo"?: number;
    "trend-holo"?: number;
    avg1?: number;
    avg7?: number;
    avg30?: number;
  };
  tcgplayer?: {
    updated?: string;
    unit?: string;
    normal?: TCGPlayerPriceEntry;
    holofoil?: TCGPlayerPriceEntry;
    reverseHolofoil?: TCGPlayerPriceEntry;
    "1st-edition"?: TCGPlayerPriceEntry;
    unlimited?: TCGPlayerPriceEntry;
  };
}

export interface TCGDexCard {
  id: string; // e.g., "base5-45"
  localId: string; // Card number within set, e.g., "45"
  name: string;
  image?: string; // Base URL for images (append /high.webp, /low.webp, etc.)
  hp?: number;
  rarity?: string;
  category?: string;
  illustrator?: string;
  set?: {
    id: string;
    name: string;
    logo?: string;
    symbol?: string;
  };
  // TCGDex uses `pricing` at root level, NOT `tcgplayer.prices`
  pricing?: TCGDexPricing;
}

export interface TCGDexSet {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: {
    total?: number;
    official?: number;
  };
}

export interface TCGDexLookupResult {
  success: boolean;
  card: TCGDexCard | null;
  imageUrl: string | null;
  marketPriceCents: number | null;
  priceLabel: string | null;
  fromCache: boolean;
  error?: string;
}

interface CachedTCGDexEntry {
  cache_key: string;
  tcgdex_card_id: string;
  name: string;
  image_url: string | null;
  hp: number | null;
  rarity: string | null;
  set_id: string | null;
  set_name: string | null;
  market_price_cents: number | null;
  price_label: string | null;
  price_cached_at: number | null;
  cached_at: number;
  ttl_hours: number;
}

/**
 * Static mapping of common Pokemon TCG set names to TCGDex set IDs.
 * TCGDex uses lowercase hyphenated slugs.
 */
const SET_NAME_TO_TCGDEX_ID: Record<string, string> = {
  // Base Set era
  "base set": "base1",
  "base": "base1",
  jungle: "base2",
  fossil: "base3",
  "base set 2": "base4",
  "team rocket": "base5",
  "gym heroes": "gym1",
  "gym challenge": "gym2",

  // Neo era
  "neo genesis": "neo1",
  "neo discovery": "neo2",
  "neo revelation": "neo3",
  "neo destiny": "neo4",

  // e-Card era
  expedition: "ecard1",
  "expedition base set": "ecard1",
  aquapolis: "ecard2",
  skyridge: "ecard3",

  // EX era
  "ruby & sapphire": "ex1",
  sandstorm: "ex2",
  dragon: "ex3",
  "team magma vs team aqua": "ex4",
  "hidden legends": "ex5",
  "firered & leafgreen": "ex6",
  "team rocket returns": "ex7",
  deoxys: "ex8",
  emerald: "ex9",
  "unseen forces": "ex10",
  "delta species": "ex11",
  "legend maker": "ex12",
  "holon phantoms": "ex13",
  "crystal guardians": "ex14",
  "dragon frontiers": "ex15",
  "power keepers": "ex16",

  // Diamond & Pearl era
  "diamond & pearl": "dp1",
  "mysterious treasures": "dp2",
  "secret wonders": "dp3",
  "great encounters": "dp4",
  "majestic dawn": "dp5",
  "legends awakened": "dp6",
  stormfront: "dp7",

  // Platinum era
  platinum: "pl1",
  "rising rivals": "pl2",
  "supreme victors": "pl3",
  arceus: "pl4",

  // HeartGold SoulSilver era
  "heartgold & soulsilver": "hgss1",
  "hgss": "hgss1",
  unleashed: "hgss2",
  undaunted: "hgss3",
  triumphant: "hgss4",
  "call of legends": "col1",

  // Black & White era
  "black & white": "bw1",
  "emerging powers": "bw2",
  "noble victories": "bw3",
  "next destinies": "bw4",
  "dark explorers": "bw5",
  "dragons exalted": "bw6",
  "boundaries crossed": "bw7",
  "plasma storm": "bw8",
  "plasma freeze": "bw9",
  "plasma blast": "bw10",
  "legendary treasures": "bw11",

  // XY era
  xy: "xy1",
  flashfire: "xy2",
  "furious fists": "xy3",
  "phantom forces": "xy4",
  "primal clash": "xy5",
  "roaring skies": "xy6",
  "ancient origins": "xy7",
  breakthrough: "xy8",
  breakpoint: "xy9",
  fates: "xy10",
  "fates collide": "xy10",
  "steam siege": "xy11",
  evolutions: "xy12",

  // Sun & Moon era
  "sun & moon": "sm1",
  "guardians rising": "sm2",
  "burning shadows": "sm3",
  "shining legends": "sm3.5",
  "crimson invasion": "sm4",
  "ultra prism": "sm5",
  "forbidden light": "sm6",
  "celestial storm": "sm7",
  "dragon majesty": "sm7.5",
  "lost thunder": "sm8",
  "team up": "sm9",
  "unbroken bonds": "sm10",
  "unified minds": "sm11",
  "hidden fates": "sm11.5",
  "cosmic eclipse": "sm12",

  // Sword & Shield era
  "sword & shield": "swsh1",
  "rebel clash": "swsh2",
  "darkness ablaze": "swsh3",
  "champion's path": "swsh3.5",
  "vivid voltage": "swsh4",
  "shining fates": "swsh4.5",
  "battle styles": "swsh5",
  "chilling reign": "swsh6",
  "evolving skies": "swsh7",
  celebrations: "cel25",
  "fusion strike": "swsh8",
  "brilliant stars": "swsh9",
  "astral radiance": "swsh10",
  "pokemon go": "swsh10.5",
  "lost origin": "swsh11",
  "silver tempest": "swsh12",
  "crown zenith": "swsh12.5",

  // Scarlet & Violet era
  "scarlet & violet": "sv1",
  "paldea evolved": "sv2",
  "obsidian flames": "sv3",
  "151": "sv03.5",
  "paradox rift": "sv4",
  "paldean fates": "sv04.5",
  "temporal forces": "sv5",
  "twilight masquerade": "sv6",
  "shrouded fable": "sv06.5",
  "stellar crown": "sv7",
  "surging sparks": "sv8",
};

/**
 * Normalize set name for lookup in the mapping table.
 * Lowercases, removes extra whitespace, handles common variations.
 */
function normalizeSetName(setName: string): string {
  return setName
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export class TCGDexAdapter {
  private setsCache: Map<string, TCGDexSet> | null = null;
  private setsCacheLoadedAt: number = 0;
  private readonly SETS_CACHE_TTL_MS = 3600000; // 1 hour

  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
    private readonly fetchTimeoutMs: number = 5000
  ) {}

  /**
   * Generate cache key for TCGDex lookups.
   */
  private generateCacheKey(setId: string, cardNumber: string): string {
    return `tcgdex:${setId}:${cardNumber}`;
  }

  /**
   * Fetch from local cache.
   */
  private fetchFromCache(cacheKey: string): CachedTCGDexEntry | null {
    try {
      const cached = this.db
        .prepare(
          `SELECT * FROM tcgdex_cache WHERE cache_key = ?`
        )
        .get(cacheKey) as CachedTCGDexEntry | undefined;

      if (!cached) return null;

      const now = Math.floor(Date.now() / 1000);
      const identityExpired = now > cached.cached_at + cached.ttl_hours * 3600;

      if (identityExpired) {
        this.logger.debug({ cacheKey }, "TCGDex cache entry expired (identity)");
        return null;
      }

      return cached;
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to fetch from TCGDex cache");
      return null;
    }
  }

  /**
   * Check if cached price is still valid.
   */
  private isPriceFresh(cached: CachedTCGDexEntry): boolean {
    if (!cached.price_cached_at) return false;
    const now = Math.floor(Date.now() / 1000);
    return now < cached.price_cached_at + PRICE_CACHE_TTL_HOURS * 3600;
  }

  /**
   * Write to local cache.
   */
  private writeToCache(
    cacheKey: string,
    card: TCGDexCard,
    imageUrl: string | null,
    marketPriceCents: number | null,
    priceLabel: string | null
  ): void {
    const now = Math.floor(Date.now() / 1000);

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO tcgdex_cache
           (cache_key, tcgdex_card_id, name, image_url, hp, rarity, set_id, set_name,
            market_price_cents, price_label, price_cached_at, cached_at, ttl_hours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cacheKey,
          card.id,
          card.name,
          imageUrl,
          card.hp ?? null,
          card.rarity ?? null,
          card.set?.id ?? null,
          card.set?.name ?? null,
          marketPriceCents,
          priceLabel,
          marketPriceCents !== null ? now : null,
          now,
          IDENTITY_CACHE_TTL_HOURS
        );

      this.logger.debug({ cacheKey, cardId: card.id }, "Wrote to TCGDex cache");
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to write to TCGDex cache");
    }
  }

  /**
   * Update only the price portion of a cached entry.
   */
  private updateCachedPrice(
    cacheKey: string,
    marketPriceCents: number | null,
    priceLabel: string | null
  ): void {
    const now = Math.floor(Date.now() / 1000);

    try {
      this.db
        .prepare(
          `UPDATE tcgdex_cache
           SET market_price_cents = ?, price_label = ?, price_cached_at = ?
           WHERE cache_key = ?`
        )
        .run(marketPriceCents, priceLabel, marketPriceCents !== null ? now : null, cacheKey);

      this.logger.debug({ cacheKey, marketPriceCents }, "Updated TCGDex cache price");
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to update TCGDex cache price");
    }
  }

  /**
   * Resolve set name to TCGDex set ID.
   * Uses static mapping first, then falls back to API lookup with fuzzy matching.
   */
  async resolveSetId(setName: string): Promise<string | null> {
    const normalized = normalizeSetName(setName);

    // Try static mapping first
    const staticId = SET_NAME_TO_TCGDEX_ID[normalized];
    if (staticId) {
      return staticId;
    }

    // Try partial match in static mapping
    for (const [key, id] of Object.entries(SET_NAME_TO_TCGDEX_ID)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return id;
      }
    }

    // Fall back to fetching sets from API and fuzzy matching
    await this.loadSetsCache();

    if (this.setsCache) {
      // Exact match
      const exactMatch = this.setsCache.get(normalized);
      if (exactMatch) return exactMatch.id;

      // Fuzzy match by name
      for (const [, set] of this.setsCache) {
        const setNameNormalized = normalizeSetName(set.name);
        if (
          setNameNormalized.includes(normalized) ||
          normalized.includes(setNameNormalized)
        ) {
          return set.id;
        }
      }
    }

    this.logger.debug({ setName, normalized }, "Could not resolve TCGDex set ID");
    return null;
  }

  /**
   * Load all sets from TCGDex API (cached for 1 hour).
   */
  private async loadSetsCache(): Promise<void> {
    const now = Date.now();
    if (this.setsCache && now - this.setsCacheLoadedAt < this.SETS_CACHE_TTL_MS) {
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

      const response = await fetch(`${TCGDEX_API_BASE}/sets`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`TCGDex sets API returned ${response.status}`);
      }

      const sets = (await response.json()) as TCGDexSet[];
      this.setsCache = new Map();

      for (const set of sets) {
        // Index by normalized name
        this.setsCache.set(normalizeSetName(set.name), set);
        // Also index by ID for direct access
        this.setsCache.set(set.id, set);
      }

      this.setsCacheLoadedAt = now;
      this.logger.debug({ setCount: sets.length }, "Loaded TCGDex sets cache");
    } catch (error) {
      this.logger.error({ error }, "Failed to load TCGDex sets cache");
      // Don't throw - allow graceful degradation
    }
  }

  /**
   * Extract market price from TCGDex card's pricing.tcgplayer object.
   * Note: TCGDex uses `card.pricing.tcgplayer.*` NOT `card.tcgplayer.prices.*`
   * Prefers: unlimited > normal > holofoil > reverseHolofoil > 1st-edition
   * Returns price in cents.
   */
  private extractMarketPrice(
    card: TCGDexCard
  ): { priceCents: number | null; priceLabel: string | null } {
    const tcgplayerPricing = card.pricing?.tcgplayer;
    if (!tcgplayerPricing) {
      return { priceCents: null, priceLabel: null };
    }

    // Priority order for price extraction
    const priceTypes: Array<{
      key: keyof NonNullable<TCGDexPricing["tcgplayer"]>;
      label: string;
    }> = [
      { key: "unlimited", label: "TCGPlayer unlimited market" },
      { key: "normal", label: "TCGPlayer normal market" },
      { key: "holofoil", label: "TCGPlayer holofoil market" },
      { key: "reverseHolofoil", label: "TCGPlayer reverse holo market" },
      { key: "1st-edition", label: "TCGPlayer 1st ed market" },
    ];

    for (const { key, label } of priceTypes) {
      // Skip non-price keys (updated, unit)
      if (key === "updated" || key === "unit") continue;

      const priceObj = tcgplayerPricing[key];
      if (
        typeof priceObj === "object" &&
        priceObj !== null &&
        "marketPrice" in priceObj &&
        priceObj.marketPrice != null &&
        priceObj.marketPrice > 0
      ) {
        // Convert dollars to cents
        return {
          priceCents: Math.round(priceObj.marketPrice * 100),
          priceLabel: label,
        };
      }
    }

    return { priceCents: null, priceLabel: null };
  }

  /**
   * Get card by set name and card number.
   * Primary lookup method for marketplace order enrichment.
   */
  async getCardBySetAndNumber(
    setName: string,
    cardNumber: string
  ): Promise<TCGDexLookupResult> {
    // Resolve set ID
    const setId = await this.resolveSetId(setName);
    if (!setId) {
      return {
        success: false,
        card: null,
        imageUrl: null,
        marketPriceCents: null,
        priceLabel: null,
        fromCache: false,
        error: `Could not resolve set ID for "${setName}"`,
      };
    }

    // Normalize card number: handle "60/64" → "60", but preserve leading zeros
    // (e.g., swsh12.5-001 requires zero-padding to be kept)
    const normalizedNumber = cardNumber.split("/")[0].trim();

    const cacheKey = this.generateCacheKey(setId, normalizedNumber);

    // Check cache first
    const cached = this.fetchFromCache(cacheKey);
    if (cached) {
      const priceFresh = this.isPriceFresh(cached);

      if (priceFresh) {
        // Full cache hit - both identity and price are fresh
        return {
          success: true,
          card: {
            id: cached.tcgdex_card_id,
            localId: normalizedNumber,
            name: cached.name,
            image: cached.image_url?.replace("/high.webp", "") ?? undefined,
            hp: cached.hp ?? undefined,
            rarity: cached.rarity ?? undefined,
            set: cached.set_id
              ? { id: cached.set_id, name: cached.set_name ?? "" }
              : undefined,
          },
          imageUrl: cached.image_url,
          marketPriceCents: cached.market_price_cents,
          priceLabel: cached.price_label,
          fromCache: true,
        };
      }

      // Identity cached but price stale - refresh price only
      this.logger.debug({ cacheKey }, "TCGDex price stale, refreshing");
    }

    // Fetch from API
    const tcgdexCardId = `${setId}-${normalizedNumber}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

      const response = await fetch(`${TCGDEX_API_BASE}/cards/${tcgdexCardId}`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          return {
            success: false,
            card: null,
            imageUrl: null,
            marketPriceCents: null,
            priceLabel: null,
            fromCache: false,
            error: `Card not found: ${tcgdexCardId}`,
          };
        }
        throw new Error(`TCGDex API returned ${response.status}`);
      }

      const card = (await response.json()) as TCGDexCard;

      // Build high-res image URL
      const imageUrl = card.image ? `${card.image}/high.webp` : null;

      // Extract market price
      const { priceCents, priceLabel } = this.extractMarketPrice(card);

      // Write to cache
      this.writeToCache(cacheKey, card, imageUrl, priceCents, priceLabel);

      this.logger.debug(
        {
          tcgdexCardId: card.id,
          name: card.name,
          imageUrl,
          marketPriceCents: priceCents,
        },
        "TCGDex card lookup successful"
      );

      return {
        success: true,
        card,
        imageUrl,
        marketPriceCents: priceCents,
        priceLabel,
        fromCache: false,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          card: null,
          imageUrl: null,
          marketPriceCents: null,
          priceLabel: null,
          fromCache: false,
          error: `TCGDex API timeout after ${this.fetchTimeoutMs}ms`,
        };
      }

      this.logger.error(
        { error, tcgdexCardId, setName, cardNumber },
        "TCGDex card lookup failed"
      );

      return {
        success: false,
        card: null,
        imageUrl: null,
        marketPriceCents: null,
        priceLabel: null,
        fromCache: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
