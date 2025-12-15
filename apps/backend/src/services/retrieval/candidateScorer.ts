import type { ExtractedFields, HoloType } from "../../domain/job";
import { isNationalDexInProductName } from "./nationalDexLookup";

export const SIGNAL_SCHEMA_VERSION = "1.0.0";
export const SCORER_VERSION = "basic-v1";

export type SignalKey =
  | "nameExact"
  | "nameSubstring"
  | "nameTokenOverlap"
  | "suffixMismatch"
  | "setCardMatch"
  | "setTotalMatch"
  | "yearProximity"
  | "salesVolume"
  | "variantMatch";

export interface EvidenceSignal {
  key: SignalKey;
  strength: "strong" | "medium" | "weak";
  detail?: string;
}

export interface ScoreExplanation {
  score: number;
  signals: EvidenceSignal[];
  derived: {
    extractedNameNorm: string;
    candidateNameNorm: string;
    extractedSetCard: string | null;
    candidateSetCard: string | null;
    extractedSetTotal: string | null;
    candidateSetTotal: string | null;
    candidateSuffix: string | null;
  };
}

export interface PriceChartingCandidate {
  id: string;
  productName: string;
  consoleName?: string | null;
  releaseYear?: number | null;
  salesVolume?: number | null;
  cardNumber?: string | null;
  totalSetSize?: string | null;
}

export interface CandidateScorer {
  score(extracted: ExtractedFields, candidate: PriceChartingCandidate): number;
  explain(extracted: ExtractedFields, candidate: PriceChartingCandidate): ScoreExplanation;
}

const normalizeName = (value?: string | null): string =>
  value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() ?? "";

interface SetNumberParts {
  card?: string | null;
  total?: string | null;
}

const parseSetNumber = (value?: string | null): SetNumberParts => {
  if (!value) return {};
  const cleaned = value.replace(/\s+/g, "");
  const slashMatch = cleaned.match(/^(?<card>[a-zA-Z0-9-]+)\/(?<total>[a-zA-Z0-9-]+)/);
  if (slashMatch?.groups) {
    return {
      card: slashMatch.groups.card?.toLowerCase() ?? null,
      total: slashMatch.groups.total?.toLowerCase() ?? null,
    };
  }
  return { card: cleaned.toLowerCase(), total: null };
};

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/**
 * Detect 1st Edition marker from PriceCharting product name.
 * Looks for "1st Edition" or "First Edition" (case-insensitive).
 */
const detectFirstEdition = (productName: string): boolean => {
  return /\b(1st|first)\s+edition\b/i.test(productName);
};

/**
 * Detect Shadowless variant from PriceCharting product name.
 * Looks for "Shadowless" (case-insensitive).
 */
const detectShadowless = (productName: string): boolean => {
  return /\bshadowless\b/i.test(productName);
};

/**
 * Detect holo type from PriceCharting product name.
 * Returns constrained HoloType or null if unclear.
 *
 * Special handling: PriceCharting often omits "non-holo" text for base Unlimited variants.
 * If no explicit holo markers are found, returns null (caller can treat as non_holo context-dependent).
 */
const detectHoloType = (productName: string): HoloType | null => {
  const lower = productName.toLowerCase();

  // Check for reverse holo first (more specific)
  if (/\breverse\s*(holo|foil)\b/i.test(productName)) {
    return "reverse_holo";
  }

  // Check for explicit non-holo markers
  if (/\bnon[\s-]?holo\b/i.test(productName) || /\bunlimited\s+edition\b/i.test(productName)) {
    return "non_holo";
  }

  // Check for holo markers
  if (/\bholo(graphic|foil)?\b/i.test(productName)) {
    return "holo";
  }

  // No explicit markers found - null allows context-dependent interpretation
  return null;
};

