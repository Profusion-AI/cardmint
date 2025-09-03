/**
 * Unit tests for ROI Runtime Execution Engine
 * 
 * Tests Budget management, LazyRoiRunner, and tier-based evaluation logic.
 */

import { Budget, LazyRoiRunner } from '../runtime';
import { SharpImageIO, Image } from '../../platform/imageio/sharp';
import { 
  TemplateVariation, 
  ImageFeatures, 
  CandidateScore, 
  RoiTier,
  DEFAULT_BUDGET_MS 
} from '../types';

// Mock the SharpImageIO for testing
jest.mock('../../platform/imageio/sharp');
const MockSharpImageIO = SharpImageIO as jest.MockedClass<typeof SharpImageIO>;

describe('Budget Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Budget', () => {
    test('should initialize with correct total time', () => {
      const budget = new Budget(100);
      
      expect(budget.msTotal).toBe(100);
      expect(budget.msUsed).toBe(0);
      expect(budget.remains).toBe(100);
      expect(budget.isExhausted).toBe(false);
    });

    test('should track time consumption correctly', () => {
      const budget = new Budget(100);
      
      budget.take(30);
      expect(budget.msUsed).toBe(30);
      expect(budget.remains).toBe(70);
      expect(budget.isExhausted).toBe(false);
      
      budget.take(50);
      expect(budget.msUsed).toBe(80);
      expect(budget.remains).toBe(20);
      expect(budget.isExhausted).toBe(false);
      
      budget.take(25);
      expect(budget.msUsed).toBe(105);
      expect(budget.remains).toBe(0); // Should not go negative
      expect(budget.isExhausted).toBe(true);
    });

    test('should handle over-consumption gracefully', () => {
      const budget = new Budget(50);
      
      budget.take(75); // Take more than total
      expect(budget.msUsed).toBe(75);
      expect(budget.remains).toBe(0); // Clamped to 0
      expect(budget.isExhausted).toBe(true);
    });

    test('should handle zero budget edge case', () => {
      const budget = new Budget(0);
      
      expect(budget.remains).toBe(0);
      expect(budget.isExhausted).toBe(true);
      
      budget.take(10);
      expect(budget.remains).toBe(0);
      expect(budget.isExhausted).toBe(true);
    });

    test('should allocate sub-budgets correctly', () => {
      const budget = new Budget(100);
      
      const subBudget = budget.allocate(30);
      expect(subBudget.msTotal).toBe(30);
      expect(budget.msUsed).toBe(30);
      expect(budget.remains).toBe(70);
      
      // Allocating more than remaining should give only what's left
      const largeBudget = budget.allocate(100);
      expect(largeBudget.msTotal).toBe(70);
      expect(budget.msUsed).toBe(100);
      expect(budget.remains).toBe(0);
    });

    test('should track real elapsed time', () => {
      const budget = new Budget(100);
      
      // Real time should be very small for this test
      expect(budget.elapsedReal).toBeGreaterThanOrEqual(0);
      expect(budget.elapsedReal).toBeLessThan(10); // Should be under 10ms for this test
    });

    test('should detect runaway operations', () => {
      const budget = new Budget(10);
      
      // Mock performance.now to simulate long elapsed time
      const originalNow = performance.now;
      let mockTime = 0;
      performance.now = jest.fn(() => mockTime);
      
      // Simulate 25ms elapsed (more than 2x budget)
      mockTime = 25;
      expect(budget.checkRealTime()).toBe(false);
      
      // Restore original
      performance.now = originalNow;
    });
  });
});

