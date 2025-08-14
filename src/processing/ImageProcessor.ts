import { createLogger } from '../utils/logger';
import { OCRData, CardMetadata } from '../types';
import { OCRService } from '../ocr/OCRService';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('image-processor');

export interface ProcessingResult {
  ocrData?: OCRData;
  metadata?: CardMetadata;
  thumbnailPath?: string;
}

export interface ProcessingOptions {
  cardId: string;
  imageData: Buffer | string;
  settings?: {
    ocrEnabled?: boolean;
    generateThumbnail?: boolean;
    enhanceImage?: boolean;
  };
}

export class ImageProcessor {
  private ocrService: OCRService;
  private tempDir: string = '/tmp/cardmint';
  
  constructor() {
    // Initialize with high-accuracy mode for 98%+ accuracy target
    this.ocrService = new OCRService(true, 0.85);
    this.ensureTempDir();
    logger.info('Image processor initialized with PaddleOCR');
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
      
      // OCR processing
      if (options.settings?.ocrEnabled !== false) {
        result.ocrData = await this.performOCR(options.imageData);
      }
      
      // Thumbnail generation
      if (options.settings?.generateThumbnail !== false) {
        result.thumbnailPath = await this.generateThumbnail(options.imageData);
      }
      
      // Extract metadata
      result.metadata = await this.extractMetadata(result.ocrData);
      
      const processingTime = Date.now() - startTime;
      logger.info(`Image processed in ${processingTime}ms for card ${options.cardId}`);
      
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
  
  private async extractMetadata(ocrData?: OCRData): Promise<CardMetadata> {
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
      
      // Set patterns (usually in metadata regions)
      if (region.type === 'metadata' && text.length > 3 && text.length < 50) {
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