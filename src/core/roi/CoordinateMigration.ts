/**
 * Coordinate Migration Utilities for CardMint ROI System
 * 
 * Handles one-time migration of existing templates from mixed coordinate systems
 * to unified coordinate abstraction with rollback capability and audit trails.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../../utils/logger';
import {
  CoordinateFormat,
  LegacyCoordinate,
  ValidationResult,
  CoordinateError,
  COORDINATE_SYSTEM_VERSION,
} from './types';
import { UnifiedCoordinateSystem } from './CoordinateSystem';

const logger = createLogger('CoordinateMigration');

export interface MigrationReport {
  version: string;
  timestamp: string;
  sourceFile: string;
  backupFile: string;
  templatesProcessed: number;
  templatesSucceeded: number;
  templatesFailed: number;
  errors: MigrationError[];
  warnings: string[];
  coordinateSystemStats: {
    totalCoordinatesMigrated: number;
    formatDistribution: Record<CoordinateFormat, number>;
    averageMigrationTimeMs: number;
  };
}

export interface MigrationError {
  templateId: string;
  roiKey: string;
  error: string;
  originalData: any;
  attemptedFormat: CoordinateFormat;
}

export interface MigrationOptions {
  targetFormat: CoordinateFormat;
  createBackup: boolean;
  validateBeforeMigration: boolean;
  validateAfterMigration: boolean;
  rollbackOnFailure: boolean;
  dryRun: boolean;
}

export interface MigrationPlan {
  templatesAnalyzed: number;
  coordinatesToMigrate: number;
  estimatedRisks: string[];
  recommendedActions: string[];
  formatBreakdown: Record<string, { currentFormat: CoordinateFormat | 'mixed'; count: number }>;
}

/**
 * Coordinate system migration manager
 */
export class CoordinateMigrationManager {
  private coordinateSystem: UnifiedCoordinateSystem;
  private backupDirectory: string;

  constructor(
    coordinateSystem: UnifiedCoordinateSystem,
    backupDir: string = './data/backups/roi-migration'
  ) {
    this.coordinateSystem = coordinateSystem;
    this.backupDirectory = backupDir;
  }

