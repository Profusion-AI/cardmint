/**
 * Canonical ROI Bridge
 * 
 * Integration layer between the Pokemon Canon naming system and ROI Registry.
 * Translates canonical family/era identifiers to ROI templates while maintaining
 * backward compatibility with legacy template IDs.
 */

import { createLogger } from '../../utils/logger';
import { canon, CanonFeatures, NormalizedCard } from '../../lib/canon';
import { EnhancedROIRegistry, ROIExtractionOptions } from './EnhancedROIRegistry';
import { ROITemplate, ROIManifest } from '../../services/local-matching/ROIRegistry';

const logger = createLogger('CanonicalROIBridge');

export interface CanonicalROIRequest {
  imageWidth: number;
  imageHeight: number;
  ocrExtract?: {
    set_name?: string;
    card_number?: string;
    card_name?: string;
    language?: string;
    rarity_hint?: string;
    rulebox_present?: boolean;
    layout_variant?: string;
  };
  features?: CanonFeatures;
  options?: ROIExtractionOptions;
}

export interface CanonicalROIResult {
  rois: Required<import('../../services/local-matching/ROIRegistry').ROIDefinition>;
  rotation: number;
  scaleX: number;
  scaleY: number;
  coordinateFormat: import('./types').CoordinateFormat;
  confidence: number;
  metadata: {
    templateId: string;
    canonicalFamily: string;
    canonicalEra: string;
    canonicalAcronyms: string[];
    ruleBoxCanonical: string;
    cacheHit: boolean;
    conversionTimeMs: number;
    canonicalizationTimeMs: number;
  };
  canonical: NormalizedCard;
}

/**
 * Family-to-Template mapping for backward compatibility
 * Maps new canonical family IDs to existing template IDs during transition period
 */
const FAMILY_TO_TEMPLATE_MAPPING: Record<string, string> = {
  // Direct mappings to existing templates
  'scarlet_violet': 'modern_standard',
  'sword_shield': 'modern_standard',
  'sun_moon': 'modern_standard',
  'bw_xy': 'modern_standard',
  
  // Neo era mapping
  'classic_wotc': 'neo_era', // Best fit for classic cards
  'e_card': 'neo_era',
  'ex_dp': 'neo_era',
  'hgss': 'neo_era',
  
  // Special layouts - fallback to modern for now
  'legend_split': 'modern_standard',
  'vmax_vstar_landscape': 'modern_standard',
  'trainer_ownership': 'base_set', // Gym-style cards use base set template
  
  // Promo mapping
  'promo': 'mcd_promo',
};

/**
 * Era-based template selection when family mapping fails
 */
const ERA_TO_TEMPLATE_FALLBACK: Record<string, string> = {
  'classic_wotc': 'base_set',
  'e_card': 'neo_era',
  'ex': 'neo_era',
  'diamond_pearl': 'neo_era',
  'hgss': 'neo_era',
  'bw': 'modern_standard',
  'xy': 'modern_standard',
  'sun_moon': 'modern_standard',
  'sword_shield': 'modern_standard',
  'scarlet_violet': 'modern_standard',
};

export class CanonicalROIBridge {
  private enhancedROIRegistry: EnhancedROIRegistry;

  constructor(dataRoot?: string) {
    this.enhancedROIRegistry = new EnhancedROIRegistry(dataRoot);
  }

  async initialize(): Promise<void> {
    await this.enhancedROIRegistry.initialize();
    logger.info('Canonical ROI Bridge initialized');
  }

  /**
   * Get ROIs using canonical naming system
   * Primary entry point that handles canonicalization and template mapping
   */
  async getCanonicalROIs(request: CanonicalROIRequest): Promise<CanonicalROIResult> {
    const startTime = performance.now();
    
    // Step 1: Canonicalize the input data
    const canonicalStart = performance.now();
    const canonical = canon.normalize(
      request.ocrExtract || {}, 
      request.features || {}
    );
    const canonicalizationTime = performance.now() - canonicalStart;

    logger.debug('Canonicalized card data:', {
      era: canonical.era,
      family: canonical.family,
      acronyms: canonical.acronyms,
      ruleBoxCanonical: canonical.ruleBoxCanonical,
      confidence: canonical.confidence,
    });

    // Step 2: Map canonical family to legacy template ID
    const templateId = this.resolveTemplateId(canonical);
    
    // Step 3: Prepare enhanced hints for ROI registry
    const enhancedHints = this.buildEnhancedHints(canonical, request.features);
    
    // Step 4: Get ROIs from enhanced registry
    const roiResult = await this.enhancedROIRegistry.getEnhancedScaledROIs(
      request.imageWidth,
      request.imageHeight,
      enhancedHints,
      request.options
    );

    const totalTime = performance.now() - startTime;

    // Step 5: Build canonical result with enhanced metadata
    const canonicalResult: CanonicalROIResult = {
      ...roiResult,
      canonical,
      metadata: {
        ...roiResult.metadata,
        templateId,
        canonicalFamily: canonical.family,
        canonicalEra: canonical.era,
        canonicalAcronyms: canonical.acronyms,
        ruleBoxCanonical: canonical.ruleBoxCanonical,
        canonicalizationTimeMs: canonicalizationTime,
        conversionTimeMs: totalTime,
      },
    };

    logger.debug('Canonical ROI result:', {
      templateId,
      family: canonical.family,
      era: canonical.era,
      confidence: canonicalResult.confidence,
      totalTimeMs: totalTime,
    });

    return canonicalResult;
  }

