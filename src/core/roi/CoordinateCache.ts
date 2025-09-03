/**
 * High-Performance Coordinate Caching System
 * 
 * Provides intelligent caching for coordinate conversions with LRU eviction,
 * batch operations, and performance monitoring.
 */

import { createLogger } from '../../utils/logger';
import {
  CoordinateFormat,
  Size,
  CoordinatePerformanceMetrics,
} from './types';

const logger = createLogger('CoordinateCache');

export interface CacheKey {
  sourceCoordinate: string;  // JSON stringified coordinate
  referenceSize: string;     // "widthxheight"
  targetFormat: CoordinateFormat;
  precision?: number;
}

export interface CacheEntry<T = any> {
  value: T;
  accessCount: number;
  lastAccessed: number;
  createdAt: number;
  computationTimeMs: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  avgComputationTimeMs: number;
  memoryUsageBytes: number;
  evictions: number;
  oldestEntryAge: number;
}

export interface BatchCacheResult<T = any> {
  cached: Map<string, T>;
  uncached: Array<{ key: string; data: any }>;
  hitRate: number;
}

/**
 * Advanced LRU cache with performance monitoring and batch operations
 */
export class AdvancedCoordinateCache {
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private maxSize: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private computationTimes: number[] = [];

  constructor(maxSize: number = 2000) {
    this.maxSize = maxSize;
  }

  /**
   * Generate consistent cache key from coordinate data
   */
  private generateKey(
    coordinate: any,
    referenceSize: Size,
    targetFormat: CoordinateFormat,
    precision?: number
  ): string {
    const coordStr = JSON.stringify(coordinate, Object.keys(coordinate).sort());
    const sizeStr = `${referenceSize.width}x${referenceSize.height}`;
    const precStr = precision !== undefined ? `p${precision}` : '';
    return `${targetFormat}_${coordStr}_${sizeStr}_${precStr}`;
  }

  /**
   * Get cached coordinate conversion result
   */
  get<T = any>(
    coordinate: any,
    referenceSize: Size,
    targetFormat: CoordinateFormat,
    precision?: number
  ): T | undefined {
    const key = this.generateKey(coordinate, referenceSize, targetFormat, precision);
    const entry = this.cache.get(key);

    if (entry) {
      this.hits++;
      entry.accessCount++;
      entry.lastAccessed = Date.now();

      // Update LRU order
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.accessOrder.push(key);

      return entry.value as T;
    }

    this.misses++;
    return undefined;
  }

  /**
   * Store coordinate conversion result with performance metrics
   */
  set<T = any>(
    coordinate: any,
    referenceSize: Size,
    targetFormat: CoordinateFormat,
    value: T,
    computationTimeMs: number,
    precision?: number
  ): void {
    const key = this.generateKey(coordinate, referenceSize, targetFormat, precision);
    const now = Date.now();

    // Update computation time statistics
    this.computationTimes.push(computationTimeMs);
    if (this.computationTimes.length > 1000) {
      this.computationTimes.shift();
    }

    // Check if we need to evict entries
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLeastRecentlyUsed();
    }

    const entry: CacheEntry<T> = {
      value,
      accessCount: 1,
      lastAccessed: now,
      createdAt: now,
      computationTimeMs,
    };

