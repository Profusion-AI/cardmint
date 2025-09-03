/**
 * TextMatcher - ROI-based text extraction for promo codes and set identifiers
 * Handles alphanumeric patterns with regex validation
 */

import * as fs from 'fs/promises';
import sharp from 'sharp';
import { createLogger } from '../../../utils/logger';
import { createPerformanceLogger } from '../../../utils/localMatchingMetrics';
import { roiRegistry } from '../ROIRegistry';
import { hybridOCREngine } from '../ocr/HybridOCREngine';
import type { Matcher, MatchResult, MatchCandidate } from '../types';

const logger = createLogger('TextMatcher');

interface TextValidationResult {
  isValid: boolean;
  normalized: string;
  confidence: number;
  pattern: string;
  textType: 'promo' | 'set_code' | 'regulation_mark' | 'name' | 'generic';
}

export class TextMatcher implements Matcher {
  readonly name = 'text' as const;
  
  private initialized = false;
  private pokemonNames: string[] = [];
  
  // Known promo patterns with validation
  private readonly promoPatterns = [
    {
      name: 'xy_series',
      regex: /^XY(\d{1,3})$/i,
      confidence: 0.95,
      normalizer: (match: RegExpMatchArray) => `XY${match[1].padStart(2, '0')}`
    },
    {
      name: 'swsh_series', 
      regex: /^SWSH(\d{1,4})$/i,
      confidence: 0.95,
      normalizer: (match: RegExpMatchArray) => `SWSH${match[1].padStart(3, '0')}`
    },
    {
      name: 'sm_series',
      regex: /^SM(\d{1,3})$/i,
      confidence: 0.90,
      normalizer: (match: RegExpMatchArray) => `SM${match[1].padStart(2, '0')}`
    },
    {
      name: 'bw_series',
      regex: /^BW(\d{1,3})$/i,
      confidence: 0.90,
      normalizer: (match: RegExpMatchArray) => `BW${match[1].padStart(2, '0')}`
    },
    {
      name: 'dp_series',
      regex: /^DP(\d{1,3})$/i,
      confidence: 0.85,
      normalizer: (match: RegExpMatchArray) => `DP${match[1].padStart(2, '0')}`
    }
  ];

  // SV regulation marks
  private readonly regulationMarks = ['D', 'E', 'F', 'G', 'H'];
  