  /**
   * Resolve canonical family to legacy template ID
   * Handles mapping during transition period
   */
  private resolveTemplateId(canonical: NormalizedCard): string {
    // First try direct family mapping
    let templateId = FAMILY_TO_TEMPLATE_MAPPING[canonical.family];
    
    if (templateId) {
      logger.debug(`Family mapping: ${canonical.family} → ${templateId}`);
      return templateId;
    }

    // Fallback to era-based mapping
    templateId = ERA_TO_TEMPLATE_FALLBACK[canonical.era];
    
    if (templateId) {
      logger.debug(`Era fallback mapping: ${canonical.era} → ${templateId}`);
      return templateId;
    }

    // Ultimate fallback
    logger.warn(`No mapping found for family=${canonical.family}, era=${canonical.era}, using modern_standard`);
    return 'modern_standard';
  }

  /**
   * Build enhanced hints for ROI registry using canonical data
   */
  private buildEnhancedHints(canonical: NormalizedCard, originalFeatures?: CanonFeatures): any {
    const hints: any = {
      // Preserve original features for compatibility
      ...originalFeatures,
      
      // Add canonical enhancements
      era: canonical.era,
      layout_family: canonical.family,
      rule_box_canonical: canonical.ruleBoxCanonical,
      canonical_acronyms: canonical.acronyms,
      
      // Map to legacy field names for backward compatibility
      roi_template: this.resolveTemplateId(canonical),
    };

    // Add special handling for specific families
    if (canonical.family === 'legend_split') {
      hints.layout_hint = 'landscape';
      hints.special_variant = 'legend';
    }
    
    if (canonical.family === 'vmax_vstar_landscape') {
      hints.layout_hint = 'landscape';
      hints.special_variant = 'vmax_landscape';
    }
    
    if (canonical.family === 'trainer_ownership') {
      hints.layout_hint = 'gym';
      hints.special_variant = 'trainer_ownership';
    }

    // Handle rule box presence
    if (canonical.ruleBoxCanonical !== 'none') {
      hints.rulebox_present = true;
      hints.rule_box_type = canonical.ruleBoxCanonical;
    }

    // Map era to layout hints for legacy compatibility
    const eraToLayoutHint: Record<string, string> = {
      'classic_wotc': 'classic',
      'e_card': 'e_card',
      'ex': 'ex_era',
      'diamond_pearl': 'dp',
      'hgss': 'hgss',
      'bw': 'bw',
      'xy': 'xy', 
      'sun_moon': 'sm',
      'sword_shield': 'swsh',
      'scarlet_violet': 'sv',
    };

    hints.layout_hint = hints.layout_hint || eraToLayoutHint[canonical.era] || 'modern';

    logger.debug('Enhanced hints generated:', hints);
    return hints;
  }

  /**
   * Get available canonical families
   */
  getAvailableFamilies(): string[] {
    return Object.keys(FAMILY_TO_TEMPLATE_MAPPING);
  }

  /**
   * Get ROI configuration for a canonical family
   */
  getCanonicalROIConfig(
    familyId: string, 
    tier: 'critical' | 'standard' | 'detailed' | 'optional' = 'critical'
  ): string[] {
    return canon.getROIConfig(familyId, tier);
  }

  /**
   * Validate canonical ROI request
   */
  validateCanonicalRequest(request: CanonicalROIRequest): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!request.imageWidth || request.imageWidth <= 0) {
      errors.push('Invalid imageWidth: must be positive number');
    }

    if (!request.imageHeight || request.imageHeight <= 0) {
      errors.push('Invalid imageHeight: must be positive number');
    }

    if (request.ocrExtract) {
      const canonValidation = canon.validate(request.ocrExtract);
      if (!canonValidation.valid) {
        errors.push(...canonValidation.errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get mapping diagnostics for debugging
   */
  getMappingDiagnostics(): {
    familyMappings: Record<string, string>;
    eraFallbacks: Record<string, string>;
    availableFamilies: string[];
    canonVersion: string;
  } {
    return {
      familyMappings: FAMILY_TO_TEMPLATE_MAPPING,
      eraFallbacks: ERA_TO_TEMPLATE_FALLBACK,
      availableFamilies: this.getAvailableFamilies(),
      canonVersion: '2025-09-02',
    };
  }
}

// Export singleton for convenience
export const canonicalROIBridge = new CanonicalROIBridge();
export default canonicalROIBridge;