/**
 * Unified Coordinate System for CardMint ROI handling
 * 
 * Provides transparent conversion between pixel, percentage, and normalized coordinates
 * with automatic format detection and backward compatibility.
 */

import {
  CoordinateFormat,
  TypedCoordinate,
  AbsoluteCoordinate,
  PercentageCoordinate,
  NormalizedCoordinate,
  LegacyCoordinate,
  Size,
  ValidationResult,
  CoordinateSystemConfig,
  CoordinatePerformanceMetrics,
  CoordinateError,
  ValidationError,
  ConversionError,
  isAbsoluteCoordinate,
  isPercentageCoordinate,
  isNormalizedCoordinate,
  DEFAULT_COORDINATE_PRECISION,
  MAX_COORDINATE_VALUE,
  MIN_COORDINATE_VALUE,
} from './types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('CoordinateSystem');

export interface CoordinateAdapter {
  toAbsolute(coordinate: any, referenceSize: Size): AbsoluteCoordinate;
  toPercentage(coordinate: any, referenceSize: Size): PercentageCoordinate;
  toNormalized(coordinate: any, referenceSize: Size): NormalizedCoordinate;
  detectFormat(coordinate: any): CoordinateFormat | null;
  validate(coordinate: any, format?: CoordinateFormat): ValidationResult;
  migrate(legacyCoordinate: LegacyCoordinate, targetFormat?: CoordinateFormat): TypedCoordinate;
}

/**
 * High-performance coordinate conversion cache
 */
