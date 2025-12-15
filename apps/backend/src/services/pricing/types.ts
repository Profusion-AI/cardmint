// PokePriceTracker API types and interfaces

// ============================================================================
// Sets Endpoint Types (GET /api/v2/sets)
// ============================================================================

export interface PPTSet {
  id: string;                    // PPT MongoDB ObjectId
  tcgPlayerId: string;           // TCGPlayer slug (e.g., "team-rocket")
  name: string;                  // Display name (e.g., "Team Rocket")
  series: string;                // Series grouping (e.g., "Base", "Scarlet & Violet")
  releaseDate: string;           // ISO 8601 date
  cardCount: number;
  priceGuideUrl?: string;
  hasPriceGuide: boolean;
  noPriceGuideReason?: string | null;
  imageCdnUrl?: string;
  imageCdnUrl200?: string;
  imageCdnUrl400?: string;
  imageCdnUrl800?: string;
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PPTSetsResponse {
  data: PPTSet[];
  metadata: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    language?: string;
  };
}

// ============================================================================
// Cards Endpoint Types (GET /api/v2/cards)
// ============================================================================

export interface PPTConditionPrice {
  price: number;
  listings: number;
  priceString: string;
}

export interface PPTVariantPrices {
  [condition: string]: PPTConditionPrice;
}

export interface PPTCardPrices {
  market: number | null;
  listings: number | null;
  primaryCondition?: string;
  conditions?: Record<string, PPTConditionPrice>;
  variants?: Record<string, PPTVariantPrices>;
}

export interface PPTCardFull {
  id: string;                    // PPT MongoDB ObjectId
  tcgPlayerId: string;           // TCGPlayer product ID (deterministic key)
  setId: string;                 // FK to set's MongoDB ObjectId
  setName: string;
  name: string;
  cardNumber?: string;           // e.g., "83/82"
  totalSetNumber?: string;       // e.g., "82"
  rarity?: string;
  cardType?: string;             // e.g., "Lightning", "Fire"
  hp?: number;
  stage?: string;                // e.g., "Basic", "Stage 1"
  attacks?: Array<{
    cost: string[];
    name: string;
    damage?: string;
    text?: string;
  }>;
  weakness?: {
    type: string | null;
    value: string | null;
  };
  resistance?: {
    type: string | null;
    value: string | null;
  };
  retreatCost?: number;
  artist?: string | null;
  tcgPlayerUrl?: string;
  prices?: PPTCardPrices;
  imageUrl?: string;
}

export interface PPTCardsResponse {
  data: PPTCardFull[];
  metadata: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    includes?: {
      priceHistory?: boolean;
      ebayData?: boolean;
    };
  };
}

// ============================================================================
// Existing Types
// ============================================================================

export interface PPTConfig {
  apiKey: string;
  baseUrl: string;
  tier: 'free' | 'paid';
  dailyLimit: number;
  timeoutMs: number;
}

export interface PPTPriceHistoryDataPoint {
  date: string; // ISO 8601
  market: number;
  volume: number | null;
}

export interface PPTConditionHistory {
  dataPoints: number;
  latestPrice: number;
  latestDate: string; // ISO 8601
  priceRange: {
    min: number;
    max: number;
  };
  history: PPTPriceHistoryDataPoint[];
}

export interface PPTPriceHistory {
  totalDataPoints: number;
  earliestDate: string; // ISO 8601
  latestDate: string; // ISO 8601
  conditions_tracked: string[]; // e.g., ["Near Mint", "Lightly Played", "Moderately Played"]
  conditions: Record<string, PPTConditionHistory>; // Keyed by condition name
  lastUpdated: string; // ISO 8601
}

export interface PPTCard {
  id: string;
  tcgPlayerId?: string;
  name: string;
  setName: string;
  cardNumber?: string;
  totalSetNumber?: string;
  hp?: number;
  cardType?: string;
  rarity?: string;
  stage?: string;
  attacks?: Array<{
    cost: string[];
    name: string;
    damage?: string;
  }>;
  prices?: {
    market?: number;
    low?: number;
    mid?: number;
    high?: number;
  };
  priceHistory?: PPTPriceHistory; // Present when includeHistory=true
  imageUrl?: string;
}

