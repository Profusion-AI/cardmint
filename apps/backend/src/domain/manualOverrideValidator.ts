/**
 * Manual Override Validator
 *
 * Validates staged overrides from the operator workbench Manual tab.
 * Two-tier validation:
 * 1. Schema validation (hard block): format, types, ranges
 * 2. Business validation (warnings only): suspicious patterns, HP mismatches
 */

export interface StagedOverrides {
  card_name?: string;
  set_name?: string;
  set_number?: string;
  hp_value?: number;
  variant_hint?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: keyof StagedOverrides;
  code: string;
  message: string;
}

export interface ValidationWarning {
  field: keyof StagedOverrides;
  code: string;
  message: string;
}

// Schema constraints (matches frontend exactly)
const SET_NUMBER_REGEX = /^\d{1,3}(\/\d{1,3})?$/;
const VARIANT_HINT_VALUES = [
  "NONE",
  "HOLO",
  "REVERSE_HOLO",
  "FULL_ART",
  "PROMO",
  "FIRST_EDITION",
  "SHADOWLESS",
];

/**
 * Validate staged overrides (schema + business checks)
 *
 * @param overrides - The staged overrides to validate
 * @param extractedFields - Original extracted fields for comparison (optional, for business checks)
 * @returns ValidationResult with errors (blocking) and warnings (non-blocking)
 */
export function validateStagedOverrides(
  overrides: StagedOverrides,
  extractedFields?: { card_name?: string; set_number?: string; hp_value?: number | null }
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Schema validation (hard blocks)

  // Card name: 3-80 chars
  if (overrides.card_name !== undefined) {
    const trimmed = overrides.card_name.trim();
    if (trimmed.length < 3) {
      errors.push({
        field: "card_name",
        code: "TOO_SHORT",
        message: "Card name must be at least 3 characters",
      });
    } else if (trimmed.length > 80) {
      errors.push({
        field: "card_name",
        code: "TOO_LONG",
        message: "Card name must be at most 80 characters",
      });
    }
  }

  // Set name: 3-80 chars
  if (overrides.set_name !== undefined) {
    const trimmed = overrides.set_name.trim();
    if (trimmed.length < 3) {
      errors.push({
        field: "set_name",
        code: "TOO_SHORT",
        message: "Set name must be at least 3 characters",
      });
    } else if (trimmed.length > 80) {
      errors.push({
        field: "set_name",
        code: "TOO_LONG",
        message: "Set name must be at most 80 characters",
      });
    }
  }

  // Set number: regex pattern
  if (overrides.set_number !== undefined) {
    const trimmed = overrides.set_number.trim();
    if (trimmed.length > 0 && !SET_NUMBER_REGEX.test(trimmed)) {
      errors.push({
        field: "set_number",
        code: "INVALID_FORMAT",
        message: "Set number must be in format: 123 or 123/456",
      });
    }
  }

  // HP value: 0-400, integer
  if (overrides.hp_value !== undefined) {
    if (!Number.isInteger(overrides.hp_value)) {
      errors.push({
        field: "hp_value",
        code: "NOT_INTEGER",
        message: "HP value must be an integer",
      });
    } else if (overrides.hp_value < 0 || overrides.hp_value > 400) {
      errors.push({
        field: "hp_value",
        code: "OUT_OF_RANGE",
        message: "HP value must be between 0 and 400",
      });
    }
  }

  // Variant hint: enum
  if (overrides.variant_hint !== undefined) {
    if (!VARIANT_HINT_VALUES.includes(overrides.variant_hint)) {
      errors.push({
        field: "variant_hint",
        code: "INVALID_ENUM",
        message: "Invalid variant hint value",
      });
    }
  }

  // Business validation (warnings only)
  if (extractedFields) {
    // Warn if HP value changed significantly (>50% difference)
    if (
      overrides.hp_value !== undefined &&
      extractedFields.hp_value !== null &&
      extractedFields.hp_value !== undefined
    ) {
      const originalHp = extractedFields.hp_value;
      const newHp = overrides.hp_value;
      const diff = Math.abs(newHp - originalHp);
      const percentChange = originalHp > 0 ? (diff / originalHp) * 100 : 0;

      if (percentChange > 50) {
        warnings.push({
          field: "hp_value",
          code: "LARGE_HP_CHANGE",
          message: `HP changed significantly: ${originalHp} → ${newHp} (${percentChange.toFixed(0)}% change)`,
        });
      }
    }

    // Warn if card name changed substantially (>50% character difference)
    if (overrides.card_name !== undefined && extractedFields.card_name) {
      const originalName = extractedFields.card_name.trim().toLowerCase();
      const newName = overrides.card_name.trim().toLowerCase();

      // Simple character difference heuristic
      const maxLen = Math.max(originalName.length, newName.length);
      const commonChars = [...originalName].filter((char) => newName.includes(char)).length;
      const similarity = maxLen > 0 ? (commonChars / maxLen) * 100 : 0;

      if (similarity < 50) {
        warnings.push({
          field: "card_name",
          code: "LARGE_NAME_CHANGE",
          message: `Card name changed substantially: "${extractedFields.card_name}" → "${overrides.card_name}"`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Normalize staged overrides (trim strings, handle empty values)
 */
export function normalizeStagedOverrides(overrides: StagedOverrides): StagedOverrides {
  const normalized: StagedOverrides = {};

  if (overrides.card_name !== undefined) {
    const trimmed = overrides.card_name.trim();
    if (trimmed.length > 0) {
      normalized.card_name = trimmed;
    }
  }

  if (overrides.set_name !== undefined) {
    const trimmed = overrides.set_name.trim();
    if (trimmed.length > 0) {
      normalized.set_name = trimmed;
    }
  }

  if (overrides.set_number !== undefined) {
    const trimmed = overrides.set_number.trim();
    if (trimmed.length > 0) {
      normalized.set_number = trimmed;
    }
  }

  if (overrides.hp_value !== undefined) {
    normalized.hp_value = overrides.hp_value;
  }

  if (overrides.variant_hint !== undefined && overrides.variant_hint !== "NONE") {
    normalized.variant_hint = overrides.variant_hint;
  }

  return normalized;
}
