/* TODO: Review and add specific port type imports from @core/* */
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger';
import { OCRData, CardMetadata } from '../types';
import { OCRService } from '../ocr/OCRService';
import { mlServiceClient, MLPrediction } from '../ml/MLServiceClient';
import { ports } from '../app/wiring';

const logger = createLogger('image-processor');

export interface ProcessingResult {
  ocrData?: OCRData;
  mlPrediction?: MLPrediction;
  metadata?: CardMetadata;
  thumbnailPath?: string;
  recognitionMethod?: 'ml' | 'ocr' | 'combined' | 'ml-validated' | 'ocr-validated';
  combinedConfidence?: number;
  enhancedData?: EnhancedCardData;
  apiValidated?: boolean;
  officialImageUrl?: string;
  marketPrice?: number;
}

export interface ProcessingOptions {
  cardId: string;
  imageData: Buffer | string;
  settings?: {
    ocrEnabled?: boolean;
    mlEnabled?: boolean;
    generateThumbnail?: boolean;
    enhanceImage?: boolean;
    forceOCROnly?: boolean;
  };
}

export class ImageProcessor {
  private ocrService: OCRService;
  private tempDir: string = '/tmp/cardmint';
  
  constructor() {
    // Initialize with high-accuracy mode for 98%+ accuracy target
    this.ocrService = new OCRService(true, 0.85);
    this.ensureTempDir();
    logger.info('Image processor initialized with ML ensemble and PaddleOCR');
  }
  
  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create temp directory', error);
    }
  }
  
  async process(options: ProcessingOptions): Promise<ProcessingResult> {
    const startTime = Date.now();
    logger.debug(`Processing image for card ${options.cardId}`);
    
    try {
      const result: ProcessingResult = {};
      
      // Image enhancement
      if (options.settings?.enhanceImage) {
        await this.enhanceImage(options.imageData);
      }
      
      // Determine image path for ML service
      let imagePath: string;
      if (Buffer.isBuffer(options.imageData)) {
        imagePath = path.join(this.tempDir, `ml_${options.cardId}_${Date.now()}.jpg`);
        await fs.writeFile(imagePath, options.imageData);
      } else {
        imagePath = options.imageData;
      }
      
      // Try ML ensemble first (unless forced to OCR-only)
      if (options.settings?.mlEnabled !== false && !options.settings?.forceOCROnly) {
        const mlResult = await mlServiceClient.recognizeCard(imagePath, true);
        if (mlResult) {
          result.mlPrediction = mlResult;
        }
        
        if (result.mlPrediction) {
          result.recognitionMethod = 'ml';
          logger.info(`ML recognition successful for card ${options.cardId}`, {
            card: result.mlPrediction.card_name,
            confidence: result.mlPrediction.ensemble_confidence,
            models: result.mlPrediction.active_models,
          });
        }
      }
      
      // Fall back to OCR if ML failed or if we want combined results
      if (!result.mlPrediction || options.settings?.ocrEnabled !== false) {
        result.ocrData = await this.performOCR(imagePath);
        
        if (!result.mlPrediction) {
          result.recognitionMethod = 'ocr';
        } else {
          result.recognitionMethod = 'combined';
        }
      }
      
      // Calculate combined confidence if we have both
      if (result.mlPrediction && result.ocrData) {
        result.combinedConfidence = this.calculateCombinedConfidence(
          result.mlPrediction,
          result.ocrData
        );
      }
      
      // API Validation - Validate ML/OCR results against Pokemon TCG API
      if (result.mlPrediction || result.ocrData) {
        try {
          const ocrResult = result.ocrData ? {
            success: true,
            avg_confidence: result.ocrData.confidence,
            extracted_card_info: this.extractOCRInfo(result.ocrData),
            regions: [],
            total_regions: result.ocrData.regions.length,
          } : undefined;
          
          const enhancedData = await ports.validate.validateMLPrediction(result.mlPrediction!, ocrResult);
          
          result.enhancedData = enhancedData;
          
          if (enhancedData.finalCard) {
            result.apiValidated = true;
            result.recognitionMethod = enhancedData.validationMethod;
            result.combinedConfidence = enhancedData.finalConfidence;
            result.officialImageUrl = enhancedData.enrichmentData?.officialImage;
            result.marketPrice = enhancedData.enrichmentData?.marketPrice;
            
            // Update metadata with validated data
            result.metadata = {
              cardName: enhancedData.finalCard.name,
              cardSet: enhancedData.finalCard.set.name,
              cardNumber: enhancedData.finalCard.number,
              rarity: enhancedData.finalCard.rarity || 'Common',
              condition: 'Near Mint',
              language: 'English',
            };
            
            logger.info(`API validation successful for card ${options.cardId}`, {
              cardName: enhancedData.finalCard.name,
              confidence: enhancedData.finalConfidence,
              method: enhancedData.validationMethod,
              marketPrice: result.marketPrice,
            });
          } else {
            result.apiValidated = false;
            // Fall back to original metadata extraction
            result.metadata = await this.extractMetadata(result.ocrData, result.mlPrediction);
          }
        } catch (error) {
          logger.error('API validation failed, using local results', { error });
          result.apiValidated = false;
          result.metadata = await this.extractMetadata(result.ocrData, result.mlPrediction);
        }
      } else {
        // No ML or OCR data, extract basic metadata
        result.metadata = await this.extractMetadata(result.ocrData, result.mlPrediction);
      }
      
      // Thumbnail generation
      if (options.settings?.generateThumbnail !== false) {
        result.thumbnailPath = await this.generateThumbnail(options.imageData);
      }
      
      // Clean up temp file if we created one
      if (Buffer.isBuffer(options.imageData)) {
        await fs.unlink(imagePath).catch(() => {});
      }
      
      const processingTime = Date.now() - startTime;
      logger.info(`Image processed in ${processingTime}ms for card ${options.cardId}`, {
        method: result.recognitionMethod,
        mlConfidence: result.mlPrediction?.ensemble_confidence,
        ocrConfidence: result.ocrData?.confidence,
        combinedConfidence: result.combinedConfidence,
      });
      
      return result;
      
    } catch (error) {
      logger.error(`Failed to process image for card ${options.cardId}:`, error);
      throw error;
    }
  }
  
  private async enhanceImage(_imageData: Buffer | string): Promise<Buffer> {
    // TODO: Implement image enhancement using OpenCV
    // - Denoise
    // - Adjust contrast
    // - Sharpen
    return Buffer.isBuffer(_imageData) ? _imageData : Buffer.from(_imageData);
  }
  
  private async performOCR(imageData: Buffer | string): Promise<OCRData> {
    const startTime = Date.now();
    
    try {
      // Save image to temp file if it's a buffer
      let imagePath: string;
      if (Buffer.isBuffer(imageData)) {
        imagePath = path.join(this.tempDir, `ocr_${Date.now()}.jpg`);
        await fs.writeFile(imagePath, imageData);
      } else {
        imagePath = imageData;
      }
      
      // Run OCR with PaddleOCR
      const ocrResult = await this.ocrService.processImage(imagePath);
      
      // Validate results
      const validation = this.ocrService.validateResults(ocrResult);
      if (!validation.isValid) {
        logger.warn('OCR validation issues', { issues: validation.issues });
      }
      
      // Convert to our OCRData format
      const ocrData = this.ocrService.convertToOCRData(ocrResult);
      ocrData.processingTimeMs = Date.now() - startTime;
      
      // Clean up temp file if we created one
      if (Buffer.isBuffer(imageData)) {
        await fs.unlink(imagePath).catch(() => {});
      }
      
      logger.info(`OCR completed with ${(ocrResult.avg_confidence || 0) * 100}% confidence`, {
        processingTime: ocrData.processingTimeMs,
        regionsFound: ocrData.regions.length,
        requiresReview: ocrResult.requires_review,
      });
      
      return ocrData;
      
    } catch (error) {
      logger.error('OCR processing failed', error);
      // Return empty OCR data on failure
      return {
        fullText: '',
        regions: [],
        confidence: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }
  
  private async generateThumbnail(_imageData: Buffer | string): Promise<string> {
    // TODO: Implement thumbnail generation using OpenCV
    // - Resize to standard thumbnail size
    // - Optimize for web display
    return '/tmp/thumbnail.jpg';
  }
  
  private calculateCombinedConfidence(mlPrediction: MLPrediction, ocrData: OCRData): number {
    // Weight ML predictions higher since they use visual features
    const mlWeight = 0.7;
    const ocrWeight = 0.3;
    
    const mlConf = mlPrediction.ensemble_confidence || 0;
    const ocrConf = ocrData.confidence || 0;
    
    // If both agree on the card name, boost confidence
    let agreementBonus = 0;
    if (ocrData.fullText && mlPrediction.card_name) {
      const ocrName = this.extractCardNameFromText(ocrData.fullText);
      if (ocrName && ocrName.toLowerCase() === mlPrediction.card_name.toLowerCase()) {
        agreementBonus = 0.1;
      }
    }
    
    const combined = (mlConf * mlWeight) + (ocrConf * ocrWeight) + agreementBonus;
    return Math.min(combined, 1.0);
  }
  
  private extractCardNameFromText(text: string): string | null {
    // Simple extraction - take the first line that looks like a card name
    const lines = text.split('\n').filter(l => l.trim().length > 2);
    if (lines.length > 0) {
      // Pokemon card names are usually at the top
      return lines[0].trim();
    }
    return null;
  }
  
  private extractOCRInfo(ocrData: OCRData): any {
    // Convert OCRData to the format expected by validation service
    const info: any = {};
    
    // Extract card name from title regions
    const titleRegions = ocrData.regions.filter(r => r.type === 'title');
    if (titleRegions.length > 0) {
      info.card_name = titleRegions[0].text;
    } else if (ocrData.fullText) {
      info.card_name = this.extractCardNameFromText(ocrData.fullText);
    }
    
    // Extract other info from regions
    for (const region of ocrData.regions) {
      const text = region.text;
      
      // Look for card number
      const numberMatch = text.match(/(\d{1,3})\/\d{1,3}|#(\d{1,3})/);
      if (numberMatch && !info.card_number) {
        info.card_number = numberMatch[1] || numberMatch[2];
      }
      
      // Look for HP
      const hpMatch = text.match(/HP\s*(\d+)/i);
      if (hpMatch && !info.hp) {
        info.hp = parseInt(hpMatch[1]);
      }
      
      // Look for rarity indicators
      if (text.match(/rare|uncommon|common|holo/i) && !info.rarity) {
        info.rarity = text;
      }
    }
    
    return info;
  }
  
  private async extractMetadata(ocrData?: OCRData, mlPrediction?: MLPrediction): Promise<CardMetadata> {
    // Prefer ML predictions if available
    if (mlPrediction && mlPrediction.confidence > 0.5) {
      return {
        cardName: mlPrediction.card_name || 'Unknown Card',
        cardSet: mlPrediction.set_name || 'Unknown Set',
        cardNumber: mlPrediction.card_number || '001',
        rarity: mlPrediction.rarity || 'Common',
        condition: 'Near Mint',
        language: 'English',
      };
    }
    
    // Fall back to OCR extraction
    if (!ocrData || ocrData.regions.length === 0) {
      return {
        cardName: 'Unknown Card',
        cardSet: 'Unknown Set',
        cardNumber: '001',
        rarity: 'Common',
        condition: 'Near Mint',
        language: 'English',
      };
    }
    
    // Extract card name from title regions with highest confidence
    const titleRegions = ocrData.regions
      .filter(r => r.type === 'title' && r.confidence > 0.8)
      .sort((a, b) => b.confidence - a.confidence);
    
    const cardName = titleRegions[0]?.text || 'Unknown Card';
    
    // Look for card number patterns
    let cardNumber = '001';
    let cardSet = 'Unknown Set';
    let rarity = 'Common';
    
    for (const region of ocrData.regions) {
      const text = region.text;
      
      // Card number patterns: "123/456", "#123", "No. 123"
      const numberMatch = text.match(/(\d{1,3})\/\d{1,3}|#(\d{1,3})|No\.?\s*(\d{1,3})/i);
      if (numberMatch) {
        cardNumber = numberMatch[1] || numberMatch[2] || numberMatch[3];
      }
      
      // Rarity patterns
      const rarityPatterns = [
        'Common', 'Uncommon', 'Rare', 'Super Rare', 'Ultra Rare',
        'Secret Rare', 'Mythic', 'Legendary', 'Holo', 'Foil'
      ];
      for (const pattern of rarityPatterns) {
        if (text.toLowerCase().includes(pattern.toLowerCase())) {
          rarity = pattern;
          break;
        }
      }
      
      // Set patterns (usually in other regions)
      if (region.type === 'other' && text.length > 3 && text.length < 50) {
        // Could be a set name
        if (!text.match(/^\d+/) && !text.includes('©')) {
          cardSet = text;
        }
      }
    }
    
    return {
      cardName,
      cardSet,
      cardNumber,
      rarity,
      condition: 'Near Mint', // Default, will be set during capture
      language: 'English',     // Default, can be detected later
    };
  }
}