/**
 * Canon Validation Utilities
 * 
 * Zod-powered validation utilities that enhance the existing canon system
 * with strict type checking and comprehensive validation.
 */

import {
  PokemonCanon,
  validatePokemonCanon,
  LanguageCode,
  LayoutVariant,
  EraId,
  LayoutFamilyId,
  LANGUAGE_CODES,
  LAYOUT_VARIANTS,
  LAYOUT_FAMILY_IDS,
} from './pokemonCanon.schema';
import {
  TypedOCRExtract,
  TypedNormalizedCard,
  TypedCanonFeatures,
  CanonValidationResult,
  ValidationOptions,
  isValidLanguageCode,
  isValidLayoutVariant,
  isValidEraId,
  isValidLayoutFamilyId,
} from './canon.types';

/** Load and validate canon configuration with enhanced error reporting */
export function loadAndValidateCanon(json: unknown): {
  canon: PokemonCanon;
  validation: CanonValidationResult;
} {
  const validation: CanonValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    suggestions: [],
  };

  try {
    const canon = validatePokemonCanon(json);
    validation.valid = true;
    validation.suggestions?.push('Canon configuration loaded successfully with full type safety');
    return { canon, validation };
  } catch (error) {
    if (error instanceof Error) {
      validation.errors.push(`Canon validation failed: ${error.message}`);
    } else {
      validation.errors.push('Unknown canon validation error');
    }
    // Return a minimal canon for error recovery (cast to any to bypass strict typing)
    const fallbackCanon = {
      version: '0.0.0-error',
      namespace: 'cardmint.pkm',
      conventions: {
        jsonKeyCase: 'lowerCamelCase' as const,
        enumCase: 'SCREAMING_SNAKE_CASE' as const,
        idFormat: 'kebab-case' as const,
        roiIdFormat: 'familyId:roiName' as const,
        languageCodes: ['EN', 'JP'] as LanguageCode[],
        layoutVariants: ['standard', 'full_art', 'landscape'] as LayoutVariant[],
        roiTiers: ['CRITICAL', 'STANDARD', 'DETAILED', 'OPTIONAL'] as const,
        roiRoles: ['text', 'symbol'] as const,
      },
      acronymCanon: {},
      eras: [],
      layoutFamilies: [],
      rarityMarkers: [],
      ruleBoxCanon: [],
      numberFormats: [],
      namePatterns: [],
      priceChartingMap: {
        ungradedPriceField: 'loose_price',
        psa9PriceField: 'condition_17_price',
        psa10PriceField: 'condition_18_price',
        idFields: ['card_name'] as const,
        normalizationRules: {},
      },
      ocrExtractSchema: {
        required: ['set_name', 'card_number', 'card_name', 'language'] as const,
      },
      synonyms: {
        set: {},
        rarity: {},
        language: {},
      },
      roiIdNaming: {
        examples: [],
        rules: [],
      },
      // Provide minimal family defaults for all required families
      familyDefaults: Object.fromEntries(
        LAYOUT_FAMILY_IDS.map(id => [id, { critical: [], standard: [], detailed: [], optional: [] }])
      ),
      acceptancePolicies: {
        newTemplate: {
          requires: ['testCoverage'],
          maxRois: 40,
        },
        newROI: {
          requires: ['ablationProof'],
          autoDowngrade: 'never',
        },
      },
      examples: {},
    } as unknown as PokemonCanon;
    
    return { canon: fallbackCanon, validation };
  }
}

