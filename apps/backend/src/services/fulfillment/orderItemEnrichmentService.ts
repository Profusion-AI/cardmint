/**
 * Order Item Enrichment Service
 *
 * Enriches marketplace order items with market-derived pricing and card images.
 * Uses PPT as primary source with TCGDex fallback.
 *
 * Architecture:
 * 1. Try PPT via getPriceByCardsQuery (condition-aware pricing)
 * 2. If PPT fails → TCGDex fallback (NM market + condition discount)
 * 3. Images always from TCGDex (even if PPT provided price)
 */

import type * as Database from "better-sqlite3";
import type { Logger } from "pino";
import type { PokePriceTrackerAdapter } from "../pricing/pptAdapter.js";
import { TCGDexAdapter } from "../pricing/tcgdexAdapter.js";

/**
 * Condition normalization map.
 * Maps various condition strings to standardized abbreviations.
 */
const CONDITION_NORMALIZE: Record<string, string> = {
  // Verbose → abbreviated
  "Near Mint": "NM",
  "Lightly Played": "LP",
  "Moderately Played": "MP",
  "Heavily Played": "HP",
  Damaged: "DMG",
  // Already abbreviated - pass through
  NM: "NM",
  LP: "LP",
  MP: "MP",
  HP: "HP",
  DMG: "DMG",
  // TCGPlayer variants
  "Near Mint Holofoil": "NM",
  "Lightly Played Holofoil": "LP",
  "Moderately Played Holofoil": "MP",
  "Heavily Played Holofoil": "HP",
  "Damaged Holofoil": "DMG",
  // Additional common formats
  "near mint": "NM",
  "lightly played": "LP",
  "moderately played": "MP",
  "heavily played": "HP",
  damaged: "DMG",
  nm: "NM",
  lp: "LP",
  mp: "MP",
  hp: "HP",
  dmg: "DMG",
};

/**
 * Condition discount multipliers for TCGDex fallback.
 * TCGDex only provides NM market price, so we apply discounts for other conditions.
 */
const CONDITION_DISCOUNT: Record<string, number> = {
  NM: 1.0,
  LP: 0.85,
  MP: 0.7,
  HP: 0.5,
  DMG: 0.3,
};

/**
 * Input order item from marketplace_order_items table.
 */
export interface OrderItem {
  id: number;
  product_name: string;
  tcgplayer_sku_id: string | null;
  set_name: string | null;
  card_number: string | null;
  condition: string | null;
  rarity: string | null;
  product_line: string | null;
  quantity: number;
  unit_price_cents: number | null;
  price_confidence: "exact" | "estimated" | "unavailable";
  image_url: string | null;
}

/**
 * Enriched order item with market-derived pricing and card image.
 */
export interface EnrichedOrderItem extends OrderItem {
  // New enriched fields
  derivedUnitPriceCents: number | null;
  priceSource: "ppt" | "tcgdex" | "unavailable";
  priceLabel: string | null; // e.g., "PPT LP" or "TCGPlayer unlimited market (NM estimate)"
  cardImageUrl: string | null;
}

interface EnrichmentServiceOptions {
  concurrencyLimit?: number; // default: 3
  perItemTimeoutMs?: number; // default: 8000ms
}

export class OrderItemEnrichmentService {
  private readonly tcgdexAdapter: TCGDexAdapter;
  private readonly concurrencyLimit: number;
  private readonly perItemTimeoutMs: number;

  constructor(
    private readonly pptAdapter: PokePriceTrackerAdapter | null,
    private readonly db: Database.Database,
    private readonly logger: Logger,
    opts?: EnrichmentServiceOptions
  ) {
    this.tcgdexAdapter = new TCGDexAdapter(db, logger, 5000);
    this.concurrencyLimit = opts?.concurrencyLimit ?? 3;
    this.perItemTimeoutMs = opts?.perItemTimeoutMs ?? 8000;
  }

  /**
   * Normalize condition string to standardized abbreviation.
   */
  private normalizeCondition(condition: string | null): string | null {
    if (!condition) return null;
    const normalized = CONDITION_NORMALIZE[condition] ?? CONDITION_NORMALIZE[condition.trim()];
    return normalized ?? null;
  }

  /**
   * Generate cache key for market pricing lookup.
   */
  private generateCacheKey(
    setName: string,
    cardNumber: string,
    condition: string
  ): string {
    return `mkt:${setName}:${cardNumber}:${condition}`;
  }

