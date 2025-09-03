/**
 * HybridOCREngine - Dual OCR strategy with PaddleOCR and Tesseract
 * Optimized for ROI-specific micro-tasks with strict preprocessing
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import sharp from 'sharp';
import { createWorker, Worker } from 'tesseract.js';
import { createLogger } from '../../../utils/logger';
import { createPerformanceLogger } from '../../../utils/localMatchingMetrics';
import type { Rectangle } from '../ROIRegistry';

const logger = createLogger('HybridOCREngine');

export interface OCRResult {
  text: string;
  confidence: number;
  engine: 'tesseract' | 'paddle';
  processing_time_ms: number;
  preprocessing_applied: string[];
  metadata?: Record<string, any>;
}

export interface OCRConfig {
  engine: 'tesseract' | 'paddle' | 'hybrid';
  tesseract: {
    psm: number;
    oem: number;
    whitelist: string;
    blacklist: string;
    load_system_dawg: boolean;
    load_freq_dawg: boolean;
  };
  paddle: {
    model_dir: string;
    use_gpu: boolean;
    use_tensorrt: boolean;
    precision: 'fp32' | 'fp16' | 'int8';
    rec_batch_num: number;
    max_text_length: number;
  };
  preprocessing: {
    normalize_height: number;
    apply_clahe: boolean;
    apply_unsharp: boolean;
    threshold_method: 'sauvola' | 'adaptive' | 'otsu';
    morphology_ops: string[];
    rotation_tolerance: number;
  };
}

export type ROIType = 'number' | 'promo' | 'set_code' | 'regulation_mark' | 'name' | 'text';

export class HybridOCREngine {
  private tesseractWorker: Worker | null = null;
  private paddleWorker: any = null; // PaddleOCR instance
  private initialized = false;
  private warmupComplete = false;
  
  private readonly config: OCRConfig;
  
  constructor() {
    this.config = {
      engine: (process.env.OCR_ENGINE as any) || 'hybrid',
      tesseract: {
        psm: parseInt(process.env.OCR_NUM_PSM || '7'),
        oem: 3, // Default LSTM OCR Engine Mode
        whitelist: process.env.OCR_WHITELIST_NUM || '0123456789/',
        blacklist: '',
        load_system_dawg: process.env.TESSERACT_LOAD_DAWG !== 'true',
        load_freq_dawg: process.env.TESSERACT_LOAD_DAWG !== 'true'
      },
      paddle: {
        model_dir: path.join(process.env.DATA_ROOT || './data', 'paddle_models'),
        use_gpu: process.env.PADDLE_USE_GPU === 'true',
        use_tensorrt: process.env.PADDLE_USE_TENSORRT === 'true',
        precision: (process.env.PADDLE_PRECISION as any) || 'fp32',
        rec_batch_num: parseInt(process.env.PADDLE_BATCH_SIZE || '1'),
        max_text_length: parseInt(process.env.PADDLE_MAX_LENGTH || '25')
      },
      preprocessing: {
        normalize_height: parseInt(process.env.OCR_NORMALIZE_HEIGHT || '64'),
        apply_clahe: process.env.OCR_APPLY_CLAHE !== 'false',
        apply_unsharp: process.env.OCR_APPLY_UNSHARP === 'true',
        threshold_method: (process.env.OCR_THRESHOLD_METHOD as any) || 'sauvola',
        morphology_ops: (process.env.OCR_MORPHOLOGY_OPS || 'close').split(','),
        rotation_tolerance: parseInt(process.env.SV_ROTATION_TOLERANCE || '5')
      }
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    const perfLogger = createPerformanceLogger('HybridOCREngine.initialize');
    
    try {
      logger.info('Initializing HybridOCREngine...', {
        engine: this.config.engine,
        tesseract_psm: this.config.tesseract.psm,
        paddle_precision: this.config.paddle.precision
      });
      
      // Initialize Tesseract worker
      if (this.config.engine === 'tesseract' || this.config.engine === 'hybrid') {
        await this.initializeTesseract();
      }
      
      // Initialize PaddleOCR
      if (this.config.engine === 'paddle' || this.config.engine === 'hybrid') {
        await this.initializePaddle();
      }
      
      // Warm up engines
      if (process.env.OCR_WARMUP === 'true') {
        await this.warmUp();
      }
      
      this.initialized = true;
      const initTime = perfLogger.end({
        tesseract_ready: !!this.tesseractWorker,
        paddle_ready: !!this.paddleWorker
      });
      
      logger.info(`HybridOCREngine initialized successfully (${initTime}ms)`);
      
    } catch (error) {
      perfLogger.end({ error: true });
      logger.error('Failed to initialize HybridOCREngine:', error);
      throw error;
    }
  }

  private async initializeTesseract(): Promise<void> {
    this.tesseractWorker = await createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          logger.debug(`Tesseract progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    
    // Configure Tesseract parameters
    await this.tesseractWorker.setParameters({
      tessedit_pageseg_mode: this.config.tesseract.psm.toString(),
      tessedit_ocr_engine_mode: this.config.tesseract.oem.toString(),
      tessedit_char_whitelist: this.config.tesseract.whitelist,
      tessedit_char_blacklist: this.config.tesseract.blacklist,
      load_system_dawg: this.config.tesseract.load_system_dawg.toString(),
      load_freq_dawg: this.config.tesseract.load_freq_dawg.toString(),
      load_unambig_dawg: 'false',
      load_punc_dawg: 'false',
      load_number_dawg: 'false',
      load_fixed_length_dawgs: 'false'
    });
    
    logger.debug('Tesseract worker initialized');
  }

  private async initializePaddle(): Promise<void> {
    try {
      // Try to load PaddleOCR - note this is a placeholder as the actual
      // PaddleOCR Node.js implementation may vary
      // const PaddleOCR = require('@paddlejs-models/ocr');
      // this.paddleWorker = new PaddleOCR(this.config.paddle);
      
      logger.debug('PaddleOCR initialization skipped (implementation pending)');
      // For now, we'll use Tesseract as fallback for all operations
      
    } catch (error) {
      logger.warn('PaddleOCR not available, using Tesseract only:', error);
      this.paddleWorker = null;
    }
  }

  private async warmUp(): Promise<void> {
    if (this.warmupComplete) return;
    
    try {
      logger.debug('Warming up OCR engines...');
      
      // Create a dummy test image with text
      const testImageBuffer = await this.createTestImage();
      
      // Warm up Tesseract
      if (this.tesseractWorker) {
        await this.recognizeWithTesseract(testImageBuffer, 'number');
      }
      
      // Warm up PaddleOCR
      if (this.paddleWorker) {
        // await this.recognizeWithPaddle(testImageBuffer, 'text');
      }
      
      this.warmupComplete = true;
      logger.debug('OCR engines warmed up successfully');
      
    } catch (error) {
      logger.warn('OCR warmup failed:', error);
    }
  }

  private async createTestImage(): Promise<Buffer> {
    // Create a simple test image with "123/456" text
    // This would use canvas or sharp to generate a test image
    // For now, return a placeholder
    return Buffer.from([]);
  }

  async recognizeROI(
    imageBuffer: Buffer,
    roiType: ROIType,
    hints?: {
      expected_pattern?: string;
      whitelist?: string;
      max_length?: number;
      rotation_deg?: number;
    }
  ): Promise<OCRResult> {
    if (!this.initialized) await this.initialize();
    
    const perfLogger = createPerformanceLogger(`OCR.${roiType}`);
    
    try {
      // Preprocess the ROI image
      const preprocessedBuffer = await this.preprocessROI(imageBuffer, roiType, hints);
      
      // Choose engine based on ROI type and configuration
      const engine = this.selectEngine(roiType);
      
      let result: OCRResult;
      
      if (engine === 'tesseract') {
        result = await this.recognizeWithTesseract(preprocessedBuffer, roiType, hints);
      } else if (engine === 'paddle') {
        result = await this.recognizeWithPaddle(preprocessedBuffer, roiType, hints);
      } else {
        // Hybrid: try fast path first, fallback if needed
        result = await this.recognizeHybrid(preprocessedBuffer, roiType, hints);
      }
      
      // Post-process and validate result
      result = await this.postProcessResult(result, roiType, hints);
      
      const processingTime = perfLogger.end({
        engine: result.engine,
        confidence: result.confidence,
        text_length: result.text.length
      });
      
      result.processing_time_ms = processingTime;
      
      return result;
      
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      
      logger.error(`OCR failed for ${roiType}:`, error);
      
      return {
        text: '',
        confidence: 0,
        engine: 'tesseract',
        processing_time_ms: errorTime,
        preprocessing_applied: [],
        metadata: { error: String(error) }
      };
    }
  }

  private selectEngine(roiType: ROIType): 'tesseract' | 'paddle' | 'hybrid' {
    if (this.config.engine !== 'hybrid') {
      return this.config.engine;
    }
    
    // Engine selection strategy based on ROI type
    switch (roiType) {
      case 'number':
        return 'tesseract'; // Fast and accurate for numbers
      case 'promo':
        return this.paddleWorker ? 'paddle' : 'tesseract'; // Better for alphanumeric
      case 'set_code':
        return this.paddleWorker ? 'paddle' : 'tesseract'; // Better for short codes
      case 'regulation_mark':
        return 'tesseract'; // Simple single characters
      case 'text':
      default:
        return this.paddleWorker ? 'paddle' : 'tesseract';
    }
  }

  private async preprocessROI(
    buffer: Buffer, 
    roiType: ROIType,
    hints?: { rotation_deg?: number }
  ): Promise<Buffer> {
    const steps: string[] = [];

    try {
      let image = sharp(buffer, { sequentialRead: true });

      // Rotation (light tolerance only; heavy rotations belong upstream in ROIRegistry)
      const rot = hints?.rotation_deg;
      if (rot && Math.abs(rot) > 0.1) {
        image = image.rotate(rot);
        steps.push(`rotate_${Math.round(rot)}deg`);
      }

      // Normalize height by ROI type (small, legible glyphs)
      const targetHeight = roiType === 'number' ? 48 :
                          roiType === 'promo' ? 64 :
                          this.config.preprocessing.normalize_height;

      image = image.resize({
        height: targetHeight,
        kernel: sharp.kernel.lanczos3,
        fastShrinkOnLoad: true,
      });
      steps.push(`normalize_h${targetHeight}`);

      // Grayscale + normalize (contrast stretch)
      image = image.grayscale().normalize();
      steps.push('grayscale', 'normalize');

      // Light denoise for tiny ROIs
      image = image.median(1);
      steps.push('median_1');

      // Threshold proxy (adaptive methods not natively available in sharp)
      // Use a mid-level threshold; for darker bands, normalization helps.
      image = image.threshold();
      steps.push(`${this.config.preprocessing.threshold_method}_threshold`);

      // Optional unsharp for crisp edges
      if (this.config.preprocessing.apply_unsharp) {
        image = image.sharpen(1, 1, 0.5);
        steps.push('unsharp');
      }

      const out = await image.toBuffer();
      logger.debug(`Preprocessing applied: ${steps.join(', ')}`);
      return out;
    } catch (err) {
      logger.warn('PreprocessROI failed; using raw buffer:', err);
      return buffer;
    }
  }

  private async recognizeWithTesseract(
    buffer: Buffer, 
    roiType: ROIType,
    hints?: any
  ): Promise<OCRResult> {
    if (!this.tesseractWorker) {
      throw new Error('Tesseract worker not initialized');
    }
    
    // Configure parameters for this specific recognition
    const config = this.getTesseractConfig(roiType, hints);
    
    // Update parameters if needed
    await this.tesseractWorker.setParameters(config);
    
    const startTime = Date.now();
    const result = await this.tesseractWorker.recognize(buffer);
    const processingTime = Date.now() - startTime;
    
    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence / 100, // Convert to 0-1 range
      engine: 'tesseract',
      processing_time_ms: processingTime,
      preprocessing_applied: [], // Will be filled by caller
      metadata: {
        psm: config.tessedit_pageseg_mode,
        whitelist: config.tessedit_char_whitelist,
        blocks: result.data.blocks?.length || 0,
        words: result.data.words?.length || 0
      }
    };
  }

  private getTesseractConfig(roiType: ROIType, hints?: any): Record<string, string> {
    // Only set runtime-safe params here; init-only params are set once in initializeTesseract
    const baseConfig: Record<string, string> = {};
    
    switch (roiType) {
      case 'number':
        return {
          ...baseConfig,
          tessedit_pageseg_mode: '7', // Single text line
          tessedit_char_whitelist: hints?.whitelist || '0123456789/',
          tessedit_char_blacklist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        };
        
      case 'promo':
        return {
          ...baseConfig,
          tessedit_pageseg_mode: '8', // Single word
          tessedit_char_whitelist: hints?.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          tessedit_char_blacklist: ''
        };
        
      case 'set_code':
      case 'regulation_mark':
        return {
          ...baseConfig,
          tessedit_pageseg_mode: '8', // Single word
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          tessedit_char_blacklist: '0123456789'
        };
      case 'name':
        return {
          ...baseConfig,
          tessedit_pageseg_mode: '7', // Single line (name bar)
          tessedit_char_whitelist: hints?.whitelist || "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-' .♀♂",
          tessedit_char_blacklist: ''
        };
        
      default:
        return {
          ...baseConfig,
          tessedit_pageseg_mode: this.config.tesseract.psm.toString(),
          tessedit_char_whitelist: this.config.tesseract.whitelist,
          tessedit_char_blacklist: this.config.tesseract.blacklist
        };
    }
  }

  private async recognizeWithPaddle(
    buffer: Buffer, 
    roiType: ROIType,
    hints?: any
  ): Promise<OCRResult> {
    if (!this.paddleWorker) {
      // Fallback to Tesseract
      return this.recognizeWithTesseract(buffer, roiType, hints);
    }
    
    // TODO: Implement actual PaddleOCR recognition
    // const result = await this.paddleWorker.recognize(buffer);
    
    // Placeholder implementation
    return {
      text: '',
      confidence: 0,
      engine: 'paddle',
      processing_time_ms: 0,
      preprocessing_applied: [],
      metadata: { status: 'not_implemented' }
    };
  }

  private async recognizeHybrid(
    buffer: Buffer, 
    roiType: ROIType,
    hints?: any
  ): Promise<OCRResult> {
    // Strategy: Try fast Tesseract first, fallback to PaddleOCR if confidence is low
    const tesseractResult = await this.recognizeWithTesseract(buffer, roiType, hints);
    
    // Define confidence threshold for fallback
    const fallbackThreshold = 0.6;
    
    if (tesseractResult.confidence >= fallbackThreshold) {
      return tesseractResult; // Good enough, use fast result
    }
    
    // Low confidence, try PaddleOCR for better accuracy
    if (this.paddleWorker) {
      logger.debug(`Low Tesseract confidence (${tesseractResult.confidence}), trying PaddleOCR`);
      const paddleResult = await this.recognizeWithPaddle(buffer, roiType, hints);
      
      // Use the result with higher confidence
      return paddleResult.confidence > tesseractResult.confidence ? 
             paddleResult : tesseractResult;
    }
    
    return tesseractResult; // No fallback available
  }

  private async postProcessResult(
    result: OCRResult, 
    roiType: ROIType,
    hints?: { expected_pattern?: string; max_length?: number }
  ): Promise<OCRResult> {
    
    let text = result.text;
    const originalText = text;
    
    // Clean up common OCR errors
    text = text.replace(/[^\w\s\/]/g, ''); // Remove special characters except word chars, spaces, and /
    text = text.trim();
    
    // Apply type-specific post-processing
    switch (roiType) {
      case 'number':
        // Enforce number/ratio pattern: ddd/ddd
        const numberMatch = text.match(/(\d{1,3}).*?(\d{1,3})/);
        if (numberMatch) {
          text = `${numberMatch[1]}/${numberMatch[2]}`;
        }
        break;
        
      case 'promo':
        // Validate promo pattern: XY##, SWSH###, etc.
        const promoPattern = /^(XY\d{1,3}|SWSH\d{1,4}|[A-Z]{2,4}\d{1,4})$/;
        if (!promoPattern.test(text)) {
          result.confidence *= 0.5; // Penalize invalid patterns
        }
        break;
        
      case 'set_code':
        // Clean to uppercase letters only
        text = text.replace(/[^A-Z]/g, '');
        if (text.length > 5) {
          text = text.substring(0, 5); // Limit length
        }
        break;
        
      case 'regulation_mark':
        // Should be single letter D, E, F, G, or H
        text = text.replace(/[^DEFGH]/g, '');
        if (text.length > 1) {
          text = text.charAt(0);
        }
        break;
    }
    
    // Apply length limits
    if (hints?.max_length && text.length > hints.max_length) {
      text = text.substring(0, hints.max_length);
    }
    
    // Update confidence if text was significantly changed
    if (text !== originalText) {
      const changeRatio = Math.abs(text.length - originalText.length) / Math.max(1, originalText.length);
      if (changeRatio > 0.3) {
        result.confidence *= (1 - changeRatio * 0.5);
      }
    }
    
    return {
      ...result,
      text,
      metadata: {
        ...result.metadata,
        original_text: originalText,
        post_processed: text !== originalText
      }
    };
  }

  async terminate(): Promise<void> {
    if (this.tesseractWorker) {
      await this.tesseractWorker.terminate();
      this.tesseractWorker = null;
    }
    
    if (this.paddleWorker) {
      // await this.paddleWorker.terminate();
      this.paddleWorker = null;
    }
    
    this.initialized = false;
    logger.info('HybridOCREngine terminated');
  }

  isReady(): boolean {
    return this.initialized;
  }

  getStats(): Record<string, any> {
    return {
      initialized: this.initialized,
      warmupComplete: this.warmupComplete,
      tesseractReady: !!this.tesseractWorker,
      paddleReady: !!this.paddleWorker,
      engine: this.config.engine,
      preprocessing: this.config.preprocessing
    };
  }
}

// Global OCR engine instance
export const hybridOCREngine = new HybridOCREngine();