/** Validate OCR extract with comprehensive type checking */
export function validateOCRExtract(
  input: any,
  _options: ValidationOptions = {}
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  typedExtract?: Partial<TypedOCRExtract>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const typedExtract: Partial<TypedOCRExtract> = {};

  // Required fields validation
  const requiredFields = ['set_name', 'card_number', 'card_name', 'language'];
  for (const field of requiredFields) {
    if (!input[field]) {
      errors.push(`Missing required field: ${field}`);
    } else if (typeof input[field] !== 'string') {
      errors.push(`Field ${field} must be a string, got ${typeof input[field]}`);
    } else {
      (typedExtract as any)[field] = input[field];
    }
  }

  // Language validation
  if (input.language) {
    if (!isValidLanguageCode(input.language)) {
      errors.push(`Invalid language code: ${input.language}. Valid options: ${LANGUAGE_CODES.join(', ')}`);
    } else {
      typedExtract.language = input.language;
    }
  }

  // Layout variant validation
  if (input.layout_variant) {
    if (!isValidLayoutVariant(input.layout_variant)) {
      warnings.push(`Unknown layout variant: ${input.layout_variant}. Valid options: ${LAYOUT_VARIANTS.join(', ')}`);
    } else {
      typedExtract.layout_variant = input.layout_variant;
    }
  }

  // Boolean fields validation
  if (input.rulebox_present !== undefined) {
    if (typeof input.rulebox_present !== 'boolean') {
      errors.push(`Field rulebox_present must be boolean, got ${typeof input.rulebox_present}`);
    } else {
      typedExtract.rulebox_present = input.rulebox_present;
    }
  }

  // Card number format validation
  if (input.card_number && typeof input.card_number === 'string') {
    const cardNumberPatterns = [
      /^\d{1,3}\/\d{1,3}$/, // Basic fraction
      /^(TG|GG)\d{1,3}\/(TG|GG)\d{1,3}$/, // Trainer Gallery
      /^((SR|UR|HR|CSR|CHR|AR|SAR)?\d{1,3}\/\d{1,3})$/, // Japanese special
    ];
    
    const isValidFormat = cardNumberPatterns.some(pattern => pattern.test(input.card_number));
    if (!isValidFormat) {
      warnings.push(`Card number format may be invalid: ${input.card_number}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    typedExtract: errors.length === 0 ? typedExtract as TypedOCRExtract : typedExtract,
  };
}

/** Validate normalized card result */
export function validateNormalizedCard(
  result: any,
  _options: ValidationOptions = {}
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  typedCard?: TypedNormalizedCard;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Era validation
  if (!result.era) {
    errors.push('Missing era field');
  } else if (!isValidEraId(result.era)) {
    errors.push(`Invalid era: ${result.era}`);
  }

  // Family validation
  if (!result.family) {
    errors.push('Missing family field');
  } else if (!isValidLayoutFamilyId(result.family)) {
    errors.push(`Invalid layout family: ${result.family}`);
  }

  // Language validation
  if (!result.language) {
    errors.push('Missing language field');
  } else if (!isValidLanguageCode(result.language)) {
    errors.push(`Invalid language: ${result.language}`);
  }

  // Layout variant validation
  if (result.layout_variant && !isValidLayoutVariant(result.layout_variant)) {
    warnings.push(`Unknown layout variant: ${result.layout_variant}`);
  }

  // Confidence validation
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
    warnings.push(`Invalid confidence value: ${result.confidence} (should be 0-1)`);
  }

  // Acronyms validation
  if (!Array.isArray(result.acronyms)) {
    warnings.push('Acronyms field should be an array');
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    warnings,
    typedCard: valid ? result as TypedNormalizedCard : undefined,
  };
}

/** Enhanced canon features validation */
export function validateCanonFeatures(
  features: any,
  _options: ValidationOptions = {}
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  typedFeatures?: TypedCanonFeatures;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const typedFeatures: Partial<TypedCanonFeatures> = { ...features };

  // Era validation
  if (features.era && !isValidEraId(features.era)) {
    warnings.push(`Unknown era hint: ${features.era}`);
  }

  // Layout hint validation
  if (features.layout_hint && !isValidLayoutVariant(features.layout_hint)) {
    warnings.push(`Unknown layout hint: ${features.layout_hint}`);
  }

  // Layout variant validation
  if (features.layout_variant && !isValidLayoutVariant(features.layout_variant)) {
    warnings.push(`Unknown layout variant: ${features.layout_variant}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    typedFeatures: typedFeatures as TypedCanonFeatures,
  };
}

/** Validate ROI ID format */
export function validateROIId(roiId: string): {
  valid: boolean;
  familyId?: LayoutFamilyId;
  roiName?: string;
  error?: string;
} {
  const roiIdPattern = /^([a-z0-9_]+):([a-z0-9_-]+)$/;
  const match = roiId.match(roiIdPattern);
  
  if (!match) {
    return {
      valid: false,
      error: `Invalid ROI ID format: ${roiId}. Expected format: 'familyId:roiName'`,
    };
  }

  const [, familyId, roiName] = match;
  
  if (!isValidLayoutFamilyId(familyId)) {
    return {
      valid: false,
      familyId: familyId as LayoutFamilyId,
      roiName,
      error: `Unknown layout family in ROI ID: ${familyId}`,
    };
  }

  return {
    valid: true,
    familyId: familyId as LayoutFamilyId,
    roiName,
  };
}

/** Migration validation helper */
export function validateCanonMigration(
  oldConfig: any,
  newConfig: PokemonCanon
): CanonValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Version check
  if (oldConfig.version && newConfig.version <= oldConfig.version) {
    warnings.push(`New version (${newConfig.version}) is not newer than old version (${oldConfig.version})`);
  }

  // Namespace preservation
  if (oldConfig.namespace && oldConfig.namespace !== newConfig.namespace) {
    warnings.push(`Namespace changed from ${oldConfig.namespace} to ${newConfig.namespace}`);
  }

  // Era compatibility
  if (oldConfig.eras) {
    const oldEras = new Set(oldConfig.eras.map((e: any) => e.id as string));
    const newEras = new Set(newConfig.eras.map(e => e.id));
    
    for (const oldEra of oldEras) {
      if (!newEras.has(oldEra as EraId)) {
        errors.push(`Era removed in migration: ${oldEra}`);
      }
    }
  }

  // Family compatibility
  if (oldConfig.layoutFamilies) {
    const oldFamilies = new Set(oldConfig.layoutFamilies.map((f: any) => f.id as string));
    const newFamilies = new Set(newConfig.layoutFamilies.map(f => f.id));
    
    for (const oldFamily of oldFamilies) {
      if (!newFamilies.has(oldFamily as LayoutFamilyId)) {
        errors.push(`Layout family removed in migration: ${oldFamily}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    suggestions,
  };
}