export class BasicCandidateScorer implements CandidateScorer {
  score(extracted: ExtractedFields, candidate: PriceChartingCandidate): number {
    let score = 0;

    const extractedName = normalizeName(extracted.card_name);
    const candidateName = normalizeName(candidate.productName);

    if (extractedName) {
      // Check for V/EX/GX suffix mismatches (Galarian Rapidash vs Galarian Rapidash V)
      const extractedHasSuffix = /\s+(v|ex|gx|vmax|vstar)$/i.test(extracted.card_name ?? "");
      const candidateHasSuffix = /\s+(v|ex|gx|vmax|vstar)$/i.test(candidate.productName ?? "");

      if (candidateName === extractedName) {
        score += 0.50;
      } else if (extractedHasSuffix !== candidateHasSuffix) {
        // Penalize mismatched suffixes heavily (e.g., "Rapidash" vs "Rapidash V")
        const overlap = this.tokenOverlap(extractedName, candidateName);
        score += overlap * 0.15; // Reduced from 0.35
      } else if (candidateName.includes(extractedName)) {
        score += 0.35;
      } else {
        const overlap = this.tokenOverlap(extractedName, candidateName);
        score += overlap * 0.30;
      }
    }

    const extractedSet = parseSetNumber(extracted.set_number);
    const candidateSet = parseSetNumber(candidate.cardNumber ?? undefined);

    // Check if candidate's card number is actually a National Dex number (not a set card number)
    const isNationalDex = candidate.cardNumber
      ? isNationalDexInProductName(candidate.productName, candidate.cardNumber)
      : false;

    // Set number match is a strong signal - increase weight
    if (extractedSet.card && candidateSet.card) {
      if (isNationalDex) {
        // National Dex case: can't verify set number, but name matched
        // Add compensating weight to lift confidence above 0.5 threshold
        score += 0.25;
      } else if (extractedSet.card === candidateSet.card) {
        // Normal set number match
        score += 0.35; // Increased from 0.25
      }
    }

    if (extractedSet.total && candidate.totalSetSize) {
      if (extractedSet.total === candidate.totalSetSize.toLowerCase()) {
        score += 0.12; // Slight increase from 0.1
      }
    }

    if (candidate.releaseYear && candidate.releaseYear >= 1970) {
      // Slight preference for more common sets when no other data is available.
      const penalty = Math.min(Math.abs(candidate.releaseYear - 2000) / 100, 0.05);
      score += 0.05 - penalty;
    }

    if (typeof candidate.salesVolume === "number" && candidate.salesVolume > 0) {
      score += Math.min(candidate.salesVolume / 500, 0.1);
    }

    // Variant discrimination boosts (HT-001)
    // WARNING: Total max boost +0.35; with name-exact (0.50) + set-match (0.35) can reach 1.20 before clamp.
    // Score clamped to [0.05, 1.0] at return. Monitor clamp frequency if variant boosts stack heavily.
    // CRITICAL: Only boost on POSITIVE evidence matches to avoid rewarding absence of features.
    if (extracted.first_edition_stamp === true) {
      const candidateFirstEdition = detectFirstEdition(candidate.productName);
      if (candidateFirstEdition === true) {
        score += 0.15;
      }
    }

    if (extracted.shadowless === true) {
      const candidateShadowless = detectShadowless(candidate.productName);
      if (candidateShadowless === true) {
        score += 0.12;
      }
    }

    if (extracted.holo_type) {
      const candidateHoloType = detectHoloType(candidate.productName);
      // Match explicit holo/reverse_holo markers, OR treat null as non_holo when extracted says non_holo
      const holoMatches =
        candidateHoloType === extracted.holo_type ||
        (candidateHoloType === null && extracted.holo_type === "non_holo");

      if (holoMatches) {
        score += 0.08;
      }
    }

    // Floor confidence to small value to prevent zero-confidence when returning fallbacks.
    return clamp(score, 0.05, 1);
  }

