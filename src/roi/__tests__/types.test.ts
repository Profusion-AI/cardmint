/**
 * Unit tests for Phase 6.2 ROI Types
 * 
 * Tests type guards, validation functions, and constants for the ROI system.
 */

import {
  isValidLayoutFamily,
  isValidRoiTier,
  isPercentageCoordinate,
  isAbsoluteCoordinate,
  validateRoiId,
  ROI_ID_PATTERN,
  DEFAULT_THRESHOLDS,
  MAX_ROIS_PER_FAMILY,
  PercentageCoordinate,
  AbsoluteCoordinate,
  LayoutFamilyId,
  RoiTier,
} from '../types';

describe('ROI Type Guards', () => {
  describe('isValidLayoutFamily', () => {
    test('should accept valid layout family IDs', () => {
      const validFamilies = [
        'classic_wotc',
        'e_card', 
        'ex_dp',
        'hgss',
        'bw_xy',
        'sun_moon',
        'sword_shield',
        'scarlet_violet',
        'legend_split',
        'vmax_vstar_landscape',
        'trainer_ownership'
      ];

      validFamilies.forEach(family => {
        expect(isValidLayoutFamily(family)).toBe(true);
      });
    });

    test('should reject invalid layout family IDs', () => {
      const invalidFamilies = [
        'invalid_family',
        'modern_standard', // Legacy name
        'SWORD_SHIELD',    // Wrong case
        'sword-shield',    // Wrong separator
        '',
        undefined,
        null,
        123
      ];

      invalidFamilies.forEach(family => {
        expect(isValidLayoutFamily(family as any)).toBe(false);
      });
    });
  });

  describe('isValidRoiTier', () => {
    test('should accept valid ROI tiers', () => {
      const validTiers: RoiTier[] = ['CRITICAL', 'STANDARD', 'DETAILED', 'OPTIONAL'];
      
      validTiers.forEach(tier => {
        expect(isValidRoiTier(tier)).toBe(true);
      });
    });

    test('should reject invalid ROI tiers', () => {
      const invalidTiers = [
        'critical',  // Wrong case
        'HIGH',      // Wrong name
        'PRIORITY',  // Wrong name
        '',
        undefined,
        null
      ];

      invalidTiers.forEach(tier => {
        expect(isValidRoiTier(tier as any)).toBe(false);
      });
    });
  });

  describe('isPercentageCoordinate', () => {
    test('should accept valid percentage coordinates', () => {
      const validCoords: PercentageCoordinate[] = [
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        { x: 1, y: 1, w: 0, h: 0 }, // Edge case: zero size at corner
      ];

      validCoords.forEach(coord => {
        expect(isPercentageCoordinate(coord)).toBe(true);
      });
    });

    test('should reject invalid percentage coordinates', () => {
      const invalidCoords = [
        { x: -0.1, y: 0, w: 1, h: 1 },    // Negative x
        { x: 0, y: 1.1, w: 1, h: 1 },     // Y > 1
        { x: 0, y: 0, w: -0.5, h: 1 },    // Negative width
        { x: 0, y: 0, w: 1, h: 1.5 },     // Height > 1
        { x: 0, y: 0, width: 1, height: 1 }, // Wrong property names
        {},                                // Empty object
        null,
        undefined,
        'invalid',
      ];

      invalidCoords.forEach(coord => {
        expect(isPercentageCoordinate(coord)).toBe(false);
      });
    });
  });

  describe('isAbsoluteCoordinate', () => {
    test('should accept valid absolute coordinates', () => {
      const validCoords: AbsoluteCoordinate[] = [
        { x: 0, y: 0, w: 100, h: 100 },
        { x: 50, y: 75, w: 200, h: 150 },
        { x: 1000, y: 2000, w: 1, h: 1 },
      ];

      validCoords.forEach(coord => {
        expect(isAbsoluteCoordinate(coord)).toBe(true);
      });
    });

    test('should reject invalid absolute coordinates', () => {
      const invalidCoords = [
        { x: -10, y: 0, w: 100, h: 100 },  // Negative x
        { x: 0, y: -5, w: 100, h: 100 },   // Negative y
        { x: 0, y: 0, w: 0, h: 100 },      // Zero width
        { x: 0, y: 0, w: 100, h: 0 },      // Zero height
        { x: 0, y: 0, w: -50, h: 100 },    // Negative width
        {},
        null,
        undefined,
      ];

      invalidCoords.forEach(coord => {
        expect(isAbsoluteCoordinate(coord)).toBe(false);
      });
    });
  });
});

