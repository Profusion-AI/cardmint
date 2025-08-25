import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../utils/logger';
import { OCRData, CardMetadata } from '../types';

const logger = createLogger('ocr-service');

export interface OCRRegion {
  text: string;
  confidence: number;
  bounding_box: {
    top_left: number[];
    top_right: number[];
    bottom_right: number[];
    bottom_left: number[];
  };
  type: 'title' | 'body' | 'metadata';
  center: { x: number; y: number };
}

export interface OCRResult {
  success: boolean;
  full_text?: string;
  regions?: OCRRegion[];
  avg_confidence?: number;
  total_regions?: number;
  requires_review?: boolean;
  extracted_card_info?: {
    card_name: string | null;
    card_set: string | null;
    card_number: string | null;
    rarity: string | null;
    card_type: string | null;
    hp: number | null;
    stage: string | null;
    pokemon_type: string | null;
    attacks: Array<{
      name: string;
      damage: string | null;
      confidence: number;
    }>;
    weakness: string | null;
    resistance: string | null;
    retreat_cost: string | null;
    illustrator: string | null;
    text_sections: Array<{
      text: string;
      confidence: number;
      type: string;
    }>;
  };
  error?: string;
  pass_number?: number;
  high_accuracy_mode?: boolean;
}

export class OCRService {
  private readonly pythonScript: string;
  private readonly highAccuracyMode: boolean;
  private readonly confidenceThreshold: number;

  constructor(
    highAccuracyMode: boolean = true,
    confidenceThreshold: number = 0.85
  ) {
    this.pythonScript = path.join(__dirname, 'paddleocr_service.py');
    this.highAccuracyMode = highAccuracyMode;
    this.confidenceThreshold = confidenceThreshold;
    
    logger.info('OCR Service initialized', {
      highAccuracyMode,
      confidenceThreshold,
    });
  }

  /**
   * Process a card image and extract text using PaddleOCR
   */
  async processImage(imagePath: string): Promise<OCRResult> {
    const startTime = Date.now();
    
    try {
      // Verify image exists
      await fs.access(imagePath);
      
      // Run Python OCR service
      const result = await this.runPythonOCR(imagePath);
      
      const processingTime = Date.now() - startTime;
      logger.info(`OCR completed in ${processingTime}ms`, {
        imagePath,
        confidence: result.avg_confidence,
        regionsFound: result.total_regions,
        requiresReview: result.requires_review,
      });
      
      return result;
      
    } catch (error) {
      logger.error('OCR processing failed', { error, imagePath });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run the Python OCR script as a subprocess
   */
  private runPythonOCR(imagePath: string): Promise<OCRResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.pythonScript,
        imagePath,
        this.highAccuracyMode.toString(),
      ];
      
      // Redirect stderr to /dev/null to avoid JSON parsing issues with PaddleOCR warnings
      const pythonProcess = spawn('python3', args, {
        stdio: ['pipe', 'pipe', 'ignore']  // ignore stderr
      });
      
      let stdout = '';
      
      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          logger.error('Python OCR process failed', { code });
          reject(new Error(`OCR process exited with code ${code}`));
          return;
        }
        