export interface PPTQueryParams {
  name?: string;
  setName?: string;
  cardNumber?: string;
  hp?: number;
  limit?: number;
}

export interface PPTResponse {
  data: PPTCard[];
  meta?: {
    total: number;
    page: number;
    perPage: number;
  };
}

// Parse-Title endpoint request/response (approximate per vendor docs)
export interface PPTParseTitleOptions {
  fuzzyMatching?: boolean; // default true
  includeConfidence?: boolean; // default true
  maxSuggestions?: number; // default 5 (1-10)
  strictMode?: boolean; // default false
  includeMetadata?: boolean; // default true
}

export interface PPTParseTitleRequestBody {
  title: string; // 3-500 chars (we cap below 100 to control cost)
  options?: PPTParseTitleOptions;
}

export interface PPTParseMatch extends PPTCard {
  confidence?: number; // present when includeConfidence=true
}

export interface PPTParseTitleMetadata {
  total: number;
  count: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  includes?: {
    priceHistory?: boolean;
    ebayData?: boolean;
  };
}

export interface PPTParseTitleResponse {
  data: PPTParseMatch[]; // Array of matches directly
  metadata: PPTParseTitleMetadata;
}

export interface PPTRateLimitHeaders {
  callsConsumed?: number;
  dailyRemaining?: number;
  minuteRemaining?: number;
}

export interface QuotaStatus {
  tier: 'free' | 'paid';
  dailyLimit: number;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
  callsConsumed: number | null;
  warningLevel: 'ok' | 'warning' | 'critical';
  shouldHalt: boolean;
}

export interface CachedPrice {
  cache_key: string;
  canonical_sku: string | null;
  listing_sku: string;
  condition: string;
  market_price: number | null;
  ppt_card_id: string | null;
  hp_value: number | null;
  total_set_number: string | null;
  enrichment_signals: string; // JSON blob
  cached_at: number;
  ttl_hours: number;
}

export interface PriceData {
  market_price: number | null;
  pricing_source: 'ppt' | 'csv' | 'manual';
  pricing_status: 'fresh' | 'stale' | 'missing';
  ppt_card_id?: string;
  hp_value?: number;
  total_set_number?: string;
  enrichment_signals?: Record<string, unknown>;
  cached_at?: number;
}

export interface EnrichmentResult {
  success: boolean;
  priceData: PriceData | null;
  quotaStatus: QuotaStatus;
  error?: string;
  fromCache: boolean;
  // Deterministic lookup tracking (added 2025-12-01)
  lookupStrategy?: 'tcgplayer_deterministic' | 'pricecharting_bridge' | 'parse_title' | 'cards_query' | 'csv_fallback';
  mismatchRejected?: boolean;
  outlierRejected?: boolean;
  rejectionReason?: string;
}

// ============================================================================
// Pricing Policy Helpers
// ============================================================================

/**
 * Minimum listing price floor - no card can be listed below this price.
 * This is a hard business rule to ensure profitability on all listings.
 */
export const MINIMUM_LISTING_PRICE = 0.79;

/**
 * Compute launch_price from market_price using standard 1.25x markup.
 * Rounds UP to nearest cent to ensure margin is preserved.
 * Enforces MINIMUM_LISTING_PRICE floor - no listing can go below $0.79.
 *
 * This is the single source of truth for launch_price derivation.
 * All call sites (enrichmentHelper, evershopClient, backfill scripts)
 * must use this function to ensure consistent pricing behavior.
 *
 * @param marketPrice - The market price (from PPT or CSV)
 * @returns launch_price rounded up to nearest cent, minimum $0.79
 */
export function computeLaunchPrice(marketPrice: number): number {
  const computedPrice = Math.ceil(marketPrice * 1.25 * 100) / 100;
  return Math.max(computedPrice, MINIMUM_LISTING_PRICE);
}
