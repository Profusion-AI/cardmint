import { ImageValidationService } from '../../../src/services/ImageValidationService';
import { logger } from '../../../src/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

jest.mock('../../../src/utils/logger');
jest.mock('fs/promises');

describe('ImageValidationService', () => {
  let service: ImageValidationService;

  beforeEach(() => {
    service = new ImageValidationService();
    jest.clearAllMocks();
  });

  describe('compareImages', () => {
    const mockImage1 = Buffer.from('fake-image-1');
    const mockImage2 = Buffer.from('fake-image-2');

    it('should return high similarity for identical images', async () => {
      const result = await service.compareImages(mockImage1, mockImage1);

      expect(result.overall).toBe(1.0);
      expect(result.ssim).toBe(1.0);
      expect(result.perceptualHash).toBe(1.0);
      expect(result.histogram).toBe(1.0);
      expect(result.features).toBe(1.0);
    });

    it('should return low similarity for different images', async () => {
      const result = await service.compareImages(mockImage1, mockImage2);

      expect(result.overall).toBeLessThan(1.0);
      expect(result.overall).toBeGreaterThanOrEqual(0);
    });

    it('should handle image comparison errors gracefully', async () => {
      // Mock an error in image processing
      const invalidBuffer = Buffer.from('');
      
      const result = await service.compareImages(invalidBuffer, mockImage1);

      expect(result.overall).toBe(0);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('assessImageQuality', () => {
    it('should assess high quality image', async () => {
      const goodImage = Buffer.alloc(1024 * 100); // 100KB image
      goodImage.fill('high-quality-data');

      const assessment = await service.assessImageQuality(goodImage);

      expect(assessment.isGoodQuality).toBe(true);
      expect(assessment.brightness).toBeGreaterThan(0);
      expect(assessment.contrast).toBeGreaterThan(0);
      expect(assessment.sharpness).toBeGreaterThan(0);
    });

    it('should detect low quality images', async () => {
      const poorImage = Buffer.alloc(10); // Very small image
      
      const assessment = await service.assessImageQuality(poorImage);

      expect(assessment.isGoodQuality).toBe(false);
      expect(assessment.issues).toContain('Image too small');
    });

    it('should detect blur in images', async () => {
      const blurryImage = Buffer.alloc(1024 * 50);
      blurryImage.fill(0); // Uniform data simulating blur

      const assessment = await service.assessImageQuality(blurryImage);

      expect(assessment.sharpness).toBeLessThan(0.5);
      expect(assessment.issues).toContain('Image is blurry');
    });
  });

  describe('detectSpecialEdition', () => {
    it('should detect 1st Edition marker', async () => {
      const firstEdImage = Buffer.from('1st-edition-marker-present');
      
      const result = await service.detectSpecialEdition(firstEdImage);

      expect(result.isFirstEdition).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('should detect shadowless cards', async () => {
      const shadowlessImage = Buffer.from('no-shadow-detected');
      
      const result = await service.detectSpecialEdition(shadowlessImage);

      expect(result.isShadowless).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('should detect holographic patterns', async () => {
      const holoImage = Buffer.from('holographic-pattern-detected');
      
      const result = await service.detectSpecialEdition(holoImage);

      expect(result.isHolo).toBe(true);
      expect(result.holoPattern).toBeDefined();
    });

    it('should detect reverse holo cards', async () => {
      const reverseHoloImage = Buffer.from('reverse-holo-pattern');
      
      const result = await service.detectSpecialEdition(reverseHoloImage);

      expect(result.isReverseHolo).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('calculateSSIM', () => {
    it('should calculate perfect SSIM for identical images', () => {
      const image = Buffer.from('test-image');
      const ssim = (service as any).calculateSSIM(image, image);

      expect(ssim).toBe(1.0);
    });

    it('should calculate lower SSIM for different images', () => {
      const image1 = Buffer.from('image-1');
      const image2 = Buffer.from('image-2-different');
      const ssim = (service as any).calculateSSIM(image1, image2);

      expect(ssim).toBeLessThan(1.0);
      expect(ssim).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculatePerceptualHash', () => {
    it('should generate consistent hash for same image', () => {
      const image = Buffer.from('consistent-image');
      const hash1 = (service as any).calculatePerceptualHash(image);
      const hash2 = (service as any).calculatePerceptualHash(image);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different images', () => {
      const image1 = Buffer.from('image-1');
      const image2 = Buffer.from('completely-different-image');
      const hash1 = (service as any).calculatePerceptualHash(image1);
      const hash2 = (service as any).calculatePerceptualHash(image2);

      expect(hash1).not.toBe(hash2);
    });

    it('should calculate Hamming distance correctly', () => {
      const similarity = (service as any).comparePerceptualHashes('1111', '1110');
      expect(similarity).toBeCloseTo(0.75, 2); // 3 out of 4 bits match
    });
  });

  describe('compareHistograms', () => {
    it('should return high similarity for similar color distributions', () => {
      const image1 = Buffer.from('similar-colors-1');
      const image2 = Buffer.from('similar-colors-2');
      
      const similarity = (service as any).compareHistograms(image1, image2);

      expect(similarity).toBeGreaterThan(0.8);
    });

    it('should return low similarity for different color distributions', () => {
      const brightImage = Buffer.alloc(100).fill(255); // Bright image
      const darkImage = Buffer.alloc(100).fill(0);    // Dark image
      
      const similarity = (service as any).compareHistograms(brightImage, darkImage);

      expect(similarity).toBeLessThan(0.3);
    });
  });

  describe('detectFeatures', () => {
    it('should detect ORB features in image', () => {
      const image = Buffer.from('image-with-features');
      const features = (service as any).detectFeatures(image);

      expect(features).toBeInstanceOf(Array);
      expect(features.length).toBeGreaterThanOrEqual(0);
    });

    it('should match features between similar images', () => {
      const image1 = Buffer.from('featured-image-1');
      const image2 = Buffer.from('featured-image-1-rotated');
      
      const similarity = (service as any).compareFeatures(image1, image2);

      expect(similarity).toBeGreaterThan(0.5);
    });
  });

  describe('validateCardImage', () => {
    it('should validate authentic card images', async () => {
      const capturedImage = Buffer.from('authentic-card-image');
      const officialImage = Buffer.from('official-card-image');

      const validation = await service.validateCardImage(capturedImage, officialImage);

      expect(validation.isAuthentic).toBe(true);
      expect(validation.confidence).toBeGreaterThan(0.85);
      expect(validation.warnings).toHaveLength(0);
    });

    it('should detect counterfeit cards', async () => {
      const fakeImage = Buffer.from('counterfeit-card');
      const officialImage = Buffer.from('official-card-image');

      const validation = await service.validateCardImage(fakeImage, officialImage);

      expect(validation.isAuthentic).toBe(false);
      expect(validation.confidence).toBeLessThan(0.5);
      expect(validation.warnings).toContain('Possible counterfeit detected');
    });

    it('should detect image quality issues', async () => {
      const blurryImage = Buffer.alloc(100).fill(128); // Uniform gray (blurry)
      const officialImage = Buffer.from('sharp-official-image');

      const validation = await service.validateCardImage(blurryImage, officialImage);

      expect(validation.warnings).toContain('Captured image quality is poor');
      expect(validation.confidence).toBeLessThan(0.7);
    });
  });

  describe('processOfficialImages', () => {
    it('should process official images from directory', async () => {
      const mockFiles = [
        'charizard_large.jpg',
        'pikachu_large.jpg',
        'blastoise_large.jpg'
      ];

      (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('image-data'));

      const results = await service.processOfficialImages('/official_images');

      expect(fs.readdir).toHaveBeenCalledWith('/official_images');
      expect(fs.readFile).toHaveBeenCalledTimes(3);
      expect(results).toHaveLength(3);
    });

    it('should skip non-image files', async () => {
      const mockFiles = [
        'card.jpg',
        'readme.txt',
        'data.json',
        'card2.png'
      ];

      (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('image-data'));

      const results = await service.processOfficialImages('/official_images');

      expect(fs.readFile).toHaveBeenCalledTimes(2); // Only jpg and png
      expect(results).toHaveLength(2);
    });

    it('should handle read errors gracefully', async () => {
      (fs.readdir as jest.Mock).mockRejectedValue(new Error('Permission denied'));

      const results = await service.processOfficialImages('/restricted');

      expect(results).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to process official images',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe('edge detection', () => {
    it('should detect card edges accurately', () => {
      const cardImage = Buffer.from('card-with-clear-edges');
      const edges = (service as any).detectEdges(cardImage);

      expect(edges).toBeDefined();
      expect(edges.confidence).toBeGreaterThan(0.8);
    });

    it('should handle cards with damaged edges', () => {
      const damagedCard = Buffer.from('card-with-worn-edges');
      const edges = (service as any).detectEdges(damagedCard);

      expect(edges.confidence).toBeLessThan(0.7);
      expect(edges.warnings).toContain('Edge wear detected');
    });
  });

  describe('color validation', () => {
    it('should validate correct card colors', () => {
      const capturedColors = { red: 120, green: 80, blue: 200 };
      const expectedColors = { red: 125, green: 85, blue: 195 };

      const isValid = (service as any).validateColors(capturedColors, expectedColors);

      expect(isValid).toBe(true);
    });

    it('should detect color mismatches', () => {
      const capturedColors = { red: 50, green: 50, blue: 50 };
      const expectedColors = { red: 200, green: 100, blue: 150 };

      const isValid = (service as any).validateColors(capturedColors, expectedColors);

      expect(isValid).toBe(false);
    });
  });
});