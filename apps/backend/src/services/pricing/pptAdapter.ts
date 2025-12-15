import type * as Database from "better-sqlite3";
import type { Logger } from "pino";
import type {
  PPTConfig,
  PPTCard,
  PPTQueryParams,
  PPTResponse,
  PPTCardFull,
  PPTCardsResponse,
  PPTRateLimitHeaders,
  QuotaStatus,
  CachedPrice,
  PriceData,
  EnrichmentResult,
  PPTParseTitleRequestBody,
  PPTParseTitleResponse,
  PPTParseMatch,
} from "./types";
import { PPTAuditLogger } from "./pptAuditLogger";

const PPT_API_BASE = "https://www.pokemonpricetracker.com";
const DEFAULT_CACHE_TTL_HOURS = 24;
const DETERMINISTIC_CACHE_TTL_HOURS = 48;
const FUZZY_CACHE_TTL_HOURS = 6;
const QUOTA_WARNING_THRESHOLD = 0.8; // 80%
const QUOTA_HALT_THRESHOLD = 0.95; // 95%

/**
 * Normalize cardNumber for PPT API requests.
 * Strips "/total" suffix (e.g., "60/64" → "60") and trims leading zeros.
 */
function normalizeCardNumber(cardNumber: string): string {
  // Strip "/total" suffix
  const numerator = cardNumber.split("/")[0];
  // Trim leading zeros but keep at least one digit
  return numerator.replace(/^0+(?=\d)/, "");
}

/**
 * Normalize set names/slugs for overlap comparison.
 * Lowercases, removes non-alphanumeric characters.
 */
