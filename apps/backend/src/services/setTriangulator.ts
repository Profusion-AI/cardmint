/**
 * Path C: Set Triangulator Service
 *
 * Disambiguates set identity by triangulating multiple weak signals
 * (card number, set total, rarity, card type) against PokePriceTracker API.
 *
 * Key insight: The combination of cardNumber + totalSetNumber is highly
 * discriminative and often uniquely identifies a set.
 *
 * @see docs/TDD-PathC-SetSymbol-Disambiguation.md
 * @see /home/kyle/.claude/plans/smooth-waddling-hare.md
 */

import type * as Database from "better-sqlite3";
import type { Logger } from "pino";
import type { PPTCardFull, QuotaStatus } from "./pricing/types";
import { runtimeConfig } from "../config";

// ============================================================================
// Types
// ============================================================================

export interface ParsedSignals {
  cardName: string;
  cardNumber: string | null; // "25" or "083" (normalized, no leading zeros)
  setTotal: string | null; // "165" or "102"
  rarity: string | null;
  cardType: string | null;
  hpValue: number | null;
  shadowless: boolean | null;
  artist: string | null;
}

export interface TriangulationResult {
  setName: string | null; // Canonical set name (from canonical_sets.name)
  tcgPlayerId: string | null; // TCGPlayer slug (from canonical_sets.tcg_player_id)
  pptSetId: string | null; // PPT MongoDB ObjectId (for debugging)
  confidence: number; // 0.0 - 1.0
  matchingSignals: string[]; // ["cardNumber", "setTotal", "rarity"]
  candidateCount: number;
  uniqueSetCount: number;
  pptCreditsUsed: number;
  latencyMs: number;
  action: "hard_filter" | "soft_rerank" | "discard" | "skipped";
  quotaStatus: QuotaStatus | null; // Pass through for session quota updates
  candidates?: Array<{
    setName: string;
    tcgPlayerId: string | null;
    pptSetId: string;
  }>;
}

export interface PathCTelemetry {
  job_id: string;
  attempted: boolean;
  signals: {
    cardNumber: string | null;
    setTotal: string | null;
    rarity: string | null;
    cardType: string | null;
  };
  c1_ppt_results_count: number;
  c1_filtered_count: number;
  c1_unique_sets: number;
  c1_confidence: number;
  c1_latency_ms: number;
  c1_ppt_credits: number;
  set_applied: boolean;
  final_set_name: string | null;
  final_confidence: number;
  action: string;
}

interface PPTSearchResult {
  cards: PPTCardFull[];
  quotaStatus: QuotaStatus | null;
  creditsUsed: number;
}

// ============================================================================
// SetTriangulator Class
// ============================================================================