describe('LazyRoiRunner', () => {
  let mockImageIO: jest.Mocked<SharpImageIO>;
  let runner: LazyRoiRunner;
  let mockImage: Image;
  let mockFeatures: ImageFeatures;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockImageIO = new MockSharpImageIO() as jest.Mocked<SharpImageIO>;
    runner = new LazyRoiRunner(mockImageIO, {
      enableCaching: true,
    });

    mockImage = {
      data: Buffer.alloc(1000),
      width: 100,
      height: 150,
      channels: 3,
      format: 'jpeg',
    };

    mockFeatures = {
      aspectRatio: 1.0,
      borderColor: 'grey',
      ruleBoxBand: false,
      textDensityTop: 0.5,
    };
  });

  test('should initialize with default configuration', () => {
    const defaultRunner = new LazyRoiRunner(mockImageIO);
    expect(defaultRunner).toBeDefined();
  });

  test('should initialize with custom configuration', () => {
    const customRunner = new LazyRoiRunner(mockImageIO, {
      tiers: ['CRITICAL', 'STANDARD'],
      thresholds: { accept: 0.9, tryNextTier: 0.8, lowConfidence: 0.7 },
      enableCaching: false,
    });
    expect(customRunner).toBeDefined();
  });

  describe('ROI evaluation process', () => {
    let mockTemplate: TemplateVariation;

    beforeEach(() => {
      mockTemplate = {
        id: 'test_template',
        layoutFamily: 'sword_shield',
        parentId: 'sword_shield',
        coreROIs: {
          rois: [
            {
              id: 'sword_shield:critical_roi',
              tier: 'CRITICAL',
              role: 'name_band',
              coords: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
              weights: { base: 1.0 },
            },
          ],
        },
        eraSpecificROIs: {
          rois: [
            {
              id: 'sword_shield:standard_roi',
              tier: 'STANDARD', 
              role: 'set_symbol',
              coords: { x: 0.7, y: 0.05, w: 0.1, h: 0.1 },
              weights: { base: 0.8 },
            },
          ],
        },
        conditions: {
          era: ['sword_shield'],
          layoutVariant: 'standard',
        },
      };

      // Mock imageIO methods
      mockImageIO.resize = jest.fn().mockResolvedValue(mockImage);
      mockImageIO.crop = jest.fn().mockResolvedValue({
        ...mockImage,
        width: 50,
        height: 25,
      });
    });

    test('should complete evaluation within budget', async () => {
      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(mockTemplate, mockImage, mockFeatures, budget);

      expect(result).toBeDefined();
      expect(result.templateId).toBe('test_template');
      expect(result.fused).toBeGreaterThanOrEqual(0);
      expect(result.fused).toBeLessThanOrEqual(1);
      expect(result.msSpent).toBeGreaterThan(0);
      expect(result.usedRois).toBeInstanceOf(Array);
      expect(result.perRoi).toBeDefined();
    });

    test('should respect budget constraints', async () => {
      const tinyBudget = new Budget(1); // Very small budget
      const result = await runner.run(mockTemplate, mockImage, mockFeatures, tinyBudget);

      expect(result.msSpent).toBeLessThanOrEqual(10); // Allow some tolerance for test execution
      expect(tinyBudget.isExhausted).toBe(true);
    });

    test('should handle templates with no matching ROIs', async () => {
      const emptyTemplate: TemplateVariation = {
        id: 'empty_template',
        layoutFamily: 'sword_shield',
        parentId: 'sword_shield',
        coreROIs: { rois: [] },
        eraSpecificROIs: { rois: [] },
        conditions: { era: ['sword_shield'] },
      };

      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(emptyTemplate, mockImage, mockFeatures, budget);

      expect(result.fused).toBe(0);
      expect(result.usedRois).toHaveLength(0);
      expect(Object.keys(result.perRoi)).toHaveLength(0);
    });

    test('should filter ROIs by conditions', async () => {
      const conditionalTemplate: TemplateVariation = {
        ...mockTemplate,
        eraSpecificROIs: {
          rois: [
            {
              id: 'sword_shield:conditional_roi',
              tier: 'STANDARD',
              role: 'rulebox', 
              coords: { x: 0.1, y: 0.8, w: 0.8, h: 0.15 },
              weights: { base: 1.0 },
              condition: (features) => features.ruleBoxBand === true,
            },
          ],
        },
      };

      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(conditionalTemplate, mockImage, mockFeatures, budget);

      // Should not include conditional ROI since ruleBoxBand is false
      expect(result.usedRois).not.toContain('sword_shield:conditional_roi');
      expect(result.perRoi['sword_shield:conditional_roi']).toBeUndefined();
    });

    test('should handle ROI evaluation errors gracefully', async () => {
      // Mock crop to throw an error
      mockImageIO.crop = jest.fn().mockRejectedValue(new Error('Crop failed'));

      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(mockTemplate, mockImage, mockFeatures, budget);

      // Should still return a result even with errors
      expect(result).toBeDefined();
      expect(result.templateId).toBe('test_template');
      // Scores might be zero due to errors, but structure should be intact
    });
  });

  describe('Cache management', () => {
    test('should provide cache statistics', () => {
      const stats = runner.getCacheStats();
      
      expect(stats).toHaveProperty('scoreCache');
      expect(stats).toHaveProperty('coordCache');
      expect(stats.scoreCache).toHaveProperty('size');
      expect(stats.coordCache).toHaveProperty('size');
    });

    test('should clear caches on command', () => {
      runner.clearCaches();
      const stats = runner.getCacheStats();
      
      expect(stats.scoreCache.size).toBe(0);
      expect(stats.coordCache.size).toBe(0);
    });
  });

  describe('Tier-based evaluation', () => {
    test('should process tiers in correct order', async () => {
      const multiTierTemplate: TemplateVariation = {
        id: 'multi_tier',
        layoutFamily: 'sword_shield', 
        parentId: 'sword_shield',
        coreROIs: {
          rois: [
            {
              id: 'sword_shield:critical_1',
              tier: 'CRITICAL',
              role: 'name_band',
              coords: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
              weights: { base: 1.0 },
            },
          ],
        },
        eraSpecificROIs: {
          rois: [
            {
              id: 'sword_shield:standard_1',
              tier: 'STANDARD',
              role: 'set_symbol', 
              coords: { x: 0.7, y: 0.05, w: 0.1, h: 0.1 },
              weights: { base: 0.8 },
            },
            {
              id: 'sword_shield:detailed_1',
              tier: 'DETAILED',
              role: 'type_icons',
              coords: { x: 0.05, y: 0.18, w: 0.2, h: 0.06 },
              weights: { base: 0.6 },
            },
            {
              id: 'sword_shield:optional_1', 
              tier: 'OPTIONAL',
              role: 'holographic_pattern',
              coords: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 },
              weights: { base: 0.3 },
            },
          ],
        },
        conditions: { era: ['sword_shield'] },
      };

      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(multiTierTemplate, mockImage, mockFeatures, budget);

      // Critical tier should always be evaluated
      expect(result.usedRois).toContain('sword_shield:critical_1');
      
      // Other tiers may or may not be evaluated depending on budget/confidence
      expect(result.tier).toBeDefined();
      expect(['CRITICAL', 'STANDARD', 'DETAILED', 'OPTIONAL']).toContain(result.tier);
    });

    test('should stop early on high confidence', async () => {
      // Use a runner with low thresholds for early termination
      const earlyStopRunner = new LazyRoiRunner(mockImageIO, {
        thresholds: { accept: 0.1, tryNextTier: 0.05, lowConfidence: 0.01 },
      });

      const mockTemplate: TemplateVariation = {
        id: 'early_stop',
        layoutFamily: 'sword_shield',
        parentId: 'sword_shield', 
        coreROIs: {
          rois: [
            {
              id: 'sword_shield:high_confidence_roi',
              tier: 'CRITICAL',
              role: 'name_band',
              coords: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
              weights: { base: 2.0 }, // High weight for high confidence
            },
          ],
        },
        eraSpecificROIs: { rois: [] },
        conditions: { era: ['sword_shield'] },
      };

      const budget = new Budget(DEFAULT_BUDGET_MS);
      const result = await runner.run(mockTemplate, mockImage, mockFeatures, budget);

      // Should have some unused budget due to early termination
      expect(result.msSpent).toBeLessThan(DEFAULT_BUDGET_MS);
    });
  });

  describe('Coordinate conversion', () => {
    test('should convert percentage to absolute coordinates', () => {
      // This tests the private toAbsolute method indirectly through run()
      const templateWithKnownCoords: TemplateVariation = {
        id: 'coord_test',
        layoutFamily: 'sword_shield',
        parentId: 'sword_shield',
        coreROIs: {
          rois: [
            {
              id: 'sword_shield:coord_test',
              tier: 'CRITICAL',
              role: 'name_band',
              coords: { x: 0.5, y: 0.25, w: 0.4, h: 0.2 }, // Known percentages
              weights: { base: 1.0 },
            },
          ],
        },
        eraSpecificROIs: { rois: [] },
        conditions: { era: ['sword_shield'] },
      };

      // Mock crop to verify absolute coordinates
      let capturedCoords: any;
      mockImageIO.crop = jest.fn().mockImplementation((image, x, y, w, h) => {
        capturedCoords = { x, y, w, h };
        return Promise.resolve({
          ...mockImage,
          width: w,
          height: h,
        });
      });

      const budget = new Budget(DEFAULT_BUDGET_MS);
      
      return runner.run(templateWithKnownCoords, mockImage, mockFeatures, budget).then(() => {
        expect(mockImageIO.crop).toHaveBeenCalled();
        expect(capturedCoords).toBeDefined();
        
        // Verify coordinate conversion: 
        // mockImage is 100x150, so 0.5, 0.25, 0.4, 0.2 should become 50, 37, 40, 30
        expect(capturedCoords.x).toBe(50);
        expect(capturedCoords.y).toBe(Math.floor(150 * 0.25));
        expect(capturedCoords.w).toBe(40);
        expect(capturedCoords.h).toBe(30);
      });
    });
  });
});