describe('ROI ID Validation', () => {
  describe('validateRoiId', () => {
    test('should validate correct ROI ID format', () => {
      const validIds = [
        'sword_shield:name_band',
        'bw_xy:rule_box',
        'scarlet_violet:regulation_mark',
        'classic_wotc:set_symbol',
        'legend_split:split_detector',
      ];

      validIds.forEach(id => {
        const result = validateRoiId(id);
        expect(result.valid).toBe(true);
        expect(result.familyId).toBeDefined();
        expect(result.roiName).toBeDefined();
        expect(result.error).toBeUndefined();
      });
    });

    test('should extract family and ROI name correctly', () => {
      const result = validateRoiId('sword_shield:name_band');
      
      expect(result.valid).toBe(true);
      expect(result.familyId).toBe('sword_shield');
      expect(result.roiName).toBe('name_band');
    });

    test('should reject invalid ROI ID formats', () => {
      const invalidIds = [
        'sword_shield',           // Missing colon
        ':name_band',            // Missing family
        'sword_shield:',         // Missing ROI name
        'sword_shield:name:band', // Too many colons
        'invalid_family:test',    // Unknown family
        'SWORD_SHIELD:NAME_BAND', // Wrong case
        '',
        'no-colon-at-all',
      ];

      invalidIds.forEach(id => {
        const result = validateRoiId(id);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    test('should detect unknown layout families', () => {
      const result = validateRoiId('unknown_family:test_roi');
      
      expect(result.valid).toBe(false);
      expect(result.familyId).toBe('unknown_family');
      expect(result.roiName).toBe('test_roi');
      expect(result.error).toContain('Unknown layout family');
    });
  });

  describe('ROI_ID_PATTERN', () => {
    test('should match valid ROI ID patterns', () => {
      const validPatterns = [
        'family:roi',
        'long_family_name:long_roi_name',
        'a:b',
        'test_123:roi_456',
        'family_name:roi-with-hyphens',
      ];

      validPatterns.forEach(pattern => {
        expect(ROI_ID_PATTERN.test(pattern)).toBe(true);
      });
    });

    test('should reject invalid patterns', () => {
      const invalidPatterns = [
        'nocolon',
        ':missingfamily',
        'missingroi:',
        'family::double',
        'Family:ROI',  // Uppercase
        'family:roi:extra',
        'family:roi with spaces',
        'family-with-hyphens:roi',
        '',
      ];

      invalidPatterns.forEach(pattern => {
        expect(ROI_ID_PATTERN.test(pattern)).toBe(false);
      });
    });
  });
});

describe('Constants and Defaults', () => {
  test('DEFAULT_THRESHOLDS should have valid values', () => {
    expect(DEFAULT_THRESHOLDS.accept).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.accept).toBeLessThanOrEqual(1);
    expect(DEFAULT_THRESHOLDS.tryNextTier).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.tryNextTier).toBeLessThan(DEFAULT_THRESHOLDS.accept);
    expect(DEFAULT_THRESHOLDS.lowConfidence).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.lowConfidence).toBeLessThanOrEqual(1);
  });

  test('MAX_ROIS_PER_FAMILY should be reasonable', () => {
    expect(MAX_ROIS_PER_FAMILY).toBe(40);
    expect(MAX_ROIS_PER_FAMILY).toBeGreaterThan(0);
    expect(MAX_ROIS_PER_FAMILY).toBeLessThan(100); // Sanity check
  });
});

describe('Type Safety', () => {
  test('LayoutFamilyId should be assignable from valid strings', () => {
    const familyId: LayoutFamilyId = 'sword_shield';
    expect(typeof familyId).toBe('string');
    expect(isValidLayoutFamily(familyId)).toBe(true);
  });

  test('RoiTier should be assignable from valid strings', () => {
    const tier: RoiTier = 'CRITICAL';
    expect(typeof tier).toBe('string');
    expect(isValidRoiTier(tier)).toBe(true);
  });

  test('PercentageCoordinate should enforce correct structure', () => {
    const coord: PercentageCoordinate = {
      x: 0.1,
      y: 0.2, 
      w: 0.3,
      h: 0.4,
    };

    expect(isPercentageCoordinate(coord)).toBe(true);
    
    // TypeScript should prevent this at compile time, but verify structure
    expect(coord).toHaveProperty('x');
    expect(coord).toHaveProperty('y');
    expect(coord).toHaveProperty('w');
    expect(coord).toHaveProperty('h');
  });

  test('AbsoluteCoordinate should enforce correct structure', () => {
    const coord: AbsoluteCoordinate = {
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    };

    expect(isAbsoluteCoordinate(coord)).toBe(true);
    expect(coord).toHaveProperty('x');
    expect(coord).toHaveProperty('y');
    expect(coord).toHaveProperty('w');
    expect(coord).toHaveProperty('h');
  });
});

describe('Edge Cases', () => {
  test('should handle boundary coordinate values', () => {
    // Boundary percentage coordinates
    const boundaryPercentage: PercentageCoordinate = { x: 0, y: 0, w: 1, h: 1 };
    expect(isPercentageCoordinate(boundaryPercentage)).toBe(true);

    const zeroSizePercentage: PercentageCoordinate = { x: 0.5, y: 0.5, w: 0, h: 0 };
    expect(isPercentageCoordinate(zeroSizePercentage)).toBe(true);

    // Boundary absolute coordinates
    const zeroAbsolute: AbsoluteCoordinate = { x: 0, y: 0, w: 1, h: 1 };
    expect(isAbsoluteCoordinate(zeroAbsolute)).toBe(true);

    const largeAbsolute: AbsoluteCoordinate = { x: 10000, y: 10000, w: 5000, h: 5000 };
    expect(isAbsoluteCoordinate(largeAbsolute)).toBe(true);
  });

  test('should handle extreme ROI ID cases', () => {
    // Very long but valid ROI ID
    const longId = 'very_long_family_name_for_testing:extremely_long_roi_name_that_is_still_valid';
    const result = validateRoiId(longId);
    expect(result.valid).toBe(false); // Should fail due to unknown family, but format is OK
    expect(ROI_ID_PATTERN.test(longId)).toBe(true);

    // Minimum valid ROI ID
    const minId = 'bw_xy:a';
    const minResult = validateRoiId(minId);
    expect(minResult.valid).toBe(true);
    expect(minResult.familyId).toBe('bw_xy');
    expect(minResult.roiName).toBe('a');
  });

  test('should handle numeric-like strings in type guards', () => {
    expect(isValidLayoutFamily('123')).toBe(false);
    expect(isValidRoiTier('456')).toBe(false);
    
    // But actual numbers should definitely fail
    expect(isValidLayoutFamily(123 as any)).toBe(false);
    expect(isValidRoiTier(456 as any)).toBe(false);
  });
});