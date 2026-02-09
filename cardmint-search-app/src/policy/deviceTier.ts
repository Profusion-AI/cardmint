import { freemem, totalmem } from "node:os";

/**
 * Device-tier inference policy for edge deployment.
 *
 * Tiers are derived from the PRD (Section 7):
 * - Tier 0: <4 GB effective RAM → text/OCR-first, no heavy VLM
 * - Tier 1: 4-6 GB RAM → compact multimodal (1.2B-1.8B class)
 * - Tier 2: >=6 GB RAM → full multimodal (up to 3B class)
 *
 * This module provides:
 * 1. Tier detection from system memory or explicit override
 * 2. Policy constraints per tier (allowed models, latency budgets)
 * 3. Fallback cascade when higher-tier capabilities are unavailable
 */

export type DeviceTier = "tier0" | "tier1" | "tier2";

export interface TierPolicy {
  tier: DeviceTier;
  /** Maximum allowed inference latency in milliseconds */
  latencyBudgetMs: number;
  /** Model classes allowed at this tier */
  allowedModelClasses: string[];
  /** Whether vector/embedding search is available */
  vectorSearchEnabled: boolean;
  /** Whether image-assisted search is available */
  imageSearchEnabled: boolean;
  /** Human-readable description */
  description: string;
}

const TIER_POLICIES: Record<DeviceTier, TierPolicy> = {
  tier0: {
    tier: "tier0",
    latencyBudgetMs: 500,
    allowedModelClasses: [],
    vectorSearchEnabled: false,
    imageSearchEnabled: false,
    description: "Text/OCR-first fallback — no on-device VLM",
  },
  tier1: {
    tier: "tier1",
    latencyBudgetMs: 3000,
    allowedModelClasses: ["lfm-1.2b", "moondream-2"],
    vectorSearchEnabled: true,
    imageSearchEnabled: true,
    description: "Compact multimodal — 1.2B-1.8B class models",
  },
  tier2: {
    tier: "tier2",
    latencyBudgetMs: 2000,
    allowedModelClasses: ["lfm-1.2b", "moondream-2", "qwen-2.5-vl-3b"],
    vectorSearchEnabled: true,
    imageSearchEnabled: true,
    description: "Full multimodal — up to 3B class models",
  },
};

/** Detect device tier from available system memory. */
export function detectTier(): DeviceTier {
  const totalGb = totalmem() / (1024 ** 3);
  const freeGb = freemem() / (1024 ** 3);

  // Use the lesser of total and 1.5x free as "effective" memory budget
  const effectiveGb = Math.min(totalGb, freeGb * 1.5);

  if (effectiveGb >= 6) return "tier2";
  if (effectiveGb >= 4) return "tier1";
  return "tier0";
}

/** Resolve tier from explicit override or auto-detect. */
export function resolveTier(override?: string | null): DeviceTier {
  if (override === "tier0" || override === "tier1" || override === "tier2") {
    return override;
  }
  return detectTier();
}

/** Get the policy for a given tier. */
export function getTierPolicy(tier: DeviceTier): TierPolicy {
  return TIER_POLICIES[tier];
}

/**
 * Get the fallback chain for a tier (tier itself + all lower tiers).
 * Used when a higher-tier operation fails or times out.
 */
export function getFallbackChain(tier: DeviceTier): DeviceTier[] {
  switch (tier) {
    case "tier2": return ["tier2", "tier1", "tier0"];
    case "tier1": return ["tier1", "tier0"];
    case "tier0": return ["tier0"];
  }
}

/** Check if a model class is allowed at the given tier. */
export function isModelAllowed(tier: DeviceTier, modelClass: string): boolean {
  return TIER_POLICIES[tier].allowedModelClasses.includes(modelClass);
}

/**
 * Enforce latency budget: returns true if the operation completed within budget.
 * Use this after an inference call to decide whether to fallback.
 */
export function withinBudget(tier: DeviceTier, durationMs: number): boolean {
  return durationMs <= TIER_POLICIES[tier].latencyBudgetMs;
}
