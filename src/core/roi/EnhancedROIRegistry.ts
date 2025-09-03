/**
 * Enhanced ROI Registry with Coordinate Abstraction Layer
 * 
 * Extends the existing ROI Registry with unified coordinate system support,
 * maintaining backward compatibility while enabling new features.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../../utils/logger';
import {
  CoordinateFormat,
  Size,
  LegacyCoordinate,
  AbsoluteCoordinate,
  PercentageCoordinate,
  ValidationResult,
  CoordinateSystemConfig,
  CoordinateError,
  COORDINATE_SYSTEM_VERSION,
} from './types';
import { UnifiedCoordinateSystem } from './CoordinateSystem';
import { AdvancedCoordinateCache } from './CoordinateCache';
import { CoordinateMigrationManager, MigrationOptions, MigrationReport } from './CoordinateMigration';

// Re-export existing types for compatibility
export {
  Rectangle,
  RectPercent,
  ROIConditions,
  ROIEntry,
  ROIValue,
  ROIDefinition,
  ROITemplate,
  ROIManifest,
} from '../../services/local-matching/ROIRegistry';

import {
  Rectangle,
  RectPercent,
  ROIConditions,
  ROIEntry,
  ROIValue,
  ROIDefinition,
  ROITemplate,
  ROIManifest,
} from '../../services/local-matching/ROIRegistry';

const logger = createLogger('EnhancedROIRegistry');

export interface EnhancedROIManifest extends ROIManifest {
  coordinateSystemVersion?: string;
  coordinateFormat?: CoordinateFormat;
  migrationHistory?: Array<{
    version: string;
    timestamp: string;
    format: CoordinateFormat;
  }>;
}

export interface ROIExtractionOptions {
  targetFormat?: CoordinateFormat;
  precision?: number;
  validateCoordinates?: boolean;
  useCache?: boolean;
  clampToBounds?: boolean;
}

export interface ScaledROIResult {
  rois: Required<ROIDefinition>;
  rotation: number;
  scaleX: number;
  scaleY: number;
  coordinateFormat: CoordinateFormat;
  confidence: number;
  metadata: {
    templateId: string;
    cacheHit: boolean;
    conversionTimeMs: number;
  };
}

/**
 * Enhanced ROI Registry with coordinate abstraction
 */
export class EnhancedROIRegistry {
  private manifest: EnhancedROIManifest | null = null;
  private initialized = false;
  private coordinateSystem: UnifiedCoordinateSystem;
  private coordinateCache: AdvancedCoordinateCache;
  private migrationManager: CoordinateMigrationManager;
  private dataRoot: string;

