/**
 * Canonical Pokemon Card Naming System
 * 
 * Single source-of-truth for Pokemon card naming standardization.
 * Prevents logic from falling through cracks by providing unified
 * canonicalization for acronyms, eras, layout families, and more.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';
// Enhanced validation support (optional Zod integration)
import { 
  validateOCRExtract, 
  validateNormalizedCard,
  loadAndValidateCanon 
} from '../canon/canon.validation';
import type { CanonValidationResult } from '../canon/canon.types';

const logger = createLogger('Canon');

export interface PokemonNamingCanon {
  version: string;
  namespace: string;
  conventions: {
    jsonKeyCase: string;
    enumCase: string;
    idFormat: string;
    roiIdFormat: string;
    languageCodes: string[];
    layoutVariants: string[];
    roiTiers: string[];
    roiRoles: string[];
  };
  acronymCanon: Record<string, {
    display: string;
    canonical: string;
    description: string;
    ruleBox: boolean;
    synonyms: string[];
  }>;
  eras: Array<{
    id: string;
    code: string;
    displayName: string;
    years: string;
    familyDefault: string;
    synonyms: string[];
    commonMarkers: string[];
  }>;
  layoutFamilies: Array<{
    id: string;
    displayName: string;
    eraHints: string[];
    defaultCoreRois: string[];
    conditionalRois: string[];
    typicalVariants: string[];
  }>;
  rarityMarkers: Array<{
    id: string;
    displayName: string;
    synonyms: string[];
    detectionCues: string[];
    impacts: {
      layoutVariants: string[];
      families: string[];
    };
  }>;
  ruleBoxCanon: Array<{
    id: string;
    display: string;
    ruleBox: boolean;
    appliesToEras: string[];
  }>;
  numberFormats: Array<{
    id: string;
    pattern: string;
    normalize: string;
    examples: string[];
    isSecretRule?: string;
  }>;
  namePatterns: Array<{
    id: string;
    pattern: string;
    normalize: string;
    notes: string;
  }>;
  synonyms: {
    set: Record<string, string>;
    rarity: Record<string, string>;
    language: Record<string, string>;
  };
  familyDefaults: Record<string, {
    critical: string[];
    standard: string[];
    detailed: string[];
    optional: string[];
  }>;
  priceChartingMap: {
    ungradedPriceField: string;
    psa9PriceField: string;
    psa10PriceField: string;
    bgs10PriceField?: string;
    volumeField?: string;
    idFields: string[];
    normalizationRules: Record<string, string[]>;
  };
}

export interface OCRExtract {
  set_name?: string;
  card_number?: string;
  card_name?: string;
  language?: string;
  rarity_hint?: string;
  rulebox_present?: boolean;
  layout_variant?: string;
}

export interface NormalizedCard {
  era: string;
  family: string;
  acronyms: string[];
  card_name: string;
  card_number: string;
  set_name: string;
  language: string;
  ruleBoxCanonical: string;
  confidence: number;
}

export interface CanonFeatures {
  era?: string;
  layout_hint?: string;
  roi_template?: string;
  rarity_hints?: string[];
  rulebox_present?: boolean;
  set_name?: string;
  [key: string]: any;
}

export class PokemonCanon {
  private config: PokemonNamingCanon;
  private acronymLookup: Map<string, any> = new Map();
  private eraLookup: Map<string, any> = new Map();
  private familyLookup: Map<string, any> = new Map();
  private zodValidationEnabled = true;
  private validationResult?: CanonValidationResult;

  constructor(configPath?: string, options: { enableZodValidation?: boolean } = {}) {
    const defaultPath = path.join(__dirname, '../../config/naming/pokemon.json');
    const finalPath = configPath || defaultPath;
    this.zodValidationEnabled = options.enableZodValidation ?? true;
    
    try {
      const configData = fs.readFileSync(finalPath, 'utf-8');
      const parsedConfig = JSON.parse(configData);
      
      // Enhanced validation with Zod if enabled
      if (this.zodValidationEnabled) {
        try {
          const { canon: validatedCanon, validation } = loadAndValidateCanon(parsedConfig);
          this.config = validatedCanon as any; // Bridge between types
          this.validationResult = validation;
          
          if (validation.valid) {
            logger.info(`Loaded Pokemon naming canon v${this.config.version} with Zod validation ✓`);
          } else {
            logger.warn(`Canon loaded with validation warnings:`, validation.warnings);
            logger.error(`Canon validation errors:`, validation.errors);
          }
        } catch (zodError) {
          logger.warn(`Zod validation failed, falling back to basic parsing:`, zodError);
          this.config = parsedConfig;
          this.zodValidationEnabled = false;
        }
      } else {
        this.config = parsedConfig;
        logger.info(`Loaded Pokemon naming canon v${this.config.version} (basic validation)`);
      }
      
      this.buildLookupMaps();
    } catch (error) {
      logger.error(`Failed to load naming canon from ${finalPath}:`, error);
      throw new Error(`Pokemon naming canon initialization failed: ${error}`);
    }
  }

  private buildLookupMaps(): void {
    // Build acronym synonym lookup
    for (const [canonical, data] of Object.entries(this.config.acronymCanon)) {
      this.acronymLookup.set(canonical, data);
      this.acronymLookup.set(data.display.toLowerCase(), data);
      
      for (const synonym of data.synonyms) {
        this.acronymLookup.set(synonym.toLowerCase(), data);
      }
    }

    // Build era synonym lookup
    for (const era of this.config.eras) {
      this.eraLookup.set(era.id, era);
      this.eraLookup.set(era.code.toLowerCase(), era);
      this.eraLookup.set(era.displayName.toLowerCase(), era);
      
      for (const synonym of era.synonyms) {
        this.eraLookup.set(synonym.toLowerCase(), era);
      }
    }

    // Build family lookup
    for (const family of this.config.layoutFamilies) {
      this.familyLookup.set(family.id, family);
      this.familyLookup.set(family.displayName.toLowerCase(), family);
    }
  }

  /**
   * Canonicalize an acronym (e.g., "EX", "ex", "GX") to its canonical form
   */
  acronym(input: string): string {
    const normalized = input.toLowerCase().trim();
    const match = this.acronymLookup.get(normalized);
    
    if (match) {
      return match.canonical;
    }
    
    logger.warn(`Unknown acronym: ${input}`);
    return input.toUpperCase(); // Fallback to uppercase
  }

  /**
   * Determine the era from set name or features
   */
  era(input: string | CanonFeatures): string {
    let searchTerm: string;
    
    if (typeof input === 'string') {
      searchTerm = input.toLowerCase();
    } else {
      // Use set_name from features if available
      searchTerm = (input.set_name || input.layout_hint || '').toLowerCase();
    }

    const match = this.eraLookup.get(searchTerm);
    if (match) {
      return match.id;
    }

    // Try partial matching for set names
    for (const era of this.config.eras) {
      for (const synonym of era.synonyms) {
        if (searchTerm.includes(synonym.toLowerCase())) {
          return era.id;
        }
      }
    }

    logger.warn(`Unknown era for: ${searchTerm}`);
    return 'scarlet_violet'; // Default to most recent era
  }

  /**
   * Determine layout family from features
   */
  family(features: CanonFeatures): string {
    const detectedEra = this.era(features);
    const eraData = this.eraLookup.get(detectedEra);
    
    if (eraData?.familyDefault) {
      return eraData.familyDefault;
    }

    // Check for special layout markers
    if (features.rarity_hints?.includes('LEGEND')) {
      return 'legend_split';
    }
    
    if (features.rarity_hints?.includes('VMAX') || features.rarity_hints?.includes('VSTAR')) {
      if (features.layout_hint === 'landscape') {
        return 'vmax_vstar_landscape';
      }
    }

    if (features.rarity_hints?.includes('TRAINER_OWNERSHIP')) {
      return 'trainer_ownership';
    }

    logger.warn(`Using era default family for features:`, features);
    return eraData?.familyDefault || 'scarlet_violet';
  }

  /**
   * Normalize card number format
   */
  number(input: string): string {
    const trimmed = input.trim();
    
    for (const format of this.config.numberFormats) {
      const regex = new RegExp(format.pattern);
      const match = trimmed.match(regex);
      
      if (match && match.groups) {
        // Handle secret rare detection
        if (format.isSecretRule) {
          const { num, den } = match.groups;
          if (parseInt(num) > parseInt(den)) {
            logger.info(`Secret rare detected: ${trimmed}`);
          }
        }
        
        // Apply normalization template
        let normalized = format.normalize;
        for (const [key, value] of Object.entries(match.groups)) {
          normalized = normalized.replace(`{${key}}`, value);
        }
        
        return normalized;
      }
    }
    
    logger.warn(`Unknown number format: ${input}`);
    return trimmed;
  }

  /**
   * Normalize card name
   */
  name(input: string): string {
    const trimmed = input.trim();
    
    for (const pattern of this.config.namePatterns) {
      const regex = new RegExp(pattern.pattern);
      const match = trimmed.match(regex);
      
      if (match && match.groups) {
        let normalized = pattern.normalize;
        for (const [key, value] of Object.entries(match.groups)) {
          normalized = normalized.replace(`{${key}}`, value.trim());
        }
        
        return normalized;
      }
    }
    
    // Clean up multiple spaces
    return trimmed.replace(/\s+/g, ' ');
  }

  /**
   * Map to PriceCharting field names
   */
  priceCharting(record: Record<string, any>): Record<string, any> {
    const mapping = this.config.priceChartingMap;
    const mapped: Record<string, any> = {};
    
    // Apply field mappings
    const fieldMappings: Record<string, string> = {
      ungraded_price: mapping.ungradedPriceField,
      psa9_price: mapping.psa9PriceField,
      psa10_price: mapping.psa10PriceField,
    };
    
    // Add optional fields if they exist
    if (mapping.bgs10PriceField) {
      fieldMappings.bgs10_price = mapping.bgs10PriceField;
    }
    if (mapping.volumeField) {
      fieldMappings.volume = mapping.volumeField;
    }
    
    for (const [sourceField, targetField] of Object.entries(fieldMappings)) {
      if (record[sourceField] !== undefined) {
        mapped[targetField] = record[sourceField];
      }
    }
    
    // Apply normalization rules
    for (const field of mapping.idFields) {
      if (record[field]) {
        mapped[field] = this.applyNormalizationRules(
          record[field],
          mapping.normalizationRules[field] || []
        );
      }
    }
    
    return mapped;
  }

  private applyNormalizationRules(value: string, rules: string[]): string {
    let result = value;
    
    for (const rule of rules) {
      switch (rule) {
        case 'applyNamePatterns':
          result = this.name(result);
          break;
        case 'stripMultipleSpaces':
          result = result.replace(/\s+/g, ' ').trim();
          break;
        case 'canonSetName':
          result = this.config.synonyms.set[result] || result;
          break;
        case 'matchNumberFormats':
          result = this.number(result);
          break;
        case 'EN_or_JP':
          result = this.config.synonyms.language[result] || result;
          break;
      }
    }
    
    return result;
  }

  /**
   * Full normalization of OCR extract to canonical form
   */
  normalize(ocrExtract: OCRExtract, features?: CanonFeatures): NormalizedCard {
    const combinedFeatures = { ...features, ...ocrExtract };
    
    const detectedEra = this.era(combinedFeatures);
    const detectedFamily = this.family(combinedFeatures);
    
    // Extract acronyms from card name
    const acronyms: string[] = [];
    if (ocrExtract.card_name) {
      // Simple acronym extraction (can be enhanced)
      const words = ocrExtract.card_name.split(/\s+/);
      for (const word of words) {
        if (this.acronymLookup.has(word.toLowerCase())) {
          acronyms.push(this.acronym(word));
        }
      }
    }
    
    // Determine rule box canonical
    let ruleBoxCanonical = 'none';
    for (const rule of this.config.ruleBoxCanon) {
      if (rule.appliesToEras.includes(detectedEra)) {
        if (acronyms.some(acr => rule.id.includes(acr))) {
          ruleBoxCanonical = rule.id;
          break;
        }
      }
    }
    
    return {
      era: detectedEra,
      family: detectedFamily,
      acronyms,
      card_name: this.name(ocrExtract.card_name || ''),
      card_number: this.number(ocrExtract.card_number || ''),
      set_name: this.config.synonyms.set[ocrExtract.set_name || ''] || ocrExtract.set_name || '',
      language: this.config.synonyms.language[ocrExtract.language || ''] || ocrExtract.language || 'EN',
      ruleBoxCanonical,
      confidence: this.calculateConfidence(ocrExtract, combinedFeatures),
    };
  }

  private calculateConfidence(ocrExtract: OCRExtract, features: CanonFeatures): number {
    let confidence = 0.5; // Base confidence
    
    // Required fields boost confidence
    if (ocrExtract.set_name) confidence += 0.2;
    if (ocrExtract.card_number) confidence += 0.2;
    if (ocrExtract.card_name) confidence += 0.2;
    
    // Era detection confidence
    if (this.eraLookup.has((ocrExtract.set_name || '').toLowerCase())) {
      confidence += 0.1;
    }
    
    // Features boost confidence
    if (features.era && this.eraLookup.has(features.era)) {
      confidence += 0.05;
    }
    if (features.roi_template) {
      confidence += 0.05;
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Get ROI configuration for a layout family
   */
  getROIConfig(familyId: string, tier: 'critical' | 'standard' | 'detailed' | 'optional' = 'critical'): string[] {
    const familyConfig = this.config.familyDefaults[familyId];
    
    if (!familyConfig) {
      logger.warn(`No ROI config for family: ${familyId}`);
      return [];
    }
    
    return familyConfig[tier] || [];
  }

  /**
   * Validate that input conforms to canonical naming conventions
   */
  validate(input: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Validate language codes
    if (input.language && !this.config.conventions.languageCodes.includes(input.language)) {
      errors.push(`Invalid language code: ${input.language}`);
    }
    
    // Validate layout variants
    if (input.layout_variant && !this.config.conventions.layoutVariants.includes(input.layout_variant)) {
      errors.push(`Invalid layout variant: ${input.layout_variant}`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Enhanced OCR validation with Zod schema (if enabled)
   */
  validateOCRExtract(input: any): { 
    valid: boolean; 
    errors: string[]; 
    warnings?: string[]; 
    suggestions?: string[] 
  } {
    if (this.zodValidationEnabled) {
      try {
        const validation = validateOCRExtract(input);
        return {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
          suggestions: validation.warnings?.length 
            ? ['Consider addressing warnings for better accuracy']
            : ['OCR extract validation passed']
        };
      } catch (error) {
        logger.warn('Zod OCR validation failed, falling back to basic validation:', error);
      }
    }
    
    // Fallback to basic validation
    return this.validate(input);
  }

  /**
   * Enhanced normalization with validation
   */
  normalizeWithValidation(ocrExtract: OCRExtract, features?: CanonFeatures): {
    result: NormalizedCard;
    validation: { valid: boolean; errors: string[]; warnings?: string[] };
  } {
    // Perform normalization
    const result = this.normalize(ocrExtract, features);
    
    // Enhanced validation if Zod is enabled
    if (this.zodValidationEnabled) {
      try {
        const validation = validateNormalizedCard(result);
        return {
          result,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
          }
        };
      } catch (error) {
        logger.warn('Zod normalization validation failed:', error);
      }
    }
    
    // Basic validation fallback
    return {
      result,
      validation: { valid: true, errors: [] }
    };
  }

  /**
   * Get validation diagnostics
   */
  getValidationDiagnostics(): {
    zodEnabled: boolean;
    configVersion: string;
    validationResult?: CanonValidationResult;
  } {
    return {
      zodEnabled: this.zodValidationEnabled,
      configVersion: this.config.version,
      validationResult: this.validationResult,
    };
  }

  /**
   * Force re-validation of current configuration
   */
  revalidateConfiguration(): CanonValidationResult {
    if (!this.zodValidationEnabled) {
      return {
        valid: true,
        errors: [],
        warnings: ['Zod validation is disabled'],
        suggestions: ['Enable Zod validation for enhanced type safety']
      };
    }

    try {
      const { validation } = loadAndValidateCanon(this.config);
      this.validationResult = validation;
      return validation;
    } catch (error) {
      const errorResult: CanonValidationResult = {
        valid: false,
        errors: [`Re-validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings: [],
        suggestions: ['Check configuration file for errors']
      };
      this.validationResult = errorResult;
      return errorResult;
    }
  }
}

// Export singleton instance
export const canon = new PokemonCanon();
export default canon;