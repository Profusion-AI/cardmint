/**
 * Sword & Shield Era Hierarchical Template
 * 
 * Converts the legacy modern_standard template to Phase 6.2 hierarchical structure
 * with conditional ROIs and tier-based evaluation for SWSH cards.
 */

import {
  LayoutFamilyId,
  BaseTemplate,
  TemplateVariation,
  RoiSpec,
  RoiTier,
  RoiRole,
  TemplateConditions,
  ImageFeatures,
} from '../types';

// Sword & Shield family ID
const FAMILY_ID: LayoutFamilyId = "sword_shield";

// Core ROIs that are always evaluated (CRITICAL tier)
const CORE_ROIS: RoiSpec[] = [
  {
    id: "sword_shield:card_bounds",
    tier: "CRITICAL",
    role: "art_border",
    coords: { x: 0.017, y: 0.025, w: 0.967, h: 0.950 },
    weights: { base: 1.0, max: 1.0 },
  },
  {
    id: "sword_shield:name_band",
    tier: "CRITICAL", 
    role: "name_band",
    coords: { x: 0.050, y: 0.050, w: 0.900, h: 0.120 },
    weights: { base: 1.2, max: 1.5 },
  },
  {
    id: "sword_shield:artwork_region",
    tier: "CRITICAL",
    role: "art_border", 
    coords: { x: 0.100, y: 0.200, w: 0.800, h: 0.600 },
    weights: { base: 0.8, max: 1.0 },
  },
  {
    id: "sword_shield:bottom_text_band",
    tier: "CRITICAL",
    role: "text",
    coords: { x: 0.050, y: 0.850, w: 0.900, h: 0.100 },
    weights: { base: 1.0, max: 1.2 },
  },
];

// Standard tier ROIs for common elements
const STANDARD_ROIS: RoiSpec[] = [
  {
    id: "sword_shield:set_symbol",
    tier: "STANDARD",
    role: "set_symbol",
    coords: { x: 0.700, y: 0.050, w: 0.100, h: 0.100 },
    weights: { base: 0.9, max: 1.1 },
  },
  {
    id: "sword_shield:card_number",
    tier: "STANDARD", 
    role: "text",
    coords: { x: 0.750, y: 0.920, w: 0.200, h: 0.060 },
    weights: { base: 1.0, max: 1.2 },
  },
  {
    id: "sword_shield:regulation_mark",
    tier: "STANDARD",
    role: "symbol",
    coords: { x: 0.867, y: 0.900, w: 0.033, h: 0.050 },
    weights: { base: 0.7, max: 1.0 },
    condition: (features: ImageFeatures) => {
      // Only present on cards from regulation D onwards
      return features.borderColor !== 'yellow'; // Modern cards typically have grey borders
    },
  },
];

// Detailed tier ROIs for advanced features
const DETAILED_ROIS: RoiSpec[] = [
  {
    id: "sword_shield:hp_indicator",
    tier: "DETAILED",
    role: "text",
    coords: { x: 0.800, y: 0.060, w: 0.150, h: 0.080 },
    weights: { base: 0.6, max: 0.8 },
    condition: (features: ImageFeatures) => {
      // Only on Pokemon cards, not Trainer/Energy
      return features.textDensityTop !== undefined && features.textDensityTop > 0.3;
    },
  },
  {
    id: "sword_shield:type_icons",
    tier: "DETAILED",
    role: "symbol",
    coords: { x: 0.050, y: 0.180, w: 0.200, h: 0.060 },
    weights: { base: 0.5, max: 0.7 },
  },
  {
    id: "sword_shield:weakness_resistance",
    tier: "DETAILED", 
    role: "symbol",
    coords: { x: 0.050, y: 0.800, w: 0.400, h: 0.080 },
    weights: { base: 0.4, max: 0.6 },
    condition: (features: ImageFeatures) => {
      return features.textDensityTop !== undefined && features.textDensityTop > 0.3;
    },
  },
];

