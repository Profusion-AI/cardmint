/**
 * Text Normalization for Pokemon Card Matching
 * Optimized for OCR variations and Pokemon-specific patterns
 */

export class TextNormalizer {
  private static instance: TextNormalizer;
  
  // Pokemon-specific character mappings for OCR corrections
  private readonly POKEMON_OCR_FIXES = new Map([
    // Common OCR misreads
    ['é', 'e'],     // Pokémon -> Pokemon  
    ['ō', 'o'],     // Johto names
    ['ū', 'u'],     // Some names
    ['0', 'o'],     // OCR often confuses 0/o
    ['1', 'l'],     // OCR often confuses 1/l/I
    ['5', 's'],     // Sometimes 5/S confusion
    ['8', 'b'],     // Sometimes 8/B confusion
  ]);

  // Pokemon name patterns to preserve
  private readonly PRESERVE_PATTERNS = [
    /ex$/i,         // Pikachu-EX -> pikachu ex
    /gx$/i,         // Charizard-GX -> charizard gx  
    /vmax$/i,       // Pikachu VMAX -> pikachu vmax
    /v$/i,          // Pikachu V -> pikachu v
    /lv\.\d+/i,     // Charizard LV.76 -> charizard lv 76
  ];

  // Set name normalization (common variations)
  private readonly SET_ALIASES = new Map([
    ['base', 'base set'],
    ['base1', 'base set'],
    ['jungle', 'jungle'],
    ['fossil', 'fossil'],
    ['team rocket', 'team rocket'],
    ['base2', 'base set 2'],
    ['gym heroes', 'gym heroes'],
    ['gym challenge', 'gym challenge'],
    ['neo genesis', 'neo genesis'],
    // Add more as needed
  ]);

  static getInstance(): TextNormalizer {
    if (!TextNormalizer.instance) {
      TextNormalizer.instance = new TextNormalizer();
    }
    return TextNormalizer.instance;
  }

  /**
   * Normalize Pokemon card name for consistent matching
   */
  normalizeName(name: string): string {
    if (!name) return '';

    let normalized = name.toLowerCase().trim();
    
    // Apply OCR character fixes
    for (const [wrong, correct] of this.POKEMON_OCR_FIXES) {
      normalized = normalized.replace(new RegExp(wrong, 'g'), correct);
    }
    
    // Handle special Pokemon patterns
    normalized = this.handlePokemonPatterns(normalized);
    
    // Remove special characters but preserve spaces
    normalized = normalized.replace(/[^\w\s]/g, ' ');
    
    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    return normalized;
  }

  /**
   * Normalize set name with alias resolution
   */
  normalizeSet(setName: string): string {
    if (!setName) return '';

    let normalized = setName.toLowerCase().trim();
    
    // Apply OCR fixes
    for (const [wrong, correct] of this.POKEMON_OCR_FIXES) {
      normalized = normalized.replace(new RegExp(wrong, 'g'), correct);
    }
    
    // Check for set aliases
    if (this.SET_ALIASES.has(normalized)) {
      normalized = this.SET_ALIASES.get(normalized)!;
    }
    
    // Clean up
    normalized = normalized.replace(/[^\w\s]/g, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    return normalized;
  }

  /**
   * Normalize card number (extract primary number)
   */
  normalizeNumber(cardNumber: string): string {
    if (!cardNumber) return '';

    let normalized = cardNumber.toLowerCase().trim();
    
    // Extract primary number from formats like:
    // "25/102" -> "25"
    // "25a" -> "25a" (keep letter variants)
    // "PROMO-25" -> "25"
    // "DP05" -> "dp05" (keep set prefixes)
    
    const patterns = [
      /^(\d+[a-z]?)\/\d+$/,           // "25/102" -> "25"
      /^promo[_\-]?(\d+[a-z]?)$/i,    // "PROMO-25" -> "25"
      /^([a-z]+\d+[a-z]?)$/i,         // "DP05" -> "dp05"
      /^(\d+[a-z]?)$/,                // "25" -> "25"
    ];
    
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return match[1].toLowerCase();
      }
    }
    
    // Fallback: just clean up
    return normalized.replace(/[^\w]/g, '');
  }

  private handlePokemonPatterns(name: string): string {
    // Convert hyphenated patterns to spaced
    // "Pikachu-EX" -> "pikachu ex"
    for (const pattern of this.PRESERVE_PATTERNS) {
      if (pattern.test(name)) {
        name = name.replace(/-/g, ' ');
        break;
      }
    }
    
    // Handle specific Pokemon name patterns
    const patterns = [
      // "Mr. Mime" -> "mr mime"
      [/mr\.\s*/i, 'mr '],
      // "Nidoran♀" -> "nidoran f" / "nidoran♂" -> "nidoran m"
      [/♀/g, 'f'],
      [/♂/g, 'm'],
      // Remove other Unicode symbols that might confuse matching
      [/[^\x00-\x7F]/g, ''], // Remove non-ASCII
    ];
    
    for (const [pattern, replacement] of patterns) {
      name = name.replace(pattern, replacement);
    }
    
    return name;
  }

  /**
   * Generate all normalization variants for a card
   */
  generateVariants(cardData: {
    name?: string;
    set_name?: string;
    card_number?: string;
  }): {
    normalized_name: string;
    normalized_set: string;
    normalized_number: string;
    search_variants: string[];
  } {
    const normalized_name = this.normalizeName(cardData.name || '');
    const normalized_set = this.normalizeSet(cardData.set_name || '');
    const normalized_number = this.normalizeNumber(cardData.card_number || '');
    
    // Generate search variants for better FTS5 matching
    const search_variants = this.generateSearchVariants(normalized_name);
    
    return {
      normalized_name,
      normalized_set,
      normalized_number,
      search_variants
    };
  }

  private generateSearchVariants(name: string): string[] {
    const variants = new Set([name]);
    
    // Add variants without common suffixes
    const withoutSuffixes = name.replace(/\s+(ex|gx|vmax|v|lv\s*\d+)$/, '');
    if (withoutSuffixes !== name) {
      variants.add(withoutSuffixes);
    }
    
    // Add variants with different spacing
    const noSpaces = name.replace(/\s+/g, '');
    if (noSpaces !== name && noSpaces.length >= 3) {
      variants.add(noSpaces);
    }
    
    return Array.from(variants);
  }

  /**
   * Calculate edit distance between two strings (Levenshtein)
   */
  calculateEditDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Calculate similarity score (0-1)
   */
  calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;
    
    const distance = this.calculateEditDistance(str1, str2);
    return (maxLen - distance) / maxLen;
  }
}

export const textNormalizer = TextNormalizer.getInstance();