        try {
          const result = JSON.parse(stdout);
          logger.info('Parsed OCR result keys', { 
            keys: Object.keys(result),
            hasExtractedInfo: !!result.extracted_card_info,
            extractedKeys: result.extracted_card_info ? Object.keys(result.extracted_card_info) : null
          });
          resolve(result);
        } catch (parseError) {
          logger.error('Failed to parse OCR result', { stdout: stdout.substring(0, 200), parseError });
          reject(new Error('Invalid OCR result format'));
        }
      });
      
      pythonProcess.on('error', (error) => {
        logger.error('Failed to spawn Python process', { error });
        reject(error);
      });
    });
  }

  /**
   * Map OCR region type to our standard type
   */
  private mapRegionType(ocrType: string): 'title' | 'description' | 'stats' | 'other' {
    switch (ocrType) {
      case 'title':
        return 'title';
      case 'body':
        return 'description';
      case 'metadata':
        return 'stats';
      default:
        return 'other';
    }
  }

  /**
   * Convert OCR result to our standard OCRData format
   */
  convertToOCRData(result: OCRResult): OCRData {
    const ocrData: OCRData = {
      fullText: result.full_text || '',
      regions: [],
      confidence: result.avg_confidence || 0,
      processingTimeMs: 0, // Will be set by caller
    };
    
    if (result.regions) {
      ocrData.regions = result.regions.map(region => ({
        text: region.text,
        confidence: region.confidence,
        boundingBox: {
          x: region.bounding_box.top_left[0],
          y: region.bounding_box.top_left[1],
          width: region.bounding_box.bottom_right[0] - region.bounding_box.top_left[0],
          height: region.bounding_box.bottom_right[1] - region.bounding_box.top_left[1],
        },
        type: this.mapRegionType(region.type),
      }));
    }
    
    return ocrData;
  }

  /**
   * Extract card metadata from OCR result
   */
  extractCardMetadata(result: OCRResult): CardMetadata {
    const metadata: CardMetadata = {
      cardName: 'Unknown Card',
      cardSet: 'Unknown Set',
      cardNumber: '001',
      rarity: 'Common',
      condition: 'Near Mint',
      language: 'English',
    };
    
    if (result.extracted_card_info) {
      const info = result.extracted_card_info;
      
      if (info.card_name) {
        metadata.cardName = info.card_name;
      }
      
      if (info.card_set) {
        metadata.cardSet = info.card_set;
      }
      
      if (info.card_number) {
        metadata.cardNumber = info.card_number;
      }
      
      if (info.rarity) {
        metadata.rarity = info.rarity;
      }
    }
    
    return metadata;
  }

  /**
   * Validate OCR results and determine if manual review is needed
   */
  validateResults(result: OCRResult): {
    isValid: boolean;
    requiresReview: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    
    if (!result.success) {
      issues.push('OCR processing failed');
      return { isValid: false, requiresReview: true, issues };
    }
    
    if (!result.regions || result.regions.length === 0) {
      issues.push('No text regions detected');
      return { isValid: false, requiresReview: true, issues };
    }
    
    if (result.avg_confidence && result.avg_confidence < this.confidenceThreshold) {
      issues.push(`Low confidence: ${(result.avg_confidence * 100).toFixed(1)}%`);
    }
    
    if (!result.extracted_card_info?.card_name) {
      issues.push('Card name not detected');
    }
    
    const requiresReview = result.requires_review || issues.length > 0;
    const isValid = result.success && (!requiresReview || result.avg_confidence! > 0.7);
    
    return { isValid, requiresReview, issues };
  }

  /**
   * Process multiple images in batch for efficiency
   */
  async processBatch(imagePaths: string[]): Promise<OCRResult[]> {
    logger.info(`Processing batch of ${imagePaths.length} images`);
    
    // Process in parallel with concurrency limit
    const batchSize = 4; // Process 4 images at a time
    const results: OCRResult[] = [];
    
    for (let i = 0; i < imagePaths.length; i += batchSize) {
      const batch = imagePaths.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(path => this.processImage(path))
      );
      results.push(...batchResults);
      
      logger.debug(`Processed ${results.length}/${imagePaths.length} images`);
    }
    
    // Calculate batch statistics
    const successCount = results.filter(r => r.success).length;
    const avgConfidence = results
      .filter(r => r.avg_confidence)
      .reduce((sum, r) => sum + r.avg_confidence!, 0) / successCount;
    
    logger.info('Batch processing complete', {
      total: imagePaths.length,
      successful: successCount,
      failed: imagePaths.length - successCount,
      averageConfidence: avgConfidence,
    });
    
    return results;
  }
}