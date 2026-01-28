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

/** Options for TCGDex card lookup */
export interface TCGDexLookupOptions {
  cardName?: string | null; // For validation during set inference
}

/** Failure classification for debug logging */
type LookupFailureClass =
  | "localid_mismatch" // Some variants 404 but later succeeded
  | "set_mismatch" // All variants 404 for resolved set
  | "set_unresolved" // Could not resolve set ID
  | "set_inference_failed" // Denominator-based inference failed
  | "timeout"
  | "api_error";

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

  // Index: officialCardCount → [setIds] for denominator-based set inference
  private officialCountIndex: Map<number, string[]> | null = null;

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
   * Picks the LONGEST matching key to avoid "Sword & Shield Base Set" → "Base Set" hijacking.
   */
  async resolveSetId(setName: string): Promise<string | null> {
    const normalized = normalizeSetName(setName);

    // Try static mapping first (exact match)
    const staticId = SET_NAME_TO_TCGDEX_ID[normalized];
    if (staticId) {
      return staticId;
    }

    // Try partial match in static mapping - collect ALL matches and pick longest
    const staticMatches: Array<{ key: string; id: string }> = [];
    for (const [key, id] of Object.entries(SET_NAME_TO_TCGDEX_ID)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        staticMatches.push({ key, id });
      }
    }

    if (staticMatches.length > 0) {
      // Pick the longest matching key (most specific match wins)
      staticMatches.sort((a, b) => b.key.length - a.key.length);
      return staticMatches[0].id;
    }

    // Fall back to fetching sets from API and fuzzy matching
    await this.loadSetsCache();

    if (this.setsCache) {
      // Exact match
      const exactMatch = this.setsCache.get(normalized);
      if (exactMatch) return exactMatch.id;

      // Fuzzy match by name - collect ALL matches and pick best
      const apiMatches: Array<{ name: string; id: string }> = [];
      for (const [, set] of this.setsCache) {
        const setNameNormalized = normalizeSetName(set.name);
        if (
          setNameNormalized.includes(normalized) ||
          normalized.includes(setNameNormalized)
        ) {
          apiMatches.push({ name: set.name, id: set.id });
        }
      }

      if (apiMatches.length > 0) {
        // Pick the longest matching name (most specific)
        apiMatches.sort((a, b) => b.name.length - a.name.length);
        return apiMatches[0].id;
      }
    }

    this.logger.debug({ setName, normalized }, "Could not resolve TCGDex set ID");
    return null;
  }

  /**
   * Load all sets from TCGDex API (cached for 1 hour).
   * Also builds officialCountIndex for denominator-based set inference.
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
      this.officialCountIndex = new Map();

      for (const set of sets) {
        // Index by normalized name
        this.setsCache.set(normalizeSetName(set.name), set);
        // Also index by ID for direct access
        this.setsCache.set(set.id, set);

        // Build officialCountIndex for denominator-based set inference
        const officialCount = set.cardCount?.official;
        if (officialCount && officialCount > 0) {
          const existing = this.officialCountIndex.get(officialCount) ?? [];
          existing.push(set.id);
          this.officialCountIndex.set(officialCount, existing);
        }
      }

      this.setsCacheLoadedAt = now;
      this.logger.debug(
        { setCount: sets.length, countIndexSize: this.officialCountIndex.size },
        "Loaded TCGDex sets cache with cardCount index"
      );
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
   * Generate localId variants to try for a card number.
   * Order: raw → stripped (no leading zeros) → pad3 (zero-pad to 3 digits)
   */
  private generateLocalIdVariants(cardNumber: string): string[] {
    // Extract numerator from "X/Y" format (e.g., "055/072" → "055")
    const raw = cardNumber.split("/")[0].trim();

    const variants = new Set<string>();
    variants.add(raw);

    // Stripped: remove leading zeros if purely numeric
    if (/^\d+$/.test(raw)) {
      const stripped = raw.replace(/^0+/, "") || "0";
      variants.add(stripped);

      // Pad3: left-pad to 3 digits
      const numericVal = parseInt(stripped, 10);
      if (!isNaN(numericVal) && numericVal < 1000) {
        const pad3 = numericVal.toString().padStart(3, "0");
        variants.add(pad3);
      }
    }

    return Array.from(variants);
  }

  /**
   * Parse denominator from "X/Y" card number format.
   * Returns null if not in X/Y format or Y is not numeric.
   */
  private parseDenominator(cardNumber: string): number | null {
    const match = cardNumber.match(/^\d+\/(\d+)$/);
    if (!match) return null;
    const denom = parseInt(match[1], 10);
    return isNaN(denom) ? null : denom;
  }

  /**
   * Normalize card name for comparison (strip common suffixes like "(Full Art)").
   */
  private normalizeCardName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/g, "") // Remove trailing parentheticals
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Fetch a card from TCGDex API with timeout handling.
   * Returns null on 404, throws on other errors.
   */
  private async fetchCardFromApi(tcgdexCardId: string): Promise<TCGDexCard | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await fetch(`${TCGDEX_API_BASE}/cards/${tcgdexCardId}`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`TCGDex API returned ${response.status}`);
      }

      return (await response.json()) as TCGDexCard;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Try to find a card using multiple localId variants for a given setId.
   * Returns the first successful result or null if all variants fail.
   */
  private async tryVariantsForSet(
    setId: string,
    variants: string[],
    opts?: TCGDexLookupOptions
  ): Promise<{ card: TCGDexCard; localIdUsed: string; cacheKey: string } | null> {
    const attemptedIds: string[] = [];

    for (const localId of variants) {
      const cacheKey = this.generateCacheKey(setId, localId);

      // Check cache first
      const cached = this.fetchFromCache(cacheKey);
      if (cached) {
        // Validate card name if provided
        if (opts?.cardName) {
          const normalizedExpected = this.normalizeCardName(opts.cardName);
          const normalizedCached = this.normalizeCardName(cached.name);
          if (normalizedExpected !== normalizedCached) {
            this.logger.debug(
              { cacheKey, expected: opts.cardName, cached: cached.name },
              "Cached card name mismatch, skipping"
            );
            continue;
          }
        }

        // Return reconstructed card from cache
        return {
          card: {
            id: cached.tcgdex_card_id,
            localId,
            name: cached.name,
            image: cached.image_url?.replace("/high.webp", "") ?? undefined,
            hp: cached.hp ?? undefined,
            rarity: cached.rarity ?? undefined,
            set: cached.set_id
              ? { id: cached.set_id, name: cached.set_name ?? "" }
              : undefined,
            // Reconstruct pricing from cache
            pricing: cached.market_price_cents != null
              ? {
                  tcgplayer: {
                    unlimited: { marketPrice: cached.market_price_cents / 100 },
                  },
                }
              : undefined,
          },
          localIdUsed: localId,
          cacheKey,
        };
      }

      attemptedIds.push(`${setId}-${localId}`);
    }

    // No cache hits - try network for each variant
    for (const localId of variants) {
      const tcgdexCardId = `${setId}-${localId}`;

      try {
        const card = await this.fetchCardFromApi(tcgdexCardId);
        if (card) {
          // Validate card name if provided
          if (opts?.cardName) {
            const normalizedExpected = this.normalizeCardName(opts.cardName);
            const normalizedFetched = this.normalizeCardName(card.name);
            if (normalizedExpected !== normalizedFetched) {
              this.logger.debug(
                { tcgdexCardId, expected: opts.cardName, fetched: card.name },
                "Fetched card name mismatch, skipping"
              );
              continue;
            }
          }

          return {
            card,
            localIdUsed: localId,
            cacheKey: this.generateCacheKey(setId, localId),
          };
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error; // Re-throw timeout to be handled by caller
        }
        // Log but continue trying other variants
        this.logger.debug(
          { tcgdexCardId, error: (error as Error).message },
          "Variant fetch failed"
        );
      }
    }

    return null;
  }

  /**
   * Log failed lookup with classification for debugging.
   */
  private logFailedLookup(
    failureClass: LookupFailureClass,
    details: {
      setName: string;
      cardNumber: string;
      cardName?: string | null;
      resolvedSetId?: string | null;
      denominator?: number | null;
      attemptedIds?: string[];
      error?: string;
    }
  ): void {
    this.logger.debug(
      {
        failureClass,
        setName: details.setName,
        cardNumber: details.cardNumber,
        cardName: details.cardName ?? undefined,
        resolvedSetId: details.resolvedSetId ?? undefined,
        denominator: details.denominator ?? undefined,
        attemptedIds: details.attemptedIds ?? undefined,
        error: details.error ?? undefined,
      },
      `TCGDex lookup failed: ${failureClass}`
    );
  }

  /**
   * Get card by set name and card number.
   * Primary lookup method for marketplace order enrichment.
   *
   * Strategy:
   * 1. Generate localId variants (raw, stripped, pad3)
   * 2. Resolve set ID and try all variants (cache-first, then network)
   * 3. If set resolution fails OR all variants 404, use denominator-based set inference
   * 4. Validate card name during inference to avoid wrong-set matches
   */
  async getCardBySetAndNumber(
    setName: string,
    cardNumber: string,
    opts?: TCGDexLookupOptions
  ): Promise<TCGDexLookupResult> {
    const variants = this.generateLocalIdVariants(cardNumber);
    const denominator = this.parseDenominator(cardNumber);
    let resolvedSetId: string | null = null;
    let attemptedIds: string[] = [];

    // Step 1: Try resolved set ID with all variants
    resolvedSetId = await this.resolveSetId(setName);

    if (resolvedSetId) {
      try {
        const result = await this.tryVariantsForSet(resolvedSetId, variants, opts);
        if (result) {
          const { card, cacheKey } = result;

          // Build high-res image URL
          const imageUrl = card.image ? `${card.image}/high.webp` : null;
          const { priceCents, priceLabel } = this.extractMarketPrice(card);

          // Write to cache
          this.writeToCache(cacheKey, card, imageUrl, priceCents, priceLabel);

          this.logger.debug(
            { tcgdexCardId: card.id, name: card.name, imageUrl, marketPriceCents: priceCents },
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
        }

        // All variants failed for resolved set
        attemptedIds = variants.map((v) => `${resolvedSetId}-${v}`);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          this.logFailedLookup("timeout", {
            setName,
            cardNumber,
            cardName: opts?.cardName,
            resolvedSetId,
            error: `Timeout after ${this.fetchTimeoutMs}ms`,
          });

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

        this.logFailedLookup("api_error", {
          setName,
          cardNumber,
          cardName: opts?.cardName,
          resolvedSetId,
          error: error instanceof Error ? error.message : "Unknown error",
        });

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

    // Step 2: Denominator-based set inference fallback
    if (denominator && opts?.cardName) {
      await this.loadSetsCache();

      if (this.officialCountIndex) {
        const candidateSetIds = this.officialCountIndex.get(denominator) ?? [];

        // Cap to prevent excessive API calls
        const limitedCandidates = candidateSetIds.slice(0, 25);

        for (const candidateSetId of limitedCandidates) {
          // Skip the already-tried set
          if (candidateSetId === resolvedSetId) continue;

          try {
            const result = await this.tryVariantsForSet(candidateSetId, variants, opts);
            if (result) {
              const { card, cacheKey } = result;

              // Build high-res image URL
              const imageUrl = card.image ? `${card.image}/high.webp` : null;
              const { priceCents, priceLabel } = this.extractMarketPrice(card);

              // Write to cache
              this.writeToCache(cacheKey, card, imageUrl, priceCents, priceLabel);

              this.logger.info(
                {
                  tcgdexCardId: card.id,
                  name: card.name,
                  inferredSetId: candidateSetId,
                  originalSetName: setName,
                  denominator,
                },
                "TCGDex card lookup successful via set inference"
              );

              return {
                success: true,
                card,
                imageUrl,
                marketPriceCents: priceCents,
                priceLabel,
                fromCache: false,
              };
            }
          } catch (error) {
            // Timeout during inference - stop trying
            if (error instanceof Error && error.name === "AbortError") {
              this.logFailedLookup("timeout", {
                setName,
                cardNumber,
                cardName: opts.cardName,
                resolvedSetId,
                denominator,
                error: `Timeout during set inference`,
              });

              return {
                success: false,
                card: null,
                imageUrl: null,
                marketPriceCents: null,
                priceLabel: null,
                fromCache: false,
                error: `TCGDex API timeout during set inference`,
              };
            }
            // Continue to next candidate
          }
        }

        // Set inference failed
        if (limitedCandidates.length > 0) {
          this.logFailedLookup("set_inference_failed", {
            setName,
            cardNumber,
            cardName: opts.cardName,
            resolvedSetId,
            denominator,
            attemptedIds: [
              ...attemptedIds,
              ...limitedCandidates.flatMap((s) => variants.map((v) => `${s}-${v}`)),
            ],
          });
        }
      }
    }

    // Step 3: Final failure - log and return
    if (!resolvedSetId) {
      this.logFailedLookup("set_unresolved", {
        setName,
        cardNumber,
        cardName: opts?.cardName,
        denominator,
      });

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

    this.logFailedLookup("set_mismatch", {
      setName,
      cardNumber,
      cardName: opts?.cardName,
      resolvedSetId,
      denominator,
      attemptedIds,
    });

    return {
      success: false,
      card: null,
      imageUrl: null,
      marketPriceCents: null,
      priceLabel: null,
      fromCache: false,
      error: `Card not found for any localId variant: ${attemptedIds.join(", ")}`,
    };
  }
}
