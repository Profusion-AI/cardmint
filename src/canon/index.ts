/**
 * Canon System Index
 * 
 * Centralized exports for the enhanced canonical naming system.
 * Provides both legacy compatibility and new type-safe interfaces.
 */

// Re-export everything from existing canon for backward compatibility
export * from '../lib/canon';

// Enhanced Zod-based validation system
export * from './pokemonCanon.schema';
export * from './canon.types';
export * from './canon.validation';

// Convenience re-exports for common types
export type {
  PokemonCanon,
  LanguageCode,
  LayoutVariant,
  EraId,
  LayoutFamilyId,
  AcronymCanonical,
  RoiTier,
} from './pokemonCanon.schema';

export type {
  TypedOCRExtract,
  TypedNormalizedCard,
  TypedCanonFeatures,
  CanonValidationResult,
  ValidationOptions,
} from './canon.types';

// Enhanced utilities
export {
  loadAndValidateCanon,
  validateOCRExtract,
  validateNormalizedCard,
  validateCanonFeatures,
  validateROIId,
} from './canon.validation';

/**
 * Factory function to create canon instance with enhanced validation
 */
export function createEnhancedCanon(configPath?: string, enableZodValidation = true) {
  // Import here to avoid circular dependencies
  const { PokemonCanon } = require('../lib/canon');
  return new PokemonCanon(configPath, { enableZodValidation });
}

/**
 * Type-safe canon singleton with Zod validation enabled
 */
export const enhancedCanon = createEnhancedCanon();

/**
 * Migration utilities
 */
export { validateCanonMigration } from './canon.validation';

/**
 * Version information
 */
export const CANON_SYSTEM_VERSION = '2.0.0-zod-enhanced';
export const SCHEMA_VERSION = '2025-09-02';