  /**
   * Enrich a single order item with market pricing and image.
   */
  private async enrichSingleItem(item: OrderItem): Promise<EnrichedOrderItem> {
    const enrichedItem: EnrichedOrderItem = {
      ...item,
      derivedUnitPriceCents: null,
      priceSource: "unavailable",
      priceLabel: null,
      cardImageUrl: item.image_url, // Preserve existing image if any
    };

    // Validate required fields
    if (!item.set_name || !item.card_number) {
      this.logger.debug(
        { itemId: item.id, productName: item.product_name },
        "Order item missing set_name or card_number, skipping enrichment"
      );
      return enrichedItem;
    }

    const normalizedCondition = this.normalizeCondition(item.condition);
    if (!normalizedCondition) {
      this.logger.debug(
        { itemId: item.id, condition: item.condition },
        "Unknown condition, skipping price enrichment"
      );
      // Still try to get image
      return this.enrichImageOnly(item, enrichedItem);
    }

    const cacheKey = this.generateCacheKey(
      item.set_name,
      item.card_number,
      normalizedCondition
    );

    // Try PPT first (condition-aware pricing)
    if (this.pptAdapter) {
      try {
        const pptResult = await this.pptAdapter.getPriceByCardsQuery(
          cacheKey, // canonicalSku
          cacheKey, // listingSku
          normalizedCondition,
          {
            setName: item.set_name,
            cardNumber: item.card_number,
            cardName: item.product_name,
            tcgPlayerId: item.tcgplayer_sku_id,
          }
        );

        if (pptResult.success && pptResult.priceData?.market_price != null) {
          enrichedItem.derivedUnitPriceCents = Math.round(
            pptResult.priceData.market_price * 100
          );
          enrichedItem.priceSource = "ppt";
          enrichedItem.priceLabel = `PPT ${normalizedCondition}`;

          this.logger.debug(
            {
              itemId: item.id,
              priceCents: enrichedItem.derivedUnitPriceCents,
              condition: normalizedCondition,
            },
            "PPT price enrichment successful"
          );
        }
      } catch (error) {
        this.logger.warn(
          { itemId: item.id, error: (error as Error).message },
          "PPT enrichment failed, falling back to TCGDex"
        );
      }
    }

    // Fallback to TCGDex (or always fetch for image)
    try {
      const tcgdexResult = await this.tcgdexAdapter.getCardBySetAndNumber(
        item.set_name,
        item.card_number,
        { cardName: item.product_name }
      );

      if (tcgdexResult.success) {
        // Always use TCGDex image (typically higher quality)
        if (tcgdexResult.imageUrl) {
          enrichedItem.cardImageUrl = tcgdexResult.imageUrl;
        }

        // Use TCGDex price only if PPT failed
        if (
          enrichedItem.priceSource === "unavailable" &&
          tcgdexResult.marketPriceCents != null
        ) {
          // Apply condition discount since TCGDex provides NM price only
          const discount = CONDITION_DISCOUNT[normalizedCondition] ?? 1.0;
          const adjustedPrice = Math.round(tcgdexResult.marketPriceCents * discount);

          enrichedItem.derivedUnitPriceCents = adjustedPrice;
          enrichedItem.priceSource = "tcgdex";

          if (normalizedCondition === "NM") {
            enrichedItem.priceLabel = tcgdexResult.priceLabel;
          } else {
            enrichedItem.priceLabel = `${tcgdexResult.priceLabel} (${normalizedCondition} estimate)`;
          }

          this.logger.debug(
            {
              itemId: item.id,
              rawPriceCents: tcgdexResult.marketPriceCents,
              adjustedPriceCents: adjustedPrice,
              condition: normalizedCondition,
              discount,
            },
            "TCGDex price enrichment with condition adjustment"
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        { itemId: item.id, error: (error as Error).message },
        "TCGDex enrichment failed"
      );
    }

    return enrichedItem;
  }

  /**
   * Enrich item with image only (when price lookup not possible).
   */
  private async enrichImageOnly(
    item: OrderItem,
    enrichedItem: EnrichedOrderItem
  ): Promise<EnrichedOrderItem> {
    if (!item.set_name || !item.card_number) {
      return enrichedItem;
    }

    try {
      const tcgdexResult = await this.tcgdexAdapter.getCardBySetAndNumber(
        item.set_name,
        item.card_number,
        { cardName: item.product_name }
      );

      if (tcgdexResult.success && tcgdexResult.imageUrl) {
        enrichedItem.cardImageUrl = tcgdexResult.imageUrl;
      }
    } catch (error) {
      this.logger.debug(
        { itemId: item.id, error: (error as Error).message },
        "TCGDex image-only lookup failed"
      );
    }

    return enrichedItem;
  }

  /**
   * Enrich multiple order items with concurrent processing.
   * Respects concurrency limit and per-item timeout.
   */
  async enrichOrderItems(items: OrderItem[]): Promise<EnrichedOrderItem[]> {
    if (items.length === 0) {
      return [];
    }

    this.logger.info(
      { itemCount: items.length, concurrencyLimit: this.concurrencyLimit },
      "Starting order item enrichment"
    );

    const results: EnrichedOrderItem[] = [];
    const queue = [...items];

    // Process items in batches respecting concurrency limit
    while (queue.length > 0) {
      const batch = queue.splice(0, this.concurrencyLimit);

      const batchPromises = batch.map(async (item) => {
        // Wrap with timeout
        const timeoutPromise = new Promise<EnrichedOrderItem>((_, reject) => {
          setTimeout(
            () => reject(new Error("Enrichment timeout")),
            this.perItemTimeoutMs
          );
        });

        const enrichPromise = this.enrichSingleItem(item);

        try {
          return await Promise.race([enrichPromise, timeoutPromise]);
        } catch (error) {
          this.logger.warn(
            { itemId: item.id, error: (error as Error).message },
            "Item enrichment failed or timed out"
          );

          // Return item with unavailable status on failure
          return {
            ...item,
            derivedUnitPriceCents: null,
            priceSource: "unavailable" as const,
            priceLabel: null,
            cardImageUrl: item.image_url,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    const enrichedCount = results.filter(
      (r) => r.priceSource !== "unavailable"
    ).length;
    const withImageCount = results.filter((r) => r.cardImageUrl != null).length;

    this.logger.info(
      {
        totalItems: items.length,
        enrichedWithPrice: enrichedCount,
        enrichedWithImage: withImageCount,
        pptCount: results.filter((r) => r.priceSource === "ppt").length,
        tcgdexCount: results.filter((r) => r.priceSource === "tcgdex").length,
      },
      "Order item enrichment complete"
    );

    return results;
  }
}
