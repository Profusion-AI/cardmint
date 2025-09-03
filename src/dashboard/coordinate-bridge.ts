/**
 * Coordinate System Bridge for Frontend Integration
 * 
 * Provides seamless integration between the backend coordinate abstraction
 * and frontend ROI tools with performance monitoring and debugging support.
 */

import {
  CoordinateFormat,
  AbsoluteCoordinate,
  PercentageCoordinate,
  Size,
  ValidationResult,
  CoordinatePerformanceMetrics,
} from '../core/roi/types';

export interface FrontendCoordinate {
  x: number;
  y: number;
  width: number;
  height: number;
  format?: CoordinateFormat;
  precision?: number;
}

export interface BridgeOptions {
  preferredFormat: CoordinateFormat;
  enableValidation: boolean;
  enableDebugMode: boolean;
  maxPrecision: number;
  performanceTracking: boolean;
}

export interface ConversionResult {
  coordinate: FrontendCoordinate;
  format: CoordinateFormat;
  conversionTimeMs: number;
  cacheHit: boolean;
  warnings: string[];
  metadata?: {
    originalFormat: CoordinateFormat;
    referenceSize: Size;
    precision: number;
  };
}

export interface CoordinateBridgeStats {
  conversions: {
    total: number;
    successful: number;
    failed: number;
    cached: number;
  };
  performance: {
    averageConversionTimeMs: number;
    slowestConversionMs: number;
    fastestConversionMs: number;
    cacheHitRate: number;
  };
  validation: {
    totalValidations: number;
    validCoordinates: number;
    invalidCoordinates: number;
    commonErrors: Array<{ error: string; count: number }>;
  };
}

export interface DebugInfo {
  enabled: boolean;
  lastConversions: Array<{
    timestamp: number;
    input: any;
    output: FrontendCoordinate;
    conversionTimeMs: number;
    format: CoordinateFormat;
  }>;
  activeReference: Size | null;
  coordinateSystemHealth: number;
}

/**
 * Frontend-Backend coordinate system bridge
 */
export class CoordinateBridge {
  private options: BridgeOptions;
  private stats: CoordinateBridgeStats;
  private debugInfo: DebugInfo;
  private activeReferenceSize: Size | null = null;
  private conversionCache = new Map<string, ConversionResult>();
  private validationErrorCounts = new Map<string, number>();

  constructor(options: Partial<BridgeOptions> = {}) {
    this.options = {
      preferredFormat: 'percentage',
      enableValidation: true,
      enableDebugMode: false,
      maxPrecision: 6,
      performanceTracking: true,
      ...options,
    };

    this.stats = this.initializeStats();
    this.debugInfo = {
      enabled: this.options.enableDebugMode,
      lastConversions: [],
      activeReference: null,
      coordinateSystemHealth: 100,
    };

    this.setupPerformanceMonitoring();
  }

  private initializeStats(): CoordinateBridgeStats {
    return {
      conversions: {
        total: 0,
        successful: 0,
        failed: 0,
        cached: 0,
      },
      performance: {
        averageConversionTimeMs: 0,
        slowestConversionMs: 0,
        fastestConversionMs: Number.MAX_VALUE,
        cacheHitRate: 0,
      },
      validation: {
        totalValidations: 0,
        validCoordinates: 0,
        invalidCoordinates: 0,
        commonErrors: [],
      },
    };
  }

  /**
   * Set the reference image size for coordinate conversions
   */
  setReferenceSize(width: number, height: number): void {
    this.activeReferenceSize = { width, height };
    this.debugInfo.activeReference = this.activeReferenceSize;
    
    if (this.options.enableDebugMode) {
      console.log('🎯 Coordinate Bridge: Reference size set', this.activeReferenceSize);
    }
  }

