/**
 * Phase 6.2 ROI System Types - Production-Ready Template Hierarchy
 * 
 * Type-safe, OS-agnostic ROI system with ≤50ms template selection,
 * hierarchical templates, lazy-loading evaluation, and comprehensive debugging.
 */

// Layout family IDs from canonical naming system
export type LayoutFamilyId =
  | "classic_wotc" | "e_card" | "ex_dp" | "hgss" | "bw_xy"
  | "sun_moon" | "sword_shield" | "scarlet_violet"
  | "legend_split" | "vmax_vstar_landscape" | "trainer_ownership";

// ROI tier priorities for lazy evaluation
export type RoiTier = "CRITICAL" | "STANDARD" | "DETAILED" | "OPTIONAL";

// ROI functional roles for classification
export type RoiRole = 
  | "text" | "symbol" | "pattern" | "rulebox" | "edge_logo" 
  | "art_border" | "set_symbol" | "number_box" | "name_band" 
  | "evolution_box" | "trainer_portrait" | "delta_species";

// Core coordinate interfaces
export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// Percentage-based coordinates for template persistence (0-1 scale)
export interface PercentageCoordinate extends Point {
  x: number;    // 0-1
  y: number;    // 0-1
  w: number;    // 0-1 (width)
  h: number;    // 0-1 (height)
}

// Absolute pixel coordinates for runtime processing
export interface AbsoluteCoordinate extends Point {
  x: number;
  y: number;
  w: number;    // width in pixels
  h: number;    // height in pixels
}

// Image features for template selection and condition evaluation
export interface ImageFeatures {
  aspectRatio: number;
  borderColor: "yellow" | "grey" | "unknown";
  ruleBoxBand?: boolean;
  textDensityTop?: number;      // 0-1 (FAST corners density)
  edgeLogoSignal?: number;      // 0-1 (Canny+Hough confidence)
  deltaSymbolSignal?: number;   // 0-1 (Delta Species marker)
  levelXToken?: boolean;        // LV.X detection
  radiantPattern?: number;      // 0-1 (radial frequency energy)
  trainerPortraitBlob?: number; // 0-1 (face detection confidence)
}

// ROI specification with conditional evaluation
export interface RoiSpec {
  id: string;                                // "family:roi-name" format
  tier: RoiTier;
  role: RoiRole;
  coords: PercentageCoordinate;              // persisted as 0-1, resolved to absolute
  weights: { 
    base: number;                            // base confidence weight
    max?: number;                            // maximum contribution cap
  };
  condition?: (features: ImageFeatures) => boolean; // runtime condition toggle
}

// Collection of ROIs for a template section
export interface ROISet {
  rois: RoiSpec[];
}

// Base template with core ROIs
export interface BaseTemplate {
  id: string;                                // family ID
  layoutFamily: LayoutFamilyId;
  coreROIs: ROISet;                         // always-evaluated ROIs
}

// Template variation with conditional ROIs
export interface TemplateVariation extends BaseTemplate {
  parentId: string;                         // base family ID
  eraSpecificROIs: ROISet;                 // ROIs specific to this variation
  conditions: TemplateConditions;          // when this variation applies
}

// Conditions for template variation selection
export interface TemplateConditions {
  era?: string[];                          // from canonical era system
  hasRuleBox?: boolean;
  layoutVariant?: "standard" | "full_art" | "landscape";
  hasTrainerPortrait?: boolean;
  hasDeltaSpeciesCue?: boolean;
  hasEdgeLogos?: boolean;
  hasRadiantPattern?: boolean;
  minConfidence?: number;                  // minimum confidence threshold
}

// Candidate scoring result
export interface CandidateScore {
  templateId: string;
  fused: number;                           // 0-1 final confidence score
  usedRois: string[];                      // ROI IDs that contributed
  perRoi: Record<string, number>;          // individual ROI scores
  msSpent: number;                         // processing time consumed
  tier: RoiTier;                          // highest tier evaluated
}

// Time budget management
export interface TimeBudget {
  msTotal: number;
  msUsed: number;
  msRemaining: number;
}

// ROI evaluation thresholds
export interface EvaluationThresholds {
  accept: number;                          // auto-accept confidence (0.86)
  tryNextTier: number;                     // continue to next tier (0.72)
  lowConfidence: number;                   // trigger debug output (0.80)
}

// Platform-specific worker configuration
export interface WorkerConfig {
  maxWorkers: number;                      // 1-4 based on platform
  skipDetailedTier: boolean;               // Pi 5 optimization
  enablePyramid: boolean;                  // multi-scale processing
}

