/**
 * Canon Type Definitions
 * 
 * Type-safe definitions that bridge between the Zod schema system
 * and our existing canon implementation for enhanced type safety.
 */

import {
  LanguageCode,
  LayoutVariant,
  EraId,
  LayoutFamilyId,
  AcronymCanonical,
  RoiTier,
} from './pokemonCanon.schema';

/** Enhanced OCR Extract with strict typing */
export interface TypedOCRExtract {
  set_name: string;
  card_number: string;
  card_name: string;
  language: LanguageCode;
  rarity_hint?: string;
  rulebox_present?: boolean;
  layout_variant?: LayoutVariant;
}

/** Enhanced Normalized Card with strict typing */
export interface TypedNormalizedCard {
  era: EraId;
  family: LayoutFamilyId;
  acronyms: AcronymCanonical[];
  card_name: string;
  card_number: string;
  set_name: string;
  language: LanguageCode;
  layout_variant: LayoutVariant;
  ruleBoxCanonical: string;
  confidence: number;
}

/** Enhanced Canon Features with strict typing */
export interface TypedCanonFeatures {
  era?: EraId;
  layout_hint?: LayoutVariant;
  roi_template?: string;
  rarity_hints?: string[];
  rulebox_present?: boolean;
  set_name?: string;
  layout_variant?: LayoutVariant;
  [key: string]: any;
}

/** ROI Configuration Request */
export interface ROIConfigRequest {
  familyId: LayoutFamilyId;
  tier?: RoiTier;
}

/** Canon Validation Result */
export interface CanonValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  suggestions?: string[];
}

/** Type guards for runtime validation */
export function isValidLanguageCode(code: string): code is LanguageCode {
  return code === 'EN' || code === 'JP';
}

export function isValidLayoutVariant(variant: string): variant is LayoutVariant {
  return variant === 'standard' || variant === 'full_art' || variant === 'landscape';
}

export function isValidEraId(era: string): era is EraId {
  const validEras: readonly string[] = [
    'classic_wotc', 'e_card', 'ex', 'diamond_pearl', 'hgss',
    'bw', 'xy', 'sun_moon', 'sword_shield', 'scarlet_violet'
  ];
  return validEras.includes(era);
}

export function isValidLayoutFamilyId(family: string): family is LayoutFamilyId {
  const validFamilies: readonly string[] = [
    'classic_wotc', 'e_card', 'ex_dp', 'hgss', 'bw_xy',
    'sun_moon', 'sword_shield', 'scarlet_violet', 'legend_split',
    'vmax_vstar_landscape', 'trainer_ownership'
  ];
  return validFamilies.includes(family);
}

/** Utility type for canon method signatures */
export type CanonMethod<T, R> = (input: T) => R;
export type CanonAsyncMethod<T, R> = (input: T) => Promise<R>;

/** Configuration validation options */
export interface ValidationOptions {
  strictMode?: boolean;
  allowUnknownFields?: boolean;
  requireAllFields?: boolean;
  validateSemantics?: boolean;
}