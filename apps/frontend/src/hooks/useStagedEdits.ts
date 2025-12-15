import { useEffect, useState, useRef } from "react";

export interface StagedOverrides {
  card_name?: string;
  set_number?: string;
  hp_value?: number;
  variant_hint?: string;
}

interface ValidationErrors {
  card_name?: string;
  set_number?: string;
  hp_value?: string;
  variant_hint?: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationErrors;
}

// Validation schema (matches backend)
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

function validateStagedOverrides(overrides: StagedOverrides): ValidationResult {
  const errors: ValidationErrors = {};

  // Card name: 3-80 chars
  if (overrides.card_name !== undefined) {
    const trimmed = overrides.card_name.trim();
    if (trimmed.length < 3 || trimmed.length > 80) {
      errors.card_name = "Card name must be 3-80 characters";
    }
  }

  // Set number: regex pattern
  if (overrides.set_number !== undefined) {
    const trimmed = overrides.set_number.trim();
    if (trimmed.length > 0 && !SET_NUMBER_REGEX.test(trimmed)) {
      errors.set_number = "Set number must be in format: 123 or 123/456";
    }
  }

  // HP value: 0-400, integer
  if (overrides.hp_value !== undefined) {
    if (!Number.isInteger(overrides.hp_value) || overrides.hp_value < 0 || overrides.hp_value > 400) {
      errors.hp_value = "HP must be an integer between 0 and 400";
    }
  }

  // Variant hint: enum
  if (overrides.variant_hint !== undefined) {
    if (!VARIANT_HINT_VALUES.includes(overrides.variant_hint)) {
      errors.variant_hint = "Invalid variant hint";
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

export function useStagedEdits(jobId: string | null) {
  const [edits, setEdits] = useState<StagedOverrides>({});
  const [hasEmittedStaged, setHasEmittedStaged] = useState(false);
  const lastJobId = useRef<string | null>(null);

  // Load from sessionStorage when jobId changes
  useEffect(() => {
    if (!jobId) {
      setEdits({});
      setHasEmittedStaged(false);
      lastJobId.current = null;
      return;
    }

    if (jobId === lastJobId.current) {
      return;
    }

    lastJobId.current = jobId;

    if (typeof window === "undefined") {
      setEdits({});
      setHasEmittedStaged(false);
      return;
    }

    try {
      const key = `cardmint:stagedEdits:${jobId}`;
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        setEdits(parsed.edits || {});
        setHasEmittedStaged(parsed.hasEmittedStaged || false);
      } else {
        setEdits({});
        setHasEmittedStaged(false);
      }
    } catch {
      setEdits({});
      setHasEmittedStaged(false);
    }
  }, [jobId]);

  // Persist to sessionStorage whenever edits change
  useEffect(() => {
    if (!jobId) return;
    if (typeof window === "undefined") return;

    try {
      const key = `cardmint:stagedEdits:${jobId}`;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          edits,
          hasEmittedStaged,
        })
      );
    } catch {
      /* ignore quota */
    }
  }, [jobId, edits, hasEmittedStaged]);

  // Emit manual_edits_staged event when edits first become dirty
  useEffect(() => {
    if (!jobId) return;
    if (hasEmittedStaged) return;

    const hasEdits = Object.keys(edits).length > 0;
    if (!hasEdits) return;

    console.info("MANUAL_EDITS_STAGED", {
      jobId,
      staged_at: new Date().toISOString(),
      edited_keys: Object.keys(edits),
      validity_snapshot: validateStagedOverrides(edits),
    });

    setHasEmittedStaged(true);
  }, [jobId, edits, hasEmittedStaged]);

  const validation = validateStagedOverrides(edits);

  const hasValidEdits = Object.keys(edits).length > 0 && validation.isValid;
  const hasInvalidEdits = Object.keys(edits).length > 0 && !validation.isValid;

  const clearEdits = () => {
    setEdits({});
    setHasEmittedStaged(false);

    if (jobId && typeof window !== "undefined") {
      try {
        const key = `cardmint:stagedEdits:${jobId}`;
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    edits,
    setEdits,
    clearEdits,
    isValid: validation.isValid,
    errors: validation.errors,
    hasValidEdits,
    hasInvalidEdits,
  };
}
