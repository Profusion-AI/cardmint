/**
 * Card data validation utilities for Pokémon TCG cards
 * Provides name validation, set canonicalization, and identifier format checking
 */

// Common Pokémon names for validation (subset - can be expanded)
const COMMON_POKEMON_NAMES = new Set([
  'pikachu', 'charizard', 'blastoise', 'venusaur', 'mewtwo', 'mew', 'lugia', 'ho-oh',
  'celebi', 'kyogre', 'groudon', 'rayquaza', 'dialga', 'palkia', 'giratina', 'arceus',
  'reshiram', 'zekrom', 'kyurem', 'xerneas', 'yveltal', 'zygarde', 'solgaleo', 'lunala',
  'necrozma', 'zacian', 'zamazenta', 'eternatus', 'calyrex', 'koraidon', 'miraidon',
  'totodile', 'feraligatr', 'blissey', 'gardevoir', 'toxapex', 'tsareena', 'bastiodon',
  'polteageist', 'pangoro', 'eevee', 'vaporeon', 'jolteon', 'flareon', 'espeon', 'umbreon',
  'leafeon', 'glaceon', 'sylveon', 'lucario', 'garchomp', 'dragapult', 'corviknight',
  'grimmsnarl', 'alcremie', 'dragozolt', 'dracovish', 'wo-chien'
].map(name => normalizeCardName(name)));

// Set name canonicalization mappings (extended from golden-accuracy.ts)
const SET_CANONICAL_NAMES: Record<string, string> = {
  // Remove common prefixes
  'pokémon sun & moon': 'sun & moon',
  'pokemon sun & moon': 'sun & moon',
  'pokémon darkness ablaze': 'darkness ablaze',
  'pokemon darkness ablaze': 'darkness ablaze',
  'pokémon paldea evolved': 'paldea evolved',
  'pokemon paldea evolved': 'paldea evolved',
  'pokémon swsh black star promos': 'swsh black star promos',
  'pokemon swsh black star promos': 'swsh black star promos',
  'pokémon xy black star promos': 'xy black star promos',
  'pokemon xy black star promos': 'xy black star promos',
  'pokémon pop series 6': 'pop series 6',
  'pokemon pop series 6': 'pop series 6',
  'pokémon mcdonald\'s 2019': 'mcdonald\'s 2019',
  'pokemon mcdonald\'s 2019': 'mcdonald\'s 2019',
  'pokémon mcdonalds 2019': 'mcdonald\'s 2019',
  'pokemon mcdonalds 2019': 'mcdonald\'s 2019',
  'mcdonald\'s collection 2019': 'mcdonald\'s 2019',
  'mcdonalds 2019': 'mcdonald\'s 2019',
  
  // Common abbreviations and variations
  'neo genesis': 'neo genesis',
  'neo revelation': 'neo revelation', 
  'neo destiny': 'neo destiny',
  'sun moon': 'sun & moon',
  'sm base': 'sun & moon',
  'swsh': 'sword & shield',
  'sword shield': 'sword & shield',
  'sv': 'scarlet & violet',
  'scarlet violet': 'scarlet & violet',
};

export function normalizeCardName(name: string | undefined): string {
  if (!name) return '';
  return name.normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]/g, '')  // Keep hyphens for names like "Wo-Chien"
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalSetName(setName: string | undefined): string {
  if (!setName) return '';
  
  let normalized = setName.toLowerCase().trim();
  
  // Remove common prefixes
  normalized = normalized.replace(/^(pokémon|pokemon)\s+/i, '').trim();
  normalized = normalized.replace(/^the\s+/i, '').trim();
  
  // Normalize ampersands and spaces
  normalized = normalized.replace(/\s*&\s*/g, ' & ');
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Apply specific mappings
  return SET_CANONICAL_NAMES[normalized] || normalized;
}

