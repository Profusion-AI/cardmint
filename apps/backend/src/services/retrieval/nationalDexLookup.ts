import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * National Pokedex lookup utility
 *
 * Loads pokemon_names_and_numbers.json to provide canonical National Dex numbers
 * for filtering out false set number mismatches in PriceCharting scoring.
 *
 * Context: PriceCharting embeds National Dex numbers in product names (e.g., "Celebi #251")
 * which causes false alerts when comparing against card set numbers (e.g., "003/072").
 *
 * See: docs/KNOWN_ISSUE_NATIONAL_POKEDEX_NUMBERS.md
 */

interface PokemonSpecies {
  name: string;
  number: number;
}

let nationalDexMap: Map<number, string[]> | null = null;

/**
 * Load National Dex data from pokemon_names_and_numbers.json
 * Maps National Dex number → array of Pokemon names (including variants)
 */
export function loadNationalDex(): Map<number, string[]> {
  if (nationalDexMap) {
    return nationalDexMap;
  }

  // Resolve path to repo root relative to this module's location
  // Module: apps/backend/src/services/retrieval/nationalDexLookup.ts
  // Target: pokemon_names_and_numbers.json (repo root)
  // Use import.meta.url for robust resolution (works from backend server, tests, scripts)
  const dataPath = join(fileURLToPath(new URL(".", import.meta.url)), "../../..", "pokemon_names_and_numbers.json");

  const rawData = readFileSync(dataPath, "utf-8");
  const species: PokemonSpecies[] = JSON.parse(rawData);

  nationalDexMap = new Map();

  for (const entry of species) {
    const existing = nationalDexMap.get(entry.number) || [];
    existing.push(entry.name);
    nationalDexMap.set(entry.number, existing);
  }

  return nationalDexMap;
}

/**
 * Check if a number is a National Pokedex number
 *
 * @param num - Number to check
 * @returns true if this is a known National Dex number
 */
export function isNationalDexNumber(num: number): boolean {
  const dex = loadNationalDex();
  return dex.has(num);
}

/**
 * Extract National Dex number from a PriceCharting product name
 *
 * Examples:
 * - "Pikachu #25" → 25
 * - "Celebi #251" → 251
 * - "Celebi #251 [Reverse Holo]" → 251
 * - "Mew #151 PSA 10" → 151
 * - "Terapagos #1025" → 1025 (Gen 9, 4-digit National Dex)
 * - "Squirtle [1st Edition] #63" → 63 (but 63 is not Squirtle's National Dex number)
 *
 * @param productName - PriceCharting product name
 * @returns National Dex number if found in pattern, null otherwise
 */
export function extractNationalDexFromProductName(productName: string): number | null {
  // Match #N+ anywhere in the string (supports 1-4 digit National Dex numbers)
  // Handles trailing qualifiers like "[Reverse Holo]", "PSA 10", etc.
  const match = productName.match(/#(\d+)/);
  if (!match) {
    return null;
  }

  const num = parseInt(match[1], 10);
  return isNaN(num) ? null : num;
}

/**
 * Determine if a candidate's card number is actually its National Dex number
 *
 * Used by the scorer to avoid false set number mismatch penalties.
 *
 * Logic:
 * - Extract #NNN from product name
 * - Check if NNN is a valid National Dex number
 * - Check if the Pokemon name in the product matches any species with that Dex number
 *
 * @param productName - PriceCharting product name (e.g., "Celebi #251")
 * @param cardNumber - Canonical card number from PriceCharting (e.g., "251")
 * @returns true if cardNumber is a National Dex number, not a set card number
 */
export function isNationalDexInProductName(productName: string, cardNumber: string): boolean {
  const dexNum = extractNationalDexFromProductName(productName);
  if (!dexNum) {
    return false;
  }

  // Check if the extracted number matches the canonical card number
  if (dexNum.toString() !== cardNumber) {
    return false;
  }

  // Check if this number is a valid National Dex number
  if (!isNationalDexNumber(dexNum)) {
    return false;
  }

  // Extract base Pokemon name from product name (before any brackets/numbers)
  const baseName = productName.replace(/\s*\[.*?\]\s*/g, "").replace(/\s*#\d+\s*$/, "").trim();

  // Check if any Pokemon species with this Dex number matches the product name
  const dex = loadNationalDex();
  const speciesNames = dex.get(dexNum) || [];

  return speciesNames.some((species) => {
    const speciesBase = species.split("(")[0].trim(); // "Pikachu (Partner Pikachu)" → "Pikachu"
    return baseName.toLowerCase().includes(speciesBase.toLowerCase());
  });
}