function normalizeSetNameForOverlap(name: string | undefined | null): string {
  if (!name) return "";
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Tight name normalization for simple equality checks.
 * Lowercases and strips whitespace.
 */
function normalizeNameTight(name: string | undefined | null): string {
  if (!name) return "";
  return name.toLowerCase().replace(/\s+/g, "");
}

export class PokePriceTrackerAdapter {
  private lastQuotaCheck: QuotaStatus | null = null;
  private auditLogger: PPTAuditLogger;

  constructor(
    private readonly db: Database.Database,
    private readonly config: PPTConfig,
    private readonly logger: Logger,
  ) {
    this.auditLogger = new PPTAuditLogger();
  }

  /**
   * Get current quota status from last API call
   */
  getQuotaStatus(): QuotaStatus | null {
    return this.lastQuotaCheck;
  }

  /**
   * Check if quota allows making API calls
   */
  private checkQuotaAllowance(quotaStatus: QuotaStatus): boolean {
    if (quotaStatus.shouldHalt) {
      this.logger.warn(
        {
          tier: quotaStatus.tier,
          dailyRemaining: quotaStatus.dailyRemaining,
          dailyLimit: quotaStatus.dailyLimit,
        },
        "PPT quota critical - halting non-essential calls",
      );
      return false;
    }

    if (quotaStatus.warningLevel === "warning") {
      this.logger.warn(
        {
          tier: quotaStatus.tier,
          dailyRemaining: quotaStatus.dailyRemaining,
          dailyLimit: quotaStatus.dailyLimit,
        },
        "PPT quota warning - approaching daily limit",
      );
    }

    return true;
  }

  /**
   * Parse rate limit headers from PPT API response
   */
  private parseRateLimitHeaders(headers: Headers): PPTRateLimitHeaders {
    const callsConsumed = headers.get("x-api-calls-consumed");
    const dailyRemaining = headers.get("x-ratelimit-daily-remaining");
    const minuteRemaining = headers.get("x-ratelimit-minute-remaining");

    return {
      callsConsumed: callsConsumed ? parseInt(callsConsumed, 10) : undefined,
      dailyRemaining: dailyRemaining ? parseInt(dailyRemaining, 10) : undefined,
      minuteRemaining: minuteRemaining ? parseInt(minuteRemaining, 10) : undefined,
    };
  }

  /**
   * Update quota status and log if needed
   */
  private updateQuotaStatus(rateLimits: PPTRateLimitHeaders, operation: string): QuotaStatus {
    const dailyRemaining = rateLimits.dailyRemaining ?? null;
    const callsConsumed = rateLimits.callsConsumed ?? null;

    let warningLevel: "ok" | "warning" | "critical" = "ok";
    let shouldHalt = false;

    if (dailyRemaining !== null) {
      const usageRatio = 1 - dailyRemaining / this.config.dailyLimit;

      if (usageRatio >= QUOTA_HALT_THRESHOLD) {
        warningLevel = "critical";
        shouldHalt = true;
      } else if (usageRatio >= QUOTA_WARNING_THRESHOLD) {
        warningLevel = "warning";
      }
    }

    const quotaStatus: QuotaStatus = {
      tier: this.config.tier,
      dailyLimit: this.config.dailyLimit,
      dailyRemaining,
      minuteRemaining: rateLimits.minuteRemaining ?? null,
      callsConsumed,
      warningLevel,
      shouldHalt,
    };

    this.lastQuotaCheck = quotaStatus;

    // Log quota metrics
    this.logQuotaMetrics(quotaStatus, operation);

    return quotaStatus;
  }

  /**
   * Log quota metrics to ppt_quota_log table
   */
  private logQuotaMetrics(quota: QuotaStatus, operation: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO ppt_quota_log
           (logged_at, calls_consumed, daily_remaining, minute_remaining, tier, operation, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Math.floor(Date.now() / 1000),
          quota.callsConsumed,
          quota.dailyRemaining,
          quota.minuteRemaining,
          quota.tier,
          operation,
          quota.warningLevel !== "ok" ? `Warning level: ${quota.warningLevel}` : null,
        );
    } catch (error) {
      this.logger.error({ error, operation }, "Failed to log PPT quota metrics");
    }
  }

  /**
   * Generate cache key from canonical SKU and condition
   * Multiple listings of same card share pricing via canonical_sku
   */
  private generateCacheKey(canonicalSku: string, condition: string, strategy?: string): string {
    const strategySuffix = strategy ? `:${strategy}` : "";
    return `${canonicalSku}:${condition}${strategySuffix}`;
  }

  /**
   * Delete cache entry for a given key.
   */
  private async deleteCacheEntry(cacheKey: string): Promise<void> {
    try {
      this.db.prepare(`DELETE FROM ppt_price_cache WHERE cache_key = ?`).run(cacheKey);
      this.logger.debug({ cacheKey }, "Deleted stale PPT cache entry");
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to delete PPT cache entry");
    }
  }

  /**
   * Safely parse enrichment_signals JSON stored in cache rows.
   */
  private parseCachedSignals(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /**
   * Check if cached price is still valid (within TTL)
   */
  private isCacheValid(cachedPrice: CachedPrice): boolean {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = cachedPrice.cached_at + cachedPrice.ttl_hours * 3600;
    return now < expiresAt;
  }

  /**
   * Fetch price from cache
   */
  private async fetchFromCache(cacheKey: string): Promise<CachedPrice | null> {
    try {
      const cached = this.db
        .prepare(
          `SELECT cache_key, canonical_sku, listing_sku, condition, market_price, ppt_card_id,
                  hp_value, total_set_number, enrichment_signals, cached_at, ttl_hours
           FROM ppt_price_cache
           WHERE cache_key = ?`,
        )
        .get(cacheKey) as CachedPrice | undefined;

      if (!cached) {
        return null;
      }

      if (!this.isCacheValid(cached)) {
        this.logger.debug({ cacheKey }, "Cache entry expired");
        return null;
      }

      this.logger.debug({ cacheKey, age_hours: (Date.now() / 1000 - cached.cached_at) / 3600 }, "Cache hit");
      return cached;
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to fetch from cache");
      return null;
    }
  }

  /**
   * Write price to cache
   */
  private resolveTtlHours(strategy?: string): number {
    if (!strategy) return DEFAULT_CACHE_TTL_HOURS;
    if (strategy === "tcgplayer" || strategy === "pricecharting") return DETERMINISTIC_CACHE_TTL_HOURS;
    if (strategy === "cards_query" || strategy === "parseTitle") return FUZZY_CACHE_TTL_HOURS;
    return DEFAULT_CACHE_TTL_HOURS;
  }

  /**
   * Write price to cache
   */
  private async writeToCache(
    priceData: PriceData,
    canonicalSku: string,
    listingSku: string,
    condition: string,
    opts?: { strategy?: string; ttlHours?: number },
  ): Promise<void> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, opts?.strategy);
    const now = Math.floor(Date.now() / 1000);
    const ttlHours = opts?.ttlHours ?? this.resolveTtlHours(opts?.strategy);

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ppt_price_cache
           (cache_key, canonical_sku, listing_sku, condition, market_price, ppt_card_id, hp_value,
            total_set_number, enrichment_signals, cached_at, ttl_hours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cacheKey,
          canonicalSku,
          listingSku,
          condition,
          priceData.market_price,
          priceData.ppt_card_id ?? null,
          priceData.hp_value ?? null,
          priceData.total_set_number ?? null,
          JSON.stringify(priceData.enrichment_signals ?? {}),
          now,
          ttlHours,
        );

      this.logger.debug({ cacheKey, canonicalSku, listingSku }, "Wrote to cache");
    } catch (error) {
      this.logger.error({ error, cacheKey }, "Failed to write to cache");
    }
  }

  /**
   * Call PPT cards API (legacy path)
   */
  private async callPPTCards(params: PPTQueryParams): Promise<{ data: PPTResponse; headers: Headers }> {
    const url = new URL(`${this.config.baseUrl}/api/v2/cards`);

    if (params.name) url.searchParams.set("search", params.name);
    if (params.setName) url.searchParams.set("set", params.setName);
    if (params.cardNumber) url.searchParams.set("cardNumber", params.cardNumber);
    if (params.hp) url.searchParams.set("hp", params.hp.toString());
    if (params.limit) url.searchParams.set("limit", params.limit.toString());

    this.logger.debug({ url: url.toString(), params }, "Calling PPT API");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Map 429 (rate limit) and 503 (service unavailable) to specific error type
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as PPTResponse;
      return { data, headers: response.headers };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`PPT API timeout after ${this.config.timeoutMs}ms`);
      }

      throw error;
    }
  }

  /**
   * Flexible cards query caller for GET /api/v2/cards with richer parameters.
   */
  private async callPPTCardsGeneric(params: Record<string, string | number | boolean | undefined>): Promise<{ data: PPTCardsResponse; headers: Headers }> {
    const url = new URL(`${this.config.baseUrl}/api/v2/cards`);

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    this.logger.debug({ url: url.toString(), params }, "Calling PPT cards API (generic)");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`,
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as PPTCardsResponse;
      return { data, headers: response.headers };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`PPT API timeout after ${this.config.timeoutMs}ms`);
      }

      throw error;
    }
  }

  private async callPPTCardByPricechartingId(pricechartingId: string): Promise<{ card: PPTCard; headers: Headers }> {
    const cleanId = pricechartingId.trim();
    const url = new URL(`${this.config.baseUrl}/api/v2/card/${encodeURIComponent(cleanId)}`);

    this.logger.debug({ url: url.toString(), pricechartingId: cleanId }, "Calling PPT card lookup API");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          // Bridge ID is invalid (card not found in PPT catalog)
          this.logger.warn(
            { status: 404, pricechartingId: cleanId, url: url.toString() },
            "PPT_BRIDGE_INVALID: Bridge ID not found in PPT catalog"
          );
          throw new Error(`PPT_BRIDGE_INVALID: ${cleanId} not found (404)`);
        }
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const payload = (await response.json()) as PPTCard | { data?: PPTCard };
      const card = (payload as { data?: PPTCard }).data ?? (payload as PPTCard);

      if (!card || typeof card !== "object" || !card.id) {
        throw new Error("PPT card lookup returned no data");
      }

      return { card, headers: response.headers };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`PPT API timeout after ${this.config.timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Call PPT cards API with tcgPlayerId for deterministic lookup.
   * Also accepts optional set slug and card number for disambiguation.
   * Cost: 1 credit.
   */
  private async callPPTCardByTcgPlayerId(
    tcgPlayerId: string,
    _setSlug?: string,
    _cardNumber?: string,
  ): Promise<{ card: PPTCard | null; headers: Headers }> {
    const url = new URL(`${this.config.baseUrl}/api/v2/cards`);
    url.searchParams.set("tcgPlayerId", tcgPlayerId);
    // Note: PPT API only accepts tcgPlayerId, cardId, setId, setName, search, limit, offset
    // set/cardNumber are not valid params - tcgPlayerId is deterministic enough
    url.searchParams.set("limit", "1");

    this.logger.debug({ url: url.toString(), tcgPlayerId }, "Calling PPT cards API with tcgPlayerId");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`,
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const json = (await response.json()) as { data: PPTCard | PPTCard[]; metadata?: unknown };
      // Handle both single object (tcgPlayerId lookup) and array (search results)
      const card = Array.isArray(json.data)
        ? json.data.length > 0 ? json.data[0] : null
        : json.data ?? null;

      return { card, headers: response.headers };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`PPT API timeout after ${this.config.timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Condition mapping from CardMint condition buckets to PPT condition names.
   */
  private static readonly CONDITION_MAP: Record<string, string> = {
    NM: "Near Mint",
    LP: "Lightly Played",
    MP: "Moderately Played",
    HP: "Heavily Played",
    DMG: "Damaged",
  };

  /**
   * Extract condition-specific price from PPT prices object.
   * Falls back to market price if condition-specific not available.
   * Also checks variants for condition-specific pricing when conditions is missing.
   */
  private extractConditionPrice(
    prices: {
      market?: number | null;
      conditions?: Record<string, { price: number; listings: number }>;
      variants?: Record<string, Record<string, { price: number; listings: number }>>;
      primaryCondition?: string;
    } | undefined,
    condition: string,
  ): number | null {
    if (!prices) return null;

    const pptCondition = PokePriceTrackerAdapter.CONDITION_MAP[condition] || "Near Mint";

    // Try condition-specific first (direct conditions object)
    if (prices.conditions?.[pptCondition]?.price != null) {
      this.logger.debug({ condition, pptCondition, price: prices.conditions[pptCondition].price }, "Using condition-specific price");
      return prices.conditions[pptCondition].price;
    }

    // Try variants fallback - check primaryCondition variant first, then any variant
    if (prices.variants) {
      // Check primaryCondition variant first if available
      const primaryVariant = prices.primaryCondition ? prices.variants[prices.primaryCondition] : null;
      if (primaryVariant?.[pptCondition]?.price != null) {
        this.logger.debug({ condition, pptCondition, price: primaryVariant[pptCondition].price, variant: prices.primaryCondition }, "Using variant condition-specific price");
        return primaryVariant[pptCondition].price;
      }

      // Check all variants
      for (const [variantName, variantPrices] of Object.entries(prices.variants)) {
        if (variantPrices[pptCondition]?.price != null) {
          this.logger.debug({ condition, pptCondition, price: variantPrices[pptCondition].price, variant: variantName }, "Using variant condition-specific price (fallback)");
          return variantPrices[pptCondition].price;
        }
      }
    }

    // Explicit fallback to market (NM equivalent)
    this.logger.debug({ condition, pptCondition, marketPrice: prices.market }, "Condition-specific price not available, using market price");
    return prices.market ?? null;
  }

  /**
   * Validate that PPT response matches canonical set/cardNumber.
   * Returns validation result with optional mismatch details for logging.
   */
  private validateSetCardMatch(
    pptCard: PPTCard,
    canonical: { setSlug: string; cardNumber: string },
  ): { valid: boolean; mismatch?: string } {
    const normalizeNum = (n: string | undefined | null): string => {
      if (!n) return "";
      // Strip leading zeros, take first part before slash, lowercase, trim
      return n.replace(/^0+/, "").split("/")[0].toLowerCase().trim();
    };

    const normalizeSet = (s: string | undefined | null): string => {
      if (!s) return "";
      // Lowercase, remove non-alphanumeric
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    };

    const canonicalNum = normalizeNum(canonical.cardNumber);
    const pptNum = normalizeNum(pptCard.cardNumber);
    const canonicalSet = normalizeSet(canonical.setSlug);
    const pptSet = normalizeSet(pptCard.setName);

    // Card number must match (if both present)
    const numMatch = !canonicalNum || !pptNum || canonicalNum === pptNum;

    // Set must have overlap (one contains the other, handles slug vs full name)
    const setMatch = !canonicalSet || !pptSet || canonicalSet.includes(pptSet) || pptSet.includes(canonicalSet);

    if (!numMatch || !setMatch) {
      return {
        valid: false,
        mismatch: `canonical(${canonical.setSlug}/${canonical.cardNumber}) vs ppt(${pptCard.setName}/${pptCard.cardNumber})`,
      };
    }

    return { valid: true };
  }

  /**
   * Select best PPT candidate using strict cardNumber + set overlap rules.
   * Returns null if no candidate meets both requirements.
   */
  private selectBestCandidate(
    candidates: PPTCardFull[],
    target: { cardNumber?: string; setSlug?: string; setName?: string; cardName?: string },
  ): PPTCardFull | null {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }

    const normalizedTargetNumber = target.cardNumber ? normalizeCardNumber(target.cardNumber) : "";
    const normalizedTargetSet = normalizeSetNameForOverlap(target.setSlug ?? target.setName);
    const normalizedTargetName = normalizeNameTight(target.cardName);

    const scored = candidates.map((candidate) => {
      const candidateNum = candidate.cardNumber ? normalizeCardNumber(candidate.cardNumber) : "";
      const candidateSet = normalizeSetNameForOverlap(candidate.setName);
      const candidateName = normalizeNameTight(candidate.name);

      const numberExact = normalizedTargetNumber !== "" && candidateNum !== "" ? candidateNum === normalizedTargetNumber : false;
      const setOverlap =
        normalizedTargetSet !== "" && candidateSet !== ""
          ? candidateSet.includes(normalizedTargetSet) || normalizedTargetSet.includes(candidateSet)
          : false;
      const nameExact = normalizedTargetName !== "" && candidateName !== "" && candidateName === normalizedTargetName;

      let score = 0;
      if (numberExact) score += 2;
      if (setOverlap) score += 2;
      if (nameExact) score += 1;

      return { candidate, score, numberExact, setOverlap };
    });

    const passing = scored
      .filter((entry) => entry.numberExact && entry.setOverlap)
      .sort((a, b) => b.score - a.score);

    return passing[0]?.candidate ?? null;
  }

  /**
   * Get price by TCGPlayer ID with set/number disambiguation.
   * This is the new deterministic lookup path that should be tried before parse-title.
   *
   * @param canonicalSku - Canonical SKU for cache key
   * @param listingSku - Full listing SKU for audit trail
   * @param condition - Condition bucket (NM, LP, MP, HP)
   * @param tcgPlayerId - TCGPlayer product ID for deterministic lookup
   * @param canonicalContext - Set slug and card number for validation
   * @param opts - Optional: skipCacheWrite
   */
  async getPriceByTcgPlayerId(
    canonicalSku: string,
    listingSku: string,
    condition: string,
    tcgPlayerId: string,
    canonicalContext: { setSlug: string; cardNumber: string },
    opts?: { skipCacheWrite?: boolean },
  ): Promise<EnrichmentResult> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, "tcgplayer");
    const legacyCacheKey = this.generateCacheKey(canonicalSku, condition);

    // Step 1: Cache check
    const cached = await this.fetchFromCache(cacheKey);
    const legacyCached = legacyCacheKey !== cacheKey ? await this.fetchFromCache(legacyCacheKey) : null;
    const cacheCandidates = [cached, legacyCached].filter(Boolean) as CachedPrice[];

    const usableCache = cacheCandidates.find((entry) => {
      const signals = this.parseCachedSignals(entry.enrichment_signals);
      const lookupStrategy = (signals as any)?.lookupStrategy;
      const hasCardId = Boolean(entry.ppt_card_id);
      const isFuzzy = lookupStrategy === "parse_title" || lookupStrategy === "parseTitle";

      if (!hasCardId || isFuzzy) {
        void this.deleteCacheEntry(entry.cache_key);
        return false;
      }
      return true;
    });

    if (usableCache) {
      const priceData: PriceData = {
        market_price: usableCache.market_price,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: usableCache.ppt_card_id ?? undefined,
        hp_value: usableCache.hp_value ?? undefined,
        total_set_number: usableCache.total_set_number ?? undefined,
        enrichment_signals: this.parseCachedSignals(usableCache.enrichment_signals),
        cached_at: usableCache.cached_at,
      };

      // Migrate legacy cache entries to strategy-aware key with deterministic TTL
      if (usableCache.cache_key !== cacheKey && !opts?.skipCacheWrite) {
        await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
          strategy: "tcgplayer",
          ttlHours: DETERMINISTIC_CACHE_TTL_HOURS,
        });
      }

      return {
        success: true,
        priceData,
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        fromCache: true,
        lookupStrategy: "tcgplayer_deterministic",
      };
    }

    // Step 2: Quota guard
    if (this.lastQuotaCheck && !this.checkQuotaAllowance(this.lastQuotaCheck)) {
      this.logger.warn({ canonicalSku, listingSku, condition }, "Skipping PPT tcgPlayerId lookup due to quota limit");
      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck,
        error: "Quota exhausted",
        fromCache: false,
        lookupStrategy: "tcgplayer_deterministic",
      };
    }

    // Step 3: Deterministic API call with set/number filters
    try {
      const { card, headers } = await this.callPPTCardByTcgPlayerId(
        tcgPlayerId,
        canonicalContext.setSlug,
        canonicalContext.cardNumber,
      );
      const rateLimits = this.parseRateLimitHeaders(headers);
      const quotaStatus = this.updateQuotaStatus(rateLimits, "getPriceByTcgPlayerId");

      if (!card) {
        this.logger.debug({ canonicalSku, tcgPlayerId }, "No PPT results for tcgPlayerId");
        return {
          success: false,
          priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
          quotaStatus,
          error: "No results for tcgPlayerId",
          fromCache: false,
          lookupStrategy: "tcgplayer_deterministic",
        };
      }

      // Step 4: Post-filter validation - check set/number match
      const validation = this.validateSetCardMatch(card, canonicalContext);
      if (!validation.valid) {
        this.logger.warn(
          {
            canonicalSku,
            tcgPlayerId,
            mismatch: validation.mismatch,
          },
          "PPT tcgPlayerId response mismatch - rejecting",
        );
        return {
          success: false,
          priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
          quotaStatus,
          error: `Mismatch: ${validation.mismatch}`,
          fromCache: false,
          lookupStrategy: "tcgplayer_deterministic",
          mismatchRejected: true,
          rejectionReason: validation.mismatch,
        };
      }

      // Step 5: Extract condition-aware price
      const marketPrice = this.extractConditionPrice(card.prices as any, condition);

      const priceData: PriceData = {
        market_price: marketPrice,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: card.id,
        hp_value: card.hp,
        total_set_number: card.totalSetNumber,
        enrichment_signals: {
          lookupStrategy: "tcgplayer_deterministic",
          deterministic: true,
          tcgPlayerId,
          conditionUsed: condition,
          conditionMapped: PokePriceTrackerAdapter.CONDITION_MAP[condition] || "Near Mint",
          cardSummary: {
            name: card.name,
            setName: card.setName,
            cardNumber: card.cardNumber ?? null,
            totalSetNumber: card.totalSetNumber ?? null,
            rarity: card.rarity ?? null,
            cardType: card.cardType ?? null,
            hp: card.hp ?? null,
          },
        },
        cached_at: Math.floor(Date.now() / 1000),
      };

      if (!opts?.skipCacheWrite) {
        await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
          strategy: "tcgplayer",
          ttlHours: DETERMINISTIC_CACHE_TTL_HOURS,
        });
      }

      this.logger.info(
        {
          canonicalSku,
          listingSku,
          condition,
          tcgPlayerId,
          market_price: priceData.market_price,
          ppt_card_id: priceData.ppt_card_id,
          fromCache: false,
        },
        "PPT deterministic enrichment (tcgPlayerId) successful",
      );

      return {
        success: true,
        priceData,
        quotaStatus,
        fromCache: false,
        lookupStrategy: "tcgplayer_deterministic",
      };
    } catch (error) {
      this.logger.error(
        {
          error,
          canonicalSku,
          tcgPlayerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "PPT tcgPlayerId lookup failed",
      );

      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        error: error instanceof Error ? error.message : "Unknown error",
        fromCache: false,
        lookupStrategy: "tcgplayer_deterministic",
      };
    }
  }

  /**
   * Call PPT parse-title API with authentication and timeout
   */
  private async callPPTParseTitle(body: PPTParseTitleRequestBody): Promise<{ data: PPTParseTitleResponse; headers: Headers }> {
    const url = new URL(`${this.config.baseUrl}/api/v2/parse-title`);

    this.logger.debug({ url: url.toString(), body }, "Calling PPT parse-title API");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as PPTParseTitleResponse;
      return { data, headers: response.headers };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`PPT API timeout after ${this.config.timeoutMs}ms`);
      }
      throw error;
    }
  }

  async getPriceByPricechartingId(
    canonicalSku: string,
    listingSku: string,
    condition: string,
    pricechartingId: string,
    opts?: { skipCacheWrite?: boolean },
  ): Promise<EnrichmentResult> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, "pricecharting");
    const legacyCacheKey = this.generateCacheKey(canonicalSku, condition);

    const cached = await this.fetchFromCache(cacheKey);
    const legacyCached = legacyCacheKey !== cacheKey ? await this.fetchFromCache(legacyCacheKey) : null;
    const cacheCandidates = [cached, legacyCached].filter(Boolean) as CachedPrice[];

    const usableCache = cacheCandidates.find((entry) => {
      const signals = this.parseCachedSignals(entry.enrichment_signals);
      const lookupStrategy = (signals as any)?.lookupStrategy;
      const hasCardId = Boolean(entry.ppt_card_id);
      const isFuzzy = lookupStrategy === "parse_title" || lookupStrategy === "parseTitle";

      if (!hasCardId || isFuzzy) {
        void this.deleteCacheEntry(entry.cache_key);
        return false;
      }
      return true;
    });

    if (usableCache) {
      const priceData: PriceData = {
        market_price: usableCache.market_price,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: usableCache.ppt_card_id ?? undefined,
        hp_value: usableCache.hp_value ?? undefined,
        total_set_number: usableCache.total_set_number ?? undefined,
        enrichment_signals: this.parseCachedSignals(usableCache.enrichment_signals),
        cached_at: usableCache.cached_at,
      };

      if (usableCache.cache_key !== cacheKey && !opts?.skipCacheWrite) {
        await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
          strategy: "pricecharting",
          ttlHours: DETERMINISTIC_CACHE_TTL_HOURS,
        });
      }

      return {
        success: true,
        priceData,
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        fromCache: true,
        lookupStrategy: "cards_query",
      };
    }

    if (this.lastQuotaCheck && !this.checkQuotaAllowance(this.lastQuotaCheck)) {
      this.logger.warn({ canonicalSku, listingSku, condition }, "Skipping PPT card lookup due to quota limit");
      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck,
        error: "Quota exhausted",
        fromCache: false,
      };
    }

    try {
      const { card, headers } = await this.callPPTCardByPricechartingId(pricechartingId);
      const rateLimits = this.parseRateLimitHeaders(headers);
      const quotaStatus = this.updateQuotaStatus(rateLimits, "getPriceByPricechartingId");

      const priceData: PriceData = {
        market_price: card.prices?.market ?? null,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: card.id,
        hp_value: card.hp,
        total_set_number: card.totalSetNumber,
        enrichment_signals: {
          lookupStrategy: "pricecharting_bridge",
          deterministic: true,
          pricechartingId,
          cardSummary: {
            name: card.name,
            setName: card.setName,
            cardNumber: card.cardNumber ?? null,
            totalSetNumber: card.totalSetNumber ?? null,
            rarity: card.rarity ?? null,
            cardType: card.cardType ?? null,
            hp: card.hp ?? null,
          },
        },
        cached_at: Math.floor(Date.now() / 1000),
      };

      if (!opts?.skipCacheWrite) {
        await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
          strategy: "pricecharting",
          ttlHours: DETERMINISTIC_CACHE_TTL_HOURS,
        });
      }

      this.logger.info(
        {
          canonicalSku,
          listingSku,
          condition,
          pricecharting_id: pricechartingId,
          market_price: priceData.market_price,
          ppt_card_id: priceData.ppt_card_id,
          fromCache: false,
        },
        "PPT pricecharting bridge enrichment successful",
      );

      return { success: true, priceData, quotaStatus, fromCache: false };
    } catch (error) {
      this.logger.error(
        {
          error,
          canonicalSku,
          listingSku,
          condition,
          pricecharting_id: pricechartingId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "PPT deterministic enrichment failed",
      );

      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        error: error instanceof Error ? error.message : "Unknown error",
        fromCache: false,
      };
    }
  }

  /**
   * Enrich a card with PPT pricing data
   * @param canonicalSku - Canonical SKU for cache key (e.g., "PKM:BASE:063:holo:EN")
   * @param listingSku - Full listing SKU for audit trail (e.g., "PKM:BASE:063:holo:EN:F176C369:NM")
   * @param condition - Condition bucket (NM, LP, MP, HP)
   * @param cardName - Card name for API query
   * @param hp - HP value for matching
   * @returns Enrichment result with price data and quota status
   */
  async getPrice(
    canonicalSku: string,
    listingSku: string,
    condition: string,
    cardName: string,
    hp?: number,
  ): Promise<EnrichmentResult> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, "cards_query");

    // Step 1: Check cache
    const cached = await this.fetchFromCache(cacheKey);
    if (cached) {
      const priceData: PriceData = {
        market_price: cached.market_price,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: cached.ppt_card_id ?? undefined,
        hp_value: cached.hp_value ?? undefined,
        total_set_number: cached.total_set_number ?? undefined,
        enrichment_signals: this.parseCachedSignals(cached.enrichment_signals),
        cached_at: cached.cached_at,
      };

      return {
        success: true,
        priceData,
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        fromCache: true,
      };
    }

    // Step 2: Check quota before API call
    if (this.lastQuotaCheck && !this.checkQuotaAllowance(this.lastQuotaCheck)) {
      this.logger.warn({ canonicalSku, listingSku, condition }, "Skipping PPT call due to quota limit");

      return {
        success: false,
        priceData: {
          market_price: null,
          pricing_source: "ppt",
          pricing_status: "missing",
        },
        quotaStatus: this.lastQuotaCheck,
        error: "Quota exhausted",
        fromCache: false,
      };
    }

    // Step 3: Call PPT cards API (legacy/default path)
    try {
      const { data, headers } = await this.callPPTCards({
        name: cardName,
        hp,
        limit: 1,
      });

      const rateLimits = this.parseRateLimitHeaders(headers);
      const quotaStatus = this.updateQuotaStatus(rateLimits, "getPrice");

      if (data.data.length === 0) {
        this.logger.debug({ canonicalSku, listingSku, cardName, hp }, "No PPT results found");

        return {
          success: false,
          priceData: {
            market_price: null,
            pricing_source: "ppt",
            pricing_status: "missing",
          },
          quotaStatus,
          error: "No results",
          fromCache: false,
        };
      }

      // Find best match (prefer exact HP match if available)
      let bestMatch: PPTCard = data.data[0];
      if (hp !== undefined) {
        const hpMatch = data.data.find((card) => card.hp === hp);
        if (hpMatch) {
          bestMatch = hpMatch;
        }
      }

      const priceData: PriceData = {
        market_price: bestMatch.prices?.market ?? null,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: bestMatch.id,
        hp_value: bestMatch.hp,
        total_set_number: bestMatch.totalSetNumber,
        enrichment_signals: {
          lookupStrategy: "cards_query",
          cardType: bestMatch.cardType,
          rarity: bestMatch.rarity,
          attacks: bestMatch.attacks?.map((a) => a.name) ?? [],
        },
        cached_at: Math.floor(Date.now() / 1000),
      };

      // Write to cache
      await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
        strategy: "cards_query",
        ttlHours: FUZZY_CACHE_TTL_HOURS,
      });

      this.logger.info(
        {
          canonicalSku,
          listingSku,
          condition,
          market_price: priceData.market_price,
          ppt_card_id: priceData.ppt_card_id,
          fromCache: false,
        },
        "PPT enrichment successful",
      );

      return {
        success: true,
        priceData,
        quotaStatus,
        fromCache: false,
        lookupStrategy: "cards_query",
      };
    } catch (error) {
      this.logger.error({ error, canonicalSku, listingSku, cardName }, "PPT API call failed");

      return {
        success: false,
        priceData: {
          market_price: null,
          pricing_source: "ppt",
          pricing_status: "missing",
        },
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        error: error instanceof Error ? error.message : "Unknown error",
        fromCache: false,
      };
    }
  }

  /**
   * Enrich price using PPT parse-title endpoint.
   * Caps cost to ~3 credits: base(2) + fuzzyMatching(1), avoiding >100 chars and >5 suggestions.
   */
  async getPriceByCardsQuery(
    canonicalSku: string,
    listingSku: string,
    condition: string,
    opts: {
      setSlug?: string;
      setName?: string;
      cardNumber?: string;
      cardName?: string;
      hp?: number;
      language?: "english" | "japanese";
      pptCardId?: string | null;
      tcgPlayerId?: string | null;
      skipCacheWrite?: boolean;
    },
  ): Promise<EnrichmentResult> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, "cards_query");

    // Cache check
    const cached = await this.fetchFromCache(cacheKey);
    if (cached) {
      const priceData: PriceData = {
        market_price: cached.market_price,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: cached.ppt_card_id ?? undefined,
        hp_value: cached.hp_value ?? undefined,
        total_set_number: cached.total_set_number ?? undefined,
        enrichment_signals: this.parseCachedSignals(cached.enrichment_signals),
        cached_at: cached.cached_at,
      };
      return {
        success: true,
        priceData,
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        fromCache: true,
        lookupStrategy: "cards_query",
      };
    }

    // Quota guard
    if (this.lastQuotaCheck && !this.checkQuotaAllowance(this.lastQuotaCheck)) {
      this.logger.warn({ canonicalSku, listingSku, condition }, "Skipping PPT cards query due to quota limit");
      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck,
        error: "Quota exhausted",
        fromCache: false,
        lookupStrategy: "cards_query",
      };
    }

    const language = opts.language ?? "english";
    const normalizedCardNumber = opts.cardNumber ? normalizeCardNumber(opts.cardNumber) : undefined;
    const queryAttempts: Array<{ reason: string; params: Record<string, string | number | boolean | undefined> }> = [];

    if (opts.pptCardId) {
      queryAttempts.push({
        reason: "ppt_card_id",
        params: { cardId: opts.pptCardId, language, limit: 1 },
      });
    }

    if (opts.tcgPlayerId) {
      queryAttempts.push({
        reason: "tcgplayer_id",
        params: {
          tcgPlayerId: opts.tcgPlayerId,
          set: opts.setSlug,
          // NOTE: cardNumber is NOT a valid PPT API param - filtering is done client-side by selectBestCandidate
          language,
          limit: 5, // Get multiple results for client-side filtering
        },
      });
    }

    if (opts.setSlug || opts.setName || opts.cardName) {
      queryAttempts.push({
        reason: "set_search",
        params: {
          set: opts.setSlug ?? opts.setName,
          // NOTE: cardNumber is NOT a valid PPT API param - filtering is done client-side by selectBestCandidate
          search: opts.cardName,
          language,
          limit: 10, // Get more results for client-side cardNumber filtering
        },
      });
    }

    // Absolute fallback: search without set (only if we have cardName and no prior set-based attempt)
    if (opts.cardName && !opts.setSlug && !opts.setName) {
      queryAttempts.push({
        reason: "search_fallback",
        params: {
          search: opts.cardName,
          // NOTE: cardNumber is NOT a valid PPT API param - filtering is done client-side by selectBestCandidate
          language,
          limit: 10,
        },
      });
    }

    let lastQuotaStatus: QuotaStatus =
      this.lastQuotaCheck ?? {
        tier: this.config.tier,
        dailyLimit: this.config.dailyLimit,
        dailyRemaining: null,
        minuteRemaining: null,
        callsConsumed: null,
        warningLevel: "ok",
        shouldHalt: false,
      };
    let lastError: string | undefined;

    for (const attempt of queryAttempts) {
      try {
        const { data, headers } = await this.callPPTCardsGeneric(attempt.params);
        const rateLimits = this.parseRateLimitHeaders(headers);
        lastQuotaStatus = this.updateQuotaStatus(rateLimits, "cardsQuery");

        const candidates = Array.isArray((data as any).data) ? (data as any).data : [];
        const bestMatch = this.selectBestCandidate(candidates as PPTCardFull[], {
          cardNumber: opts.cardNumber,
          setSlug: opts.setSlug,
          setName: opts.setName,
          cardName: opts.cardName,
        });

        if (!bestMatch) {
          this.logger.warn(
            { canonicalSku, listingSku, attempt: attempt.reason, candidateCount: candidates.length },
            "PPT cards query returned no matching candidate (set/cardNumber validation failed)",
          );
          continue;
        }

        const marketPrice = this.extractConditionPrice(bestMatch.prices as any, condition);
        if (marketPrice == null) {
          this.logger.warn(
            { canonicalSku, listingSku, attempt: attempt.reason, ppt_card_id: bestMatch.id },
            "PPT cards query match missing price data for requested condition",
          );
          continue;
        }
        const priceData: PriceData = {
          market_price: marketPrice,
          pricing_source: "ppt",
          pricing_status: "fresh",
          ppt_card_id: bestMatch.id,
          hp_value: bestMatch.hp,
          total_set_number: bestMatch.totalSetNumber,
          enrichment_signals: {
            lookupStrategy: "cards_query",
            setName: bestMatch.setName,
            cardNumber: bestMatch.cardNumber ?? null,
            attemptReason: attempt.reason,
            requestParams: attempt.params,
            cardSummary: {
              name: bestMatch.name,
              setName: bestMatch.setName,
              cardNumber: bestMatch.cardNumber ?? null,
              totalSetNumber: bestMatch.totalSetNumber ?? null,
              rarity: bestMatch.rarity ?? null,
              cardType: bestMatch.cardType ?? null,
              hp: bestMatch.hp ?? null,
              tcgPlayerId: bestMatch.tcgPlayerId ?? null,
            },
          },
          cached_at: Math.floor(Date.now() / 1000),
        };

        if (!opts.skipCacheWrite) {
          await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
            strategy: "cards_query",
            ttlHours: FUZZY_CACHE_TTL_HOURS,
          });
        }

        this.logger.info(
          {
            canonicalSku,
            listingSku,
            condition,
            market_price: priceData.market_price,
            ppt_card_id: priceData.ppt_card_id,
            attempt: attempt.reason,
            fromCache: false,
          },
          "PPT cards query enrichment successful",
        );

        return {
          success: true,
          priceData,
          quotaStatus: lastQuotaStatus,
          fromCache: false,
          lookupStrategy: "cards_query",
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { canonicalSku, listingSku, condition, attempt: attempt.reason, error: lastError },
          "PPT cards query attempt failed",
        );
      }
    }

    return {
      success: false,
      priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
      quotaStatus: lastQuotaStatus,
      error: lastError ?? "No matching candidates",
      fromCache: false,
      lookupStrategy: "cards_query",
    };
  }

  async getPriceByParsedTitle(
    canonicalSku: string,
    listingSku: string,
    condition: string,
    title: string,
    opts?: {
      fuzzyMatching?: boolean;
      includeConfidence?: boolean;
      maxSuggestions?: number;
      strictMode?: boolean;
      includeMetadata?: boolean;
      ignoreQuota?: boolean;
      skipCacheWrite?: boolean;
    },
  ): Promise<EnrichmentResult> {
    const cacheKey = this.generateCacheKey(canonicalSku, condition, "parseTitle");

    // Step 1: Cache check
    const cached = await this.fetchFromCache(cacheKey);
    if (cached) {
      const priceData: PriceData = {
        market_price: cached.market_price,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: cached.ppt_card_id ?? undefined,
        hp_value: cached.hp_value ?? undefined,
        total_set_number: cached.total_set_number ?? undefined,
        enrichment_signals: this.parseCachedSignals(cached.enrichment_signals),
        cached_at: cached.cached_at,
      };
      return {
        success: true,
        priceData,
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        fromCache: true,
        lookupStrategy: "parse_title",
      };
    }

    // Step 2: Quota guard
    if (!opts?.ignoreQuota && this.lastQuotaCheck && !this.checkQuotaAllowance(this.lastQuotaCheck)) {
      this.logger.warn({ canonicalSku, listingSku, condition }, "Skipping PPT parse-title due to quota limit");
      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck,
        error: "Quota exhausted",
        fromCache: false,
      };
    }

    // Step 3: Prepare capped-cost request
    const hardOpts = {
      fuzzyMatching: opts?.fuzzyMatching ?? true, // +1 credit
      includeConfidence: opts?.includeConfidence ?? true,
      maxSuggestions: Math.min(Math.max(opts?.maxSuggestions ?? 4, 1), 4), // cap at 4 to avoid +1 credit
      strictMode: opts?.strictMode ?? false,
      includeMetadata: opts?.includeMetadata ?? true,
    };

    // Enforce title length cap (<100 chars to avoid +1 credit). Keep >=3.
    const trimmedTitle = (() => {
      const t = (title || "").trim();
      const MIN = 3;
      const MAX = 99; // below 100 to avoid extra credit
      if (t.length <= MAX && t.length >= MIN) return t;
      if (t.length < MIN) return t.padEnd(MIN, " ").slice(0, MIN);
      // Truncate gracefully at word boundary if possible
      const slice = t.slice(0, MAX);
      const lastSpace = slice.lastIndexOf(" ");
      return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim();
    })();

    try {
      const { data, headers } = await this.callPPTParseTitle({ title: trimmedTitle, options: hardOpts });

      const rateLimits = this.parseRateLimitHeaders(headers);
      const quotaStatus = this.updateQuotaStatus(rateLimits, "parseTitle");

      const parsePayload: any = data?.data ?? [];
      const matches: PPTParseMatch[] = Array.isArray(parsePayload)
        ? parsePayload
        : Array.isArray(parsePayload?.matches)
          ? parsePayload.matches
          : [];
      const parserMeta = !Array.isArray(parsePayload) ? parsePayload : null;

      // Log to audit CSV (regardless of success/failure)
      this.auditLogger.logParseTitleEnrichment({
        listingSku,
        condition,
        requestTitle: trimmedTitle,
        rateLimits,
        matches,
        metadata: data?.metadata ?? { total: matches.length, count: matches.length, limit: matches.length, offset: 0, hasMore: false },
        fullResponse: data,
      });

      if (!Array.isArray(matches) || matches.length === 0) {
        this.logger.debug({ canonicalSku, listingSku, title: trimmedTitle }, "No PPT parse-title matches");
        return {
          success: false,
          priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
          quotaStatus,
          error: "No results",
          fromCache: false,
        };
      }

      // Choose best match by confidence when available
      let bestMatch: PPTParseMatch = matches[0];
      if (hardOpts.includeConfidence) {
        const byConf = [...matches].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        if (byConf[0]) bestMatch = byConf[0];
      }

      const priceData: PriceData = {
        market_price: bestMatch?.prices?.market ?? null,
        pricing_source: "ppt",
        pricing_status: "fresh",
        ppt_card_id: bestMatch.id,
        hp_value: bestMatch?.hp,
        total_set_number: bestMatch?.totalSetNumber,
        enrichment_signals: {
          lookupStrategy: "parse_title",
          cardType: bestMatch?.cardType,
          rarity: bestMatch?.rarity,
          attacks: bestMatch?.attacks?.map((a) => a.name) ?? [],
          setName: bestMatch?.setName,
          cardNumber: bestMatch?.cardNumber,
          tcgPlayerId: bestMatch?.tcgPlayerId,
          parseTitle: {
            requestedTitle: trimmedTitle,
            includeConfidence: hardOpts.includeConfidence,
            maxSuggestions: hardOpts.maxSuggestions,
            strictMode: hardOpts.strictMode,
            confidence: bestMatch?.confidence ?? null,
            metadata: data?.metadata ?? null,
            parser: parserMeta
              ? {
                  originalTitle: parserMeta.originalTitle ?? null,
                  sanitizedTitle: parserMeta.sanitizedTitle ?? null,
                  parsedConfidence: parserMeta.parsed?.confidence ?? null,
                  parsedCardName: parserMeta.parsed?.cardName ?? null,
                  parsedVariant: parserMeta.parsed?.variant ?? null,
                }
              : null,
            parsed: {
              title: bestMatch.name,
              normalized: `${bestMatch.name} - ${bestMatch.setName}${bestMatch.cardNumber ? ` #${bestMatch.cardNumber}` : ""}`,
              name: bestMatch.name,
              setName: bestMatch.setName,
              cardNumber: bestMatch.cardNumber ?? null,
            },
            allMatches: matches.map((match, index) => ({
              rank: index + 1,
              id: match.id,
              name: match.name,
              setName: match.setName,
              cardNumber: match.cardNumber ?? null,
              totalSetNumber: match.totalSetNumber ?? null,
              hp: match.hp ?? null,
              cardType: match.cardType ?? null,
              rarity: match.rarity ?? null,
              confidence: match.confidence ?? null,
              marketPrice: match.prices?.market ?? null,
              isBestMatch: match.id === bestMatch.id,
            })),
          },
        },
        cached_at: Math.floor(Date.now() / 1000),
      };

      if (!opts?.skipCacheWrite) {
        await this.writeToCache(priceData, canonicalSku, listingSku, condition, {
          strategy: "parseTitle",
          ttlHours: FUZZY_CACHE_TTL_HOURS,
        });
      }

      this.logger.info(
        { canonicalSku, listingSku, condition, market_price: priceData.market_price, ppt_card_id: priceData.ppt_card_id, fromCache: false },
        "PPT parse-title enrichment successful",
      );

      return { success: true, priceData, quotaStatus, fromCache: false, lookupStrategy: "parse_title" };
    } catch (error) {
      this.logger.error(
        {
          error,
          canonicalSku,
          listingSku,
          title: trimmedTitle,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "PPT parse-title call failed",
      );
      return {
        success: false,
        priceData: { market_price: null, pricing_source: "ppt", pricing_status: "missing" },
        quotaStatus: this.lastQuotaCheck ?? {
          tier: this.config.tier,
          dailyLimit: this.config.dailyLimit,
          dailyRemaining: null,
          minuteRemaining: null,
          callsConsumed: null,
          warningLevel: "ok",
          shouldHalt: false,
        },
        error: error instanceof Error ? error.message : "Unknown error",
        fromCache: false,
      };
    }
  }

  /**
   * Search cards for Path C Set Triangulation.
   * Simple search by card name with configurable limit and timeout.
   * Returns raw PPT cards for signal-based filtering.
   *
   * @param cardName - Card name to search
   * @param limit - Max results (default 50)
   * @param timeoutMs - Request timeout in ms (default from config)
   * @returns Array of PPTCardFull objects and quota status
   */
  async searchCardsForTriangulation(
    cardName: string,
    limit: number = 50,
    timeoutMs?: number
  ): Promise<{ cards: PPTCardFull[]; quotaStatus: QuotaStatus | null; creditsUsed: number }> {
    // Quota guard - WARN only, do NOT halt Path C calls per TDD spec
    // The operator should see quota warnings in the UI, but Path C should not be gated
    if (this.lastQuotaCheck?.shouldHalt) {
      this.logger.warn(
        { cardName, dailyRemaining: this.lastQuotaCheck.dailyRemaining },
        "Path C triangulation proceeding despite quota warning (warn-only policy)"
      );
    }

    const url = new URL(`${this.config.baseUrl}/api/v2/cards`);
    url.searchParams.set("search", cardName);
    url.searchParams.set("limit", String(limit));

    const effectiveTimeout = timeoutMs ?? this.config.timeoutMs;

    this.logger.debug({ url: url.toString(), cardName, limit, timeoutMs: effectiveTimeout }, "Path C: Searching PPT for triangulation");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const errorType = response.status === 429 ? "Rate limit exceeded" : "Service unavailable";
          this.logger.warn(
            { status: response.status, statusText: response.statusText, url: url.toString() },
            `Path C PPT_OUTAGE_OR_RATE_LIMIT: ${errorType}`,
          );
          throw new Error(`PPT_OUTAGE_OR_RATE_LIMIT: ${errorType} (${response.status})`);
        }
        throw new Error(`PPT API returned ${response.status}: ${response.statusText}`);
      }

      const rateLimits = this.parseRateLimitHeaders(response.headers);
      const quotaStatus = this.updateQuotaStatus(rateLimits, "searchCardsForTriangulation");

      const json = (await response.json()) as PPTCardsResponse;
      const cards = Array.isArray(json.data) ? json.data : [];

      this.logger.debug(
        { cardName, resultCount: cards.length, creditsUsed: rateLimits.callsConsumed ?? 1 },
        "Path C: PPT triangulation search complete"
      );

      return {
        cards,
        quotaStatus,
        creditsUsed: rateLimits.callsConsumed ?? 1,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        this.logger.warn({ cardName, timeoutMs: effectiveTimeout }, "Path C: PPT triangulation search timed out");
        throw new Error(`PPT triangulation timeout after ${effectiveTimeout}ms`);
      }

      throw error;
    }
  }
}
