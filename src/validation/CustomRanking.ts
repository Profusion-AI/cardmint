/**
 * Custom Ranking System for Pokemon Card Matching
 * BM25 + Pokemon-specific tie-breakers for optimal accuracy
 */

import { textNormalizer } from './TextNormalizer';

export interface RankingInput {
  name?: string;
  set?: string;
  number?: string;
  confidence?: number;
}

export interface RankingResult {
  card: any;
  score: number;
  components: {
    bm25: number;
    exact_set_bonus: number;
    number_similarity: number;
    name_similarity: number;
    overall_bonus: number;
  };
  explanation: string;
}

export class CustomRanking {
  private static instance: CustomRanking;
  
  // Scoring weights (tuned for Pokemon cards)
  private readonly WEIGHTS = {
    BM25_BASE: 0.4,           // FTS5 BM25 relevance
    EXACT_SET_BONUS: 0.3,     // Same set = big boost
    NUMBER_SIMILARITY: 0.15,   // Card number similarity
    NAME_SIMILARITY: 0.1,      // Name edit distance  
    EXACT_NAME_BONUS: 0.05,    // Perfect name match bonus
  };

  // Bonus multipliers
  private readonly BONUSES = {
    EXACT_SET_MATCH: 0.25,     // +25% for exact set match
    EXACT_NAME_MATCH: 0.2,     // +20% for exact name match
    EXACT_NUMBER_MATCH: 0.15,  // +15% for exact number match
    HIGH_CONFIDENCE_INPUT: 0.1, // +10% if input confidence >0.9
  };

  static getInstance(): CustomRanking {
    if (!CustomRanking.instance) {
      CustomRanking.instance = new CustomRanking();
    }
    return CustomRanking.instance;
  }

  /**
   * Rank FTS5 results with custom Pokemon-specific scoring
   */
  rankResults(
    ftsResults: any[], 
    input: RankingInput
  ): RankingResult[] {
    if (!ftsResults || ftsResults.length === 0) {
      return [];
    }

    const normalizedInput = {
      name: textNormalizer.normalizeName(input.name || ''),
      set: textNormalizer.normalizeSet(input.set || ''),
      number: textNormalizer.normalizeNumber(input.number || ''),
      confidence: input.confidence || 0
    };

    const rankedResults = ftsResults.map(card => 
      this.scoreCard(card, normalizedInput)
    );

    // Sort by score (highest first)
    rankedResults.sort((a, b) => b.score - a.score);

    return rankedResults;
  }

  private scoreCard(card: any, input: any): RankingResult {
    const components = {
      bm25: 0,
      exact_set_bonus: 0,
      number_similarity: 0,
      name_similarity: 0,
      overall_bonus: 0
    };

    // 1. BM25 score from FTS5 (normalized 0-1)
    const bm25Raw = Math.abs(card.rank || 0); // BM25 is negative, lower = better
    components.bm25 = this.normalizeBM25(bm25Raw);

    // 2. Set matching bonus
    if (input.set && card.normalized_set) {
      if (input.set === card.normalized_set) {
        components.exact_set_bonus = 1.0; // Perfect match
      } else {
        // Partial set similarity
        components.exact_set_bonus = textNormalizer.calculateSimilarity(
          input.set, card.normalized_set
        );
      }
    }

    // 3. Card number similarity
    if (input.number && card.normalized_number) {
      if (input.number === card.normalized_number) {
        components.number_similarity = 1.0; // Exact match
      } else {
        // Handle number variants (25a vs 25, 25/102 vs 25)
        components.number_similarity = this.calculateNumberSimilarity(
          input.number, card.normalized_number
        );
      }
    }

    // 4. Name similarity (edit distance based)
    if (input.name && card.normalized_name) {
      components.name_similarity = textNormalizer.calculateSimilarity(
        input.name, card.normalized_name
      );
    }

    // 5. Overall bonuses for exact matches
    let bonusMultiplier = 1.0;

    if (components.exact_set_bonus === 1.0) {
      bonusMultiplier += this.BONUSES.EXACT_SET_MATCH;
    }
    
    if (components.name_similarity === 1.0) {
      bonusMultiplier += this.BONUSES.EXACT_NAME_MATCH;
    }
    
    if (components.number_similarity === 1.0) {
      bonusMultiplier += this.BONUSES.EXACT_NUMBER_MATCH;
    }

    if (input.confidence > 0.9) {
      bonusMultiplier += this.BONUSES.HIGH_CONFIDENCE_INPUT;
    }

    components.overall_bonus = bonusMultiplier - 1.0; // Store just the bonus part

    // 6. Calculate weighted final score
    const baseScore = (
      components.bm25 * this.WEIGHTS.BM25_BASE +
      components.exact_set_bonus * this.WEIGHTS.EXACT_SET_BONUS +
      components.number_similarity * this.WEIGHTS.NUMBER_SIMILARITY +
      components.name_similarity * this.WEIGHTS.NAME_SIMILARITY
    );

    const finalScore = baseScore * bonusMultiplier;

    // 7. Generate explanation
    const explanation = this.generateExplanation(components, bonusMultiplier);

    return {
      card,
      score: Math.min(1.0, finalScore), // Cap at 1.0
      components,
      explanation
    };
  }

