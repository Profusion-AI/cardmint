/**
 * PPT Title Builder - Unified helper for building PriceCharting parseTitle requests
 *
 * Used by both /api/operator/enrich/ppt and /api/operator/enrich/ppt/preview
 * to ensure consistent query construction from card extraction data.
 */

export interface TitleBuilderContext {
  /** Fallback name if card_name extraction is missing */
  fallbackName: string;
  /** Optional canonical set name from cm_cards/cm_sets lookup */
  canonicalSetName?: string | null;
  /** Optional canonical collector number from cm_cards */
  canonicalCollectorNo?: string | null;
  /** Optional canonical rarity from cm_cards (used to infer holo variants) */
  canonicalRarity?: string | null;
}

/**
 * Builds an enhanced PriceCharting parseTitle query string from extraction data
 * and optional canonical context hints.
 *
 * Output format: "{card_name} {collector_number} {set_name} {variant_hints}"
 * Example: "Vulpix 14/108 Pokemon Evolutions Reverse Holo"
 *
 * @param extracted - Path A extraction result (card_name, set_number, holo_type, etc.)
 * @param context - Context with fallback name and optional canonical hints
 * @returns Enhanced query string for PPT parseTitle endpoint
 */
export function buildParseTitleFromExtraction(
  extracted: any | null,
  context: TitleBuilderContext
): string {
  const tokens: string[] = [];

  // 1. Card name
  const rawName = (extracted?.card_name || context.fallbackName || "").toString().trim();
  if (rawName) {
    tokens.push(rawName.replace(/\s+/g, " "));
  }

  // 2. Collector number (normalize and preserve full fraction like "14/108")
  // IMPORTANT: Prefer canonical over extraction to avoid Path A misidentification
  const normalizedCollector = (() => {
    const extractedNumber = typeof extracted?.set_number === "string" ? extracted.set_number : null;
    const canonicalNumber = context.canonicalCollectorNo ?? null;
    const raw = (canonicalNumber?.trim() || extractedNumber?.trim() || "").replace(/\s+/g, "");
    if (!raw) return "";

    if (raw.includes("/")) {
      const [left, right] = raw.split("/");
      const cleanedLeft = (left ?? "").replace(/[^0-9A-Za-z-]/g, "");
      const cleanedRight = (right ?? "").replace(/[^0-9A-Za-z-]/g, "");
      const numerator = cleanedLeft.replace(/^0+/, "") || cleanedLeft || left;
      if (cleanedRight.length > 0) {
        return `${numerator || left}/${cleanedRight}`;
      }
      return numerator || left;
    }

    const digits = raw.replace(/[^0-9A-Za-z-]/g, "");
    return digits.replace(/^0+/, "") || digits || raw;
  })();

  if (normalizedCollector) {
    tokens.push(normalizedCollector);
  }

  // 3. Set name (prefer canonical over extraction to avoid Path A misidentification)
  const setName = (context.canonicalSetName || extracted?.set_name || "").toString().trim();
  if (setName) {
    tokens.push(setName.replace(/\s+/g, " "));
  }

  // 4. Variant hints (holo type, first edition, shadowless)
  const variantHints: string[] = [];
  const holoType = typeof extracted?.holo_type === "string" ? extracted.holo_type : null;
  const holoLabelMap: Record<string, string> = {
    holo: "Holo",
    reverse_holo: "Reverse Holo",
    non_holo: "Non Holo",
  };

  // Only add holo hint from extraction if it doesn't conflict with canonical rarity
  // (e.g., don't add "Holo" hint if canonical rarity is "Common")
  if (holoType && holoType !== "unknown") {
    const canonicalRarityLower = (context.canonicalRarity ?? "").toLowerCase();
    const isCanonicalCommon = canonicalRarityLower.includes("common") && !canonicalRarityLower.includes("uncommon");

    // Skip holo hints if canonical rarity explicitly says Common (extraction data may be wrong)
    if (holoType === "holo" && isCanonicalCommon) {
      // Don't add holo hint - extraction data conflicts with canonical
    } else {
      variantHints.push(holoLabelMap[holoType] ?? holoType);
    }
  }

  if (extracted?.first_edition_stamp === true) {
    variantHints.push("First Edition");
  }

  if (extracted?.shadowless === true) {
    variantHints.push("Shadowless");
  }

  // Fallback: infer holo from canonical rarity if extraction didn't provide it
  // Only add if no variant hints were provided by extraction
  if (variantHints.length === 0 && typeof context.canonicalRarity === "string") {
    const rarityLower = context.canonicalRarity.toLowerCase();
    // Add holo hint if rarity explicitly mentions holo (but not for common cards)
    if (rarityLower.includes("holo") && !rarityLower.includes("common")) {
      variantHints.push("Holo");
    }
  }

  // Also check if extraction had shadowless=true but no holo hints yet,
  // AND canonical rarity suggests holo - add both
  if (extracted?.shadowless === true && variantHints.length === 1 && variantHints[0] === "Shadowless") {
    if (typeof context.canonicalRarity === "string") {
      const rarityLower = context.canonicalRarity.toLowerCase();
      if (rarityLower.includes("holo") && !rarityLower.includes("common")) {
        variantHints.unshift("Holo"); // Add Holo before Shadowless
      }
    }
  }

  for (const hint of variantHints) {
    tokens.push(hint);
  }

  return tokens
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