class CoordinateCache {
  private cache = new Map<string, any>();
  private accessOrder: string[] = [];
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): any | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.hits++;
      // Move to end of access order (LRU)
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.accessOrder.push(key);
      return value;
    }
    this.misses++;
    return undefined;
  }

  set(key: string, value: any): void {
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      return;
    }

    if (this.cache.size >= this.maxSize) {
      // Remove least recently used item
      const lruKey = this.accessOrder.shift();
      if (lruKey) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

/**
 * Unified coordinate system implementation
 */
export class UnifiedCoordinateSystem implements CoordinateAdapter {
  private cache: CoordinateCache;
  private config: CoordinateSystemConfig;
  private performanceMetrics: CoordinatePerformanceMetrics;
  private conversionsStartTime: number[] = [];

  constructor(config: Partial<CoordinateSystemConfig> = {}) {
    this.config = {
      defaultFormat: 'percentage',
      defaultPrecision: DEFAULT_COORDINATE_PRECISION,
      enableCaching: true,
      cacheSize: 1000,
      performanceTracking: true,
      validationMode: 'lenient',
      ...config,
    };

    this.cache = new CoordinateCache(this.config.cacheSize);
    this.performanceMetrics = {
      conversionTimeMs: 0,
      cacheHitRate: 0,
      totalConversions: 0,
      averageConversionTime: 0,
    };

    logger.info('UnifiedCoordinateSystem initialized', {
      defaultFormat: this.config.defaultFormat,
      cacheEnabled: this.config.enableCaching,
    });
  }

  /**
   * Automatically detect coordinate format with high confidence
   */
  detectFormat(coordinate: any): CoordinateFormat | null {
    if (!coordinate || typeof coordinate !== 'object') {
      return null;
    }

    // Check for normalized coordinates (0-1 range)
    if (isNormalizedCoordinate(coordinate)) {
      return 'normalized';
    }

    // Check for percentage coordinates (has _pct suffix)
    if (isPercentageCoordinate(coordinate)) {
      return 'percentage';
    }

    // Check for absolute coordinates
    if (isAbsoluteCoordinate(coordinate)) {
      // Additional heuristic: values > 100 are likely absolute pixels
      const maxValue = Math.max(coordinate.x, coordinate.y, coordinate.width, coordinate.height);
      if (maxValue > 100) {
        return 'absolute';
      }
      
      // Values <= 100 could be either absolute or percentage without _pct suffix
      // Default to absolute for backward compatibility
      return 'absolute';
    }

    logger.warn('Unable to detect coordinate format', coordinate);
    return null;
  }

  /**
   * Validate coordinate data with configurable strictness
   */
  validate(coordinate: any, format?: CoordinateFormat): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    if (!coordinate) {
      result.valid = false;
      result.errors.push('Coordinate is null or undefined');
      return result;
    }

    const detectedFormat = format || this.detectFormat(coordinate);
    if (!detectedFormat) {
      result.valid = false;
      result.errors.push('Unable to detect coordinate format');
      return result;
    }

    // Format-specific validation
    switch (detectedFormat) {
      case 'absolute':
        this.validateAbsoluteCoordinate(coordinate, result);
        break;
      case 'percentage':
        this.validatePercentageCoordinate(coordinate, result);
        break;
      case 'normalized':
        this.validateNormalizedCoordinate(coordinate, result);
        break;
    }

    // Common validations
    this.validateCommonProperties(coordinate, result);

    if (this.config.validationMode === 'strict' && result.warnings.length > 0) {
      result.valid = false;
      result.errors.push(...result.warnings);
      result.warnings = [];
    }

    return result;
  }

  private validateAbsoluteCoordinate(coord: AbsoluteCoordinate, result: ValidationResult): void {
    const values = [coord.x, coord.y, coord.width, coord.height];
    
    for (const value of values) {
      if (typeof value !== 'number' || !isFinite(value)) {
        result.valid = false;
        result.errors.push(`Invalid absolute coordinate value: ${value}`);
      }
      
      if (value < MIN_COORDINATE_VALUE || value > MAX_COORDINATE_VALUE) {
        result.warnings.push(`Coordinate value ${value} is outside recommended range`);
      }
    }

    if (coord.width <= 0 || coord.height <= 0) {
      result.valid = false;
      result.errors.push('Width and height must be positive');
    }
  }

  private validatePercentageCoordinate(coord: PercentageCoordinate, result: ValidationResult): void {
    const values = [coord.x_pct, coord.y_pct, coord.width_pct, coord.height_pct];
    
    for (const value of values) {
      if (typeof value !== 'number' || !isFinite(value)) {
        result.valid = false;
        result.errors.push(`Invalid percentage coordinate value: ${value}`);
      }
      
      if (value < 0 || value > 100) {
        result.warnings.push(`Percentage value ${value} is outside 0-100 range`);
      }
    }
  }

  private validateNormalizedCoordinate(coord: NormalizedCoordinate, result: ValidationResult): void {
    const values = [coord.x_norm, coord.y_norm, coord.width_norm, coord.height_norm];
    
    for (const value of values) {
      if (typeof value !== 'number' || !isFinite(value)) {
        result.valid = false;
        result.errors.push(`Invalid normalized coordinate value: ${value}`);
      }
      
      if (value < 0 || value > 1) {
        result.warnings.push(`Normalized value ${value} is outside 0-1 range`);
      }
    }
  }

  private validateCommonProperties(coord: any, result: ValidationResult): void {
    // Check for negative dimensions
    const width = coord.width || coord.width_pct || coord.width_norm;
    const height = coord.height || coord.height_pct || coord.height_norm;
    
    if (width <= 0 || height <= 0) {
      result.valid = false;
      result.errors.push('Width and height must be positive');
    }
  }

  /**
   * Convert any coordinate to absolute pixel coordinates
   */
  toAbsolute(coordinate: any, referenceSize: Size): AbsoluteCoordinate {
    const startTime = performance.now();
    
    try {
      // Check cache first
      if (this.config.enableCaching) {
        const cacheKey = `abs_${JSON.stringify(coordinate)}_${referenceSize.width}x${referenceSize.height}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const format = this.detectFormat(coordinate);
      if (!format) {
        throw new ConversionError('Unable to detect source coordinate format', 'unknown' as any, 'absolute');
      }

      let result: AbsoluteCoordinate;

      switch (format) {
        case 'absolute':
          result = { ...coordinate };
          break;
          
        case 'percentage':
          result = {
            x: Math.round((coordinate.x_pct / 100) * referenceSize.width),
            y: Math.round((coordinate.y_pct / 100) * referenceSize.height),
            width: Math.round((coordinate.width_pct / 100) * referenceSize.width),
            height: Math.round((coordinate.height_pct / 100) * referenceSize.height),
          };
          break;
          
        case 'normalized':
          result = {
            x: Math.round(coordinate.x_norm * referenceSize.width),
            y: Math.round(coordinate.y_norm * referenceSize.height),
            width: Math.round(coordinate.width_norm * referenceSize.width),
            height: Math.round(coordinate.height_norm * referenceSize.height),
          };
          break;
          
        default:
          throw new ConversionError(`Unsupported source format: ${format}`, format, 'absolute');
      }

      // Validate result
      const validation = this.validate(result, 'absolute');
      if (!validation.valid && this.config.validationMode !== 'disabled') {
        throw new ValidationError('Conversion resulted in invalid absolute coordinates', validation);
      }

      // Cache result
      if (this.config.enableCaching) {
        const cacheKey = `abs_${JSON.stringify(coordinate)}_${referenceSize.width}x${referenceSize.height}`;
        this.cache.set(cacheKey, result);
      }

      return result;
    } finally {
      if (this.config.performanceTracking) {
        this.recordConversionTime(performance.now() - startTime);
      }
    }
  }

  /**
   * Convert any coordinate to percentage coordinates
   */
  toPercentage(coordinate: any, referenceSize: Size): PercentageCoordinate {
    const startTime = performance.now();
    
    try {
      // Check cache first
      if (this.config.enableCaching) {
        const cacheKey = `pct_${JSON.stringify(coordinate)}_${referenceSize.width}x${referenceSize.height}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const format = this.detectFormat(coordinate);
      if (!format) {
        throw new ConversionError('Unable to detect source coordinate format', 'unknown' as any, 'percentage');
      }

      let result: PercentageCoordinate;

      switch (format) {
        case 'percentage':
          result = { ...coordinate };
          break;
          
        case 'absolute':
          result = {
            x: coordinate.x,  // Keep absolute x for compatibility
            y: coordinate.y,  // Keep absolute y for compatibility
            x_pct: Number(((coordinate.x / referenceSize.width) * 100).toFixed(this.config.defaultPrecision)),
            y_pct: Number(((coordinate.y / referenceSize.height) * 100).toFixed(this.config.defaultPrecision)),
            width_pct: Number(((coordinate.width / referenceSize.width) * 100).toFixed(this.config.defaultPrecision)),
            height_pct: Number(((coordinate.height / referenceSize.height) * 100).toFixed(this.config.defaultPrecision)),
          };
          break;
          
        case 'normalized':
          result = {
            x: Math.round(coordinate.x_norm * referenceSize.width),
            y: Math.round(coordinate.y_norm * referenceSize.height),
            x_pct: Number((coordinate.x_norm * 100).toFixed(this.config.defaultPrecision)),
            y_pct: Number((coordinate.y_norm * 100).toFixed(this.config.defaultPrecision)),
            width_pct: Number((coordinate.width_norm * 100).toFixed(this.config.defaultPrecision)),
            height_pct: Number((coordinate.height_norm * 100).toFixed(this.config.defaultPrecision)),
          };
          break;
          
        default:
          throw new ConversionError(`Unsupported source format: ${format}`, format, 'percentage');
      }

      // Validate result
      const validation = this.validate(result, 'percentage');
      if (!validation.valid && this.config.validationMode !== 'disabled') {
        throw new ValidationError('Conversion resulted in invalid percentage coordinates', validation);
      }

      // Cache result
      if (this.config.enableCaching) {
        const cacheKey = `pct_${JSON.stringify(coordinate)}_${referenceSize.width}x${referenceSize.height}`;
        this.cache.set(cacheKey, result);
      }

      return result;
    } finally {
      if (this.config.performanceTracking) {
        this.recordConversionTime(performance.now() - startTime);
      }
    }
  }

  /**
   * Convert any coordinate to normalized coordinates (0-1 range)
   */
  toNormalized(coordinate: any, referenceSize: Size): NormalizedCoordinate {
    const startTime = performance.now();
    
    try {
      const format = this.detectFormat(coordinate);
      if (!format) {
        throw new ConversionError('Unable to detect source coordinate format', 'unknown' as any, 'normalized');
      }

      let result: NormalizedCoordinate;

      switch (format) {
        case 'normalized':
          result = { ...coordinate };
          break;
          
        case 'absolute':
          result = {
            x: coordinate.x,
            y: coordinate.y,
            x_norm: Number((coordinate.x / referenceSize.width).toFixed(this.config.defaultPrecision)),
            y_norm: Number((coordinate.y / referenceSize.height).toFixed(this.config.defaultPrecision)),
            width_norm: Number((coordinate.width / referenceSize.width).toFixed(this.config.defaultPrecision)),
            height_norm: Number((coordinate.height / referenceSize.height).toFixed(this.config.defaultPrecision)),
          };
          break;
          
        case 'percentage':
          result = {
            x: Math.round((coordinate.x_pct / 100) * referenceSize.width),
            y: Math.round((coordinate.y_pct / 100) * referenceSize.height),
            x_norm: Number((coordinate.x_pct / 100).toFixed(this.config.defaultPrecision)),
            y_norm: Number((coordinate.y_pct / 100).toFixed(this.config.defaultPrecision)),
            width_norm: Number((coordinate.width_pct / 100).toFixed(this.config.defaultPrecision)),
            height_norm: Number((coordinate.height_pct / 100).toFixed(this.config.defaultPrecision)),
          };
          break;
          
        default:
          throw new ConversionError(`Unsupported source format: ${format}`, format, 'normalized');
      }

      return result;
    } finally {
      if (this.config.performanceTracking) {
        this.recordConversionTime(performance.now() - startTime);
      }
    }
  }

  /**
   * Migrate legacy coordinate to new typed coordinate system
   */
  migrate(legacyCoordinate: LegacyCoordinate, targetFormat: CoordinateFormat = this.config.defaultFormat): TypedCoordinate {
    const format = this.detectFormat(legacyCoordinate);
    if (!format) {
      throw new CoordinateError('Unable to detect legacy coordinate format', 'MIGRATION_ERROR');
    }

    const typedCoord: TypedCoordinate = {
      format: targetFormat,
      data: legacyCoordinate as any,
      metadata: {
        format: targetFormat,
        precision: this.config.defaultPrecision,
        origin: 'top-left',
      },
    };

    logger.debug('Migrated legacy coordinate', {
      from: format,
      to: targetFormat,
      coordinate: legacyCoordinate,
    });

    return typedCoord;
  }

  /**
   * Record conversion performance metrics
   */
  private recordConversionTime(timeMs: number): void {
    this.conversionsStartTime.push(timeMs);
    this.performanceMetrics.totalConversions++;
    
    // Keep only last 1000 measurements for moving average
    if (this.conversionsStartTime.length > 1000) {
      this.conversionsStartTime.shift();
    }
    
    this.performanceMetrics.averageConversionTime = 
      this.conversionsStartTime.reduce((sum, time) => sum + time, 0) / this.conversionsStartTime.length;
    
    const cacheStats = this.cache.getStats();
    this.performanceMetrics.cacheHitRate = cacheStats.hitRate;
  }

  /**
   * Get system performance metrics
   */
  getPerformanceMetrics(): CoordinatePerformanceMetrics {
    return { ...this.performanceMetrics };
  }

  /**
   * Clear cache and reset metrics
   */
  reset(): void {
    this.cache.clear();
    this.conversionsStartTime = [];
    this.performanceMetrics = {
      conversionTimeMs: 0,
      cacheHitRate: 0,
      totalConversions: 0,
      averageConversionTime: 0,
    };
    logger.info('Coordinate system reset');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }
}

// Export singleton instance for global use
export const coordinateSystem = new UnifiedCoordinateSystem();