  constructor(
    dataRoot: string = process.env.DATA_ROOT || './data',
    coordinateConfig?: Partial<CoordinateSystemConfig>
  ) {
    this.dataRoot = dataRoot;
    this.coordinateSystem = new UnifiedCoordinateSystem(coordinateConfig);
    this.coordinateCache = new AdvancedCoordinateCache();
    this.migrationManager = new CoordinateMigrationManager(this.coordinateSystem);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      logger.info('Initializing Enhanced ROI Registry...');

      const manifestPath = path.join(this.dataRoot, 'roi_templates.json');

      // Check if manifest exists
      try {
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        this.manifest = JSON.parse(manifestData) as EnhancedROIManifest;

        // Check if migration is needed
        if (this.needsMigration(this.manifest)) {
          logger.info('ROI manifest requires coordinate system migration');
          await this.performMigration(manifestPath);
        }

        logger.info(`Loaded enhanced ROI manifest with ${Object.keys(this.manifest.templates).length} templates`);
      } catch (error) {
        logger.info('ROI manifest not found, creating enhanced default...');
        this.manifest = this.createEnhancedDefaultManifest();
        await this.saveManifest();
      }

      // Precompute common conversions for better performance
      await this.precomputeCommonConversions();

      this.initialized = true;
      logger.info('Enhanced ROI Registry initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize Enhanced ROI Registry:', error);
      throw error;
    }
  }

  private needsMigration(manifest: EnhancedROIManifest): boolean {
    // Check if manifest has coordinate system version
    if (!manifest.coordinateSystemVersion) {
      return true;
    }

    // Check if version is outdated
    if (manifest.coordinateSystemVersion !== COORDINATE_SYSTEM_VERSION) {
      return true;
    }

    return false;
  }

  private async performMigration(manifestPath: string): Promise<void> {
    logger.info('Starting coordinate system migration');

    const migrationOptions: MigrationOptions = {
      targetFormat: 'percentage',
      createBackup: true,
      validateBeforeMigration: true,
      validateAfterMigration: true,
      rollbackOnFailure: true,
      dryRun: false,
    };

    try {
      const report = await this.migrationManager.migrateManifest(manifestPath, migrationOptions);
      
      logger.info('Migration completed successfully', {
        templatesSucceeded: report.templatesSucceeded,
        templatesFailed: report.templatesFailed,
        coordinatesMigrated: report.coordinateSystemStats.totalCoordinatesMigrated,
      });

      // Reload the migrated manifest
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      this.manifest = JSON.parse(manifestData) as EnhancedROIManifest;

    } catch (error) {
      logger.error('Migration failed', error);
      throw new CoordinateError('ROI manifest migration failed', 'MIGRATION_FAILED', error);
    }
  }

  private createEnhancedDefaultManifest(): EnhancedROIManifest {
    const baseManifest = this.createDefaultManifest();
    
    return {
      ...baseManifest,
      coordinateSystemVersion: COORDINATE_SYSTEM_VERSION,
      coordinateFormat: 'percentage',
      migrationHistory: [{
        version: COORDINATE_SYSTEM_VERSION,
        timestamp: new Date().toISOString(),
        format: 'percentage',
      }],
    };
  }

  private createDefaultManifest(): ROIManifest {
    // This mirrors the original ROIRegistry's createDefaultManifest method
    // but uses percentage coordinates by default
    return {
      version: "2.0",
      camera_calibration: {
        resolution: { width: 6000, height: 4000 },
        last_calibrated: new Date().toISOString(),
        calibration_card: "reference_card_001"
      },
      default_template: "modern_standard",
      templates: {
        modern_standard: {
          id: "modern_standard",
          name: "Modern Standard",
          description: "Standard layout for SWSH and SV era cards",
          layout_hint: "modern",
          era: "modern",
          rotation_deg: 0,
          confidence: 0.95,
          rois: {
            set_icon: { x_pct: 70, y_pct: 5, width_pct: 10, height_pct: 10 },
            bottom_band: { x_pct: 5, y_pct: 85, width_pct: 90, height_pct: 10 },
            promo_star: { x_pct: 80, y_pct: 7.5, width_pct: 5, height_pct: 7.5 },
            regulation_mark: { x_pct: 86.7, y_pct: 90, width_pct: 3.3, height_pct: 5 },
            card_name: { x_pct: 11.7, y_pct: 16.25, width_pct: 70, height_pct: 7 },
            artwork: { x_pct: 10, y_pct: 20, width_pct: 80, height_pct: 60 },
            card_bounds: { x_pct: 1.7, y_pct: 2.5, width_pct: 96.6, height_pct: 95 }
          }
        },
        neo_era: {
          id: "neo_era",
          name: "Neo Era",
          description: "Layout for Neo Genesis, Neo Discovery, Neo Revelation, Neo Destiny",
          layout_hint: "neo",
          era: "neo",
          rotation_deg: 0,
          confidence: 0.90,
          rois: {
            set_icon: { x_pct: 66.7, y_pct: 6.25, width_pct: 11.7, height_pct: 8.75 },
            bottom_band: { x_pct: 3.3, y_pct: 82.5, width_pct: 93.3, height_pct: 12.5 },
            promo_star: { x_pct: 76.7, y_pct: 5, width_pct: 6.7, height_pct: 10 },
            first_edition_stamp: { x_pct: 15, y_pct: 16, width_pct: 7, height_pct: 5.5, conditions: { firstEditionOnly: true } },
            card_name: { x_pct: 12, y_pct: 15, width_pct: 70, height_pct: 6.5 },
            artwork: { x_pct: 6.7, y_pct: 15, width_pct: 86.7, height_pct: 60 },
            card_bounds: { x_pct: 0.8, y_pct: 1.25, width_pct: 98.3, height_pct: 97.5 }
          }
        }
      }
    };
  }

  private async precomputeCommonConversions(): Promise<void> {
    if (!this.manifest) return;

    const commonSizes: Size[] = [
      { width: 6000, height: 4000 },  // Sony ZVE10M2
      { width: 4000, height: 3000 },  // 4:3 aspect ratio
      { width: 1920, height: 1080 },  // HD
      { width: 3840, height: 2160 },  // 4K
    ];

    const sampleCoordinates: any[] = [];
    
    // Extract sample coordinates from templates
    for (const template of Object.values(this.manifest.templates)) {
      for (const roiValue of Object.values(template.rois)) {
        if (roiValue) {
          const coordinates = Array.isArray(roiValue) ? roiValue : [roiValue];
          sampleCoordinates.push(...coordinates.slice(0, 2)); // Take first 2 to limit size
        }
      }
    }

    const targetFormats: CoordinateFormat[] = ['absolute', 'percentage'];

    const conversionFunction = async (coord: any, size: Size, format: CoordinateFormat) => {
      switch (format) {
        case 'absolute':
          return this.coordinateSystem.toAbsolute(coord, size);
        case 'percentage':
          return this.coordinateSystem.toPercentage(coord, size);
        case 'normalized':
          return this.coordinateSystem.toNormalized(coord, size);
        default:
          throw new Error(`Unsupported format: ${format}`);
      }
    };

    const precomputedCount = await this.coordinateCache.precomputeCommonConversions(
      commonSizes,
      sampleCoordinates,
      targetFormats,
      conversionFunction
    );

    logger.info(`Precomputed ${precomputedCount} common coordinate conversions`);
  }

  /**
   * Get scaled ROIs with enhanced coordinate handling
   */
  async getEnhancedScaledROIs(
    imageWidth: number,
    imageHeight: number,
    hints?: {
      roi_template?: string;
      layout_hint?: string;
      orientation_deg?: number;
      promo?: boolean;
      firstEdition?: boolean;
      era?: 'classic' | 'neo' | 'modern' | 'promo';
    },
    options: ROIExtractionOptions = {}
  ): Promise<ScaledROIResult> {
    const startTime = performance.now();

    if (!this.initialized) await this.initialize();
    if (!this.manifest) throw new Error('Manifest not loaded');

    const {
      targetFormat = 'absolute',
      precision = 6,
      validateCoordinates = true,
      useCache = true,
      clampToBounds = true,
    } = options;

    // Get template
    let template: ROITemplate | null = null;
    
    if (hints?.roi_template) {
      template = this.manifest.templates[hints.roi_template] || null;
    }
    
    if (!template && hints?.layout_hint) {
      for (const t of Object.values(this.manifest.templates)) {
        if (t.layout_hint === hints.layout_hint) {
          template = t;
          break;
        }
      }
    }
    
    if (!template) {
      const defaultId = this.manifest.default_template;
      template = this.manifest.templates[defaultId] || null;
    }

    if (!template) {
      throw new Error('No ROI template available');
    }

    const imageSize = { width: imageWidth, height: imageHeight };
    const calibSize = this.manifest.camera_calibration.resolution;

    // Check cache first
    let cacheHit = false;
    if (useCache) {
      const cacheResult = this.coordinateCache.get(
        { template: template.id, hints, imageSize },
        imageSize,
        targetFormat,
        precision
      );
      if (cacheResult) {
        cacheHit = true;
        return {
          ...cacheResult,
          metadata: {
            ...cacheResult.metadata,
            cacheHit: true,
            conversionTimeMs: 0,
          },
        };
      }
    }

    // Process conditions
    const matchesConditions = (conds?: ROIConditions): boolean => {
      if (!conds) return true;
      if (typeof conds.promoOnly === 'boolean' && !!hints?.promo !== conds.promoOnly) return false;
      if (typeof conds.firstEditionOnly === 'boolean' && !!hints?.firstEdition !== conds.firstEditionOnly) return false;
      if (conds.era) {
        const eraHint = hints?.era || template!.era as any;
        if (eraHint !== conds.era) return false;
      }
      return true;
    };

    const pickEntry = (val?: ROIValue): ROIEntry | undefined => {
      if (!val) return undefined;
      if (Array.isArray(val)) {
        return val.find(v => matchesConditions((v as any).conditions)) || val[0];
      }
      return matchesConditions((val as any).conditions) ? val : undefined;
    };

    // Convert coordinates using the unified system
    const convertROI = (entry?: ROIEntry): AbsoluteCoordinate => {
      if (!entry) return { x: 0, y: 0, width: 0, height: 0 };

      try {
        const converted = this.coordinateSystem.toAbsolute(entry, imageSize);
        
        if (validateCoordinates) {
          const validation = this.coordinateSystem.validate(converted, 'absolute');
          if (!validation.valid) {
            logger.warn('Invalid converted coordinate', { validation, original: entry });
          }
        }

        if (clampToBounds) {
          return {
            x: Math.max(0, Math.min(converted.x, imageWidth - 1)),
            y: Math.max(0, Math.min(converted.y, imageHeight - 1)),
            width: Math.max(1, Math.min(converted.width, imageWidth - converted.x)),
            height: Math.max(1, Math.min(converted.height, imageHeight - converted.y)),
          };
        }

        return converted;
      } catch (error) {
        logger.error('Failed to convert coordinate', { entry, error });
        return { x: 0, y: 0, width: 0, height: 0 };
      }
    };

    const scaledROIs: Required<ROIDefinition> = {
      set_icon: convertROI(pickEntry(template.rois.set_icon)),
      bottom_band: convertROI(pickEntry(template.rois.bottom_band)),
      promo_star: convertROI(pickEntry(template.rois.promo_star)),
      first_edition_stamp: convertROI(pickEntry(template.rois.first_edition_stamp)),
      regulation_mark: convertROI(pickEntry(template.rois.regulation_mark)),
      card_name: convertROI(pickEntry(template.rois.card_name)),
      artwork: convertROI(pickEntry(template.rois.artwork)),
      card_bounds: convertROI(pickEntry(template.rois.card_bounds)),
    };

    const conversionTime = performance.now() - startTime;
    const scaleX = imageWidth / calibSize.width;
    const scaleY = imageHeight / calibSize.height;

    const result: ScaledROIResult = {
      rois: scaledROIs,
      rotation: hints?.orientation_deg || template.rotation_deg,
      scaleX,
      scaleY,
      coordinateFormat: targetFormat,
      confidence: template.confidence,
      metadata: {
        templateId: template.id,
        cacheHit,
        conversionTimeMs: conversionTime,
      },
    };

    // Cache the result
    if (useCache) {
      this.coordinateCache.set(
        { template: template.id, hints, imageSize },
        imageSize,
        targetFormat,
        result,
        conversionTime,
        precision
      );
    }

    return result;
  }

  /**
   * Get coordinate system performance metrics
   */
  getCoordinateSystemMetrics() {
    return {
      coordinateSystem: this.coordinateSystem.getPerformanceMetrics(),
      cache: this.coordinateCache.getStats(),
      cacheHealth: this.coordinateCache.getHealthScore(),
    };
  }

  /**
   * Optimize coordinate cache
   */
  async optimizeCache(): Promise<number> {
    return this.coordinateCache.optimize();
  }

  /**
   * Get migration history
   */
  getMigrationHistory(): Array<{ version: string; timestamp: string; format: CoordinateFormat }> {
    return this.manifest?.migrationHistory || [];
  }

  /**
   * Export enhanced manifest with coordinate system metadata
   */
  async exportEnhancedManifest(): Promise<EnhancedROIManifest> {
    if (!this.manifest) throw new Error('Manifest not loaded');
    
    return {
      ...this.manifest,
      coordinateSystemVersion: COORDINATE_SYSTEM_VERSION,
      exportedAt: new Date().toISOString(),
    };
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifest) throw new Error('No manifest to save');

    const manifestPath = path.join(this.dataRoot, 'roi_templates.json');
    await fs.writeFile(manifestPath, JSON.stringify(this.manifest, null, 2));
    
    logger.debug('Enhanced ROI manifest saved');
  }

  /**
   * Legacy compatibility methods - delegate to coordinate system
   */
  
  async getROITemplate(templateId: string): Promise<ROITemplate | null> {
    if (!this.initialized) await this.initialize();
    return this.manifest?.templates[templateId] || null;
  }

  async getDefaultROITemplate(): Promise<ROITemplate | null> {
    if (!this.initialized) await this.initialize();
    if (!this.manifest) return null;
    
    const defaultId = this.manifest.default_template;
    return this.manifest.templates[defaultId] || null;
  }

  // Maintain backward compatibility with original getScaledROIs method
  async getScaledROIs(
    imageWidth: number,
    imageHeight: number,
    hints?: any
  ) {
    const result = await this.getEnhancedScaledROIs(imageWidth, imageHeight, hints);
    return {
      rois: result.rois,
      rotation: result.rotation,
      scaleX: result.scaleX,
      scaleY: result.scaleY,
    };
  }
}

// Export singleton instance for global use
export const enhancedROIRegistry = new EnhancedROIRegistry();