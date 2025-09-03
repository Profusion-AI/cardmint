/**
 * Core coordinate system types for the CardMint ROI abstraction layer
 * 
 * This module provides type-safe, format-agnostic coordinate handling that supports
 * both pixel-based and percentage-based coordinates with automatic conversion.
 */

// Base coordinate interfaces
export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// Absolute pixel-based coordinates
export interface AbsoluteCoordinate extends Point {
  width: number;
  height: number;
}

// Percentage-based coordinates (0-100 scale)
export interface PercentageCoordinate extends Point {
  x_pct: number;   // 0-100
  y_pct: number;   // 0-100
  width_pct: number;  // 0-100
  height_pct: number; // 0-100
}

// Normalized coordinates (0-1 scale) - for internal processing
export interface NormalizedCoordinate extends Point {
  x_norm: number;   // 0-1
  y_norm: number;   // 0-1
  width_norm: number;  // 0-1
  height_norm: number; // 0-1
}

// Coordinate format discriminated union
export type CoordinateFormat = 'absolute' | 'percentage' | 'normalized';

export interface CoordinateMetadata {
  format: CoordinateFormat;
  referenceSize?: Size;  // Original size for percentage calculations
  precision?: number;    // Decimal places for rounding
  origin?: 'top-left' | 'center' | 'bottom-left';
  aspectRatioLocked?: boolean;
  transformationMatrix?: number[]; // 3x3 matrix for advanced transformations
}

// Generic coordinate container with metadata
export interface TypedCoordinate<T extends CoordinateFormat = CoordinateFormat> {
  format: T;
  data: T extends 'absolute' ? AbsoluteCoordinate :
        T extends 'percentage' ? PercentageCoordinate :
        T extends 'normalized' ? NormalizedCoordinate :
        never;
  metadata?: CoordinateMetadata;
}

// Coordinate validation result
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  correctedData?: any;
}

// Transformation options
export interface TransformOptions {
  targetFormat: CoordinateFormat;
  targetSize?: Size;
  precision?: number;
  clampToBounds?: boolean;
  preserveAspectRatio?: boolean;
}

// Performance metrics for coordinate operations
export interface CoordinatePerformanceMetrics {
  conversionTimeMs: number;
  cacheHitRate: number;
  totalConversions: number;
  averageConversionTime: number;
}

// Legacy coordinate types (backward compatibility)
export interface LegacyRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegacyRectPercent {
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
}

// Union type for legacy support
export type LegacyCoordinate = LegacyRectangle | LegacyRectPercent;

// Condition-aware coordinates (from existing ROI system)
export interface ConditionalCoordinate<T = LegacyCoordinate> {
  data: T;
  conditions?: {
    promoOnly?: boolean;
    firstEditionOnly?: boolean;
    era?: 'classic' | 'neo' | 'modern' | 'promo';
    minConfidence?: number;
  };
}

// Coordinate system configuration
export interface CoordinateSystemConfig {
  defaultFormat: CoordinateFormat;
  defaultPrecision: number;
  enableCaching: boolean;
  cacheSize: number;
  performanceTracking: boolean;
  validationMode: 'strict' | 'lenient' | 'disabled';
}

// Error types for coordinate operations
export class CoordinateError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: any
  ) {
    super(message);
    this.name = 'CoordinateError';
  }
}

export class ValidationError extends CoordinateError {
  constructor(message: string, public details: ValidationResult) {
    super(message, 'VALIDATION_ERROR', details);
  }
}

export class ConversionError extends CoordinateError {
  constructor(message: string, public sourceFormat: CoordinateFormat, public targetFormat: CoordinateFormat) {
    super(message, 'CONVERSION_ERROR', { sourceFormat, targetFormat });
  }
}

// Utility type guards
export function isAbsoluteCoordinate(coord: any): coord is AbsoluteCoordinate {
  return coord && typeof coord.x === 'number' && typeof coord.width === 'number' && 
         !('x_pct' in coord) && !('x_norm' in coord);
}

export function isPercentageCoordinate(coord: any): coord is PercentageCoordinate {
  return coord && typeof coord.x_pct === 'number' && typeof coord.width_pct === 'number';
}

export function isNormalizedCoordinate(coord: any): coord is NormalizedCoordinate {
  return coord && typeof coord.x_norm === 'number' && typeof coord.width_norm === 'number';
}

export function isLegacyCoordinate(coord: any): coord is LegacyCoordinate {
  return isAbsoluteCoordinate(coord) || isPercentageCoordinate(coord);
}

// Constants
export const DEFAULT_COORDINATE_PRECISION = 6;
export const MAX_COORDINATE_VALUE = 1e6;
export const MIN_COORDINATE_VALUE = -1e6;
export const DEFAULT_CACHE_SIZE = 1000;

// Coordinate system version for migration tracking
export const COORDINATE_SYSTEM_VERSION = '2.0.0';