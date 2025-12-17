/**
 * LotBuilder Service
 * Multi-card bundle discount calculation with quantity tiers and synergy bonuses
 */

import type {
  LotBuilderItem,
  LotBuilderReasonCode,
  LotBuilderResult,
} from "./types";

const MAX_DISCOUNT_PCT = 15;

export class LotBuilderService {
  /**
   * Calculate discount for a lot of cards based on quantity and synergy bonuses.
   *
   * Discount Tiers by Quantity:
   * - 1 card = 0%
   * - 2 cards = 3%
   * - 3-4 cards = 5%
   * - 5+ cards = 7%
   * - Max cap: 15%
   *
   * Synergy Bonuses (additive, +1% each):
   * - SET_SYNERGY: 2+ cards from same set (+1%)
   * - RARITY_CLUSTER: 2+ cards of same rarity (+1%)
   * - CONDITION_MATCH: All cards same condition (+1%)
   */
  calculateDiscount(items: LotBuilderItem[]): LotBuilderResult {
    if (items.length === 0) {
      return {
        discountPct: 0,
        reasonCode: "NONE",
        reasonTags: [],
        reasonText: "No items in lot",
        subtotalBeforeDiscountCents: 0,
        discountAmountCents: 0,
        finalTotalCents: 0,
      };
    }

    // Calculate base discount from quantity
    const baseDiscountPct = this.getQuantityDiscount(items.length);

    // Calculate synergy bonuses
    const synergies = this.calculateSynergies(items);
    const synergyBonusPct = synergies.bonuses.length;

    // Total discount (capped at MAX_DISCOUNT_PCT)
    const totalDiscountPct = Math.min(
      baseDiscountPct + synergyBonusPct,
      MAX_DISCOUNT_PCT
    );

    // Calculate monetary amounts
    const subtotalBeforeDiscountCents = items.reduce(
      (sum, item) => sum + item.price_cents,
      0
    );

    const discountAmountCents = Math.floor(
      (subtotalBeforeDiscountCents * totalDiscountPct) / 100
    );

    const finalTotalCents = subtotalBeforeDiscountCents - discountAmountCents;

    // Determine reason code and text
    const reasonCode = this.determineReasonCode(
      items.length,
      synergies.bonuses
    );
    const reasonTags = this.buildReasonTags(synergies.bonuses);
    const reasonText = this.buildReasonText(
      items.length,
      totalDiscountPct,
      synergies
    );

    return {
      discountPct: totalDiscountPct,
      reasonCode,
      reasonTags,
      reasonText,
      subtotalBeforeDiscountCents,
      discountAmountCents,
      finalTotalCents,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getQuantityDiscount(itemCount: number): number {
    if (itemCount === 1) return 0;
    if (itemCount === 2) return 3;
    if (itemCount >= 3 && itemCount <= 4) return 5;
    if (itemCount >= 5) return 7;
    return 0;
  }

  private calculateSynergies(
    items: LotBuilderItem[]
  ): { bonuses: string[]; setSynergy: boolean; rarityCluster: boolean; conditionMatch: boolean } {
    const bonuses: string[] = [];

    // SET_SYNERGY: 2+ cards from same set
    const setSynergy = this.hasSetSynergy(items);
    if (setSynergy) {
      bonuses.push("set-synergy");
    }

    // RARITY_CLUSTER: 2+ cards of same rarity
    const rarityCluster = this.hasRarityCluster(items);
    if (rarityCluster) {
      bonuses.push("rarity-cluster");
    }

    // CONDITION_MATCH: All cards same condition
    const conditionMatch = this.hasConditionMatch(items);
    if (conditionMatch) {
      bonuses.push("condition-match");
    }

    return { bonuses, setSynergy, rarityCluster, conditionMatch };
  }

  private hasSetSynergy(items: LotBuilderItem[]): boolean {
    const setCounts = new Map<string, number>();
    for (const item of items) {
      const normalizedSet = item.set_name.trim().toLowerCase();
      if (normalizedSet) {
        setCounts.set(normalizedSet, (setCounts.get(normalizedSet) ?? 0) + 1);
      }
    }

    // Check if any set has 2+ cards
    for (const count of setCounts.values()) {
      if (count >= 2) return true;
    }
    return false;
  }

  private hasRarityCluster(items: LotBuilderItem[]): boolean {
    const rarityCounts = new Map<string, number>();
    for (const item of items) {
      const normalizedRarity = item.rarity.trim().toLowerCase();
      if (normalizedRarity) {
        rarityCounts.set(
          normalizedRarity,
          (rarityCounts.get(normalizedRarity) ?? 0) + 1
        );
      }
    }

    // Check if any rarity has 2+ cards
    for (const count of rarityCounts.values()) {
      if (count >= 2) return true;
    }
    return false;
  }

  private hasConditionMatch(items: LotBuilderItem[]): boolean {
    if (items.length <= 1) return false;

    const firstCondition = items[0].condition.trim().toLowerCase();
    if (!firstCondition) return false;

    return items.every(
      (item) => item.condition.trim().toLowerCase() === firstCondition
    );
  }

  private determineReasonCode(
    itemCount: number,
    bonuses: string[]
  ): LotBuilderReasonCode {
    // Priority order for reason codes based on synergies present
    if (bonuses.includes("set-synergy")) {
      return "SET_SYNERGY";
    }
    if (bonuses.includes("rarity-cluster")) {
      return "RARITY_CLUSTER";
    }
    if (bonuses.includes("condition-match")) {
      return "CONDITION_MATCH";
    }

    // No synergies, just quantity discount
    if (itemCount >= 2) {
      return "QUANTITY_ONLY";
    }

    return "NONE";
  }

  private buildReasonTags(bonuses: string[]): string[] {
    return [...bonuses];
  }

  private buildReasonText(
    itemCount: number,
    totalDiscountPct: number,
    synergies: {
      setSynergy: boolean;
      rarityCluster: boolean;
      conditionMatch: boolean;
    }
  ): string {
    if (itemCount === 1 || totalDiscountPct === 0) {
      return "Add more cards to unlock bundle discounts!";
    }

    // Synergy-based messages (prioritize most compelling story)
    if (synergies.setSynergy) {
      return `Save ${totalDiscountPct}% on ${itemCount} cards from the same set!`;
    }

    if (synergies.rarityCluster) {
      return `Save ${totalDiscountPct}% on ${itemCount} cards with matching rarity!`;
    }

    if (synergies.conditionMatch) {
      return `Save ${totalDiscountPct}% on ${itemCount} cards in matching condition!`;
    }

    // Quantity-only discount
    return `Bundle discount: ${totalDiscountPct}% off your ${itemCount}-card lot`;
  }
}

export const lotBuilderService = new LotBuilderService();