export class SetTriangulator {
  private readonly pptTimeoutMs: number;
  private readonly queryLimit: number;
  private readonly minSignals: number;
  private readonly hardFilterThreshold: number;
  private readonly softRerankThreshold: number;
  private readonly quotaWarningRemaining: number;

  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
    private readonly pptSearchFn: (
      cardName: string,
      limit: number,
      timeoutMs: number
    ) => Promise<PPTSearchResult>
  ) {
    this.pptTimeoutMs = runtimeConfig.pathCPptTimeoutMs;
    this.queryLimit = runtimeConfig.pathCPptQueryLimit;
    this.minSignals = runtimeConfig.pathCMinSignals;
    this.hardFilterThreshold = runtimeConfig.pathCHardFilterThreshold;
    this.softRerankThreshold = runtimeConfig.pathCSoftRerankThreshold;
    this.quotaWarningRemaining = runtimeConfig.pathCQuotaWarningRemaining;
  }

  /**
   * Parse set_number into cardNumber and setTotal.
   * Handles formats: "083/165", "83/165", "025", "SV001", "SWSH001"
   */
  parseSetNumber(setNumber: string): { cardNumber: string; setTotal: string | null } {
    if (!setNumber || typeof setNumber !== "string") {
      return { cardNumber: "", setTotal: null };
    }

    const trimmed = setNumber.trim();

    // Handle formats: "083/165", "83/165"
    const slashMatch = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (slashMatch) {
      return {
        cardNumber: slashMatch[1].replace(/^0+/, "") || "0", // "083" → "83"
        setTotal: slashMatch[2],
      };
    }

    // Promo or special format (e.g., "SV001", "SWSH001", "025")
    // Extract numeric portion if present
    const numMatch = trimmed.match(/(\d+)$/);
    if (numMatch) {
      return {
        cardNumber: numMatch[1].replace(/^0+/, "") || "0",
        setTotal: null,
      };
    }

    return { cardNumber: trimmed, setTotal: null };
  }

  /**
   * Main triangulation entry point.
   * Queries PPT and filters by signal agreement.
   */
  async triangulate(signals: ParsedSignals): Promise<TriangulationResult> {
    const startTime = Date.now();

    // Early exit if no card name
    if (!signals.cardName || signals.cardName.trim().length < 2) {
      return this.buildSkippedResult("no_card_name", startTime);
    }

    // Query PPT
    let pptResult: PPTSearchResult;
    try {
      pptResult = await this.pptSearchFn(
        signals.cardName,
        this.queryLimit,
        this.pptTimeoutMs
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Path C PPT query failed (non-blocking)");
      return this.buildSkippedResult("ppt_error", startTime);
    }

    // Check quota warning
    if (pptResult.quotaStatus?.dailyRemaining != null) {
      if (pptResult.quotaStatus.dailyRemaining <= this.quotaWarningRemaining) {
        this.logger.warn(
          {
            dailyRemaining: pptResult.quotaStatus.dailyRemaining,
            threshold: this.quotaWarningRemaining,
          },
          "Path C: PPT quota approaching limit (75% used)"
        );
      }
    }

    const { cards, creditsUsed, quotaStatus } = pptResult;

    if (!cards || cards.length === 0) {
      return this.buildResult({
        setName: null,
        tcgPlayerId: null,
        pptSetId: null,
        confidence: 0,
        matchingSignals: [],
        candidateCount: 0,
        uniqueSetCount: 0,
        pptCreditsUsed: creditsUsed,
        latencyMs: Date.now() - startTime,
        action: "skipped",
        quotaStatus,
      });
    }

    // Filter cards by signal agreement.
    // Important: when setTotal is present, it is the highest-discriminative signal. Prefer requiring it,
    // otherwise low-power signals like cardType can accidentally admit many reprints (e.g. Grass #45).
    const strictFiltered = this.filterStrictByNumberAndTotal(cards, signals);
    const filtered = strictFiltered.length > 0 ? strictFiltered : this.filterBySignals(cards, signals);

    if (filtered.length === 0) {
      return this.buildResult({
        setName: null,
        tcgPlayerId: null,
        pptSetId: null,
        confidence: 0,
        matchingSignals: [],
        candidateCount: cards.length,
        uniqueSetCount: this.countUniqueSets(cards),
        pptCreditsUsed: creditsUsed,
        latencyMs: Date.now() - startTime,
        action: "discard",
        quotaStatus,
      });
    }

    // Compute confidence and select best match
    const result = this.scoreAndSelect(filtered, signals, cards.length, creditsUsed, startTime);

    // Attach quotaStatus for session quota updates
    result.quotaStatus = quotaStatus;

    // Look up canonical set name from ppt_set_id
    if (result.pptSetId) {
      const canonical = this.lookupCanonicalSet(result.pptSetId);
      if (canonical) {
        result.setName = canonical.name;
        result.tcgPlayerId = canonical.tcgPlayerId;
      }
    }

    // Determine action based on confidence
    if (result.confidence >= this.hardFilterThreshold) {
      result.action = "hard_filter";
    } else if (result.confidence >= this.softRerankThreshold) {
      result.action = "soft_rerank";
    } else {
      result.action = "discard";
    }

    this.logger.info(
      {
        signals: {
          cardName: signals.cardName,
          cardNumber: signals.cardNumber,
          setTotal: signals.setTotal,
        },
        filter: {
          mode: strictFiltered.length > 0 ? "strict_number_total" : "min_signals",
          minSignals: this.minSignals,
          filteredCount: filtered.length,
        },
        result: {
          setName: result.setName,
          confidence: result.confidence,
          action: result.action,
          candidateCount: result.candidateCount,
          uniqueSetCount: result.uniqueSetCount,
        },
      },
      "Path C triangulation complete"
    );

    return result;
  }

  /**
   * Filter PPT cards by signal agreement.
   * Requires at least minSignals matching signals to pass.
   */
  private filterBySignals(cards: PPTCardFull[], signals: ParsedSignals): PPTCardFull[] {
    return cards.filter((card) => {
      const matchCount = this.countMatchingSignals(card, signals);
      return matchCount >= this.minSignals;
    });
  }

  /**
   * Strict filter: when we have both a cardNumber and a setTotal, require both to match.
   * This prevents low-power signals (e.g. cardType) from overwhelming the filter.
   */
  private filterStrictByNumberAndTotal(cards: PPTCardFull[], signals: ParsedSignals): PPTCardFull[] {
    if (!signals.cardNumber || !signals.setTotal) return [];
    const setTotal = String(signals.setTotal).trim();
    return cards.filter((card) => {
      if (!card.cardNumber || !card.totalSetNumber) return false;
      const normalizedCard = this.normalizeCardNumber(card.cardNumber);
      const total = String(card.totalSetNumber).trim();
      return normalizedCard === signals.cardNumber && total === setTotal;
    });
  }

  /**
   * Count how many signals match between a PPT card and our extracted signals.
   */
  private countMatchingSignals(card: PPTCardFull, signals: ParsedSignals): number {
    let count = 0;

    // Card number match (normalize leading zeros)
    if (signals.cardNumber && card.cardNumber) {
      const normalizedCard = this.normalizeCardNumber(card.cardNumber);
      if (normalizedCard === signals.cardNumber) {
        count++;
      }
    }

    // Set total match (highest discriminative power)
    if (signals.setTotal && card.totalSetNumber) {
      if (String(card.totalSetNumber).trim() === String(signals.setTotal).trim()) {
        count++;
      }
    }

    // Rarity match (fuzzy)
    if (signals.rarity && card.rarity) {
      const normalizedSignalRarity = signals.rarity.toLowerCase();
      const normalizedCardRarity = card.rarity.toLowerCase();
      if (
        normalizedCardRarity.includes(normalizedSignalRarity) ||
        normalizedSignalRarity.includes(normalizedCardRarity)
      ) {
        count++;
      }
    }

    // Card type match
    if (signals.cardType && card.cardType) {
      const normalizedSignalType = signals.cardType.toLowerCase();
      const normalizedCardType = card.cardType.toLowerCase();
      if (normalizedCardType === normalizedSignalType) {
        count++;
      }
    }

    // HP match (only when this is a Pokemon-type card, not Trainer/Supporter/Energy).
    // Path A is generally strong at HP extraction; PPT provides numeric hp for Pokemon.
    if (this.shouldUseHpSignal(signals, card) && signals.hpValue != null && card.hp != null) {
      if (this.hpMatches(signals.hpValue, card.hp)) {
        count++;
      }
    }

    // Artist match (partial, case-insensitive).
    // Helpful for WotC-era collisions and reprints; count only when both sides provide an artist.
    if (signals.artist && card.artist) {
      if (this.artistMatches(signals.artist, card.artist)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Get list of matching signal names for telemetry.
   */
  private getMatchingSignalNames(card: PPTCardFull, signals: ParsedSignals): string[] {
    const matching: string[] = [];

    if (signals.cardNumber && card.cardNumber) {
      const normalizedCard = this.normalizeCardNumber(card.cardNumber);
      if (normalizedCard === signals.cardNumber) {
        matching.push("cardNumber");
      }
    }

    if (signals.setTotal && card.totalSetNumber) {
      if (card.totalSetNumber === signals.setTotal) {
        matching.push("setTotal");
      }
    }

    if (signals.rarity && card.rarity) {
      const normalizedSignalRarity = signals.rarity.toLowerCase();
      const normalizedCardRarity = card.rarity.toLowerCase();
      if (
        normalizedCardRarity.includes(normalizedSignalRarity) ||
        normalizedSignalRarity.includes(normalizedCardRarity)
      ) {
        matching.push("rarity");
      }
    }

    if (signals.cardType && card.cardType) {
      const normalizedSignalType = signals.cardType.toLowerCase();
      const normalizedCardType = card.cardType.toLowerCase();
      if (normalizedCardType === normalizedSignalType) {
        matching.push("cardType");
      }
    }

    if (this.shouldUseHpSignal(signals, card) && signals.hpValue != null && card.hp != null) {
      if (this.hpMatches(signals.hpValue, card.hp)) {
        matching.push("hpValue");
      }
    }

    if (signals.artist && card.artist) {
      if (this.artistMatches(signals.artist, card.artist)) {
        matching.push("artist");
      }
    }

    return matching;
  }

  /**
   * Normalize card number by stripping leading zeros and /total suffix.
   */
  private normalizeCardNumber(cardNumber: string): string {
    // Strip "/total" suffix
    const numerator = cardNumber.split("/")[0];
    // Trim leading zeros but keep at least one digit
    return numerator.replace(/^0+(?=\d)/, "") || "0";
  }

  private isTrainerLikeCardType(value: string): boolean {
    const normalized = value.toLowerCase().trim();
    return (
      normalized === "trainer" ||
      normalized === "supporter" ||
      normalized === "item" ||
      normalized === "stadium" ||
      normalized === "tool" ||
      normalized === "energy" ||
      normalized === "special energy"
    );
  }

  private shouldUseHpSignal(signals: ParsedSignals, card: PPTCardFull): boolean {
    // If either side explicitly looks like a Trainer/Energy, don't use HP as a matching signal.
    if (signals.cardType && this.isTrainerLikeCardType(signals.cardType)) return false;
    if (card.cardType && this.isTrainerLikeCardType(card.cardType)) return false;
    return true;
  }

  private hpMatches(signalHp: number, cardHp: number): boolean {
    // HP is typically a multiple of 10; tolerate small OCR slips (e.g., 70 vs 80 is still wrong).
    // Keep strict: exact match or +/-10 only.
    return signalHp === cardHp || Math.abs(signalHp - cardHp) <= 10;
  }

  private normalizeArtist(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private artistMatches(signalArtistRaw: string, cardArtistRaw: string): boolean {
    const signal = this.normalizeArtist(signalArtistRaw);
    const card = this.normalizeArtist(cardArtistRaw);
    if (!signal || !card) return false;

    // Basic partial match (bounded to avoid tiny-token false positives)
    if (signal.length >= 4 && (card.includes(signal) || signal.includes(card))) {
      return true;
    }

    // Last-name token match (common in partial extractions)
    const signalTokens = signal.split(" ").filter(Boolean);
    const cardTokens = new Set(card.split(" ").filter(Boolean));
    const signalLast = signalTokens.at(-1);
    if (signalLast && signalLast.length >= 4 && cardTokens.has(signalLast)) {
      return true;
    }

    return false;
  }

  /**
   * Score filtered cards and select best match.
   */
  private scoreAndSelect(
    filtered: PPTCardFull[],
    signals: ParsedSignals,
    totalResultCount: number,
    creditsUsed: number,
    startTime: number
  ): TriangulationResult {
    const uniqueSets = this.getUniqueSets(filtered);
    const uniqueSetCount = uniqueSets.size;

    // Single unique set match
    if (uniqueSetCount === 1) {
      const bestMatch = filtered[0];
      const signalCount = this.countMatchingSignals(bestMatch, signals);
      const matchingSignals = this.getMatchingSignalNames(bestMatch, signals);

      // Confidence based on signal count (per plan)
      // Unique match + 4 signals: 0.95
      // Unique match + 3 signals: 0.875
      // Unique match + 2 signals: 0.775
      let confidence: number;
      if (signalCount >= 4) {
        confidence = 0.95;
      } else if (signalCount >= 3) {
        confidence = 0.875;
      } else {
        confidence = 0.775;
      }

      return this.buildResult({
        setName: bestMatch.setName, // Will be replaced with canonical name
        tcgPlayerId: null, // Will be looked up
        pptSetId: bestMatch.setId,
        confidence,
        matchingSignals,
        candidateCount: totalResultCount,
        uniqueSetCount,
        pptCreditsUsed: creditsUsed,
        latencyMs: Date.now() - startTime,
        action: "discard", // Will be updated based on confidence
        quotaStatus: null, // Filled in by caller
      });
    }

    // Multiple matches, all same set
    if (filtered.length > 1 && uniqueSetCount === 1) {
      const bestMatch = filtered[0];
      const matchingSignals = this.getMatchingSignalNames(bestMatch, signals);

      return this.buildResult({
        setName: bestMatch.setName,
        tcgPlayerId: null,
        pptSetId: bestMatch.setId,
        confidence: 0.85, // Multiple matches, same set
        matchingSignals,
        candidateCount: totalResultCount,
        uniqueSetCount,
        pptCreditsUsed: creditsUsed,
        latencyMs: Date.now() - startTime,
        action: "discard",
        quotaStatus: null, // Filled in by caller
      });
    }

    // Multiple matches, different sets (ambiguous)
    // Return with low confidence - could be escalated to C2 (LM Studio)
    // Special-case: Shadowless can disambiguate Base Set vs Base Set (Shadowless) when both appear.
    if (signals.shadowless !== null && uniqueSetCount > 1) {
      const isShadowlessSet = (setName: string): boolean => /\bshadowless\b/i.test(setName);
      const matching = Array.from(uniqueSets.entries()).filter(([, setName]) =>
        signals.shadowless ? isShadowlessSet(setName) : !isShadowlessSet(setName)
      );
      if (matching.length === 1) {
        const [setId, setName] = matching[0];
        const bestCard = filtered.find((card) => card.setId === setId) ?? filtered[0];
        const signalCount = this.countMatchingSignals(bestCard, signals);
        const matchingSignals = this.getMatchingSignalNames(bestCard, signals);

        let confidence: number;
        if (signalCount >= 4) {
          confidence = 0.95;
        } else if (signalCount >= 3) {
          confidence = 0.875;
        } else {
          confidence = 0.775;
        }

        return this.buildResult({
          setName,
          tcgPlayerId: null,
          pptSetId: setId,
          confidence,
          matchingSignals,
          candidateCount: totalResultCount,
          uniqueSetCount: 1,
          pptCreditsUsed: creditsUsed,
          latencyMs: Date.now() - startTime,
          action: "discard",
          quotaStatus: null,
        });
      }
    }

    const setsList = Array.from(uniqueSets.entries()).map(([setId, setName]) => ({
      setName,
      tcgPlayerId: null,
      pptSetId: setId,
    }));

    return this.buildResult({
      setName: null,
      tcgPlayerId: null,
      pptSetId: null,
      confidence: 0.50, // Ambiguous - multiple different sets
      matchingSignals: [],
      candidateCount: totalResultCount,
      uniqueSetCount,
      pptCreditsUsed: creditsUsed,
      latencyMs: Date.now() - startTime,
      action: "discard",
      candidates: setsList,
      quotaStatus: null, // Filled in by caller
    });
  }

  /**
   * Get unique sets from filtered cards.
   * Returns Map<setId, setName>
   */
  private getUniqueSets(cards: PPTCardFull[]): Map<string, string> {
    const sets = new Map<string, string>();
    for (const card of cards) {
      if (card.setId && !sets.has(card.setId)) {
        sets.set(card.setId, card.setName);
      }
    }
    return sets;
  }

  /**
   * Count unique sets in cards array.
   */
  private countUniqueSets(cards: PPTCardFull[]): number {
    const setIds = new Set(cards.map((c) => c.setId).filter(Boolean));
    return setIds.size;
  }

  /**
   * Look up canonical set info from ppt_set_id.
   */
  private lookupCanonicalSet(pptSetId: string): { name: string; tcgPlayerId: string } | null {
    try {
      const row = this.db
        .prepare(
          `SELECT name, tcg_player_id FROM canonical_sets WHERE ppt_set_id = ?`
        )
        .get(pptSetId) as { name: string; tcg_player_id: string } | undefined;

      if (row) {
        return { name: row.name, tcgPlayerId: row.tcg_player_id };
      }

      this.logger.warn({ pptSetId }, "Path C: ppt_set_id not found in canonical_sets");
      return null;
    } catch (error) {
      this.logger.error({ err: error, pptSetId }, "Path C: Failed to lookup canonical set");
      return null;
    }
  }

  /**
   * Build a skipped result with minimal info.
   */
  private buildSkippedResult(reason: string, startTime: number): TriangulationResult {
    return {
      setName: null,
      tcgPlayerId: null,
      pptSetId: null,
      confidence: 0,
      matchingSignals: [],
      candidateCount: 0,
      uniqueSetCount: 0,
      pptCreditsUsed: 0,
      latencyMs: Date.now() - startTime,
      action: "skipped",
      quotaStatus: null,
    };
  }

  /**
   * Build result object.
   */
  private buildResult(partial: TriangulationResult): TriangulationResult {
    return partial;
  }
}