    this.cache.set(key, entry);
    this.accessOrder.push(key);
  }

  /**
   * Batch get operation for multiple coordinates
   */
  getBatch<T = any>(
    coordinates: Array<{
      coordinate: any;
      referenceSize: Size;
      targetFormat: CoordinateFormat;
      precision?: number;
    }>
  ): BatchCacheResult<T> {
    const cached = new Map<string, T>();
    const uncached: Array<{ key: string; data: any }> = [];

    for (const item of coordinates) {
      const key = this.generateKey(
        item.coordinate,
        item.referenceSize,
        item.targetFormat,
        item.precision
      );
      
      const result = this.get<T>(
        item.coordinate,
        item.referenceSize,
        item.targetFormat,
        item.precision
      );

      if (result !== undefined) {
        cached.set(key, result);
      } else {
        uncached.push({ key, data: item });
      }
    }

    return {
      cached,
      uncached,
      hitRate: cached.size / coordinates.length,
    };
  }

  /**
   * Batch set operation for multiple coordinates
   */
  setBatch<T = any>(
    results: Array<{
      coordinate: any;
      referenceSize: Size;
      targetFormat: CoordinateFormat;
      value: T;
      computationTimeMs: number;
      precision?: number;
    }>
  ): void {
    for (const result of results) {
      this.set(
        result.coordinate,
        result.referenceSize,
        result.targetFormat,
        result.value,
        result.computationTimeMs,
        result.precision
      );
    }
  }

  /**
   * Precompute and cache common coordinate conversions
   */
  async precomputeCommonConversions(
    commonSizes: Size[],
    sampleCoordinates: any[],
    targetFormats: CoordinateFormat[],
    conversionFunction: (coord: any, size: Size, format: CoordinateFormat) => Promise<any>
  ): Promise<number> {
    let precomputedCount = 0;
    
    logger.info('Starting precomputation of common coordinate conversions', {
      sizes: commonSizes.length,
      coordinates: sampleCoordinates.length,
      formats: targetFormats.length,
    });

    for (const size of commonSizes) {
      for (const coordinate of sampleCoordinates) {
        for (const format of targetFormats) {
          try {
            const startTime = performance.now();
            const result = await conversionFunction(coordinate, size, format);
            const computationTime = performance.now() - startTime;

            this.set(coordinate, size, format, result, computationTime);
            precomputedCount++;
          } catch (error) {
            logger.warn('Failed to precompute conversion', { coordinate, size, format, error });
          }
        }
      }
    }

    logger.info('Precomputation completed', { precomputedCount });
    return precomputedCount;
  }

  /**
   * Evict least recently used entries
   */
  private evictLeastRecentlyUsed(): void {
    if (this.accessOrder.length === 0) return;

    const lruKey = this.accessOrder.shift();
    if (lruKey) {
      this.cache.delete(lruKey);
      this.evictions++;
    }
  }

  /**
   * Clear cache and reset statistics
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.computationTimes = [];
  }

  /**
   * Remove entries matching specific criteria
   */
  invalidate(predicate: (entry: CacheEntry, key: string) => boolean): number {
    let removedCount = 0;
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (predicate(entry, key)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.cache.delete(key);
      const orderIndex = this.accessOrder.indexOf(key);
      if (orderIndex > -1) {
        this.accessOrder.splice(orderIndex, 1);
      }
      removedCount++;
    }

    return removedCount;
  }

  /**
   * Get comprehensive cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    const avgComputationTime = this.computationTimes.length > 0
      ? this.computationTimes.reduce((sum, time) => sum + time, 0) / this.computationTimes.length
      : 0;

    // Estimate memory usage (rough approximation)
    let memoryUsage = 0;
    for (const [key, entry] of this.cache.entries()) {
      memoryUsage += key.length * 2; // UTF-16 characters
      memoryUsage += JSON.stringify(entry.value).length * 2;
      memoryUsage += 64; // Approximate object overhead
    }

    // Find oldest entry
    let oldestAge = 0;
    const now = Date.now();
    for (const entry of this.cache.values()) {
      const age = now - entry.createdAt;
      if (age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      avgComputationTimeMs: avgComputationTime,
      memoryUsageBytes: memoryUsage,
      evictions: this.evictions,
      oldestEntryAge: oldestAge,
    };
  }

  /**
   * Get performance metrics for monitoring
   */
  getPerformanceMetrics(): CoordinatePerformanceMetrics {
    const stats = this.getStats();
    const total = this.hits + this.misses;

    return {
      conversionTimeMs: stats.avgComputationTimeMs,
      cacheHitRate: stats.hitRate,
      totalConversions: total,
      averageConversionTime: stats.avgComputationTimeMs,
    };
  }

  /**
   * Optimize cache by removing cold entries
   */
  optimize(): number {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    const minAccessCount = 2;

    const removed = this.invalidate((entry) => {
      const age = now - entry.lastAccessed;
      return age > maxAge || entry.accessCount < minAccessCount;
    });

    if (removed > 0) {
      logger.info('Cache optimization completed', { removed });
    }

    return removed;
  }

  /**
   * Export cache data for analysis or persistence
   */
  export(): {
    metadata: { size: number; hits: number; misses: number };
    entries: Array<{ key: string; value: any; stats: Omit<CacheEntry, 'value'> }>;
  } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      value: entry.value,
      stats: {
        accessCount: entry.accessCount,
        lastAccessed: entry.lastAccessed,
        createdAt: entry.createdAt,
        computationTimeMs: entry.computationTimeMs,
      },
    }));

    return {
      metadata: {
        size: this.cache.size,
        hits: this.hits,
        misses: this.misses,
      },
      entries,
    };
  }

  /**
   * Import cache data
   */
  import(data: ReturnType<typeof this.export>): void {
    this.clear();
    
    for (const item of data.entries) {
      const entry: CacheEntry = {
        value: item.value,
        accessCount: item.stats.accessCount,
        lastAccessed: item.stats.lastAccessed,
        createdAt: item.stats.createdAt,
        computationTimeMs: item.stats.computationTimeMs,
      };
      
      this.cache.set(item.key, entry);
      this.accessOrder.push(item.key);
    }

    this.hits = data.metadata.hits;
    this.misses = data.metadata.misses;
  }

  /**
   * Get cache health score (0-100)
   */
  getHealthScore(): number {
    const stats = this.getStats();
    let score = 100;

    // Deduct points for low hit rate
    if (stats.hitRate < 0.8) {
      score -= (0.8 - stats.hitRate) * 50;
    }

    // Deduct points for high memory usage
    const memoryMB = stats.memoryUsageBytes / (1024 * 1024);
    if (memoryMB > 50) {
      score -= Math.min((memoryMB - 50) * 2, 30);
    }

    // Deduct points for many evictions
    if (stats.evictions > stats.size * 0.5) {
      score -= 20;
    }

    return Math.max(0, Math.min(100, score));
  }
}