import type { ParsedQuery } from "./types.js";
import { normalizeCollectorNo } from "../normalize/collectorNo.js";

/**
 * Known set names for deterministic matching.
 * Lowercase for comparison. Ordered longest-first so multi-word sets match before substrings.
 */
const KNOWN_SETS: string[] = [
  "scarlet & violet",
  "sword & shield",
  "sun & moon",
  "diamond & pearl",
  "black & white",
  "heartgold & soulsilver",
  "platinum",
  "base set",
  "jungle",
  "fossil",
  "team rocket",
  "gym heroes",
  "gym challenge",
  "neo genesis",
  "neo discovery",
  "neo revelation",
  "neo destiny",
  "legendary collection",
  "expedition",
  "aquapolis",
  "skyridge",
  "ruby & sapphire",
  "sandstorm",
  "dragon",
  "hidden legends",
  "fire red & leaf green",
  "team rocket returns",
  "deoxys",
  "emerald",
  "unseen forces",
  "delta species",
  "legend maker",
  "holon phantoms",
  "crystal guardians",
  "dragon frontiers",
  "power keepers",
  "mysterious treasures",
  "secret wonders",
  "great encounters",
  "majestic dawn",
  "legends awakened",
  "stormfront",
  "rising rivals",
  "supreme victors",
  "arceus",
  "triumphant",
  "unleashed",
  "undaunted",
  "boundaries crossed",
  "plasma storm",
  "plasma freeze",
  "plasma blast",
  "legendary treasures",
  "xy",
  "flashfire",
  "furious fists",
  "phantom forces",
  "primal clash",
  "roaring skies",
  "ancient origins",
  "breakthrough",
  "breakpoint",
  "fates collide",
  "steam siege",
  "evolutions",
  "guardians rising",
  "burning shadows",
  "shining legends",
  "crimson invasion",
  "ultra prism",
  "forbidden light",
  "celestial storm",
  "lost thunder",
  "team up",
  "unbroken bonds",
  "unified minds",
  "cosmic eclipse",
  "rebel clash",
  "darkness ablaze",
  "vivid voltage",
  "battle styles",
  "chilling reign",
  "evolving skies",
  "fusion strike",
  "brilliant stars",
  "astral radiance",
  "lost origin",
  "silver tempest",
  "crown zenith",
  "paldea evolved",
  "obsidian flames",
  "151",
  "paradox rift",
  "paldean fates",
  "temporal forces",
  "twilight masquerade",
  "shrouding storm",
  "stellar crown",
  "surging sparks",
  "prismatic evolutions",
  "journey together",
  "promo",
];

// Sort longest-first so multi-word sets are matched before substrings
KNOWN_SETS.sort((a, b) => b.length - a.length);

/**
 * Known variant qualifiers that modify a set/print run.
 * These don't change the set name in the DB but affect which specific card the user wants.
 * Ordered longest-first for matching.
 */
const VARIANT_QUALIFIERS: string[] = [
  "reverse holo",
  "first edition",
  "1st edition",
  "shadowless",
  "unlimited",
  "non-holo",
  "holo",
];

VARIANT_QUALIFIERS.sort((a, b) => b.length - a.length);

/**
 * Parse a raw search query into structured fields.
 *
 * Strategy:
 * 1. Extract variant qualifiers (shadowless, 1st edition, etc.)
 * 2. Extract collector number pattern (digits + optional alpha, with optional /total)
 * 3. Extract known set name (case-insensitive)
 * 4. Remaining text is the card name
 */
export function parseQuery(raw: string): ParsedQuery {
  let work = raw.trim();
  let collectorNo: string | null = null;
  let setName: string | null = null;
  let variantHint: string | null = null;

  // Extract variant qualifier (before set extraction so "shadowless base set" doesn't confuse set matching)
  // Use word boundaries to avoid matching inside other words (e.g. "holo" inside "holon")
  for (const variant of VARIANT_QUALIFIERS) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    const m = re.exec(work);
    if (m) {
      variantHint = variant;
      work = (work.substring(0, m.index) + " " + work.substring(m.index + m[0].length)).replace(/\s+/g, " ").trim();
      break;
    }
  }

  // Extract collector number: pattern like "4/102", "004", "TG05", "002a/131", "SWSH123", "GG01"
  // Look for patterns that look like collector numbers at word boundaries
  const cnoMatch = work.match(/\b(\d{1,4}[a-z]?)\s*\/\s*\d+\b/i)    // "4/102", "002a/131"
    || work.match(/\b([A-Z]{1,4}\d{1,4}[a-z]?)\b/i)                  // "TG05", "SWSH123", "GG01"
    || work.match(/\b(\d{1,4}[a-z])\b/i)                              // "2a" (digit-first with alpha suffix)
    || work.match(/(?:^|\s)#?(\d{1,4})(?:\s|$)/);                     // standalone number "4", "004"

  if (cnoMatch) {
    const normalized = normalizeCollectorNo(cnoMatch[0].replace(/^#/, ""));
    if (normalized) {
      collectorNo = normalized;
      // Remove the matched collector number from the work string
      work = work.replace(cnoMatch[0], " ").trim();
    }
  }

  // Extract known set name (case-insensitive)
  const workLower = work.toLowerCase();
  for (const set of KNOWN_SETS) {
    const idx = workLower.indexOf(set);
    if (idx !== -1) {
      setName = work.substring(idx, idx + set.length);
      work = (work.substring(0, idx) + " " + work.substring(idx + set.length)).trim();
      break;
    }
  }

  // Remaining text is card name (clean up extra whitespace)
  const cardName = work.replace(/\s+/g, " ").trim() || null;

  return {
    cardName,
    setName,
    collectorNo,
    variantHint,
    raw,
  };
}
