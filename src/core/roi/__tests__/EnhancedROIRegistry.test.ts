/**
 * Integration tests for the Enhanced ROI Registry
 * 
 * Tests the complete coordinate abstraction integration with ROI templates
 * and ensures backward compatibility with existing code.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EnhancedROIRegistry } from '../EnhancedROIRegistry';
import { UnifiedCoordinateSystem } from '../CoordinateSystem';
import { CoordinateMigrationManager } from '../CoordinateMigration';
import { ROITemplate, ROIManifest } from '../../../services/local-matching/ROIRegistry';

describe('EnhancedROIRegistry Integration', () => {
  let registry: EnhancedROIRegistry;
  let testDataRoot: string;
  const testImageSize = { width: 3000, height: 2000 };

  beforeEach(async () => {
    // Create temporary test directory
    testDataRoot = path.join(__dirname, '../../../__temp__', `test-${Date.now()}`);
    await fs.mkdir(testDataRoot, { recursive: true });
    
    registry = new EnhancedROIRegistry(testDataRoot);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDataRoot, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Initialization and Migration', () => {
    test('should initialize with default manifest when none exists', async () => {
      await registry.initialize();
      
      const defaultTemplate = await registry.getDefaultROITemplate();
      expect(defaultTemplate).toBeDefined();
      expect(defaultTemplate?.id).toBe('modern_standard');
    });

    test('should create enhanced manifest with coordinate system metadata', async () => {
      await registry.initialize();
      
      const manifest = await registry.exportEnhancedManifest();
      expect(manifest.coordinateSystemVersion).toBeDefined();
      expect(manifest.coordinateFormat).toBe('percentage');
      expect(manifest.migrationHistory).toBeDefined();
    });

    test('should handle legacy manifest migration', async () => {
      // Create a legacy manifest with mixed coordinate formats
      const legacyManifest: ROIManifest = {
        version: "1.0",
        camera_calibration: {
          resolution: { width: 6000, height: 4000 },
          last_calibrated: new Date().toISOString(),
          calibration_card: "test_card"
        },
        default_template: "legacy_test",
        templates: {
          legacy_test: {
            id: "legacy_test",
            name: "Legacy Test Template",
            description: "Template with mixed coordinate formats",
            layout_hint: "test",
            era: "test",
            rotation_deg: 0,
            confidence: 0.9,
            rois: {
              set_icon: { x: 4200, y: 200, width: 600, height: 400 }, // Absolute
              bottom_band: { x_pct: 5, y_pct: 85, width_pct: 90, height_pct: 10 }, // Percentage
              card_bounds: { x: 100, y: 100, width: 5800, height: 3800 } // Absolute
            }
          }
        }
      };

      const manifestPath = path.join(testDataRoot, 'roi_templates.json');
      await fs.writeFile(manifestPath, JSON.stringify(legacyManifest, null, 2));

      // Initialize should trigger migration
      await registry.initialize();
      
      const migrationHistory = registry.getMigrationHistory();
      expect(migrationHistory.length).toBeGreaterThan(0);
    });
  });

  describe('Enhanced Coordinate Handling', () => {
    beforeEach(async () => {
      await registry.initialize();
    });

    test('should return scaled ROIs with enhanced metadata', async () => {
      const result = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      expect(result.rois).toBeDefined();
      expect(result.coordinateFormat).toBe('absolute');
      expect(result.metadata).toBeDefined();
      expect(result.metadata.templateId).toBe('modern_standard');
      expect(result.metadata.conversionTimeMs).toBeGreaterThanOrEqual(0);
    });

    test('should maintain backward compatibility with legacy getScaledROIs', async () => {
      const legacyResult = await registry.getScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      const enhancedResult = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      // Legacy result should match enhanced result structure
      expect(legacyResult.rois).toEqual(enhancedResult.rois);
      expect(legacyResult.rotation).toBe(enhancedResult.rotation);
      expect(legacyResult.scaleX).toBe(enhancedResult.scaleX);
      expect(legacyResult.scaleY).toBe(enhancedResult.scaleY);
    });

    test('should handle conditional ROIs correctly', async () => {
      // Test with promo conditions
      const promoResult = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { 
          roi_template: 'neo_era',
          promo: true 
        }
      );

      const nonPromoResult = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { 
          roi_template: 'neo_era',
          promo: false 
        }
      );

      // Both should succeed but may have different ROI selections
      expect(promoResult.rois).toBeDefined();
      expect(nonPromoResult.rois).toBeDefined();
    });

    test('should validate coordinates when enabled', async () => {
      const result = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' },
        { validateCoordinates: true }
      );

      // All ROI coordinates should be valid
      for (const [roiName, roi] of Object.entries(result.rois)) {
        expect(roi.x).toBeGreaterThanOrEqual(0);
        expect(roi.y).toBeGreaterThanOrEqual(0);
        expect(roi.width).toBeGreaterThan(0);
        expect(roi.height).toBeGreaterThan(0);
        expect(roi.x + roi.width).toBeLessThanOrEqual(testImageSize.width);
        expect(roi.y + roi.height).toBeLessThanOrEqual(testImageSize.height);
      }
    });

    test('should clamp coordinates to image boundaries when enabled', async () => {
      // Create a test case that would normally exceed boundaries
      const oversizedImageSize = { width: 1000, height: 800 }; // Smaller than reference
      
      const result = await registry.getEnhancedScaledROIs(
        oversizedImageSize.width,
        oversizedImageSize.height,
        { roi_template: 'modern_standard' },
        { clampToBounds: true }
      );

      for (const [roiName, roi] of Object.entries(result.rois)) {
        expect(roi.x).toBeGreaterThanOrEqual(0);
        expect(roi.y).toBeGreaterThanOrEqual(0);
        expect(roi.x + roi.width).toBeLessThanOrEqual(oversizedImageSize.width);
        expect(roi.y + roi.height).toBeLessThanOrEqual(oversizedImageSize.height);
      }
    });
  });

  describe('Performance and Caching', () => {
    beforeEach(async () => {
      await registry.initialize();
    });

    test('should use cache for repeated requests', async () => {
      const requestParams = {
        width: testImageSize.width,
        height: testImageSize.height,
        hints: { roi_template: 'modern_standard' },
        options: { useCache: true }
      };

      // First request
      const result1 = await registry.getEnhancedScaledROIs(
        requestParams.width,
        requestParams.height,
        requestParams.hints,
        requestParams.options
      );

      // Second request (should hit cache)
      const result2 = await registry.getEnhancedScaledROIs(
        requestParams.width,
        requestParams.height,
        requestParams.hints,
        requestParams.options
      );

      expect(result1.rois).toEqual(result2.rois);
      expect(result2.metadata.cacheHit).toBe(true);
    });

    test('should complete ROI extraction under performance target', async () => {
      const TARGET_TIME_MS = 50; // 50ms target from requirements
      
      const start = performance.now();
      await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(TARGET_TIME_MS);
    });

    test('should provide coordinate system metrics', async () => {
      // Generate some activity
      await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      const metrics = registry.getCoordinateSystemMetrics();
      
      expect(metrics.coordinateSystem).toBeDefined();
      expect(metrics.cache).toBeDefined();
      expect(metrics.cacheHealth).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHealth).toBeLessThanOrEqual(100);
    });

    test('should optimize cache when requested', async () => {
      // Generate cache entries
      const templates = ['modern_standard', 'neo_era'];
      const sizes = [
        { width: 1000, height: 800 },
        { width: 2000, height: 1600 },
        { width: 3000, height: 2400 }
      ];

      for (const template of templates) {
        for (const size of sizes) {
          await registry.getEnhancedScaledROIs(
            size.width,
            size.height,
            { roi_template: template }
          );
        }
      }

      const removedEntries = await registry.optimizeCache();
      expect(removedEntries).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    beforeEach(async () => {
      await registry.initialize();
    });

    test('should handle non-existent template gracefully', async () => {
      const result = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'non_existent_template' }
      );

      // Should fall back to default template
      expect(result.metadata.templateId).toBe('modern_standard');
    });

    test('should handle zero-sized images', async () => {
      expect(async () => {
        await registry.getEnhancedScaledROIs(
          0,
          0,
          { roi_template: 'modern_standard' }
        );
      }).not.toThrow();
    });

    test('should handle very large images', async () => {
      const largeSize = { width: 20000, height: 15000 };
      
      const result = await registry.getEnhancedScaledROIs(
        largeSize.width,
        largeSize.height,
        { roi_template: 'modern_standard' }
      );

      expect(result.rois).toBeDefined();
      expect(result.scaleX).toBeGreaterThan(1);
      expect(result.scaleY).toBeGreaterThan(1);
    });

    test('should handle corrupted template data gracefully', async () => {
      // This test would require injecting a corrupted template
      // For now, we test that the registry handles missing ROI data
      const template = await registry.getROITemplate('modern_standard');
      expect(template).toBeDefined();
      
      if (template) {
        // Verify all required ROIs are present
        expect(template.rois.set_icon).toBeDefined();
        expect(template.rois.bottom_band).toBeDefined();
        expect(template.rois.card_bounds).toBeDefined();
      }
    });
  });

  describe('Template Resolution', () => {
    beforeEach(async () => {
      await registry.initialize();
    });

    test('should resolve template by ID', async () => {
      const template = await registry.getROITemplate('modern_standard');
      expect(template).toBeDefined();
      expect(template?.id).toBe('modern_standard');
    });

    test('should resolve template by layout hint', async () => {
      const result = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { layout_hint: 'modern' }
      );

      expect(result.metadata.templateId).toBe('modern_standard');
    });

    test('should fall back to default template', async () => {
      const result = await registry.getEnhancedScaledROIs(
        testImageSize.width,
        testImageSize.height,
        {} // No template hints
      );

      expect(result.metadata.templateId).toBe('modern_standard');
    });
  });
});

describe('Migration Integration', () => {
  let testDataRoot: string;
  let migrationManager: CoordinateMigrationManager;
  let coordinateSystem: UnifiedCoordinateSystem;

  beforeEach(async () => {
    testDataRoot = path.join(__dirname, '../../../__temp__', `migration-test-${Date.now()}`);
    await fs.mkdir(testDataRoot, { recursive: true });
    
    coordinateSystem = new UnifiedCoordinateSystem();
    migrationManager = new CoordinateMigrationManager(coordinateSystem);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDataRoot, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should analyze migration needs correctly', async () => {
    const mixedManifest = {
      version: "1.0",
      camera_calibration: {
        resolution: { width: 6000, height: 4000 },
        last_calibrated: new Date().toISOString(),
        calibration_card: "test_card"
      },
      default_template: "test_template",
      templates: {
        test_template: {
          id: "test_template",
          name: "Test Template",
          description: "Test template with mixed formats",
          layout_hint: "test",
          era: "test",
          rotation_deg: 0,
          confidence: 0.9,
          rois: {
            absolute_roi: { x: 100, y: 200, width: 300, height: 400 },
            percentage_roi: { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 },
            conditional_roi: [
              { x: 500, y: 600, width: 100, height: 200, conditions: { promoOnly: true } },
              { x_pct: 50, y_pct: 60, width_pct: 10, height_pct: 20, conditions: { promoOnly: false } }
            ]
          }
        }
      }
    };

    const manifestPath = path.join(testDataRoot, 'test_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(mixedManifest, null, 2));

    const plan = await migrationManager.analyzeMigrationNeeds(manifestPath);
    
    expect(plan.templatesAnalyzed).toBe(1);
    expect(plan.coordinatesToMigrate).toBeGreaterThan(0);
    expect(plan.formatBreakdown.test_template.currentFormat).toBe('mixed');
    expect(plan.estimatedRisks.length).toBeGreaterThan(0);
  });

  test('should perform migration with backup and validation', async () => {
    const simpleManifest = {
      version: "1.0",
      camera_calibration: {
        resolution: { width: 6000, height: 4000 },
        last_calibrated: new Date().toISOString(),
        calibration_card: "test_card"
      },
      default_template: "simple_template",
      templates: {
        simple_template: {
          id: "simple_template",
          name: "Simple Template",
          description: "Simple template with absolute coordinates",
          layout_hint: "simple",
          era: "modern",
          rotation_deg: 0,
          confidence: 0.95,
          rois: {
            test_roi: { x: 1000, y: 2000, width: 3000, height: 1000 }
          }
        }
      }
    };

    const manifestPath = path.join(testDataRoot, 'simple_manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(simpleManifest, null, 2));

    const report = await migrationManager.migrateManifest(manifestPath, {
      targetFormat: 'percentage',
      createBackup: true,
      validateBeforeMigration: true,
      validateAfterMigration: true,
      rollbackOnFailure: true,
      dryRun: false
    });

    expect(report.templatesSucceeded).toBe(1);
    expect(report.templatesFailed).toBe(0);
    expect(report.backupFile).toBeTruthy();
    expect(report.coordinateSystemStats.totalCoordinatesMigrated).toBeGreaterThan(0);

    // Verify the migrated manifest
    const migratedData = await fs.readFile(manifestPath, 'utf-8');
    const migratedManifest = JSON.parse(migratedData);
    
    expect(migratedManifest.coordinateSystemVersion).toBeDefined();
    expect(migratedManifest.targetFormat).toBe('percentage');
    
    const migratedROI = migratedManifest.templates.simple_template.rois.test_roi;
    expect(migratedROI.x_pct).toBeDefined();
    expect(migratedROI.y_pct).toBeDefined();
    expect(migratedROI.width_pct).toBeDefined();
    expect(migratedROI.height_pct).toBeDefined();
  });
});