  constructor() {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await roiRegistry.initialize();
      await hybridOCREngine.initialize();
      // Load Pokemon lexicon for name validation
      try {
        const dataRoot = process.env.DATA_ROOT || './data';
        const raw = await fs.readFile(`${dataRoot}/pokemon_lexicon.json`, 'utf-8');
        const json = JSON.parse(raw);
        if (Array.isArray(json.pokemon_names)) {
          this.pokemonNames = json.pokemon_names.map((s: any) => String(s));
        }
      } catch (e) {
        this.pokemonNames = ['Pikachu', 'Charizard', 'Bulbasaur', 'Squirtle', 'Eevee'];
        logger.warn('pokemon_lexicon.json not found; using fallback names');
      }
      
      this.initialized = true;
      logger.info('TextMatcher initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize TextMatcher:', error);
      throw error;
    }
  }

  async match(imagePath: string, imageBuffer?: Buffer, hints?: {
    text_type?: 'promo' | 'set_code' | 'regulation_mark' | 'name';
    roi_template?: string;
    layout_hint?: string;
    orientation_deg?: number;
    expected_pattern?: string;
  }): Promise<MatchResult> {
    const perfLogger = createPerformanceLogger('TextMatcher.match');
    
    if (!this.initialized) await this.initialize();
    
    try {
      // Step 1: Load image
      let targetBuffer = imageBuffer;
      if (!targetBuffer) {
        targetBuffer = await fs.readFile(imagePath);
      }
      
      // Step 2: Extract appropriate ROI based on text type
      const roiBuffer = await this.extractTextROI(targetBuffer, hints);
      
      // Step 3: Configure OCR for text type
      const ocrType = this.mapTextTypeToOCRType(hints?.text_type);
      const ocrHints = this.getOCRHints(hints?.text_type, hints?.expected_pattern);
      
      // Step 4: Perform OCR
      const ocrResult = await hybridOCREngine.recognizeROI(roiBuffer, ocrType, ocrHints);
      
      // Step 5: Validate and normalize result
      const validation = this.validateText(ocrResult.text, hints?.text_type, hints?.expected_pattern);
      
      const processingTime = perfLogger.end({
        text_type: hints?.text_type || 'generic',
        ocr_confidence: ocrResult.confidence,
        validation_success: validation.isValid,
        extracted_text: validation.normalized
      });
      
      if (validation.isValid && validation.confidence > 0.4) {
        const candidate: MatchCandidate = {
          canonical_key: this.buildCanonicalKey(validation),
          confidence: Math.min(ocrResult.confidence, validation.confidence),
          metadata: {
            extracted_text: validation.normalized,
            raw_ocr_text: ocrResult.text,
            text_type: validation.textType,
            pattern_matched: validation.pattern,
            ocr_engine: ocrResult.engine,
            ocr_confidence: ocrResult.confidence,
            validation_confidence: validation.confidence,
            preprocessing: ocrResult.preprocessing_applied
          }
        };
        
        return {
          matched: true,
          confidence: candidate.confidence,
          best_candidate: candidate,
          all_candidates: [candidate],
          processing_time_ms: processingTime,
          cached: false,
          metadata: {
            text_type: validation.textType,
            pattern_validation: validation.pattern,
            normalized_text: validation.normalized
          }
        };
      }
      
      // No valid text found
      return {
        matched: false,
        confidence: Math.max(ocrResult.confidence * 0.3, validation.confidence),
        processing_time_ms: processingTime,
        cached: false,
        metadata: {
          raw_ocr_text: ocrResult.text,
          validation_failed: !validation.isValid,
          low_confidence: validation.confidence <= 0.4,
          text_type: hints?.text_type || 'generic',
          ocr_engine: ocrResult.engine
        }
      };
      
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      logger.error('TextMatcher failed:', error);
      
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: String(error) }
      };
    }
  }

  private async extractTextROI(imageBuffer: Buffer, hints?: any): Promise<Buffer> {
    try {
      // Determine image size for scaling
      const meta = await sharp(imageBuffer).metadata();
      const imgW = meta.width || 0;
      const imgH = meta.height || 0;

      const { rois, rotation } = await roiRegistry.getScaledROIs(imgW, imgH, {
        roi_template: hints?.roi_template,
        layout_hint: hints?.layout_hint,
        orientation_deg: hints?.orientation_deg
      });
      
      // Select appropriate ROI based on text type
      let targetROI;
      switch (hints?.text_type) {
        case 'promo':
          targetROI = rois.promo_star;
          break;
        case 'regulation_mark':
          targetROI = rois.regulation_mark;
          break;
        case 'name':
          targetROI = rois.card_name;
          break;
        case 'set_code':
          targetROI = rois.set_icon; // Set codes often near set icons
          break;
        default:
          targetROI = rois.bottom_band; // Generic text extraction
      }
      
      // Apply rotation if needed
      let image = sharp(imageBuffer);
      if (rotation !== 0) {
        image = image.rotate(rotation);
      }
      
      // Extract ROI with some padding for better OCR, clipped to bounds
      const padding = 10;
      const left = Math.max(0, Math.round(targetROI.x - padding));
      const top = Math.max(0, Math.round(targetROI.y - padding));
      const width = Math.max(1, Math.min(imgW - left, Math.round(targetROI.width + padding * 2)));
      const height = Math.max(1, Math.min(imgH - top, Math.round(targetROI.height + padding * 2)));
      const roiBuffer = await image
        .extract({ left, top, width, height })
        .toBuffer();
      
      logger.debug(`Extracted ${hints?.text_type || 'generic'} text ROI (scaled): ${width}x${height} @ ${left},${top}`);
      return roiBuffer;
      
    } catch (error) {
      logger.warn('Failed to extract text ROI, using full image:', error);
      return imageBuffer;
    }
  }

  private mapTextTypeToOCRType(textType?: string): 'promo' | 'set_code' | 'regulation_mark' | 'name' | 'text' {
    switch (textType) {
      case 'promo': return 'promo';
      case 'set_code': return 'set_code';
      case 'regulation_mark': return 'regulation_mark';
      case 'name': return 'name';
      default: return 'text';
    }
  }

  private getOCRHints(textType?: string, expectedPattern?: string): any {
    switch (textType) {
      case 'promo':
        return {
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          max_length: 10,
          expected_pattern: expectedPattern || '^(XY|SWSH|SM|BW|DP)\\d+'
        };
      case 'name':
        return {
          whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-' .♀♂",
          max_length: 24,
          expected_pattern: expectedPattern || undefined
        };
        
      case 'set_code':
        return {
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          max_length: 5,
          expected_pattern: expectedPattern || '^[A-Z]{2,5}$'
        };
        
      case 'regulation_mark':
        return {
          whitelist: 'DEFGH',
          max_length: 1,
          expected_pattern: expectedPattern || '^[DEFGH]$'
        };
        
      default:
        return {
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          max_length: 20
        };
    }
  }

  private validateText(text: string, textType?: string, expectedPattern?: string): TextValidationResult {
    const cleanText = text.trim().toUpperCase().replace(/[^A-Z0-9\- '\.♀♂]/g, '');
    
    if (!cleanText) {
      return {
        isValid: false,
        normalized: '',
        confidence: 0,
        pattern: 'empty',
        textType: 'generic'
      };
    }
    
    // Validate based on text type
    switch (textType) {
      case 'promo':
        return this.validatePromoCode(cleanText);
      case 'regulation_mark':
        return this.validateRegulationMark(cleanText);
      case 'set_code':
        return this.validateSetCode(cleanText);
      case 'name':
        return this.validateName(text);
      default:
        return this.validateGenericText(cleanText, expectedPattern);
    }
  }

  private validateName(rawText: string): TextValidationResult {
    const cleaned = rawText.replace(/[^A-Za-z0-9\- '\.♀♂]/g, '').trim();
    if (!cleaned) {
      return { isValid: false, normalized: '', confidence: 0, pattern: 'empty', textType: 'name' };
    }
    const exact = this.pokemonNames.find(n => n.toLowerCase() === cleaned.toLowerCase());
    if (exact) {
      return { isValid: true, normalized: exact, confidence: 0.98, pattern: 'exact_lexicon', textType: 'name' };
    }
    let best = '';
    let bestScore = 0;
    for (const name of this.pokemonNames) {
      const score = this.fuzzySimilarity(cleaned, name);
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    if (best && bestScore >= 0.72) {
      return { isValid: true, normalized: best, confidence: bestScore, pattern: 'fuzzy_lexicon', textType: 'name' };
    }
    return { isValid: true, normalized: cleaned, confidence: 0.55, pattern: 'raw_text', textType: 'name' };
  }

  private fuzzySimilarity(a: string, b: string): number {
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return 1;
    if (s1 && s2 && (s1.includes(s2) || s2.includes(s1))) return 0.9;
    const dist = this.levenshteinDistance(s1, s2);
    const maxLen = Math.max(s1.length, s2.length) || 1;
    return Math.max(0, 1 - dist / maxLen);
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length, n = str2.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) dp[i][j] = dp[i - 1][j - 1];
        else dp[i][j] = Math.min(dp[i - 1][j - 1] + 1, dp[i][j - 1] + 1, dp[i - 1][j] + 1);
      }
    }
    return dp[m][n];
  }

  private validatePromoCode(text: string): TextValidationResult {
    // Try known promo patterns
    for (const pattern of this.promoPatterns) {
      const match = text.match(pattern.regex);
      if (match) {
        const normalized = pattern.normalizer(match);
        return {
          isValid: true,
          normalized,
          confidence: pattern.confidence,
          pattern: pattern.name,
          textType: 'promo'
        };
      }
    }
    
    // Check for generic promo pattern
    const genericPromoMatch = text.match(/^([A-Z]{2,4})(\d{1,4})$/);
    if (genericPromoMatch) {
      const [, prefix, number] = genericPromoMatch;
      const normalized = `${prefix}${number.padStart(2, '0')}`;
      return {
        isValid: true,
        normalized,
        confidence: 0.70, // Lower confidence for unknown patterns
        pattern: 'generic_promo',
        textType: 'promo'
      };
    }
    
    return {
      isValid: false,
      normalized: text,
      confidence: 0.1,
      pattern: 'invalid_promo',
      textType: 'promo'
    };
  }

  private validateRegulationMark(text: string): TextValidationResult {
    const mark = text.charAt(0);
    
    if (this.regulationMarks.includes(mark)) {
      return {
        isValid: true,
        normalized: mark,
        confidence: 0.95,
        pattern: 'sv_regulation_mark',
        textType: 'regulation_mark'
      };
    }
    
    return {
      isValid: false,
      normalized: text,
      confidence: 0,
      pattern: 'invalid_regulation_mark',
      textType: 'regulation_mark'
    };
  }

  private validateSetCode(text: string): TextValidationResult {
    // Set codes are typically 2-5 uppercase letters
    if (text.match(/^[A-Z]{2,5}$/) && text.length >= 2) {
      return {
        isValid: true,
        normalized: text,
        confidence: 0.85,
        pattern: 'set_code',
        textType: 'set_code'
      };
    }
    
    return {
      isValid: false,
      normalized: text,
      confidence: 0.2,
      pattern: 'invalid_set_code',
      textType: 'set_code'
    };
  }

  private validateGenericText(text: string, expectedPattern?: string): TextValidationResult {
    if (expectedPattern) {
      try {
        const regex = new RegExp(expectedPattern, 'i');
        if (regex.test(text)) {
          return {
            isValid: true,
            normalized: text,
            confidence: 0.80,
            pattern: 'custom_pattern',
            textType: 'generic'
          };
        }
      } catch (error) {
        logger.warn('Invalid regex pattern:', expectedPattern);
      }
    }
    
    // Generic validation - any reasonable text
    if (text.length >= 1 && text.length <= 50) {
      return {
        isValid: true,
        normalized: text,
        confidence: 0.60,
        pattern: 'generic_text',
        textType: 'generic'
      };
    }
    
    return {
      isValid: false,
      normalized: text,
      confidence: 0,
      pattern: 'invalid_text',
      textType: 'generic'
    };
  }

  private buildCanonicalKey(validation: TextValidationResult): string {
    switch (validation.textType) {
      case 'promo':
        return `*|*|*|${validation.normalized.toLowerCase()}`;
      case 'regulation_mark':
        return `*|*|${validation.normalized}|*`;
      case 'set_code':
        return `${validation.normalized.toLowerCase()}|*|*|*`;
      case 'name':
        return `*|*|*|${validation.normalized.toLowerCase().replace(/\s+/g, '-')}`;
      default:
        return `*|*|*|${validation.normalized.toLowerCase()}`;
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  getStats(): Record<string, any> {
    return {
      initialized: this.initialized,
      ocrReady: hybridOCREngine.isReady(),
      roiReady: roiRegistry ? true : false,
      promoPatterns: this.promoPatterns.length,
      regulationMarks: this.regulationMarks.length,
      lexiconSize: this.pokemonNames.length
    };
  }
}

// Export a singleton instance
export const textMatcher = new TextMatcher();