  /**
   * Convert any coordinate to frontend-compatible format
   */
  async convertToFrontend(
    coordinate: any,
    targetFormat?: CoordinateFormat
  ): Promise<ConversionResult> {
    const startTime = performance.now();
    const format = targetFormat || this.options.preferredFormat;
    
    this.stats.conversions.total++;

    try {
      // Check cache first
      const cacheKey = this.generateCacheKey(coordinate, format);
      const cached = this.conversionCache.get(cacheKey);
      if (cached) {
        this.stats.conversions.cached++;
        return {
          ...cached,
          cacheHit: true,
        };
      }

      if (!this.activeReferenceSize) {
        throw new Error('Reference size not set. Call setReferenceSize() first.');
      }

      // Detect current format
      const currentFormat = this.detectCoordinateFormat(coordinate);
      if (!currentFormat) {
        throw new Error('Unable to detect coordinate format');
      }

      // Validate if enabled
      let warnings: string[] = [];
      if (this.options.enableValidation) {
        const validation = this.validateCoordinate(coordinate, currentFormat);
        if (!validation.valid) {
          warnings.push(...validation.errors);
          this.recordValidationErrors(validation.errors);
        }
        warnings.push(...validation.warnings);
      }

      // Convert coordinate
      const converted = await this.performConversion(
        coordinate,
        currentFormat,
        format,
        this.activeReferenceSize
      );

      const conversionTime = performance.now() - startTime;
      
      const result: ConversionResult = {
        coordinate: converted,
        format,
        conversionTimeMs: conversionTime,
        cacheHit: false,
        warnings,
        metadata: {
          originalFormat: currentFormat,
          referenceSize: this.activeReferenceSize,
          precision: this.options.maxPrecision,
        },
      };

      // Cache the result
      this.conversionCache.set(cacheKey, result);

      // Update statistics
      this.updatePerformanceStats(conversionTime);
      this.stats.conversions.successful++;

      // Debug logging
      if (this.options.enableDebugMode) {
        this.recordDebugConversion(coordinate, converted, conversionTime, format);
      }

      return result;

    } catch (error) {
      this.stats.conversions.failed++;
      
      if (this.options.enableDebugMode) {
        console.error('❌ Coordinate conversion failed', error);
      }

      throw error;
    }
  }

  /**
   * Convert multiple coordinates in batch for better performance
   */
  async convertBatch(
    coordinates: Array<{ coordinate: any; targetFormat?: CoordinateFormat }>
  ): Promise<ConversionResult[]> {
    if (!this.activeReferenceSize) {
      throw new Error('Reference size not set. Call setReferenceSize() first.');
    }

    const results: ConversionResult[] = [];
    const startTime = performance.now();

    for (const item of coordinates) {
      try {
        const result = await this.convertToFrontend(item.coordinate, item.targetFormat);
        results.push(result);
      } catch (error) {
        // Create error result
        results.push({
          coordinate: { x: 0, y: 0, width: 0, height: 0, format: 'absolute' },
          format: 'absolute',
          conversionTimeMs: 0,
          cacheHit: false,
          warnings: [`Conversion failed: ${error instanceof Error ? error.message : String(error)}`],
        });
      }
    }

    const totalTime = performance.now() - startTime;
    
    if (this.options.enableDebugMode) {
      console.log(`🚀 Batch conversion completed: ${results.length} coordinates in ${totalTime.toFixed(2)}ms`);
    }

    return results;
  }

  /**
   * Get coordinate system status for UI display
   */
  getSystemStatus(): {
    healthy: boolean;
    referenceSet: boolean;
    stats: CoordinateBridgeStats;
    recommendations: string[];
  } {
    const healthy = this.stats.conversions.failed < this.stats.conversions.total * 0.1;
    const cacheEffective = this.stats.performance.cacheHitRate > 0.5;
    const performanceGood = this.stats.performance.averageConversionTimeMs < 5;

    const recommendations: string[] = [];
    if (!healthy) {
      recommendations.push('High failure rate detected - check coordinate validation');
    }
    if (!cacheEffective && this.stats.conversions.total > 10) {
      recommendations.push('Low cache hit rate - consider coordinate consistency');
    }
    if (!performanceGood && this.stats.conversions.total > 0) {
      recommendations.push('Slow conversion performance - optimize coordinate processing');
    }
    if (!this.activeReferenceSize) {
      recommendations.push('Set reference image size for accurate conversions');
    }

    return {
      healthy: healthy && !!this.activeReferenceSize,
      referenceSet: !!this.activeReferenceSize,
      stats: this.stats,
      recommendations,
    };
  }

  /**
   * Enable/disable debug mode with console output
   */
  setDebugMode(enabled: boolean): void {
    this.options.enableDebugMode = enabled;
    this.debugInfo.enabled = enabled;
    
    if (enabled) {
      console.log('🔧 Coordinate Bridge: Debug mode enabled');
      console.log('📊 Current stats:', this.stats);
    }
  }

