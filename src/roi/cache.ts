/**
 * Multi-Level Caching System for ROI Processing
 * 
 * Implements coordinate cache, crop cache, and probe cache with LRU eviction
 * and memory management to stay within 256MB RSS limit.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { AbsoluteCoordinate, PercentageCoordinate, ImageFeatures, LayoutFamilyId } from './types';
import { createROILogger } from '../platform/logger/pino';

const logger = createROILogger('cache');

// Cache entry interfaces
export interface CoordinateCacheEntry {
  absolute: AbsoluteCoordinate;
  imageSize: { width: number; height: number };
  timestamp: number;
  accessCount: number;
}

export interface CropCacheEntry {
  cropData: Buffer; // PNG compressed crop
  timestamp: number;
  accessCount: number;
  sizeBytes: number;
}

export interface ProbeCacheEntry {
  features: ImageFeatures;
  confidence: number;
  timestamp: number;
  accessCount: number;
  processingMs: number;
}

// Cache statistics for monitoring
export interface CacheStats {
  coordinateCache: {
    size: number;
    hitRate: number;
    totalRequests: number;
    memoryMB: number;
  };
  cropCache: {
    size: number;
    hitRate: number;
    totalRequests: number;
    memoryMB: number;
  };
  probeCache: {
    size: number;
    hitRate: number;
    totalRequests: number;
    memoryMB: number;
  };
  totalMemoryMB: number;
}

// LRU cache implementation with size and memory limits
class LRUCache<K, V> {
  private cache = new Map<K, V & { _lruTimestamp: number; _lruAccessCount: number }>();
  private accessCount = 0;
  private hitCount = 0;
  
  constructor(
    private maxSize: number,
    private maxMemoryMB: number,
    private getItemSizeBytes: (item: V) => number
  ) {}
  
  get(key: K): V | undefined {
    this.accessCount++;
    const item = this.cache.get(key);
    
    if (item) {
      this.hitCount++;
      item._lruTimestamp = Date.now();
      item._lruAccessCount++;
      
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, item);
      
      const { _lruTimestamp, _lruAccessCount, ...value } = item;
      return value as V;
    }
    
    return undefined;
  }
  
  set(key: K, value: V): void {
    const item = {
      ...value,
      _lruTimestamp: Date.now(),
      _lruAccessCount: 1,
    } as V & { _lruTimestamp: number; _lruAccessCount: number };
    
    // Check if we need to evict items
    this.cache.set(key, item);
    this.enforceConstraints();
  }
  
  private enforceConstraints(): void {
    // Enforce size limit
    while (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    // Enforce memory limit
    const currentMemoryMB = this.getMemoryUsageMB();
    if (currentMemoryMB > this.maxMemoryMB) {
      this.evictByMemory(currentMemoryMB - this.maxMemoryMB);
    }
  }
  
  private evictByMemory(targetMBToFree: number): void {
    const entries = Array.from(this.cache.entries());
    
    // Sort by access frequency and recency (LRU with access count)
    entries.sort((a, b) => {
      const scoreA = a[1]._lruAccessCount * Math.log(Date.now() - a[1]._lruTimestamp + 1);
      const scoreB = b[1]._lruAccessCount * Math.log(Date.now() - b[1]._lruTimestamp + 1);
      return scoreA - scoreB; // Lower score = more likely to evict
    });
    
    let freedMB = 0;
    for (const [key, value] of entries) {
      if (freedMB >= targetMBToFree) break;
      
      const itemSizeMB = this.getItemSizeBytes(value as V) / (1024 * 1024);
      this.cache.delete(key);
      freedMB += itemSizeMB;
    }
    
    logger.debug({
      evictedItems: entries.length - this.cache.size,
      freedMB: freedMB.toFixed(2),
      remainingItems: this.cache.size,
    }, 'Cache eviction completed');
  }
  
  private getMemoryUsageMB(): number {
    let totalBytes = 0;
    
    for (const value of this.cache.values()) {
      totalBytes += this.getItemSizeBytes(value as V);
    }
    
    return totalBytes / (1024 * 1024);
  }
  
  size(): number {
    return this.cache.size;
  }
  
  clear(): void {
    this.cache.clear();
    this.accessCount = 0;
    this.hitCount = 0;
  }
  
  getHitRate(): number {
    return this.accessCount > 0 ? this.hitCount / this.accessCount : 0;
  }
  
  getStats(): { size: number; hitRate: number; totalRequests: number; memoryMB: number } {
    return {
      size: this.cache.size,
      hitRate: this.getHitRate(),
      totalRequests: this.accessCount,
      memoryMB: this.getMemoryUsageMB(),
    };
  }
}

// Multi-level cache manager
export class MultiLevelCache {
  private coordinateCache: LRUCache<string, CoordinateCacheEntry>;
  private cropCache: LRUCache<string, CropCacheEntry>;
  private probeCache: LRUCache<string, ProbeCacheEntry>;
  
  constructor(options: {
    coordinateCacheSize?: number;
    cropCacheSize?: number;
    probeCacheSize?: number;
    maxMemoryMB?: number;
    persistentCachePath?: string;
  } = {}) {
    const {
      coordinateCacheSize = 500,
      cropCacheSize = 200,
      probeCacheSize = 1000,
      maxMemoryMB = 200, // Reserve 56MB for other operations
    } = options;
    
    // Allocate memory budget across caches
    const coordMemoryMB = maxMemoryMB * 0.1; // 10% for coordinates (small data)
    const cropMemoryMB = maxMemoryMB * 0.7;   // 70% for crops (largest data)
    const probeMemoryMB = maxMemoryMB * 0.2;  // 20% for features (medium data)
    
    this.coordinateCache = new LRUCache(
      coordinateCacheSize,
      coordMemoryMB,
      this.getCoordinateSize
    );
    
    this.cropCache = new LRUCache(
      cropCacheSize,
      cropMemoryMB,
      this.getCropSize
    );
    
    this.probeCache = new LRUCache(
      probeCacheSize,
      probeMemoryMB,
      this.getProbeSize
    );
    
    logger.info({
      coordinateCacheSize,
      cropCacheSize,
      probeCacheSize,
      maxMemoryMB,
    }, 'Multi-level cache initialized');
  }
  
  // Coordinate cache methods
  getCoordinate(key: string): AbsoluteCoordinate | undefined {
    const entry = this.coordinateCache.get(key);
    return entry?.absolute;
  }
  
  setCoordinate(
    percentage: PercentageCoordinate,
    imageSize: { width: number; height: number },
    cameraId?: string,
    familyId?: LayoutFamilyId
  ): AbsoluteCoordinate {
    const key = this.generateCoordinateKey(percentage, imageSize, cameraId, familyId);
    
    const absolute: AbsoluteCoordinate = {
      x: Math.floor(percentage.x * imageSize.width),
      y: Math.floor(percentage.y * imageSize.height),
      w: Math.floor(percentage.w * imageSize.width),
      h: Math.floor(percentage.h * imageSize.height),
    };
    
    const entry: CoordinateCacheEntry = {
      absolute,
      imageSize,
      timestamp: Date.now(),
      accessCount: 1,
    };
    
    this.coordinateCache.set(key, entry);
    return absolute;
  }
  
  private generateCoordinateKey(
    coords: PercentageCoordinate,
    imageSize: { width: number; height: number },
    cameraId?: string,
    familyId?: LayoutFamilyId
  ): string {
    const baseKey = `${coords.x.toFixed(6)},${coords.y.toFixed(6)},${coords.w.toFixed(6)},${coords.h.toFixed(6)}`;
    const sizeKey = `${imageSize.width}x${imageSize.height}`;
    const contextKey = `${cameraId || 'default'}:${familyId || 'default'}`;
    return `${baseKey}@${sizeKey}#${contextKey}`;
  }
  
  // Crop cache methods
  getCrop(imageSHA: string, roiId: string, scale: number): Buffer | undefined {
    const key = `${imageSHA}:${roiId}:${scale}`;
    const entry = this.cropCache.get(key);
    return entry?.cropData;
  }
  
  setCrop(imageSHA: string, roiId: string, scale: number, cropData: Buffer): void {
    const key = `${imageSHA}:${roiId}:${scale}`;
    const entry: CropCacheEntry = {
      cropData,
      timestamp: Date.now(),
      accessCount: 1,
      sizeBytes: cropData.length,
    };
    
    this.cropCache.set(key, entry);
  }
  
  // Probe cache methods  
  getProbe(imageSHA: string, regionId: string): ImageFeatures | undefined {
    const key = `${imageSHA}:${regionId}`;
    const entry = this.probeCache.get(key);
    return entry?.features;
  }
  
  setProbe(
    imageSHA: string, 
    regionId: string, 
    features: ImageFeatures, 
    confidence: number,
    processingMs: number
  ): void {
    const key = `${imageSHA}:${regionId}`;
    const entry: ProbeCacheEntry = {
      features,
      confidence,
      timestamp: Date.now(),
      accessCount: 1,
      processingMs,
    };
    
    this.probeCache.set(key, entry);
  }
  
  // Memory size calculation methods
  private getCoordinateSize(entry: CoordinateCacheEntry): number {
    // Approximate size: 4 numbers * 8 bytes + overhead
    return 64;
  }
  
  private getCropSize(entry: CropCacheEntry): number {
    return entry.sizeBytes + 64; // Buffer size + metadata overhead
  }
  
  private getProbeSize(entry: ProbeCacheEntry): number {
    // Approximate size for ImageFeatures object + metadata
    return 256;
  }
  
  // Global cache management
  clear(): void {
    this.coordinateCache.clear();
    this.cropCache.clear();
    this.probeCache.clear();
    logger.info('All caches cleared');
  }
  
  getStats(): CacheStats {
    const coordStats = this.coordinateCache.getStats();
    const cropStats = this.cropCache.getStats();
    const probeStats = this.probeCache.getStats();
    
    return {
      coordinateCache: coordStats,
      cropCache: cropStats,
      probeCache: probeStats,
      totalMemoryMB: coordStats.memoryMB + cropStats.memoryMB + probeStats.memoryMB,
    };
  }
  
  // Health check for memory pressure
  checkMemoryPressure(): {
    withinLimits: boolean;
    totalMemoryMB: number;
    recommendations: string[];
  } {
    const stats = this.getStats();
    const recommendations: string[] = [];
    
    if (stats.totalMemoryMB > 200) {
      recommendations.push('Total cache memory exceeds 200MB limit');
    }
    
    if (stats.cropCache.memoryMB > 140) {
      recommendations.push('Crop cache memory usage high - consider reducing crop cache size');
    }
    
    if (stats.coordinateCache.hitRate < 0.8) {
      recommendations.push('Coordinate cache hit rate low - check key generation logic');
    }
    
    if (stats.cropCache.hitRate < 0.6) {
      recommendations.push('Crop cache hit rate low - may need larger cache or better eviction policy');
    }
    
    return {
      withinLimits: stats.totalMemoryMB <= 200,
      totalMemoryMB: stats.totalMemoryMB,
      recommendations,
    };
  }
  
  // Utility method for image SHA generation
  generateImageSHA(imageData: Buffer, width: number, height: number): string {
    // Simple hash for caching - in production might want crypto.createHash
    let hash = `${width}x${height}:`;
    const sampleSize = Math.min(1000, imageData.length);
    
    for (let i = 0; i < sampleSize; i += 100) {
      hash += imageData[i].toString(16).padStart(2, '0');
    }
    
    // Add a simple checksum
    let checksum = 0;
    for (let i = 0; i < sampleSize; i++) {
      checksum = (checksum + imageData[i]) % 255;
    }
    
    return `${hash}:${checksum.toString(16)}`;
  }
}

// Singleton instance for global use
let globalCache: MultiLevelCache | undefined;

export function getCache(options?: ConstructorParameters<typeof MultiLevelCache>[0]): MultiLevelCache {
  if (!globalCache) {
    globalCache = new MultiLevelCache(options);
  }
  return globalCache;
}

// Utility functions for common caching patterns
export function getCachedCoordinate(
  coords: PercentageCoordinate,
  imageSize: { width: number; height: number },
  cameraId?: string,
  familyId?: LayoutFamilyId
): AbsoluteCoordinate {
  return getCache().setCoordinate(coords, imageSize, cameraId, familyId);
}

export function getCachedCrop(imageSHA: string, roiId: string, scale: number = 1.0): Buffer | undefined {
  return getCache().getCrop(imageSHA, roiId, scale);
}

export function setCachedCrop(imageSHA: string, roiId: string, scale: number, cropData: Buffer): void {
  getCache().setCrop(imageSHA, roiId, scale, cropData);
}

export function getCachedProbe(imageSHA: string, regionId: string): ImageFeatures | undefined {
  return getCache().getProbe(imageSHA, regionId);
}

export function setCachedProbe(
  imageSHA: string, 
  regionId: string, 
  features: ImageFeatures, 
  confidence: number,
  processingMs: number
): void {
  getCache().setProbe(imageSHA, regionId, features, confidence, processingMs);
}

// Performance monitoring hook
export function logCachePerformance(): void {
  const stats = getCache().getStats();
  const health = getCache().checkMemoryPressure();
  
  logger.info({
    ...stats,
    memoryPressure: health,
  }, 'Cache performance report');
  
  if (!health.withinLimits) {
    logger.warn({
      totalMemoryMB: health.totalMemoryMB,
      recommendations: health.recommendations,
    }, 'Cache memory pressure detected');
  }
}