export function validatePokemonName(name: string | undefined): { isValid: boolean; confidence: number; suggestions?: string[] } {
  if (!name) return { isValid: false, confidence: 0 };
  
  const normalized = normalizeCardName(name);
  
  // Exact match in common names
  if (COMMON_POKEMON_NAMES.has(normalized)) {
    return { isValid: true, confidence: 1.0 };
  }
  
  // Fuzzy matching for close names
  const fuzzyMatches: string[] = [];
  for (const knownName of COMMON_POKEMON_NAMES) {
    const similarity = calculateStringSimilarity(normalized, knownName);
    if (similarity > 0.8) {
      fuzzyMatches.push(knownName);
    }
  }
  
  if (fuzzyMatches.length > 0) {
    return { 
      isValid: true, 
      confidence: 0.8, 
      suggestions: fuzzyMatches 
    };
  }
  
  // Basic heuristics for unknown names
  const hasValidChars = /^[a-z0-9\-\s]+$/i.test(name);
  const reasonableLength = name.length >= 3 && name.length <= 20;
  
  if (hasValidChars && reasonableLength) {
    return { isValid: true, confidence: 0.6 };
  }
  
  return { isValid: false, confidence: 0 };
}

export function validateIdentifier(identifier: any): { isValid: boolean; confidence: number; type?: 'regular' | 'promo' } {
  if (!identifier || typeof identifier !== 'object') {
    return { isValid: false, confidence: 0 };
  }
  
  // Promo code validation
  if (identifier.promo_code) {
    const promoPattern = /^[A-Z]{2,5}\d{1,4}$/;
    const isValid = promoPattern.test(identifier.promo_code);
    return { 
      isValid, 
      confidence: isValid ? 1.0 : 0,
      type: 'promo'
    };
  }
  
  // Regular card number validation
  if (identifier.number && identifier.set_size) {
    const numberPattern = /^\d{1,3}$/;
    const setSizePattern = /^\d{1,4}$/;
    
    const numberValid = numberPattern.test(identifier.number);
    const setSizeValid = setSizePattern.test(identifier.set_size);
    
    if (numberValid && setSizeValid) {
      // Additional logic check - number should be <= set_size
      const num = parseInt(identifier.number, 10);
      const setSize = parseInt(identifier.set_size, 10);
      
      if (num > 0 && setSize > 0 && num <= setSize) {
        return { isValid: true, confidence: 1.0, type: 'regular' };
      } else {
        return { isValid: true, confidence: 0.7, type: 'regular' };
      }
    }
  }
  
  return { isValid: false, confidence: 0 };
}

export function calculateConfidenceScore(result: {
  card_title?: string;
  set_name?: string;
  identifier?: any;
}): number {
  let score = 0;
  let factors = 0;
  
  // Name validation (40% weight)
  if (result.card_title) {
    const nameValidation = validatePokemonName(result.card_title);
    score += nameValidation.confidence * 0.4;
    factors += 0.4;
  }
  
  // Set validation (30% weight) 
  if (result.set_name) {
    const canonicalSet = canonicalSetName(result.set_name);
    const hasReasonableSetName = canonicalSet.length > 3 && canonicalSet.length < 50;
    score += (hasReasonableSetName ? 0.8 : 0.3) * 0.3;
    factors += 0.3;
  }
  
  // Identifier validation (30% weight)
  if (result.identifier) {
    const idValidation = validateIdentifier(result.identifier);
    score += idValidation.confidence * 0.3;
    factors += 0.3;
  }
  
  return factors > 0 ? score / factors : 0;
}

// Helper function for fuzzy string matching
function calculateStringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
}

export type CardValidationResult = {
  nameValidation: ReturnType<typeof validatePokemonName>;
  setValidation: { canonical: string; confidence: number };
  identifierValidation: ReturnType<typeof validateIdentifier>;
  overallConfidence: number;
};

export function validateCompleteCard(result: {
  card_title?: string;
  set_name?: string; 
  identifier?: any;
}): CardValidationResult {
  const nameValidation = validatePokemonName(result.card_title);
  const canonicalSet = canonicalSetName(result.set_name);
  const setValidation = {
    canonical: canonicalSet,
    confidence: canonicalSet.length > 3 ? 0.8 : 0.3
  };
  const identifierValidation = validateIdentifier(result.identifier);
  const overallConfidence = calculateConfidenceScore(result);
  
  return {
    nameValidation,
    setValidation,
    identifierValidation,
    overallConfidence
  };
}