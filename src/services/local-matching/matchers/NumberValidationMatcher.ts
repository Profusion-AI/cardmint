/**
 * NumberValidationMatcher - Validates card numbers against known patterns
 * Provides confidence boost for recognized number formats
 */

import { createLogger } from '../../../utils/logger';
import { DatabaseQueryService } from '../../db/DatabaseQueryService';
import type { Matcher, MatchResult, MatchCandidate } from '../types';

const logger = createLogger('NumberValidationMatcher');

interface NumberPattern {
  pattern: RegExp;
  setType: string;
  confidence: number;
}

export class NumberValidationMatcher implements Matcher {
  public readonly name = 'number' as const;
  
  private dbService: DatabaseQueryService;
  private numberPatterns: NumberPattern[] = [];
  private ready = false;

  constructor(dbService: DatabaseQueryService) {
    this.dbService = dbService;
    this.initializePatterns();
  }

  private initializePatterns(): void {
    // Common Pokemon card number patterns
    this.numberPatterns = [
      // Base Set style: 1/102, 15/102, etc.
      { 
        pattern: /^(\d+)\/(\d+)$/, 
        setType: 'numbered_set', 
        confidence: 0.9 
      },
      
      // Promo style: 001, 025, etc.
      { 
        pattern: /^(\d{3})$/, 
        setType: 'promo_three_digit', 
        confidence: 0.8 
      },
      
      // Modern style: 001/198, 025/198, etc.
      { 
        pattern: /^(\d{3})\/(\d{3})$/, 
        setType: 'modern_numbered', 
        confidence: 0.85 
      },
      
      // Special codes: SM01, DP01, etc.
      { 
        pattern: /^([A-Z]{2})(\d+)$/, 
        setType: 'special_code', 
        confidence: 0.75 
      },
      
      // Japanese style: 001-060, etc.
      { 
        pattern: /^(\d{3})-(\d{3})$/, 
        setType: 'japanese_style', 
        confidence: 0.7 
      },
      
      // Single numbers: 1, 15, 25, etc.
      { 
        pattern: /^(\d{1,2})$/, 
        setType: 'simple_number', 
        confidence: 0.6 
      }
    ];
    
    this.ready = true;
    logger.info(`Number validation matcher initialized with ${this.numberPatterns.length} patterns`);
  }

  async match(imagePath: string, imageBuffer?: Buffer): Promise<MatchResult> {
    const startTime = Date.now();
    
    if (!this.ready) {
      return {
        method: this.name,
        confidence: 0,
        candidates: [],
        processing_time_ms: Date.now() - startTime,
        timings: { [this.name]: Date.now() - startTime }
      };
    }
    
    try {
      // Extract potential card number from filename or path
      // In real implementation, this would come from OCR or other source
      const extractedNumber = this.extractNumberFromPath(imagePath);
      
      if (!extractedNumber) {
        return {
          method: this.name,
          confidence: 0,
          candidates: [],
          processing_time_ms: Date.now() - startTime,
          timings: { [this.name]: Date.now() - startTime }
        };
      }
      
      // Validate number format
      const validation = this.validateNumber(extractedNumber);
      
      // Create candidate if validation passes
      const candidates: MatchCandidate[] = [];
      if (validation.isValid) {
        const candidate: MatchCandidate = {
          id: `number-${extractedNumber}`,
          number: extractedNumber,
          score: validation.confidence,
          // Try to enhance with database lookup
          ...(await this.enhanceWithDatabase(extractedNumber, validation.setType))
        };
        
        candidates.push(candidate);
      }
      
      const processingTime = Date.now() - startTime;
      
      return {
        method: this.name,
        confidence: validation.confidence,
        best: candidates[0],
        candidates,
        processing_time_ms: processingTime,
        timings: { [this.name]: processingTime }
      };
      
    } catch (error) {
      logger.error('Error in number validation matching:', error);
      return {
        method: this.name,
        confidence: 0,
        candidates: [],
        processing_time_ms: Date.now() - startTime,
        timings: { [this.name]: Date.now() - startTime }
      };
    }
  }

  private extractNumberFromPath(imagePath: string): string | null {
    // Extract number from filename patterns like "base1-6.png" -> "6"
    const filename = imagePath.split('/').pop() || '';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    
    // Try different extraction patterns
    const patterns = [
      /^[a-zA-Z0-9]+-(\d+(?:\/\d+)?)$/, // setcode-number
      /^(\d+(?:\/\d+)?)$/, // just number
      /(\d+(?:\/\d+)?)/, // any number in string
    ];
    
    for (const pattern of patterns) {
      const match = nameWithoutExt.match(pattern);
      if (match) {
        return match[1];
      }
    }
    
    return null;
  }

  private validateNumber(number: string): {isValid: boolean, confidence: number, setType: string} {
    for (const pattern of this.numberPatterns) {
      if (pattern.pattern.test(number)) {
        return {
          isValid: true,
          confidence: pattern.confidence,
          setType: pattern.setType
        };
      }
    }
    
    return {
      isValid: false,
      confidence: 0,
      setType: 'unknown'
    };
  }

  private async enhanceWithDatabase(number: string, setType: string): Promise<Partial<MatchCandidate>> {
    try {
      // Try to find cards with this number in the database
      const results = await this.dbService.executeReadOnly('cardmint', `
        SELECT name, set_name, set_code, rarity
        FROM pokemon_cards 
        WHERE number = ?
        ORDER BY name
        LIMIT 5
      `, [number]);
      
      if (results.length > 0) {
        const firstResult = results[0];
        return {
          name: firstResult.name,
          set: firstResult.set_name,
          rarity: firstResult.rarity
        };
      }
      
    } catch (error) {
      logger.debug('Database lookup failed for number validation:', error);
    }
    
    return {};
  }

  isReady(): boolean {
    return this.ready;
  }

  getPatterns(): NumberPattern[] {
    return [...this.numberPatterns];
  }

  // Method to add custom patterns
  addPattern(pattern: RegExp, setType: string, confidence: number): void {
    this.numberPatterns.push({ pattern, setType, confidence });
    logger.debug(`Added custom number pattern: ${pattern.source}`);
  }

  // Method to validate a specific number format
  validateFormat(number: string): {
    isValid: boolean;
    confidence: number;
    setType: string;
    matches: Array<{pattern: string, type: string, confidence: number}>;
  } {
    const matches: Array<{pattern: string, type: string, confidence: number}> = [];
    let bestMatch = { isValid: false, confidence: 0, setType: 'unknown' };
    
    for (const pattern of this.numberPatterns) {
      if (pattern.pattern.test(number)) {
        matches.push({
          pattern: pattern.pattern.source,
          type: pattern.setType,
          confidence: pattern.confidence
        });
        
        if (pattern.confidence > bestMatch.confidence) {
          bestMatch = {
            isValid: true,
            confidence: pattern.confidence,
            setType: pattern.setType
          };
        }
      }
    }
    
    return {
      ...bestMatch,
      matches
    };
  }

  getStats(): {
    ready: boolean;
    patterns: number;
  } {
    return {
      ready: this.ready,
      patterns: this.numberPatterns.length
    };
  }
}