// Optional tier ROIs for specialized features
const OPTIONAL_ROIS: RoiSpec[] = [
  {
    id: "sword_shield:promo_stamp",
    tier: "OPTIONAL",
    role: "symbol", 
    coords: { x: 0.800, y: 0.075, w: 0.050, h: 0.075 },
    weights: { base: 0.3, max: 0.5 },
    condition: (features: ImageFeatures) => {
      // Only on promo cards
      return features.borderColor === 'unknown' || features.edgeLogoSignal !== undefined && features.edgeLogoSignal > 0.2;
    },
  },
  {
    id: "sword_shield:holographic_pattern",
    tier: "OPTIONAL",
    role: "pattern",
    coords: { x: 0.100, y: 0.200, w: 0.800, h: 0.600 }, // Same as artwork for pattern analysis
    weights: { base: 0.2, max: 0.4 },
    condition: (features: ImageFeatures) => {
      return features.radiantPattern !== undefined && features.radiantPattern > 0.1;
    },
  },
];

// Base template with core ROIs
export const SwordShieldBaseTemplate: BaseTemplate = {
  id: FAMILY_ID,
  layoutFamily: FAMILY_ID,
  coreROIs: {
    rois: CORE_ROIS,
  },
};

// Standard Pokemon card variation (most common)
export const SwordShieldStandardVariation: TemplateVariation = {
  ...SwordShieldBaseTemplate,
  parentId: FAMILY_ID,
  eraSpecificROIs: {
    rois: [...STANDARD_ROIS, ...DETAILED_ROIS, ...OPTIONAL_ROIS],
  },
  conditions: {
    era: ["sword_shield"],
    layoutVariant: "standard",
    hasRuleBox: false,
    minConfidence: 0.80,
  },
};

// V-series card variation (V, VMAX, VSTAR cards)
export const SwordShieldVSeriesVariation: TemplateVariation = {
  ...SwordShieldBaseTemplate,
  parentId: FAMILY_ID,
  eraSpecificROIs: {
    rois: [
      ...STANDARD_ROIS,
      // V-series specific ROIs
      {
        id: "sword_shield:rule_box",
        tier: "CRITICAL",
        role: "rulebox",
        coords: { x: 0.050, y: 0.750, w: 0.900, h: 0.150 },
        weights: { base: 1.5, max: 2.0 },
        condition: (features: ImageFeatures) => features.ruleBoxBand === true,
      },
      {
        id: "sword_shield:v_series_logo", 
        tier: "STANDARD",
        role: "symbol",
        coords: { x: 0.850, y: 0.150, w: 0.100, h: 0.100 },
        weights: { base: 1.2, max: 1.5 },
      },
      ...DETAILED_ROIS,
      ...OPTIONAL_ROIS,
    ],
  },
  conditions: {
    era: ["sword_shield"],
    layoutVariant: "standard",
    hasRuleBox: true,
    minConfidence: 0.85,
  },
};

// VMAX landscape card variation
export const SwordShieldVMAXLandscapeVariation: TemplateVariation = {
  ...SwordShieldBaseTemplate,
  parentId: FAMILY_ID,
  eraSpecificROIs: {
    rois: [
      // Landscape-specific ROI coordinates (rotated layout)
      {
        id: "sword_shield:vmax_name_band",
        tier: "CRITICAL",
        role: "name_band", 
        coords: { x: 0.050, y: 0.050, w: 0.600, h: 0.120 },
        weights: { base: 1.3, max: 1.6 },
      },
      {
        id: "sword_shield:vmax_artwork", 
        tier: "CRITICAL",
        role: "art_border",
        coords: { x: 0.050, y: 0.200, w: 0.650, h: 0.600 },
        weights: { base: 0.9, max: 1.1 },
      },
      {
        id: "sword_shield:vmax_rule_box",
        tier: "CRITICAL", 
        role: "rulebox",
        coords: { x: 0.720, y: 0.200, w: 0.230, h: 0.600 },
        weights: { base: 1.8, max: 2.2 },
        condition: (features: ImageFeatures) => features.ruleBoxBand === true,
      },
      {
        id: "sword_shield:vmax_hp",
        tier: "STANDARD",
        role: "text", 
        coords: { x: 0.750, y: 0.050, w: 0.200, h: 0.100 },
        weights: { base: 1.0, max: 1.3 },
      },
    ],
  },
  conditions: {
    era: ["sword_shield"],
    layoutVariant: "landscape", 
    hasRuleBox: true,
    minConfidence: 0.90,
  },
};