  explain(extracted: ExtractedFields, candidate: PriceChartingCandidate): ScoreExplanation {
    const signals: EvidenceSignal[] = [];

    const extractedName = normalizeName(extracted.card_name);
    const candidateName = normalizeName(candidate.productName);

    const extractedHasSuffix = /\s+(v|ex|gx|vmax|vstar)$/i.test(extracted.card_name ?? "");
    const candidateHasSuffix = /\s+(v|ex|gx|vmax|vstar)$/i.test(candidate.productName ?? "");

    // Name matching signals
    if (extractedName) {
      if (candidateName === extractedName) {
        signals.push({ key: "nameExact", strength: "strong" });
      } else if (extractedHasSuffix !== candidateHasSuffix) {
        const overlap = this.tokenOverlap(extractedName, candidateName);
        const suffix = candidate.productName.match(/\s+(v|ex|gx|vmax|vstar)$/i)?.[1]?.toUpperCase();
        signals.push({
          key: "suffixMismatch",
          strength: "strong",
          detail: candidateHasSuffix ? `Candidate has ${suffix}` : "Candidate lacks suffix",
        });
        if (overlap >= 0.66) {
          signals.push({
            key: "nameTokenOverlap",
            strength: "medium",
            detail: `${Math.round(overlap * 100)}%`,
          });
        } else if (overlap >= 0.33) {
          signals.push({
            key: "nameTokenOverlap",
            strength: "weak",
            detail: `${Math.round(overlap * 100)}%`,
          });
        }
      } else if (candidateName.includes(extractedName)) {
        signals.push({ key: "nameSubstring", strength: "medium" });
      } else {
        const overlap = this.tokenOverlap(extractedName, candidateName);
        if (overlap >= 0.66) {
          signals.push({
            key: "nameTokenOverlap",
            strength: "medium",
            detail: `${Math.round(overlap * 100)}%`,
          });
        } else if (overlap >= 0.33) {
          signals.push({
            key: "nameTokenOverlap",
            strength: "weak",
            detail: `${Math.round(overlap * 100)}%`,
          });
        }
      }
    }

    const extractedSet = parseSetNumber(extracted.set_number);
    const candidateSet = parseSetNumber(candidate.cardNumber ?? undefined);

    // Check if candidate's card number is actually a National Dex number
    const isNationalDex = candidate.cardNumber
      ? isNationalDexInProductName(candidate.productName, candidate.cardNumber)
      : false;

    // Set number match
    if (extractedSet.card && candidateSet.card) {
      if (isNationalDex) {
        // National Dex number detected - don't treat as set number mismatch
        // Mark as "strong" so UI doesn't flag this field as failed
        signals.push({
          key: "setCardMatch",
          strength: "strong",
          detail: `${candidateSet.card} is National Dex # (not set card number)`,
        });
      } else {
        const match = extractedSet.card === candidateSet.card;
        signals.push({
          key: "setCardMatch",
          strength: match ? "strong" : "weak",
          detail: `${extractedSet.card} vs ${candidateSet.card}`,
        });
      }
    }

    // Total set size match
    if (extractedSet.total && candidate.totalSetSize) {
      const match = extractedSet.total === candidate.totalSetSize.toLowerCase();
      signals.push({
        key: "setTotalMatch",
        strength: match ? "medium" : "weak",
        detail: `${extractedSet.total} vs ${candidate.totalSetSize.toLowerCase()}`,
      });
    }

    // Year proximity
    if (candidate.releaseYear && candidate.releaseYear >= 1970) {
      const distance = Math.abs(candidate.releaseYear - 2000);
      const strength = distance <= 1 ? "strong" : distance <= 5 ? "medium" : "weak";
      signals.push({ key: "yearProximity", strength, detail: String(candidate.releaseYear) });
    }

    // Sales volume
    if (typeof candidate.salesVolume === "number" && candidate.salesVolume > 0) {
      const strength =
        candidate.salesVolume >= 500 ? "strong" : candidate.salesVolume >= 200 ? "medium" : "weak";
      signals.push({ key: "salesVolume", strength, detail: String(candidate.salesVolume) });
    }

    // Variant discrimination signals (HT-001)
    let variantMatchCount = 0;
    const variantDetails: string[] = [];

    if (extracted.first_edition_stamp !== undefined) {
      const candidateFirstEdition = detectFirstEdition(candidate.productName);
      if (extracted.first_edition_stamp === candidateFirstEdition) {
        variantMatchCount++;
        if (extracted.first_edition_stamp === true) {
          variantDetails.push("1st Edition ✓");
        } else {
          variantDetails.push("1st Edition: not present (match)");
        }
      } else {
        variantDetails.push(
          `1st Edition mismatch (extracted: ${extracted.first_edition_stamp}, candidate: ${candidateFirstEdition})`
        );
      }
    }

    if (extracted.shadowless !== undefined) {
      const candidateShadowless = detectShadowless(candidate.productName);
      if (extracted.shadowless === candidateShadowless) {
        variantMatchCount++;
        if (extracted.shadowless === true) {
          variantDetails.push("Shadowless ✓");
        } else {
          variantDetails.push("Shadowless: not present (match)");
        }
      } else {
        variantDetails.push(
          `Shadowless mismatch (extracted: ${extracted.shadowless}, candidate: ${candidateShadowless})`
        );
      }
    }

    if (extracted.holo_type) {
      const candidateHoloType = detectHoloType(candidate.productName);
      // Match explicit holo/reverse_holo markers, OR treat null as non_holo when extracted says non_holo
      const holoMatches =
        candidateHoloType === extracted.holo_type ||
        (candidateHoloType === null && extracted.holo_type === "non_holo");

      if (holoMatches) {
        variantMatchCount++;
        if (extracted.holo_type === "non_holo" && candidateHoloType === null) {
          variantDetails.push("Holo: not present (match)");
        } else {
          variantDetails.push(`Holo: ${extracted.holo_type} ✓`);
        }
      } else {
        if (candidateHoloType === null) {
          variantDetails.push(`Holo type: ${extracted.holo_type} vs candidate unclear`);
        } else {
          variantDetails.push(
            `Holo mismatch (extracted: ${extracted.holo_type}, candidate: ${candidateHoloType})`
          );
        }
      }
    }

    if (variantDetails.length > 0) {
      // Determine strength based on match count vs total checks
      const totalChecks = variantDetails.length;
      const matchRatio = variantMatchCount / totalChecks;
      const strength: "strong" | "medium" | "weak" =
        matchRatio >= 0.75 ? "strong" : matchRatio >= 0.5 ? "medium" : "weak";

      signals.push({
        key: "variantMatch",
        strength,
        detail: variantDetails.join(", "),
      });
    }

    // Compute final score (reuse existing score() method to ensure consistency)
    const score = this.score(extracted, candidate);

    // Extract suffix for derived fields
    const candidateSuffix = candidateHasSuffix
      ? candidate.productName.match(/\s+(v|ex|gx|vmax|vstar)$/i)?.[1]?.toUpperCase() ?? null
      : null;

    return {
      score,
      signals,
      derived: {
        extractedNameNorm: extractedName,
        candidateNameNorm: candidateName,
        extractedSetCard: extractedSet.card ?? null,
        candidateSetCard: candidateSet.card ?? null,
        extractedSetTotal: extractedSet.total ?? null,
        candidateSetTotal: candidate.totalSetSize?.toLowerCase() ?? null,
        candidateSuffix,
      },
    };
  }

  private tokenOverlap(extracted: string, candidate: string): number {
    if (!extracted || !candidate) return 0;
    const extractedTokens = new Set(extracted.split(" "));
    const candidateTokens = candidate.split(" ");
    if (candidateTokens.length === 0) return 0;
    const matches = candidateTokens.filter((token) => extractedTokens.has(token)).length;
    return matches / candidateTokens.length;
  }
}
