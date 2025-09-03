/**
 * NumberMatcher - ROI-based card number extraction using hybrid OCR
 * Specialized for bottom-band number patterns with validation
 */

import * as fs from 'fs/promises';
import sharp from 'sharp';
import { createLogger } from '../../../utils/logger';
import { createPerformanceLogger } from '../../../utils/localMatchingMetrics';
import { roiRegistry } from '../ROIRegistry';
import { hybridOCREngine } from '../ocr/HybridOCREngine';
import type { Matcher, MatchResult, MatchCandidate } from '../types';

const logger = createLogger('NumberMatcher');

interface NumberValidationResult {
  isValid: boolean;
  normalized: string;
  confidence: number;
  pattern: string;
}

export class NumberMatcher implements Matcher {
  readonly name = 'number' as const;
  
  private initialized = false;
  
  constructor() {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Initialize dependencies
      await roiRegistry.initialize();
      await hybridOCREngine.initialize();
      
      this.initialized = true;
      logger.info('NumberMatcher initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize NumberMatcher:', error);
      throw error;
    }
  }

  async match(imagePath: string, imageBuffer?: Buffer, hints?: {
    roi_template?: string;
    number_format?: string;
    orientation_deg?: number;
    expected_set?: string;
  }): Promise<MatchResult> {
    const perfLogger = createPerformanceLogger('NumberMatcher.match');
    
    if (!this.initialized) await this.initialize();
    
    try {
      // Step 1: Load image
      let targetBuffer = imageBuffer;
      if (!targetBuffer) {
        targetBuffer = await fs.readFile(imagePath);
      }
      
      // Step 2: Extract bottom-band ROI
      const bottomBandROI = await this.extractBottomBandROI(targetBuffer, hints);
      
      // Step 3: Perform OCR on the ROI
      const ocrResult = await hybridOCREngine.recognizeROI(
        bottomBandROI,
        'number',
        {
          expected_pattern: hints?.number_format || 'ddd/ddd',
          whitelist: '0123456789/',
          max_length: 10,
          rotation_deg: hints?.orientation_deg
        }
      );
      
      // Step 4: Validate and normalize the result
      const validation = this.validateNumber(ocrResult.text, hints?.number_format);
      
      const processingTime = perfLogger.end({
        ocr_confidence: ocrResult.confidence,
        validation_success: validation.isValid,
        number_extracted: validation.normalized
      });
      
      if (validation.isValid && validation.confidence > 0.3) {
        // Create candidate with normalized number
        const candidate: MatchCandidate = {
          canonical_key: `*|${validation.normalized}|*|*`, // Number-only match
          confidence: Math.min(ocrResult.confidence, validation.confidence),
          metadata: {
            extracted_number: validation.normalized,
            raw_ocr_text: ocrResult.text,
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
            roi_extraction: 'bottom_band',
            pattern_validation: validation.pattern,
            normalized_number: validation.normalized
          }
        };
      }
      
      // No valid number found
      return {
        matched: false,
        confidence: Math.max(ocrResult.confidence * 0.5, validation.confidence),
        processing_time_ms: processingTime,
        cached: false,
        metadata: {
          raw_ocr_text: ocrResult.text,
          validation_failed: !validation.isValid,
          low_confidence: validation.confidence <= 0.3,
          ocr_engine: ocrResult.engine
        }
      };
      
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      logger.error('NumberMatcher failed:', error);
      
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: String(error) }
      };
    }
  }

  private async extractBottomBandROI(imageBuffer: Buffer, hints?: any): Promise<Buffer> {
    try {
      // Get image dimensions
      const meta = await sharp(imageBuffer).metadata();
      const imgW = meta.width || 0;
      const imgH = meta.height || 0;

      // Get scaled ROI based on actual image size
      const { rois, rotation } = await roiRegistry.getScaledROIs(imgW, imgH, {
        roi_template: hints?.roi_template,
        layout_hint: hints?.layout_hint,
        orientation_deg: hints?.orientation_deg
      });
      const bottomBandROI = rois.bottom_band;

      // Apply rotation then crop
      let image = sharp(imageBuffer);
      if (rotation !== 0) {
        image = image.rotate(rotation);
      }

      // Clip ROI to image bounds
      const left = Math.max(0, Math.round(bottomBandROI.x));
      const top = Math.max(0, Math.round(bottomBandROI.y));
      const width = Math.max(1, Math.min(imgW - left, Math.round(bottomBandROI.width)));
      const height = Math.max(1, Math.min(imgH - top, Math.round(bottomBandROI.height)));

      const roiBuffer = await image
        .extract({ left, top, width, height })
        .toBuffer();

      logger.debug(`Extracted bottom-band ROI (scaled): ${width}x${height} @ ${left},${top}`);
      return roiBuffer;
      
    } catch (error) {
      logger.warn('Failed to extract bottom-band ROI, using full image:', error);
      return imageBuffer;
    }
  }

  private validateNumber(text: string, expectedFormat?: string): NumberValidationResult {
    const cleanText = text.trim().replace(/[^\d\/]/g, ''); // Keep only digits and /
    
    if (!cleanText) {
      return {
        isValid: false,
        normalized: '',
        confidence: 0,
        pattern: 'empty'
      };
    }
    
    // Define number patterns
    const patterns = [
      {
        name: 'standard_ratio',
        regex: /^(\d{1,3})\/(\d{1,3})$/,
        normalizer: (match: RegExpMatchArray) => {
          const num = match[1].padStart(3, '0');
          const total = match[2].padStart(3, '0');
          return `${parseInt(num)}/${parseInt(total)}`;
        },
        confidence: 0.95
      },
      {
        name: 'simple_number',
        regex: /^(\d{1,4})$/,
        normalizer: (match: RegExpMatchArray) => {
          const num = parseInt(match[1]).toString();
          return num;
        },
        confidence: 0.80
      },
      {
        name: 'partial_ratio',
        regex: /(\d{1,3}).*?(\d{1,3})/,
        normalizer: (match: RegExpMatchArray) => {
          return `${parseInt(match[1])}/${parseInt(match[2])}`;
        },
        confidence: 0.60
      }
    ];
    
    // Try patterns in priority order
    for (const pattern of patterns) {
      const match = cleanText.match(pattern.regex);
      if (match) {
        const normalized = pattern.normalizer(match);
        
        // Additional validation
        if (pattern.name === 'standard_ratio') {
          const [num, total] = normalized.split('/').map(Number);
          if (num > 0 && total > 0 && num <= total && total <= 999) {
            return {
              isValid: true,
              normalized,
              confidence: pattern.confidence,
              pattern: pattern.name
            };
          }
        } else if (pattern.name === 'simple_number') {
          const num = parseInt(normalized);
          if (num > 0 && num <= 9999) {
            return {
              isValid: true,
              normalized,
              confidence: pattern.confidence,
              pattern: pattern.name
            };
          }
        } else {
          return {
            isValid: true,
            normalized,
            confidence: pattern.confidence,
            pattern: pattern.name
          };
        }
      }
    }
    
    // No valid pattern found
    return {
      isValid: false,
      normalized: cleanText,
      confidence: cleanText.length > 0 ? 0.1 : 0,
      pattern: 'invalid'
    };
  }

  isReady(): boolean {
    return this.initialized;
  }

  getStats(): Record<string, any> {
    return {
      initialized: this.initialized,
      ocrReady: hybridOCREngine.isReady(),
      roiReady: roiRegistry ? true : false
    };
  }
}

// Export a singleton instance
export const numberMatcher = new NumberMatcher();