// Performance metrics tracking
export interface PerformanceMetrics {
  templateSelectionMs: number;
  featureExtractionMs: number;
  roiEvaluationMs: number;
  totalProcessingMs: number;
  cacheHitRate: number;
  memoryUsageMB: number;
}

// Debug information for low-confidence cases
export interface DebugInfo {
  selectedTemplate: string;
  featuresVector: ImageFeatures;
  roiEvaluationOrder: Array<{
    tier: RoiTier;
    roiIds: string[];
    scores: Record<string, number>;
    costMs: number;
  }>;
  fusedScore: number;
  thresholds: EvaluationThresholds;
  budgetConsumption: TimeBudget;
  reasonForStop: "ACCEPTED" | "BUDGET_EXHAUSTED" | "LOW_CONFIDENCE" | "ALL_TIERS_EVALUATED";
}

// Chrome tracing event for performance analysis
export interface ChromeTraceEvent {
  name: string;
  cat: string;
  ph: "B" | "E" | "X";    // Begin, End, Complete
  ts: number;              // timestamp in microseconds
  pid: number;             // process ID
  tid: number;             // thread ID
  dur?: number;            // duration in microseconds
  args?: Record<string, any>;
}

// Registry health check results
export interface RegistryHealthCheck {
  totalFamilies: number;
  totalROIs: number;
  roiCountByFamily: Record<LayoutFamilyId, number>;
  roiCountByTier: Record<RoiTier, number>;
  deadConditions: string[];               // ROI IDs with never-triggered conditions
  underperformingROIs: Array<{
    roiId: string;
    upliftScore: number;                  // < 0.5pp = candidate for downgrade
    recommendedAction: "DOWNGRADE" | "DELETE";
  }>;
  memoryFootprintMB: number;
}

// Type guards for runtime validation
export function isValidLayoutFamily(family: string): family is LayoutFamilyId {
  const validFamilies: readonly string[] = [
    "classic_wotc", "e_card", "ex_dp", "hgss", "bw_xy",
    "sun_moon", "sword_shield", "scarlet_violet", 
    "legend_split", "vmax_vstar_landscape", "trainer_ownership"
  ];
  return validFamilies.includes(family);
}

export function isValidRoiTier(tier: string): tier is RoiTier {
  return ["CRITICAL", "STANDARD", "DETAILED", "OPTIONAL"].includes(tier);
}

export function isPercentageCoordinate(coord: any): coord is PercentageCoordinate {
  return coord && 
    typeof coord.x === 'number' && coord.x >= 0 && coord.x <= 1 &&
    typeof coord.y === 'number' && coord.y >= 0 && coord.y <= 1 &&
    typeof coord.w === 'number' && coord.w >= 0 && coord.w <= 1 &&
    typeof coord.h === 'number' && coord.h >= 0 && coord.h <= 1;
}

export function isAbsoluteCoordinate(coord: any): coord is AbsoluteCoordinate {
  return coord && 
    typeof coord.x === 'number' && coord.x >= 0 &&
    typeof coord.y === 'number' && coord.y >= 0 &&
    typeof coord.w === 'number' && coord.w > 0 &&
    typeof coord.h === 'number' && coord.h > 0;
}

// Constants for system configuration
export const DEFAULT_THRESHOLDS: EvaluationThresholds = {
  accept: 0.86,
  tryNextTier: 0.72,
  lowConfidence: 0.80,
};

export const DEFAULT_BUDGET_MS = 50;
export const MAX_ROIS_PER_FAMILY = 40;
export const MAX_FAMILIES = 12;
export const MEMORY_LIMIT_MB = 256;

// ROI ID naming pattern validation
export const ROI_ID_PATTERN = /^([a-z0-9_]+):([a-z0-9_-]+)$/;

export function validateRoiId(roiId: string): {
  valid: boolean;
  familyId?: LayoutFamilyId;
  roiName?: string;
  error?: string;
} {
  const match = roiId.match(ROI_ID_PATTERN);
  
  if (!match) {
    return {
      valid: false,
      error: `Invalid ROI ID format: ${roiId}. Expected 'familyId:roiName'`,
    };
  }

  const [, familyId, roiName] = match;
  
  if (!isValidLayoutFamily(familyId)) {
    return {
      valid: false,
      familyId: familyId as LayoutFamilyId,
      roiName,
      error: `Unknown layout family: ${familyId}`,
    };
  }

  return {
    valid: true,
    familyId: familyId as LayoutFamilyId,
    roiName,
  };
}

// Version tracking for migration and debugging
export const ROI_SYSTEM_VERSION = "6.2.0";
export const COORDINATE_PRECISION = 6;