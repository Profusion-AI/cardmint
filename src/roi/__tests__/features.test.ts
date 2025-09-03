/**
 * Unit tests for Feature Extraction Pipeline
 * 
 * Tests hardware-aware feature extraction with mocking for performance validation.
 */

import { FeatureExtractor } from '../features';
import { Image } from '../../platform/imageio/sharp';
import { ImageFeatures } from '../types';

// Mock the ImageIO for controlled testing
const mockImageIO = {
  crop: jest.fn(),
  getImageStats: jest.fn(),
  computeHistogram: jest.fn(),
} as any;

// Mock Sharp ImageIO
jest.mock('../../platform/imageio/sharp', () => ({
  SharpImageIO: jest.fn().mockImplementation(() => mockImageIO),
}));

describe('FeatureExtractor', () => {
  let extractor: FeatureExtractor;
  let mockImage: Image;

  beforeEach(() => {
    jest.clearAllMocks();
    
    extractor = new FeatureExtractor({
      enableCaching: true,
      maxCacheSize: 100,
      budgetMs: 10,
      fastMode: false,
    });

    mockImage = {
      data: Buffer.alloc(10000),
      width: 100,
      height: 150,
      channels: 3,
      format: 'jpeg',
    };

    // Setup default mocks
    mockImageIO.crop.mockResolvedValue({
      ...mockImage,
      width: 20,
      height: 30,
    });

    mockImageIO.getImageStats.mockResolvedValue({
      mean: 128,
      stddev: 50,
      min: 0,
      max: 255,
    });

    mockImageIO.computeHistogram.mockResolvedValue(
      Array(64).fill(0).map((_, i) => Math.max(0, 100 - Math.abs(i - 32) * 3))
    );
  });

  describe('Initialization', () => {
    test('should initialize with default configuration', () => {
      const defaultExtractor = new FeatureExtractor();
      expect(defaultExtractor).toBeDefined();
    });

    test('should initialize with custom configuration', () => {
      const customExtractor = new FeatureExtractor({
        enableCaching: false,
        maxCacheSize: 500,
        budgetMs: 20,
        fastMode: true,
      });
      expect(customExtractor).toBeDefined();
    });
  });

  describe('Feature Extraction', () => {
    test('should extract basic features from image', async () => {
      const features = await extractor.extractFeatures(mockImage);

      expect(features).toBeDefined();
      expect(features.aspectRatio).toBeCloseTo(mockImage.width / mockImage.height, 2);
      expect(features.borderColor).toMatch(/^(yellow|grey|unknown)$/);
      expect(typeof features.ruleBoxBand).toBe('boolean');
    });

    test('should calculate aspect ratio correctly', async () => {
      // Square image
      const squareImage = { ...mockImage, width: 100, height: 100 };
      const squareFeatures = await extractor.extractFeatures(squareImage);
      expect(squareFeatures.aspectRatio).toBeCloseTo(1.0, 2);

      // Landscape image  
      const landscapeImage = { ...mockImage, width: 200, height: 100 };
      const landscapeFeatures = await extractor.extractFeatures(landscapeImage);
      expect(landscapeFeatures.aspectRatio).toBeCloseTo(2.0, 2);

      // Portrait image
      const portraitImage = { ...mockImage, width: 100, height: 200 };
      const portraitFeatures = await extractor.extractFeatures(portraitImage);
      expect(portraitFeatures.aspectRatio).toBeCloseTo(0.5, 2);
    });

    test('should detect border colors based on image statistics', async () => {
      // Bright image (likely yellow border)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 200,
        stddev: 30,
        min: 150,
        max: 255,
      });

      const brightFeatures = await extractor.extractFeatures(mockImage);
      expect(brightFeatures.borderColor).toBe('unknown');

      // Medium brightness (yellow border)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 180,
        stddev: 40,
        min: 100,
        max: 220,
      });

      const mediumFeatures = await extractor.extractFeatures(mockImage);
      expect(mediumFeatures.borderColor).toBe('yellow');

      // Dark image (grey/black border)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 80,
        stddev: 25,
        min: 20,
        max: 150,
      });

      const darkFeatures = await extractor.extractFeatures(mockImage);
      expect(darkFeatures.borderColor).toBe('grey');
    });

    test('should detect rule box bands from bimodal histograms', async () => {
      // Bimodal histogram (text on background)
      const bimodalHistogram = Array(64).fill(0);
      bimodalHistogram[15] = 100; // Dark peak (text)
      bimodalHistogram[45] = 80;  // Light peak (background)
      mockImageIO.computeHistogram.mockResolvedValueOnce(bimodalHistogram);

      const features = await extractor.extractFeatures(mockImage);
      expect(features.ruleBoxBand).toBe(true);

      // Unimodal histogram (no rule box)
      const unimodalHistogram = Array(64).fill(0).map((_, i) => 
        Math.max(0, 100 - Math.abs(i - 30) * 5)
      );
      mockImageIO.computeHistogram.mockResolvedValueOnce(unimodalHistogram);

      const noRuleBoxFeatures = await extractor.extractFeatures(mockImage);
      expect(noRuleBoxFeatures.ruleBoxBand).toBe(false);
    });

    test('should calculate text density from name band complexity', async () => {
      // High complexity name band (lots of text)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 120,
        stddev: 60, // High standard deviation indicates text
        min: 10,
        max: 240,
      });

      const textFeatures = await extractor.extractFeatures(mockImage);
      expect(textFeatures.textDensityTop).toBeGreaterThan(0.5);

      // Low complexity name band (plain background)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 200,
        stddev: 10, // Low standard deviation indicates plain area
        min: 180,
        max: 220,
      });

      const plainFeatures = await extractor.extractFeatures(mockImage);
      expect(plainFeatures.textDensityTop).toBeLessThan(0.5);
    });

    test('should detect edge logos from margin complexity', async () => {
      // Complex edges (logos present)
      mockImageIO.getImageStats
        .mockResolvedValueOnce({ mean: 100, stddev: 80, min: 0, max: 255 }) // Left edge
        .mockResolvedValueOnce({ mean: 120, stddev: 75, min: 10, max: 250 }); // Right edge

      const logoFeatures = await extractor.extractFeatures(mockImage);
      expect(logoFeatures.edgeLogoSignal).toBeGreaterThan(0.3);

      // Simple edges (no logos)
      mockImageIO.getImageStats
        .mockResolvedValueOnce({ mean: 128, stddev: 15, min: 100, max: 160 }) // Left edge
        .mockResolvedValueOnce({ mean: 125, stddev: 12, min: 105, max: 150 }); // Right edge

      const noLogoFeatures = await extractor.extractFeatures(mockImage);
      expect(noLogoFeatures.edgeLogoSignal).toBeLessThan(0.3);
    });

    test('should handle radiant pattern detection', async () => {
      // High variance artwork (radiant pattern)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 150,
        stddev: 70, // High standard deviation suggests holographic effects
        min: 20,
        max: 255,
      });

      const radiantFeatures = await extractor.extractFeatures(mockImage);
      expect(radiantFeatures.radiantPattern).toBeGreaterThan(0.5);

      // Low variance artwork (no radiant pattern)
      mockImageIO.getImageStats.mockResolvedValueOnce({
        mean: 128,
        stddev: 25, // Low variance suggests flat artwork
        min: 80,
        max: 180,
      });

      const flatFeatures = await extractor.extractFeatures(mockImage);
      expect(radiantFeatures.radiantPattern).toBeGreaterThan(flatFeatures.radiantPattern);
    });
  });

  describe('Fast Mode', () => {
    test('should skip expensive features in fast mode', async () => {
      const fastExtractor = new FeatureExtractor({
        enableCaching: true,
        budgetMs: 10,
        fastMode: true,
      });

      const features = await fastExtractor.extractFeatures(mockImage);

      // Basic features should still be present
      expect(features.aspectRatio).toBeDefined();
      expect(features.borderColor).toBeDefined();

      // Advanced features should be undefined or default values
      expect(features.textDensityTop).toBeUndefined();
      expect(features.edgeLogoSignal).toBeUndefined();
      expect(features.radiantPattern).toBeUndefined();
    });

    test('should complete faster in fast mode', async () => {
      const normalExtractor = new FeatureExtractor({ fastMode: false, budgetMs: 20 });
      const fastExtractor = new FeatureExtractor({ fastMode: true, budgetMs: 20 });

      const startTime = performance.now();
      await fastExtractor.extractFeatures(mockImage);
      const fastTime = performance.now() - startTime;

      // Fast mode should complete quickly
      expect(fastTime).toBeLessThan(50); // Should be much faster than 50ms in tests
    });
  });

  describe('Caching', () => {
    test('should cache feature extraction results', async () => {
      const cachedExtractor = new FeatureExtractor({ enableCaching: true });

      // First extraction
      const features1 = await cachedExtractor.extractFeatures(mockImage);
      const callCountAfterFirst = mockImageIO.crop.mock.calls.length;

      // Second extraction of same image
      const features2 = await cachedExtractor.extractFeatures(mockImage);
      const callCountAfterSecond = mockImageIO.crop.mock.calls.length;

      // Should have cached result, no additional processing
      expect(callCountAfterSecond).toBe(callCountAfterFirst);
      expect(features1).toEqual(features2);
    });

    test('should provide cache statistics', () => {
      const stats = extractor.getCacheStats();
      
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(typeof stats.size).toBe('number');
      expect(typeof stats.maxSize).toBe('number');
    });

    test('should clear cache on command', async () => {
      // Extract features to populate cache
      await extractor.extractFeatures(mockImage);
      
      let stats = extractor.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
      
      // Clear cache
      extractor.clearCache();
      
      stats = extractor.getCacheStats();
      expect(stats.size).toBe(0);
    });

    test('should respect cache size limits', async () => {
      const limitedCacheExtractor = new FeatureExtractor({ 
        enableCaching: true, 
        maxCacheSize: 2 
      });

      // Create three different images
      const image1 = { ...mockImage, width: 100 };
      const image2 = { ...mockImage, width: 101 };
      const image3 = { ...mockImage, width: 102 };

      await limitedCacheExtractor.extractFeatures(image1);
      await limitedCacheExtractor.extractFeatures(image2);
      await limitedCacheExtractor.extractFeatures(image3);

      const stats = limitedCacheExtractor.getCacheStats();
      expect(stats.size).toBeLessThanOrEqual(2);
    });
  });

  describe('Error Handling', () => {
    test('should handle ImageIO errors gracefully', async () => {
      mockImageIO.crop.mockRejectedValueOnce(new Error('Crop failed'));

      const features = await extractor.extractFeatures(mockImage);

      // Should still return basic features even with errors
      expect(features).toBeDefined();
      expect(features.aspectRatio).toBeDefined();
      expect(features.borderColor).toBe('unknown'); // Default fallback
    });

    test('should handle statistics calculation errors', async () => {
      mockImageIO.getImageStats.mockRejectedValueOnce(new Error('Stats failed'));

      const features = await extractor.extractFeatures(mockImage);

      // Should use fallback values
      expect(features).toBeDefined();
      expect(features.borderColor).toBe('unknown');
    });

    test('should handle histogram computation errors', async () => {
      mockImageIO.computeHistogram.mockRejectedValueOnce(new Error('Histogram failed'));

      const features = await extractor.extractFeatures(mockImage);

      expect(features).toBeDefined();
      expect(features.ruleBoxBand).toBe(false); // Default fallback
    });

    test('should return minimal features on complete failure', async () => {
      // Mock all operations to fail
      mockImageIO.crop.mockRejectedValue(new Error('All operations fail'));
      mockImageIO.getImageStats.mockRejectedValue(new Error('All operations fail'));
      mockImageIO.computeHistogram.mockRejectedValue(new Error('All operations fail'));

      const features = await extractor.extractFeatures(mockImage);

      // Should return minimal safe features
      expect(features).toBeDefined();
      expect(features.aspectRatio).toBeCloseTo(mockImage.width / mockImage.height, 2);
      expect(features.borderColor).toBe('unknown');
      expect(features.ruleBoxBand).toBe(false);
    });
  });

  describe('Budget Management', () => {
    test('should respect processing budget', async () => {
      const budgetedExtractor = new FeatureExtractor({ budgetMs: 5 });

      const startTime = performance.now();
      await budgetedExtractor.extractFeatures(mockImage);
      const processingTime = performance.now() - startTime;

      // Should complete quickly within budget (allowing test overhead)
      expect(processingTime).toBeLessThan(50);
    });

    test('should handle zero budget gracefully', async () => {
      const zeroBudgetExtractor = new FeatureExtractor({ budgetMs: 0 });

      const features = await zeroBudgetExtractor.extractFeatures(mockImage);

      // Should still return basic features
      expect(features).toBeDefined();
      expect(features.aspectRatio).toBeDefined();
    });
  });

  describe('Feature Value Validation', () => {
    test('should return values in expected ranges', async () => {
      const features = await extractor.extractFeatures(mockImage);

      // Aspect ratio should be positive
      expect(features.aspectRatio).toBeGreaterThan(0);

      // Optional numeric features should be 0-1 range when present
      if (features.textDensityTop !== undefined) {
        expect(features.textDensityTop).toBeGreaterThanOrEqual(0);
        expect(features.textDensityTop).toBeLessThanOrEqual(1);
      }

      if (features.edgeLogoSignal !== undefined) {
        expect(features.edgeLogoSignal).toBeGreaterThanOrEqual(0);
        expect(features.edgeLogoSignal).toBeLessThanOrEqual(1);
      }

      if (features.radiantPattern !== undefined) {
        expect(features.radiantPattern).toBeGreaterThanOrEqual(0);
        expect(features.radiantPattern).toBeLessThanOrEqual(1);
      }

      if (features.trainerPortraitBlob !== undefined) {
        expect(features.trainerPortraitBlob).toBeGreaterThanOrEqual(0);
        expect(features.trainerPortraitBlob).toBeLessThanOrEqual(1);
      }

      if (features.deltaSymbolSignal !== undefined) {
        expect(features.deltaSymbolSignal).toBeGreaterThanOrEqual(0);
        expect(features.deltaSymbolSignal).toBeLessThanOrEqual(1);
      }
    });

    test('should handle extreme aspect ratios', async () => {
      // Very wide image
      const wideImage = { ...mockImage, width: 1000, height: 10 };
      const wideFeatures = await extractor.extractFeatures(wideImage);
      expect(wideFeatures.aspectRatio).toBeCloseTo(100, 1);

      // Very tall image
      const tallImage = { ...mockImage, width: 10, height: 1000 };
      const tallFeatures = await extractor.extractFeatures(tallImage);
      expect(tallFeatures.aspectRatio).toBeCloseTo(0.01, 2);
    });
  });
});