  private normalizeBM25(bm25Raw: number): number {
    // BM25 scores are typically -20 to 0, with 0 being best match
    // Convert to 0-1 scale where 1 is best
    const clampedBM25 = Math.max(-20, Math.min(0, bm25Raw));
    return (20 + clampedBM25) / 20;
  }

  private calculateNumberSimilarity(inputNumber: string, cardNumber: string): number {
    // Handle common number variations
    const patterns = [
      // Extract base number from "25a" vs "25"
      [/^(\d+)[a-z]?$/i, /^(\d+)[a-z]?$/i],
      // Extract from "25/102" vs "25"  
      [/^(\d+)\/\d+$/, /^(\d+)$/],
      // Promo patterns "PROMO-25" vs "25"
      [/promo[_\-]?(\d+)/i, /^(\d+)$/],
    ];

    for (const [pattern1, pattern2] of patterns) {
      const match1 = inputNumber.match(pattern1);
      const match2 = cardNumber.match(pattern2);
      
      if (match1 && match2) {
        const num1 = match1[1];
        const num2 = match2[1];
        
        if (num1 === num2) {
          return 0.9; // Close match but not perfect
        }
      }
    }

    // Fallback to string similarity
    return textNormalizer.calculateSimilarity(inputNumber, cardNumber) * 0.7;
  }

  private generateExplanation(components: any, bonusMultiplier: number): string {
    const parts = [];
    
    if (components.bm25 > 0.8) {
      parts.push(`strong text match (${components.bm25.toFixed(2)})`);
    } else if (components.bm25 > 0.6) {
      parts.push(`good text match (${components.bm25.toFixed(2)})`);
    }

    if (components.exact_set_bonus === 1.0) {
      parts.push('exact set match');
    } else if (components.exact_set_bonus > 0.8) {
      parts.push('similar set');
    }

    if (components.number_similarity === 1.0) {
      parts.push('exact number match');
    } else if (components.number_similarity > 0.8) {
      parts.push('similar number');
    }

    if (components.name_similarity === 1.0) {
      parts.push('exact name match');
    } else if (components.name_similarity > 0.9) {
      parts.push('near-exact name');
    }

    if (bonusMultiplier > 1.1) {
      parts.push(`${((bonusMultiplier - 1) * 100).toFixed(0)}% bonus`);
    }

    return parts.length > 0 ? parts.join(', ') : 'weak match';
  }

  /**
   * Quick exact match check before running full FTS search
   */
  checkExactMatch(db: any, input: RankingInput): any | null {
    const normalized = {
      name: textNormalizer.normalizeName(input.name || ''),
      set: textNormalizer.normalizeSet(input.set || ''),
      number: textNormalizer.normalizeNumber(input.number || '')
    };

    // Try exact canonical key match first (fastest)
    const canonicalKey = `${normalized.name}|${normalized.set}|${normalized.number}`;
    
    const exactMatch = db.prepare(`
      SELECT * FROM cards WHERE canonical_key = ?
    `).get(canonicalKey);

    if (exactMatch) {
      return {
        card: exactMatch,
        score: 1.0,
        components: {
          bm25: 1.0,
          exact_set_bonus: 1.0,
          number_similarity: 1.0,
          name_similarity: 1.0,
          overall_bonus: 0.5
        },
        explanation: 'perfect canonical match'
      };
    }

    return null;
  }

  /**
   * Build optimized FTS5 query with Pokemon-specific patterns
   */
  buildFTSQuery(input: RankingInput): string | null {
    const parts = [];

    // Name is most important
    if (input.name) {
      const normalized = textNormalizer.normalizeName(input.name);
      if (normalized.length >= 2) {
        // Use phrase for exact matching, or individual terms for fuzzy
        if (normalized.includes(' ')) {
          parts.push(`"${normalized}"`);
          parts.push(normalized.split(' ').join(' OR '));
        } else {
          parts.push(normalized);
        }
      }
    }

    // Add set if available
    if (input.set) {
      const normalizedSet = textNormalizer.normalizeSet(input.set);
      if (normalizedSet.length >= 2) {
        parts.push(normalizedSet);
      }
    }

    // Add number if available (less weight in FTS)
    if (input.number) {
      const normalizedNumber = textNormalizer.normalizeNumber(input.number);
      if (normalizedNumber.length >= 1) {
        parts.push(normalizedNumber);
      }
    }

    if (parts.length === 0) {
      return null;
    }

    // Join with NEAR for better phrase matching
    return parts.length > 1 ? parts.join(' NEAR ') : parts[0];
  }
}

export const customRanking = CustomRanking.getInstance();