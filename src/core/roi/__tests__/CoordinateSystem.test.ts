/**
 * Comprehensive test suite for the Unified Coordinate System
 * 
 * Tests all coordinate conversions, validation, caching, and edge cases
 * to ensure production-ready reliability.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  UnifiedCoordinateSystem,
  CoordinateAdapter,
} from '../CoordinateSystem';
import {
  CoordinateFormat,
  AbsoluteCoordinate,
  PercentageCoordinate,
  NormalizedCoordinate,
  Size,
  ValidationError,
  ConversionError,
} from '../types';

describe('UnifiedCoordinateSystem', () => {
  let coordinateSystem: UnifiedCoordinateSystem;
  const referenceSize: Size = { width: 6000, height: 4000 };
  const testSize: Size = { width: 3000, height: 2000 };

  beforeEach(() => {
    coordinateSystem = new UnifiedCoordinateSystem({
      enableCaching: true,
      performanceTracking: true,
      validationMode: 'lenient',
    });
  });

  afterEach(() => {
    coordinateSystem.reset();
  });

  describe('Format Detection', () => {
    test('should detect absolute coordinates', () => {
      const coord = { x: 100, y: 200, width: 300, height: 400 };
      expect(coordinateSystem.detectFormat(coord)).toBe('absolute');
    });

    test('should detect percentage coordinates', () => {
      const coord = { x_pct: 10.5, y_pct: 20.0, width_pct: 30.5, height_pct: 40.0 };
      expect(coordinateSystem.detectFormat(coord)).toBe('percentage');
    });

    test('should detect normalized coordinates', () => {
      const coord = { x_norm: 0.1, y_norm: 0.2, width_norm: 0.3, height_norm: 0.4 };
      expect(coordinateSystem.detectFormat(coord)).toBe('normalized');
    });

    test('should return null for unrecognizable format', () => {
      const coord = { invalid: 'data' };
      expect(coordinateSystem.detectFormat(coord)).toBeNull();
    });

    test('should handle mixed coordinate objects', () => {
      // Object with both absolute and percentage properties
      const coord = { x: 100, x_pct: 10, width: 200, width_pct: 20 };
      // Should prefer percentage format when _pct properties are present
      expect(coordinateSystem.detectFormat(coord)).toBe('percentage');
    });
  });

  describe('Coordinate Validation', () => {
    test('should validate correct absolute coordinates', () => {
      const coord: AbsoluteCoordinate = { x: 100, y: 200, width: 300, height: 400 };
      const result = coordinateSystem.validate(coord, 'absolute');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should validate correct percentage coordinates', () => {
      const coord: PercentageCoordinate = { 
        x: 600, y: 800, 
        x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 
      };
      const result = coordinateSystem.validate(coord, 'percentage');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should reject coordinates with negative dimensions', () => {
      const coord = { x: 100, y: 200, width: -300, height: 400 };
      const result = coordinateSystem.validate(coord, 'absolute');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Width and height must be positive');
    });

    test('should reject coordinates with invalid numeric values', () => {
      const coord = { x: NaN, y: 200, width: 300, height: Infinity };
      const result = coordinateSystem.validate(coord, 'absolute');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should warn about out-of-range percentage values', () => {
      const coord = { x_pct: -10, y_pct: 120, width_pct: 30, height_pct: 40 };
      const result = coordinateSystem.validate(coord, 'percentage');
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('Absolute Coordinate Conversions', () => {
    test('should convert percentage to absolute', () => {
      const percentCoord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const result = coordinateSystem.toAbsolute(percentCoord, referenceSize);
      
      expect(result).toEqual({
        x: 600,   // 10% of 6000
        y: 800,   // 20% of 4000
        width: 1800,  // 30% of 6000
        height: 1600, // 40% of 4000
      });
    });

    test('should convert normalized to absolute', () => {
      const normCoord = { x_norm: 0.1, y_norm: 0.2, width_norm: 0.3, height_norm: 0.4 };
      const result = coordinateSystem.toAbsolute(normCoord, referenceSize);
      
      expect(result).toEqual({
        x: 600,   // 0.1 * 6000
        y: 800,   // 0.2 * 4000
        width: 1800,  // 0.3 * 6000
        height: 1600, // 0.4 * 4000
      });
    });

    test('should pass through absolute coordinates unchanged', () => {
      const absCoord: AbsoluteCoordinate = { x: 100, y: 200, width: 300, height: 400 };
      const result = coordinateSystem.toAbsolute(absCoord, referenceSize);
      
      expect(result).toEqual(absCoord);
    });

    test('should round fractional pixels to integers', () => {
      const percentCoord = { x_pct: 16.666, y_pct: 33.333, width_pct: 50.001, height_pct: 25.999 };
      const result = coordinateSystem.toAbsolute(percentCoord, referenceSize);
      
      expect(result.x).toBe(Math.round(16.666 / 100 * 6000));
      expect(result.y).toBe(Math.round(33.333 / 100 * 4000));
      expect(result.width).toBe(Math.round(50.001 / 100 * 6000));
      expect(result.height).toBe(Math.round(25.999 / 100 * 4000));
    });
  });

  describe('Percentage Coordinate Conversions', () => {
    test('should convert absolute to percentage', () => {
      const absCoord: AbsoluteCoordinate = { x: 600, y: 800, width: 1800, height: 1600 };
      const result = coordinateSystem.toPercentage(absCoord, referenceSize);
      
      expect(result.x_pct).toBeCloseTo(10, 5);   // 600/6000 * 100
      expect(result.y_pct).toBeCloseTo(20, 5);   // 800/4000 * 100
      expect(result.width_pct).toBeCloseTo(30, 5);  // 1800/6000 * 100
      expect(result.height_pct).toBeCloseTo(40, 5); // 1600/4000 * 100
    });

    test('should maintain backward compatibility with absolute coordinates', () => {
      const absCoord: AbsoluteCoordinate = { x: 600, y: 800, width: 1800, height: 1600 };
      const result = coordinateSystem.toPercentage(absCoord, referenceSize);
      
      // Should preserve original absolute coordinates for compatibility
      expect(result.x).toBe(600);
      expect(result.y).toBe(800);
    });

    test('should convert normalized to percentage', () => {
      const normCoord = { x_norm: 0.1, y_norm: 0.2, width_norm: 0.3, height_norm: 0.4 };
      const result = coordinateSystem.toPercentage(normCoord, referenceSize);
      
      expect(result.x_pct).toBe(10);
      expect(result.y_pct).toBe(20);
      expect(result.width_pct).toBe(30);
      expect(result.height_pct).toBe(40);
    });

    test('should respect precision settings', () => {
      const coordinateSystemPrecise = new UnifiedCoordinateSystem({ defaultPrecision: 2 });
      const absCoord: AbsoluteCoordinate = { x: 333, y: 777, width: 1111, height: 2222 };
      const result = coordinateSystemPrecise.toPercentage(absCoord, referenceSize);
      
      // Should be rounded to 2 decimal places
      expect(result.x_pct).toBe(5.55);   // 333/6000 * 100 = 5.55
      expect(result.y_pct).toBe(19.43);  // 777/4000 * 100 = 19.425 -> 19.43
    });
  });

  describe('Normalized Coordinate Conversions', () => {
    test('should convert absolute to normalized', () => {
      const absCoord: AbsoluteCoordinate = { x: 600, y: 800, width: 1800, height: 1600 };
      const result = coordinateSystem.toNormalized(absCoord, referenceSize);
      
      expect(result.x_norm).toBeCloseTo(0.1, 5);   // 600/6000
      expect(result.y_norm).toBeCloseTo(0.2, 5);   // 800/4000
      expect(result.width_norm).toBeCloseTo(0.3, 5);  // 1800/6000
      expect(result.height_norm).toBeCloseTo(0.4, 5); // 1600/4000
    });

    test('should convert percentage to normalized', () => {
      const percentCoord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const result = coordinateSystem.toNormalized(percentCoord, referenceSize);
      
      expect(result.x_norm).toBe(0.1);   // 10/100
      expect(result.y_norm).toBe(0.2);   // 20/100
      expect(result.width_norm).toBe(0.3);  // 30/100
      expect(result.height_norm).toBe(0.4); // 40/100
    });

    test('should maintain absolute coordinates for compatibility', () => {
      const percentCoord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const result = coordinateSystem.toNormalized(percentCoord, referenceSize);
      
      // Should calculate absolute coordinates
      expect(result.x).toBe(600);
      expect(result.y).toBe(800);
    });
  });

  describe('Error Handling', () => {
    test('should throw ConversionError for undetectable format', () => {
      const invalidCoord = { invalid: 'data' };
      
      expect(() => {
        coordinateSystem.toAbsolute(invalidCoord, referenceSize);
      }).toThrow(ConversionError);
    });

    test('should throw ValidationError for invalid results in strict mode', () => {
      const strictSystem = new UnifiedCoordinateSystem({ validationMode: 'strict' });
      const invalidCoord = { x: -100, y: -200, width: -300, height: -400 };
      
      expect(() => {
        strictSystem.toAbsolute(invalidCoord, referenceSize);
      }).toThrow(ValidationError);
    });

    test('should handle edge case coordinates gracefully', () => {
      const edgeCases = [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: referenceSize.width - 1, y: referenceSize.height - 1, width: 1, height: 1 },
        { x_pct: 0, y_pct: 0, width_pct: 0.01, height_pct: 0.01 },
      ];

      for (const coord of edgeCases) {
        expect(() => {
          coordinateSystem.toAbsolute(coord, referenceSize);
        }).not.toThrow();
      }
    });
  });

  describe('Performance and Caching', () => {
    test('should cache conversion results', () => {
      const coord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      
      // First conversion
      const result1 = coordinateSystem.toAbsolute(coord, referenceSize);
      const metrics1 = coordinateSystem.getPerformanceMetrics();
      
      // Second conversion (should be cached)
      const result2 = coordinateSystem.toAbsolute(coord, referenceSize);
      const metrics2 = coordinateSystem.getPerformanceMetrics();
      
      expect(result1).toEqual(result2);
      expect(metrics2.cacheHitRate).toBeGreaterThan(0);
    });

    test('should complete conversions under performance target', () => {
      const coord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const TARGET_TIME_MS = 1; // Sub-millisecond target
      
      const start = performance.now();
      coordinateSystem.toAbsolute(coord, referenceSize);
      const duration = performance.now() - start;
      
      expect(duration).toBeLessThan(TARGET_TIME_MS);
    });

    test('should track performance metrics correctly', () => {
      const coords = [
        { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 },
        { x_pct: 15, y_pct: 25, width_pct: 35, height_pct: 45 },
        { x_pct: 20, y_pct: 30, width_pct: 40, height_pct: 50 },
      ];

      for (const coord of coords) {
        coordinateSystem.toAbsolute(coord, referenceSize);
      }

      const metrics = coordinateSystem.getPerformanceMetrics();
      expect(metrics.totalConversions).toBe(coords.length);
      expect(metrics.averageConversionTime).toBeGreaterThan(0);
    });
  });

  describe('Legacy Migration', () => {
    test('should migrate legacy rectangle format', () => {
      const legacyRect = { x: 100, y: 200, width: 300, height: 400 };
      const migrated = coordinateSystem.migrate(legacyRect, 'percentage');
      
      expect(migrated.format).toBe('percentage');
      expect(migrated.data).toEqual(legacyRect);
    });

    test('should migrate legacy percentage format', () => {
      const legacyPercent = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const migrated = coordinateSystem.migrate(legacyPercent, 'absolute');
      
      expect(migrated.format).toBe('absolute');
      expect(migrated.data).toEqual(legacyPercent);
    });

    test('should include migration metadata', () => {
      const legacyRect = { x: 100, y: 200, width: 300, height: 400 };
      const migrated = coordinateSystem.migrate(legacyRect);
      
      expect(migrated.metadata).toBeDefined();
      expect(migrated.metadata?.format).toBeDefined();
      expect(migrated.metadata?.precision).toBeDefined();
    });
  });

  describe('Boundary Conditions', () => {
    test('should handle zero-sized reference dimensions', () => {
      const coord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      const zeroSize = { width: 0, height: 0 };
      
      expect(() => {
        coordinateSystem.toAbsolute(coord, zeroSize);
      }).not.toThrow();
      
      const result = coordinateSystem.toAbsolute(coord, zeroSize);
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    test('should handle very large coordinates', () => {
      const largeCoord = { 
        x: 1000000, y: 2000000, 
        width: 3000000, height: 4000000 
      };
      const largeSize = { width: 10000000, height: 20000000 };
      
      expect(() => {
        coordinateSystem.toPercentage(largeCoord, largeSize);
      }).not.toThrow();
    });

    test('should handle fractional coordinates correctly', () => {
      const fractionalCoord = { 
        x_pct: 33.333333, y_pct: 66.666666, 
        width_pct: 12.345678, height_pct: 87.654321 
      };
      
      const result = coordinateSystem.toAbsolute(fractionalCoord, referenceSize);
      
      // Should produce integer pixel coordinates
      expect(Number.isInteger(result.x)).toBe(true);
      expect(Number.isInteger(result.y)).toBe(true);
      expect(Number.isInteger(result.width)).toBe(true);
      expect(Number.isInteger(result.height)).toBe(true);
    });
  });

  describe('Cache Management', () => {
    test('should report cache statistics', () => {
      const coord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      
      // Generate some cache activity
      coordinateSystem.toAbsolute(coord, referenceSize);
      coordinateSystem.toPercentage(coord, referenceSize);
      coordinateSystem.toAbsolute(coord, referenceSize); // Cache hit
      
      const stats = coordinateSystem.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.hitRate).toBeGreaterThan(0);
    });

    test('should reset all state when requested', () => {
      const coord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };
      
      // Generate activity
      coordinateSystem.toAbsolute(coord, referenceSize);
      
      // Reset
      coordinateSystem.reset();
      
      const metrics = coordinateSystem.getPerformanceMetrics();
      const cacheStats = coordinateSystem.getCacheStats();
      
      expect(metrics.totalConversions).toBe(0);
      expect(cacheStats.size).toBe(0);
      expect(cacheStats.hits).toBe(0);
    });
  });
});

describe('Property-Based Testing', () => {
  let coordinateSystem: UnifiedCoordinateSystem;
  const referenceSize: Size = { width: 6000, height: 4000 };

  beforeEach(() => {
    coordinateSystem = new UnifiedCoordinateSystem();
  });

  test('conversion round-trip should be identity (absolute->percentage->absolute)', () => {
    // Property: Converting absolute to percentage and back should yield original values
    for (let i = 0; i < 100; i++) {
      const original: AbsoluteCoordinate = {
        x: Math.floor(Math.random() * referenceSize.width),
        y: Math.floor(Math.random() * referenceSize.height),
        width: Math.floor(Math.random() * (referenceSize.width / 2)) + 1,
        height: Math.floor(Math.random() * (referenceSize.height / 2)) + 1,
      };

      const percentage = coordinateSystem.toPercentage(original, referenceSize);
      const backToAbsolute = coordinateSystem.toAbsolute(percentage, referenceSize);

      // Allow small rounding errors
      expect(Math.abs(backToAbsolute.x - original.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(backToAbsolute.y - original.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(backToAbsolute.width - original.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(backToAbsolute.height - original.height)).toBeLessThanOrEqual(1);
    }
  });

  test('scaling invariance property', () => {
    // Property: Percentage coordinates should be scale-invariant
    const percentCoord = { x_pct: 25, y_pct: 50, width_pct: 20, height_pct: 30 };
    
    const sizes = [
      { width: 1000, height: 800 },
      { width: 2000, height: 1600 },
      { width: 4000, height: 3200 },
      { width: 8000, height: 6400 },
    ];

    const absoluteResults = sizes.map(size => 
      coordinateSystem.toAbsolute(percentCoord, size)
    );

    // Check that the relative positions are consistent
    for (let i = 1; i < absoluteResults.length; i++) {
      const prev = absoluteResults[i - 1];
      const curr = absoluteResults[i];
      const prevSize = sizes[i - 1];
      const currSize = sizes[i];

      const scaleFactor = currSize.width / prevSize.width;
      
      expect(curr.x / prev.x).toBeCloseTo(scaleFactor, 1);
      expect(curr.y / prev.y).toBeCloseTo(scaleFactor, 1);
      expect(curr.width / prev.width).toBeCloseTo(scaleFactor, 1);
      expect(curr.height / prev.height).toBeCloseTo(scaleFactor, 1);
    }
  });

  test('boundary preservation property', () => {
    // Property: Conversions should preserve boundary conditions
    const boundaryCoords = [
      { x_pct: 0, y_pct: 0, width_pct: 100, height_pct: 100 }, // Full image
      { x_pct: 0, y_pct: 0, width_pct: 1, height_pct: 1 },     // Top-left corner
      { x_pct: 99, y_pct: 99, width_pct: 1, height_pct: 1 },  // Bottom-right corner
    ];

    for (const coord of boundaryCoords) {
      const absolute = coordinateSystem.toAbsolute(coord, referenceSize);
      
      // Check boundaries are respected
      expect(absolute.x).toBeGreaterThanOrEqual(0);
      expect(absolute.y).toBeGreaterThanOrEqual(0);
      expect(absolute.x + absolute.width).toBeLessThanOrEqual(referenceSize.width);
      expect(absolute.y + absolute.height).toBeLessThanOrEqual(referenceSize.height);
    }
  });
});