// Trainer card variation
export const SwordShieldTrainerVariation: TemplateVariation = {
  ...SwordShieldBaseTemplate,
  parentId: FAMILY_ID,
  eraSpecificROIs: {
    rois: [
      ...STANDARD_ROIS.filter(roi => roi.id !== "sword_shield:regulation_mark"), // Trainers may not have regulation marks
      {
        id: "sword_shield:trainer_text",
        tier: "CRITICAL",
        role: "text",
        coords: { x: 0.050, y: 0.450, w: 0.900, h: 0.300 },
        weights: { base: 1.4, max: 1.8 },
      },
      {
        id: "sword_shield:trainer_artwork",
        tier: "STANDARD", 
        role: "art_border",
        coords: { x: 0.100, y: 0.200, w: 0.800, h: 0.220 },
        weights: { base: 0.7, max: 0.9 },
      },
      // Add trainer portrait detection if available
      ...(OPTIONAL_ROIS.filter(roi => roi.role !== "pattern")), // No holographic patterns on most trainers
    ],
  },
  conditions: {
    era: ["sword_shield"],
    layoutVariant: "standard",
    hasRuleBox: false,
    hasTrainerPortrait: true,
    minConfidence: 0.75,
  },
};

// Export all variations for the template registry
export const SwordShieldTemplateFamily = {
  base: SwordShieldBaseTemplate,
  variations: [
    SwordShieldStandardVariation,
    SwordShieldVSeriesVariation, 
    SwordShieldVMAXLandscapeVariation,
    SwordShieldTrainerVariation,
  ],
};

// Utility function to select the best variation based on features
export function selectSwordShieldVariation(features: ImageFeatures): TemplateVariation {
  // VMAX landscape cards have distinctive aspect ratio
  if (features.aspectRatio < 0.8 && features.ruleBoxBand) {
    return SwordShieldVMAXLandscapeVariation;
  }
  
  // V-series cards have rule boxes
  if (features.ruleBoxBand) {
    return SwordShieldVSeriesVariation;
  }
  
  // Trainer cards have portrait detection
  if (features.trainerPortraitBlob !== undefined && features.trainerPortraitBlob > 0.3) {
    return SwordShieldTrainerVariation;
  }
  
  // Default to standard variation
  return SwordShieldStandardVariation;
}

// ROI count validation (must be ≤40 ROIs per family)
export function validateROICount(): {
  isValid: boolean;
  totalROIs: number;
  breakdown: Record<string, number>;
  issues: string[];
} {
  const issues: string[] = [];
  const breakdown: Record<string, number> = {};
  
  let totalROIs = CORE_ROIS.length;
  breakdown["core"] = CORE_ROIS.length;
  
  for (const variation of SwordShieldTemplateFamily.variations) {
    const variationROIs = variation.eraSpecificROIs.rois.length;
    const totalForVariation = CORE_ROIS.length + variationROIs;
    
    breakdown[variation.id || "unknown"] = totalForVariation;
    
    if (totalForVariation > 40) {
      issues.push(`Variation ${variation.id} has ${totalForVariation} ROIs (exceeds limit of 40)`);
    }
    
    totalROIs = Math.max(totalROIs, totalForVariation);
  }
  
  return {
    isValid: totalROIs <= 40 && issues.length === 0,
    totalROIs,
    breakdown,
    issues,
  };
}