  /**
   * Analyze existing templates and create migration plan
   */
  async analyzeMigrationNeeds(manifestPath: string): Promise<MigrationPlan> {
    logger.info('Analyzing ROI templates for migration needs', { manifestPath });

    try {
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestData);
      
      const plan: MigrationPlan = {
        templatesAnalyzed: 0,
        coordinatesToMigrate: 0,
        estimatedRisks: [],
        recommendedActions: [],
        formatBreakdown: {},
      };

      for (const [templateId, template] of Object.entries(manifest.templates as any)) {
        plan.templatesAnalyzed++;
        
        let templateFormatConsistency: Set<CoordinateFormat | null> = new Set();
        let templateCoordinateCount = 0;

        // Analyze each ROI in the template
        for (const [roiKey, roiValue] of Object.entries((template as any).rois || {})) {
          if (!roiValue) continue;

          const coordinates = Array.isArray(roiValue) ? roiValue : [roiValue];
          
          for (const coord of coordinates) {
            const format = this.coordinateSystem.detectFormat(coord);
            templateFormatConsistency.add(format);
            templateCoordinateCount++;
            plan.coordinatesToMigrate++;
          }
        }

        // Determine format consistency for this template
        const uniqueFormats = Array.from(templateFormatConsistency).filter(f => f !== null);
        let templateFormat: string;
        
        if (uniqueFormats.length === 0) {
          templateFormat = 'unknown';
          plan.estimatedRisks.push(`Template ${templateId}: No recognizable coordinate formats`);
        } else if (uniqueFormats.length === 1) {
          templateFormat = uniqueFormats[0]!;
        } else {
          templateFormat = 'mixed';
          plan.estimatedRisks.push(`Template ${templateId}: Mixed coordinate formats detected`);
        }

        plan.formatBreakdown[templateId] = {
          currentFormat: templateFormat as any,
          count: templateCoordinateCount,
        };
      }

      // Generate recommendations
      this.generateMigrationRecommendations(plan);

      logger.info('Migration analysis completed', {
        templates: plan.templatesAnalyzed,
        coordinates: plan.coordinatesToMigrate,
        risks: plan.estimatedRisks.length,
      });

      return plan;
    } catch (error) {
      logger.error('Failed to analyze migration needs', error);
      throw new CoordinateError('Migration analysis failed', 'ANALYSIS_ERROR', { manifestPath, error });
    }
  }

  private generateMigrationRecommendations(plan: MigrationPlan): void {
    // Check for high-risk scenarios
    const mixedFormatTemplates = Object.entries(plan.formatBreakdown)
      .filter(([_, info]) => info.currentFormat === 'mixed')
      .length;

    if (mixedFormatTemplates > 0) {
      plan.recommendedActions.push(
        `⚠️ ${mixedFormatTemplates} template(s) have mixed coordinate formats - manual review recommended`
      );
    }

    // Check for coordinate density
    if (plan.coordinatesToMigrate > 100) {
      plan.recommendedActions.push('📊 High coordinate count detected - enable progress tracking');
    }

    // Always recommend backup
    plan.recommendedActions.push('💾 Always create backup before migration');
    
    if (plan.estimatedRisks.length > 0) {
      plan.recommendedActions.push('🔍 Review estimated risks before proceeding');
      plan.recommendedActions.push('🧪 Consider running dry-run migration first');
    }
  }

  /**
   * Perform migration with comprehensive error handling and rollback
   */
  async migrateManifest(
    manifestPath: string,
    options: MigrationOptions
  ): Promise<MigrationReport> {
    const startTime = Date.now();
    
    logger.info('Starting ROI template migration', { 
      manifestPath, 
      options,
      version: COORDINATE_SYSTEM_VERSION 
    });

    // Initialize migration report
    const report: MigrationReport = {
      version: COORDINATE_SYSTEM_VERSION,
      timestamp: new Date().toISOString(),
      sourceFile: manifestPath,
      backupFile: '',
      templatesProcessed: 0,
      templatesSucceeded: 0,
      templatesFailed: 0,
      errors: [],
      warnings: [],
      coordinateSystemStats: {
        totalCoordinatesMigrated: 0,
        formatDistribution: { absolute: 0, percentage: 0, normalized: 0 },
        averageMigrationTimeMs: 0,
      },
    };

    let originalManifest: any;
    let backupPath: string | null = null;

    try {
      // Load original manifest
      const manifestData = await fs.readFile(manifestPath, 'utf-8');
      originalManifest = JSON.parse(manifestData);

      // Create backup if requested
      if (options.createBackup) {
        backupPath = await this.createBackup(manifestPath, originalManifest);
        report.backupFile = backupPath;
        logger.info('Created backup', { backupPath });
      }

      // Pre-migration validation
      if (options.validateBeforeMigration) {
        await this.validateManifest(originalManifest, report);
      }

      // Process each template
      const migratedManifest = { ...originalManifest };
      
      for (const [templateId, template] of Object.entries(originalManifest.templates)) {
        try {
          report.templatesProcessed++;
          
          const migratedTemplate = await this.migrateTemplate(
            templateId,
            template as any,
            options,
            report
          );
          
          migratedManifest.templates[templateId] = migratedTemplate;
          report.templatesSucceeded++;
          
        } catch (error) {
          report.templatesFailed++;
          report.errors.push({
            templateId,
            roiKey: 'template',
            error: error instanceof Error ? error.message : String(error),
            originalData: template,
            attemptedFormat: options.targetFormat,
          });
          
          logger.error(`Failed to migrate template ${templateId}`, error);
        }
      }

      // Add migration metadata
      migratedManifest.coordinateSystemVersion = COORDINATE_SYSTEM_VERSION;
      migratedManifest.migrationTimestamp = report.timestamp;
      migratedManifest.targetFormat = options.targetFormat;

      // Post-migration validation
      if (options.validateAfterMigration) {
        await this.validateMigratedManifest(migratedManifest, report);
      }

      // Write migrated manifest (unless dry run)
      if (!options.dryRun) {
        await fs.writeFile(manifestPath, JSON.stringify(migratedManifest, null, 2));
        logger.info('Migration completed successfully', {
          templates: report.templatesSucceeded,
          failed: report.templatesFailed,
        });
      } else {
        logger.info('Dry run completed - no files modified', {
          templates: report.templatesSucceeded,
          failed: report.templatesFailed,
        });
      }

      // Calculate final statistics
      const totalTime = Date.now() - startTime;
      report.coordinateSystemStats.averageMigrationTimeMs = 
        report.coordinateSystemStats.totalCoordinatesMigrated > 0
          ? totalTime / report.coordinateSystemStats.totalCoordinatesMigrated
          : 0;

      return report;

    } catch (error) {
      logger.error('Migration failed', error);
      
      // Attempt rollback if enabled
      if (options.rollbackOnFailure && backupPath && !options.dryRun) {
        try {
          await this.rollback(manifestPath, backupPath);
          report.warnings.push('Automatic rollback completed due to migration failure');
        } catch (rollbackError) {
          report.errors.push({
            templateId: 'system',
            roiKey: 'rollback',
            error: `Rollback failed: ${rollbackError}`,
            originalData: null,
            attemptedFormat: options.targetFormat,
          });
        }
      }
      
      throw new CoordinateError('Migration failed', 'MIGRATION_ERROR', report);
    }
  }

  private async migrateTemplate(
    templateId: string,
    template: any,
    options: MigrationOptions,
    report: MigrationReport
  ): Promise<any> {
    const migratedTemplate = { ...template };
    
    if (!template.rois) {
      report.warnings.push(`Template ${templateId} has no ROIs to migrate`);
      return migratedTemplate;
    }

    const migratedRois: any = {};
    
    for (const [roiKey, roiValue] of Object.entries(template.rois)) {
      if (!roiValue) {
        migratedRois[roiKey] = roiValue;
        continue;
      }

      try {
        const migratedROI = await this.migrateROI(roiKey, roiValue, options, report);
        migratedRois[roiKey] = migratedROI;
      } catch (error) {
        report.errors.push({
          templateId,
          roiKey,
          error: error instanceof Error ? error.message : String(error),
          originalData: roiValue,
          attemptedFormat: options.targetFormat,
        });
        
        // Keep original on error for safety
        migratedRois[roiKey] = roiValue;
      }
    }

    migratedTemplate.rois = migratedRois;
    return migratedTemplate;
  }

  private async migrateROI(
    roiKey: string,
    roiValue: any,
    options: MigrationOptions,
    report: MigrationReport
  ): Promise<any> {
    if (Array.isArray(roiValue)) {
      // Handle conditional ROI arrays
      return Promise.all(
        roiValue.map(async (item, index) => {
          try {
            return await this.migrateCoordinate(item, options, report);
          } catch (error) {
            logger.warn(`Failed to migrate array item ${index} for ROI ${roiKey}`, error);
            return item; // Keep original on failure
          }
        })
      );
    } else {
      return await this.migrateCoordinate(roiValue, options, report);
    }
  }

  private async migrateCoordinate(
    coordinate: any,
    options: MigrationOptions,
    report: MigrationReport
  ): Promise<any> {
    // Detect current format
    const currentFormat = this.coordinateSystem.detectFormat(coordinate);
    
    if (!currentFormat) {
      throw new CoordinateError('Unable to detect coordinate format', 'FORMAT_DETECTION_ERROR');
    }

    // Update format distribution stats
    report.coordinateSystemStats.formatDistribution[currentFormat]++;
    report.coordinateSystemStats.totalCoordinatesMigrated++;

    // If already in target format, return as-is
    if (currentFormat === options.targetFormat) {
      return coordinate;
    }

    // Create reference size for percentage calculations
    // Use common camera resolution as default
    const referenceSize = { width: 6000, height: 4000 };

    try {
      // Convert to target format
      let migratedCoord: any;

      switch (options.targetFormat) {
        case 'absolute':
          migratedCoord = this.coordinateSystem.toAbsolute(coordinate, referenceSize);
          break;
        case 'percentage':
          migratedCoord = this.coordinateSystem.toPercentage(coordinate, referenceSize);
          break;
        case 'normalized':
          migratedCoord = this.coordinateSystem.toNormalized(coordinate, referenceSize);
          break;
        default:
          throw new CoordinateError(`Unsupported target format: ${options.targetFormat}`, 'UNSUPPORTED_FORMAT');
      }

      // Preserve conditions and metadata
      if (coordinate.conditions) {
        migratedCoord.conditions = coordinate.conditions;
      }

      return migratedCoord;
      
    } catch (error) {
      throw new CoordinateError(
        `Failed to migrate coordinate from ${currentFormat} to ${options.targetFormat}`,
        'COORDINATE_CONVERSION_ERROR',
        { coordinate, currentFormat, targetFormat: options.targetFormat, error }
      );
    }
  }

  private async createBackup(manifestPath: string, manifest: any): Promise<string> {
    // Ensure backup directory exists
    await fs.mkdir(this.backupDirectory, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `roi_manifest_backup_${timestamp}.json`;
    const backupPath = path.join(this.backupDirectory, backupFilename);

    await fs.writeFile(backupPath, JSON.stringify(manifest, null, 2));
    
    return backupPath;
  }

  private async validateManifest(manifest: any, report: MigrationReport): Promise<void> {
    if (!manifest.templates) {
      throw new CoordinateError('Manifest missing templates section', 'VALIDATION_ERROR');
    }

    let coordinateCount = 0;
    for (const [templateId, template] of Object.entries(manifest.templates as any)) {
      if (!template.rois) {
        report.warnings.push(`Template ${templateId} has no ROIs`);
        continue;
      }

      for (const [roiKey, roiValue] of Object.entries(template.rois)) {
        if (!roiValue) continue;

        const coordinates = Array.isArray(roiValue) ? roiValue : [roiValue];
        for (const coord of coordinates) {
          const validation = this.coordinateSystem.validate(coord);
          if (!validation.valid) {
            report.warnings.push(`Invalid coordinate in ${templateId}.${roiKey}: ${validation.errors.join(', ')}`);
          }
          coordinateCount++;
        }
      }
    }

    logger.info('Pre-migration validation completed', {
      templates: Object.keys(manifest.templates).length,
      coordinates: coordinateCount,
      warnings: report.warnings.length,
    });
  }

  private async validateMigratedManifest(manifest: any, report: MigrationReport): Promise<void> {
    let validCoordinates = 0;
    let invalidCoordinates = 0;

    for (const [templateId, template] of Object.entries(manifest.templates as any)) {
      if (!template.rois) continue;

      for (const [roiKey, roiValue] of Object.entries(template.rois)) {
        if (!roiValue) continue;

        const coordinates = Array.isArray(roiValue) ? roiValue : [roiValue];
        for (const coord of coordinates) {
          const validation = this.coordinateSystem.validate(coord);
          if (validation.valid) {
            validCoordinates++;
          } else {
            invalidCoordinates++;
            report.warnings.push(
              `Post-migration validation failed for ${templateId}.${roiKey}: ${validation.errors.join(', ')}`
            );
          }
        }
      }
    }

    logger.info('Post-migration validation completed', {
      valid: validCoordinates,
      invalid: invalidCoordinates,
    });

    if (invalidCoordinates > 0) {
      throw new CoordinateError(
        `Migration resulted in ${invalidCoordinates} invalid coordinates`,
        'POST_MIGRATION_VALIDATION_ERROR'
      );
    }
  }

  private async rollback(manifestPath: string, backupPath: string): Promise<void> {
    logger.info('Performing rollback', { manifestPath, backupPath });
    
    const backupData = await fs.readFile(backupPath, 'utf-8');
    await fs.writeFile(manifestPath, backupData);
    
    logger.info('Rollback completed successfully');
  }

  /**
   * Get migration history from backup directory
   */
  async getMigrationHistory(): Promise<Array<{ file: string; timestamp: Date; size: number }>> {
    try {
      const files = await fs.readdir(this.backupDirectory);
      const backupFiles = files
        .filter(f => f.startsWith('roi_manifest_backup_') && f.endsWith('.json'))
        .map(async f => {
          const filePath = path.join(this.backupDirectory, f);
          const stats = await fs.stat(filePath);
          const timestampMatch = f.match(/roi_manifest_backup_(.+)\.json/);
          const timestamp = timestampMatch 
            ? new Date(timestampMatch[1].replace(/-/g, ':'))
            : stats.mtime;
          
          return {
            file: f,
            timestamp,
            size: stats.size,
          };
        });

      return Promise.all(backupFiles);
    } catch (error) {
      logger.error('Failed to get migration history', error);
      return [];
    }
  }

  /**
   * Clean up old backups (keep last N backups)
   */
  async cleanupBackups(keepCount: number = 5): Promise<number> {
    const history = await this.getMigrationHistory();
    
    if (history.length <= keepCount) {
      return 0;
    }

    // Sort by timestamp (newest first) and remove old ones
    const sorted = history.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const toDelete = sorted.slice(keepCount);

    let deletedCount = 0;
    for (const backup of toDelete) {
      try {
        await fs.unlink(path.join(this.backupDirectory, backup.file));
        deletedCount++;
      } catch (error) {
        logger.warn(`Failed to delete backup ${backup.file}`, error);
      }
    }

    logger.info(`Cleaned up ${deletedCount} old backups`);
    return deletedCount;
  }
}