  /**
   * Get debug information for troubleshooting
   */
  getDebugInfo(): DebugInfo {
    return { ...this.debugInfo };
  }

  /**
   * Clear all caches and reset statistics
   */
  reset(): void {
    this.conversionCache.clear();
    this.validationErrorCounts.clear();
    this.stats = this.initializeStats();
    this.debugInfo.lastConversions = [];
    
    if (this.options.enableDebugMode) {
      console.log('🧹 Coordinate Bridge: Reset completed');
    }
  }

  /**
   * Export configuration for persistence
   */
  exportConfiguration(): {
    options: BridgeOptions;
    referenceSize: Size | null;
    stats: CoordinateBridgeStats;
  } {
    return {
      options: this.options,
      referenceSize: this.activeReferenceSize,
      stats: this.stats,
    };
  }

  /**
   * Private helper methods
   */
  
  private detectCoordinateFormat(coordinate: any): CoordinateFormat | null {
    if (typeof coordinate !== 'object' || coordinate === null) {
      return null;
    }

    // Check for normalized coordinates
    if (typeof coordinate.x_norm === 'number' && typeof coordinate.width_norm === 'number') {
      return 'normalized';
    }

    // Check for percentage coordinates
    if (typeof coordinate.x_pct === 'number' && typeof coordinate.width_pct === 'number') {
      return 'percentage';
    }

    // Check for absolute coordinates
    if (typeof coordinate.x === 'number' && typeof coordinate.width === 'number') {
      // Heuristic: values > 100 are likely absolute pixels
      const maxValue = Math.max(coordinate.x, coordinate.y, coordinate.width, coordinate.height);
      return maxValue > 100 ? 'absolute' : 'absolute'; // Default to absolute for backward compatibility
    }

    return null;
  }

  private validateCoordinate(coordinate: any, format: CoordinateFormat): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    if (!coordinate || typeof coordinate !== 'object') {
      result.valid = false;
      result.errors.push('Coordinate is not an object');
      return result;
    }

    // Format-specific validation
    switch (format) {
      case 'absolute':
        this.validateAbsolute(coordinate, result);
        break;
      case 'percentage':
        this.validatePercentage(coordinate, result);
        break;
      case 'normalized':
        this.validateNormalized(coordinate, result);
        break;
    }

    // Common validations
    const width = coordinate.width || coordinate.width_pct || coordinate.width_norm;
    const height = coordinate.height || coordinate.height_pct || coordinate.height_norm;
    
    if (width <= 0 || height <= 0) {
      result.valid = false;
      result.errors.push('Width and height must be positive');
    }

    // Update validation stats
    this.stats.validation.totalValidations++;
    if (result.valid) {
      this.stats.validation.validCoordinates++;
    } else {
      this.stats.validation.invalidCoordinates++;
    }

    return result;
  }

  private validateAbsolute(coord: any, result: ValidationResult): void {
    const required = ['x', 'y', 'width', 'height'];
    for (const prop of required) {
      if (typeof coord[prop] !== 'number' || !isFinite(coord[prop])) {
        result.valid = false;
        result.errors.push(`Invalid absolute coordinate property: ${prop}`);
      }
    }
  }

  private validatePercentage(coord: any, result: ValidationResult): void {
    const required = ['x_pct', 'y_pct', 'width_pct', 'height_pct'];
    for (const prop of required) {
      if (typeof coord[prop] !== 'number' || !isFinite(coord[prop])) {
        result.valid = false;
        result.errors.push(`Invalid percentage coordinate property: ${prop}`);
      } else if (coord[prop] < 0 || coord[prop] > 100) {
        result.warnings.push(`Percentage value ${prop} is outside 0-100 range: ${coord[prop]}`);
      }
    }
  }

  private validateNormalized(coord: any, result: ValidationResult): void {
    const required = ['x_norm', 'y_norm', 'width_norm', 'height_norm'];
    for (const prop of required) {
      if (typeof coord[prop] !== 'number' || !isFinite(coord[prop])) {
        result.valid = false;
        result.errors.push(`Invalid normalized coordinate property: ${prop}`);
      } else if (coord[prop] < 0 || coord[prop] > 1) {
        result.warnings.push(`Normalized value ${prop} is outside 0-1 range: ${coord[prop]}`);
      }
    }
  }

  private async performConversion(
    coordinate: any,
    from: CoordinateFormat,
    to: CoordinateFormat,
    referenceSize: Size
  ): Promise<FrontendCoordinate> {
    // If formats match, return as-is (with format normalization)
    if (from === to) {
      return this.normalizeToFrontend(coordinate, to);
    }

    // Convert through our coordinate system
    let converted: any;

    switch (to) {
      case 'absolute':
        converted = this.toAbsolute(coordinate, referenceSize);
        break;
      case 'percentage':
        converted = this.toPercentage(coordinate, referenceSize);
        break;
      case 'normalized':
        converted = this.toNormalized(coordinate, referenceSize);
        break;
      default:
        throw new Error(`Unsupported target format: ${to}`);
    }

    return this.normalizeToFrontend(converted, to);
  }

  private toAbsolute(coordinate: any, referenceSize: Size): AbsoluteCoordinate {
    const format = this.detectCoordinateFormat(coordinate);
    
    switch (format) {
      case 'absolute':
        return { x: coordinate.x, y: coordinate.y, width: coordinate.width, height: coordinate.height };
      case 'percentage':
        return {
          x: Math.round((coordinate.x_pct / 100) * referenceSize.width),
          y: Math.round((coordinate.y_pct / 100) * referenceSize.height),
          width: Math.round((coordinate.width_pct / 100) * referenceSize.width),
          height: Math.round((coordinate.height_pct / 100) * referenceSize.height),
        };
      case 'normalized':
        return {
          x: Math.round(coordinate.x_norm * referenceSize.width),
          y: Math.round(coordinate.y_norm * referenceSize.height),
          width: Math.round(coordinate.width_norm * referenceSize.width),
          height: Math.round(coordinate.height_norm * referenceSize.height),
        };
      default:
        throw new Error('Unable to convert to absolute coordinates');
    }
  }

  private toPercentage(coordinate: any, referenceSize: Size): PercentageCoordinate {
    const format = this.detectCoordinateFormat(coordinate);
    
    switch (format) {
      case 'percentage':
        return {
          x: coordinate.x || Math.round((coordinate.x_pct / 100) * referenceSize.width),
          y: coordinate.y || Math.round((coordinate.y_pct / 100) * referenceSize.height),
          x_pct: coordinate.x_pct,
          y_pct: coordinate.y_pct,
          width_pct: coordinate.width_pct,
          height_pct: coordinate.height_pct,
        };
      case 'absolute':
        return {
          x: coordinate.x,
          y: coordinate.y,
          x_pct: Number(((coordinate.x / referenceSize.width) * 100).toFixed(this.options.maxPrecision)),
          y_pct: Number(((coordinate.y / referenceSize.height) * 100).toFixed(this.options.maxPrecision)),
          width_pct: Number(((coordinate.width / referenceSize.width) * 100).toFixed(this.options.maxPrecision)),
          height_pct: Number(((coordinate.height / referenceSize.height) * 100).toFixed(this.options.maxPrecision)),
        };
      case 'normalized':
        return {
          x: Math.round(coordinate.x_norm * referenceSize.width),
          y: Math.round(coordinate.y_norm * referenceSize.height),
          x_pct: Number((coordinate.x_norm * 100).toFixed(this.options.maxPrecision)),
          y_pct: Number((coordinate.y_norm * 100).toFixed(this.options.maxPrecision)),
          width_pct: Number((coordinate.width_norm * 100).toFixed(this.options.maxPrecision)),
          height_pct: Number((coordinate.height_norm * 100).toFixed(this.options.maxPrecision)),
        };
      default:
        throw new Error('Unable to convert to percentage coordinates');
    }
  }

  private toNormalized(coordinate: any, referenceSize: Size): any {
    const format = this.detectCoordinateFormat(coordinate);
    
    switch (format) {
      case 'normalized':
        return { ...coordinate };
      case 'absolute':
        return {
          x: coordinate.x,
          y: coordinate.y,
          x_norm: Number((coordinate.x / referenceSize.width).toFixed(this.options.maxPrecision)),
          y_norm: Number((coordinate.y / referenceSize.height).toFixed(this.options.maxPrecision)),
          width_norm: Number((coordinate.width / referenceSize.width).toFixed(this.options.maxPrecision)),
          height_norm: Number((coordinate.height / referenceSize.height).toFixed(this.options.maxPrecision)),
        };
      case 'percentage':
        return {
          x: Math.round((coordinate.x_pct / 100) * referenceSize.width),
          y: Math.round((coordinate.y_pct / 100) * referenceSize.height),
          x_norm: Number((coordinate.x_pct / 100).toFixed(this.options.maxPrecision)),
          y_norm: Number((coordinate.y_pct / 100).toFixed(this.options.maxPrecision)),
          width_norm: Number((coordinate.width_pct / 100).toFixed(this.options.maxPrecision)),
          height_norm: Number((coordinate.height_pct / 100).toFixed(this.options.maxPrecision)),
        };
      default:
        throw new Error('Unable to convert to normalized coordinates');
    }
  }

  private normalizeToFrontend(coordinate: any, format: CoordinateFormat): FrontendCoordinate {
    let x: number, y: number, width: number, height: number;

    switch (format) {
      case 'absolute':
        x = coordinate.x;
        y = coordinate.y;
        width = coordinate.width;
        height = coordinate.height;
        break;
      case 'percentage':
        x = coordinate.x || 0;
        y = coordinate.y || 0;
        width = coordinate.width_pct;
        height = coordinate.height_pct;
        break;
      case 'normalized':
        x = coordinate.x || 0;
        y = coordinate.y || 0;
        width = coordinate.width_norm;
        height = coordinate.height_norm;
        break;
      default:
        throw new Error(`Cannot normalize format: ${format}`);
    }

    return {
      x: Number(x.toFixed(this.options.maxPrecision)),
      y: Number(y.toFixed(this.options.maxPrecision)),
      width: Number(width.toFixed(this.options.maxPrecision)),
      height: Number(height.toFixed(this.options.maxPrecision)),
      format,
      precision: this.options.maxPrecision,
    };
  }

  private generateCacheKey(coordinate: any, format: CoordinateFormat): string {
    const coordStr = JSON.stringify(coordinate, Object.keys(coordinate).sort());
    const sizeStr = this.activeReferenceSize 
      ? `${this.activeReferenceSize.width}x${this.activeReferenceSize.height}` 
      : 'no-ref';
    return `${format}_${coordStr}_${sizeStr}`;
  }

  private updatePerformanceStats(conversionTime: number): void {
    if (!this.options.performanceTracking) return;

    this.stats.performance.averageConversionTimeMs = 
      (this.stats.performance.averageConversionTimeMs * (this.stats.conversions.successful - 1) + conversionTime) / 
      this.stats.conversions.successful;

    if (conversionTime > this.stats.performance.slowestConversionMs) {
      this.stats.performance.slowestConversionMs = conversionTime;
    }

    if (conversionTime < this.stats.performance.fastestConversionMs) {
      this.stats.performance.fastestConversionMs = conversionTime;
    }

    this.stats.performance.cacheHitRate = 
      this.stats.conversions.cached / this.stats.conversions.total;
  }

  private recordValidationErrors(errors: string[]): void {
    for (const error of errors) {
      const count = this.validationErrorCounts.get(error) || 0;
      this.validationErrorCounts.set(error, count + 1);
    }

    // Update common errors in stats
    this.stats.validation.commonErrors = Array.from(this.validationErrorCounts.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5); // Keep top 5 errors
  }

  private recordDebugConversion(
    input: any,
    output: FrontendCoordinate,
    conversionTime: number,
    format: CoordinateFormat
  ): void {
    this.debugInfo.lastConversions.unshift({
      timestamp: Date.now(),
      input,
      output,
      conversionTimeMs: conversionTime,
      format,
    });

    // Keep only last 10 conversions
    if (this.debugInfo.lastConversions.length > 10) {
      this.debugInfo.lastConversions.pop();
    }
  }

  private setupPerformanceMonitoring(): void {
    if (!this.options.performanceTracking) return;

    // Monitor coordinate system health
    setInterval(() => {
      const status = this.getSystemStatus();
      this.debugInfo.coordinateSystemHealth = status.healthy ? 100 : 
        Math.max(0, 100 - (status.stats.conversions.failed / Math.max(status.stats.conversions.total, 1)) * 100);
    }, 5000);
  }
}

// Export singleton instance for global use
export const coordinateBridge = new CoordinateBridge({
  enableDebugMode: process.env.NODE_ENV === 'development',
  performanceTracking: true,
});