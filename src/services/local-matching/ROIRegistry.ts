/**
 * ROI Registry - Camera geometry calibration and ROI management
 * Provides stable pixel anchors for consistent region extraction
 * 
 * @deprecated Consider migrating to EnhancedROIRegistry for new features
 * Location: /src/core/roi/EnhancedROIRegistry.ts
 * 
 * This legacy ROI Registry is maintained for backward compatibility but new
 * development should use the Enhanced ROI Registry which provides:
 * - Unified coordinate system (pixel/percentage/normalized)
 * - Performance optimizations with caching
 * - Future-proof architecture for multi-TCG support
 * - Type-safe coordinate conversions
 * 
 * Migration is optional - Enhanced ROI Registry wraps this class to maintain
 * 100% backward compatibility while adding modern features.
 * 
 * @see /docs/ROI-DEPRECATION-PLAN.md for migration guidance
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ROIRegistry');

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Percent-based rectangle (relative to calibration resolution)
export interface RectPercent {
  x_pct: number; // 0..1 fraction of width
  y_pct: number; // 0..1 fraction of height
  width_pct: number; // 0..1 fraction of width
  height_pct: number; // 0..1 fraction of height
}

export interface ROIConditions {
  promoOnly?: boolean;
  firstEditionOnly?: boolean;
  era?: 'classic' | 'neo' | 'modern' | 'promo';
}

// A single ROI entry can be pixel- or percent-based and optionally conditional
export type ROIEntry = (
  Rectangle | RectPercent
) & { conditions?: ROIConditions };

// ROIs may be a single entry or a list of conditional variants
export type ROIValue = ROIEntry | ROIEntry[];

export interface ROIDefinition {
  set_icon?: ROIValue;
  bottom_band?: ROIValue;
  promo_star?: ROIValue;
  first_edition_stamp?: ROIValue; // Neo-era stamp region
  regulation_mark?: ROIValue; // SV era only
  card_name?: ROIValue; // Top-of-card title region
  artwork?: ROIValue; // For pHash extraction
  card_bounds?: ROIValue; // Full card boundary
}

export interface ROITemplate {
  id: string;
  name: string;
  description: string;
  layout_hint: string;
  era: string;
  rois: ROIDefinition;
  rotation_deg: number;
  confidence: number;
  conditions?: ROIConditions; // Optional default conditions for the template
}

export interface ROIManifest {
  version: string;
  camera_calibration: {
    resolution: { width: number; height: number };
    last_calibrated: string;
    calibration_card: string;
  };
  default_template: string;
  templates: Record<string, ROITemplate>;
}

export class ROIRegistry {
  private manifest: ROIManifest | null = null;
  private initialized = false;
  
  constructor(
    private readonly dataRoot: string = process.env.DATA_ROOT || './data'
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      logger.info('Initializing ROI Registry...');
      
      const manifestPath = path.join(this.dataRoot, 'roi_templates.json');
      
      // Check if manifest exists, create default if not
      try {
        const manifestData = await fs.readFile(manifestPath, 'utf-8');
        this.manifest = JSON.parse(manifestData) as ROIManifest;
        logger.info(`Loaded ROI manifest with ${Object.keys(this.manifest.templates).length} templates`);
      } catch (error) {
        logger.info('ROI manifest not found, creating default...');
        this.manifest = this.createDefaultManifest();
        await this.saveManifest();
      }
      
      this.initialized = true;
      
    } catch (error) {
      logger.error('Failed to initialize ROI Registry:', error);
      throw error;
    }
  }

  private createDefaultManifest(): ROIManifest {
    return {
      version: "1.0",
      camera_calibration: {
        resolution: { width: 6000, height: 4000 }, // Sony ZVE10M2 default
        last_calibrated: new Date().toISOString(),
        calibration_card: "reference_card_001"
      },
      default_template: "modern_standard",
      templates: {
        // Modern standard layout (SWSH, SV era)
        modern_standard: {
          id: "modern_standard",
          name: "Modern Standard",
          description: "Standard layout for SWSH and SV era cards",
          layout_hint: "modern",
          era: "modern",
          rotation_deg: 0,
          confidence: 0.95,
          rois: {
            set_icon: { x: 4200, y: 200, width: 600, height: 400 }, // Top-right
            bottom_band: { x: 300, y: 3400, width: 5400, height: 400 }, // Bottom info strip
            promo_star: { x: 4800, y: 300, width: 300, height: 300 }, // Promo star location
            first_edition_stamp: { x: 0, y: 0, width: 0, height: 0 }, // Not applicable for modern
            regulation_mark: { x: 5200, y: 3600, width: 200, height: 200 }, // SV regulation mark
            card_name: { x: 700, y: 650, width: 4200, height: 280 }, // Name bar region
            artwork: { x: 600, y: 800, width: 4800, height: 2400 }, // Main artwork area
            card_bounds: { x: 100, y: 100, width: 5800, height: 3800 }
          }
        },
        
        // Neo era layout (1st/2nd generation)
        neo_era: {
          id: "neo_era",
          name: "Neo Era",
          description: "Layout for Neo Genesis, Neo Discovery, Neo Revelation, Neo Destiny",
          layout_hint: "neo",
          era: "neo",
          rotation_deg: 0,
          confidence: 0.90,
          rois: {
            set_icon: { x: 4000, y: 250, width: 700, height: 350 }, // Neo set symbol
            bottom_band: { x: 200, y: 3300, width: 5600, height: 500 }, // Copyright/number area
            promo_star: { x: 4600, y: 200, width: 400, height: 400 }, // Promo star (if promo)
            first_edition_stamp: { x: 900, y: 640, width: 420, height: 220, conditions: { firstEditionOnly: true } },
            regulation_mark: { x: 0, y: 0, width: 0, height: 0 }, // Not applicable
            card_name: { x: 720, y: 600, width: 4200, height: 260 },
            artwork: { x: 400, y: 600, width: 5200, height: 2400 }, // Main artwork
            card_bounds: { x: 50, y: 50, width: 5900, height: 3900 }
          }
        },
        
        // Base set layout (Classic era)
        base_set: {
          id: "base_set",
          name: "Base Set Era",
          description: "Layout for Base Set, Jungle, Fossil, and similar classic cards",
          layout_hint: "classic",
          era: "classic",
          rotation_deg: 0,
          confidence: 0.85,
          rois: {
            set_icon: { x: 4100, y: 300, width: 600, height: 400 }, // Classic set symbol position
            bottom_band: { x: 150, y: 3200, width: 5700, height: 600 }, // Number/copyright area
            promo_star: { x: 4800, y: 200, width: 300, height: 300 }, // Promo indicator
            first_edition_stamp: { x: 860, y: 620, width: 420, height: 220, conditions: { firstEditionOnly: true } },
            regulation_mark: { x: 0, y: 0, width: 0, height: 0 }, // Not applicable
            card_name: { x: 700, y: 600, width: 4200, height: 260 },
            artwork: { x: 300, y: 500, width: 5400, height: 2500 }, // Artwork area
            card_bounds: { x: 0, y: 0, width: 6000, height: 4000 }
          }
        },
        
        // McDonald's promo layout
        mcd_promo: {
          id: "mcd_promo",
          name: "McDonald's Promo",
          description: "Special layout for McDonald's promotional cards",
          layout_hint: "mcd_2019",
          era: "promo",
          rotation_deg: 0,
          confidence: 0.80,
          rois: {
            set_icon: { x: 4500, y: 400, width: 400, height: 300 }, // McD logo position
            bottom_band: { x: 300, y: 3500, width: 5400, height: 300 }, // Small info strip
            promo_star: { x: 200, y: 200, width: 400, height: 400 }, // McDonald's logo
            regulation_mark: { x: 0, y: 0, width: 0, height: 0 }, // Not applicable
            first_edition_stamp: { x: 0, y: 0, width: 0, height: 0 },
            card_name: { x: 720, y: 640, width: 4200, height: 260 },
            artwork: { x: 800, y: 900, width: 4400, height: 2200 }, // Compact artwork
            card_bounds: { x: 100, y: 100, width: 5800, height: 3800 }
          }
        }
      }
    };
  }

  async getROITemplate(templateId: string): Promise<ROITemplate | null> {
    if (!this.initialized) await this.initialize();
    
    if (!this.manifest) return null;
    
    return this.manifest.templates[templateId] || null;
  }

  async getROITemplateByHint(layoutHint: string): Promise<ROITemplate | null> {
    if (!this.initialized) await this.initialize();
    
    if (!this.manifest) return null;
    
    // Find template by layout hint
    for (const template of Object.values(this.manifest.templates)) {
      if (template.layout_hint === layoutHint) {
        return template;
      }
    }
    
    return null;
  }

  async getDefaultROITemplate(): Promise<ROITemplate | null> {
    if (!this.initialized) await this.initialize();
    
    if (!this.manifest) return null;
    
    const defaultId = this.manifest.default_template;
    return this.manifest.templates[defaultId] || null;
  }

  async extractROI(imageBuffer: Buffer, roi: Rectangle, rotation: number = 0): Promise<Buffer> {
    // This would integrate with sharp or canvas for actual ROI extraction
    // For now, return placeholder implementation
    logger.debug(`Extracting ROI: ${roi.x},${roi.y} ${roi.width}x${roi.height} (rotation: ${rotation}°)`);
    
    // TODO: Implement actual ROI extraction with sharp
    // const image = sharp(imageBuffer);
    // if (rotation !== 0) {
    //   image.rotate(rotation);
    // }
    // return image.extract({
    //   left: roi.x,
    //   top: roi.y,
    //   width: roi.width,
    //   height: roi.height
    // }).toBuffer();
    
    return imageBuffer; // Placeholder
  }

  async calibrateROIs(referenceImagePath: string): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    logger.info(`Calibrating ROI templates using reference: ${referenceImagePath}`);
    
    // TODO: Implement interactive ROI calibration
    // This would allow manual adjustment of ROI positions
    // using a reference card image
    
    logger.info('ROI calibration completed (placeholder)');
  }

  async updateTemplate(templateId: string, updates: Partial<ROITemplate>): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    if (!this.manifest) throw new Error('Manifest not loaded');
    
    if (!this.manifest.templates[templateId]) {
      throw new Error(`Template ${templateId} not found`);
    }
    
    // Update template
    this.manifest.templates[templateId] = {
      ...this.manifest.templates[templateId],
      ...updates
    };
    
    // Save manifest
    await this.saveManifest();
    
    logger.info(`Updated ROI template: ${templateId}`);
  }

  async addTemplate(template: ROITemplate): Promise<void> {
    if (!this.initialized) await this.initialize();
    
    if (!this.manifest) throw new Error('Manifest not loaded');
    
    this.manifest.templates[template.id] = template;
    await this.saveManifest();
    
    logger.info(`Added ROI template: ${template.id}`);
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifest) throw new Error('No manifest to save');
    
    const manifestPath = path.join(this.dataRoot, 'roi_templates.json');
    await fs.writeFile(manifestPath, JSON.stringify(this.manifest, null, 2));
    
    logger.debug('ROI manifest saved');
  }

  async getStats(): Promise<Record<string, any>> {
    if (!this.initialized) await this.initialize();
    
    return {
      initialized: this.initialized,
      templatesCount: this.manifest ? Object.keys(this.manifest.templates).length : 0,
      defaultTemplate: this.manifest?.default_template,
      cameraResolution: this.manifest?.camera_calibration.resolution,
      lastCalibrated: this.manifest?.camera_calibration.last_calibrated
    };
  }

  // Utility method to get ROI by hint with fallback
  async getROIDefinition(hints?: { 
    roi_template?: string; 
    layout_hint?: string; 
    orientation_deg?: number;
    promo?: boolean;
    firstEdition?: boolean;
    era?: 'classic' | 'neo' | 'modern' | 'promo';
  }): Promise<{ rois: ROIDefinition; rotation: number; template: ROITemplate }> {
    
    let template: ROITemplate | null = null;
    
    // Try to get template by specific ID first
    if (hints?.roi_template) {
      template = await this.getROITemplate(hints.roi_template);
    }
    
    // Fallback to layout hint
    if (!template && hints?.layout_hint) {
      template = await this.getROITemplateByHint(hints.layout_hint);
    }
    
    // Final fallback to default
    if (!template) {
      template = await this.getDefaultROITemplate();
    }
    
    if (!template) {
      throw new Error('No ROI template available');
    }
    
    return {
      rois: template.rois,
      rotation: hints?.orientation_deg || template.rotation_deg,
      template
    };
  }

  /**
   * Returns ROI rectangles scaled from the calibrated resolution to a given image size.
   * This prevents out-of-bounds crops when input images differ from calibration.
   */
  async getScaledROIs(
    imageWidth: number,
    imageHeight: number,
    hints?: { 
      roi_template?: string; 
      layout_hint?: string; 
      orientation_deg?: number;
      promo?: boolean;
      firstEdition?: boolean;
      era?: 'classic' | 'neo' | 'modern' | 'promo';
    }
  ): Promise<{ rois: Required<ROIDefinition>; rotation: number; scaleX: number; scaleY: number }> {
    if (!this.initialized) await this.initialize();

    const { rois, rotation, template } = await this.getROIDefinition(hints);

    const calibW = this.manifest?.camera_calibration.resolution.width || imageWidth;
    const calibH = this.manifest?.camera_calibration.resolution.height || imageHeight;
    const scaleX = imageWidth / calibW;
    const scaleY = imageHeight / calibH;

    const matchesConditions = (conds?: ROIConditions): boolean => {
      if (!conds) return true;
      if (typeof conds.promoOnly === 'boolean') {
        if (!!hints?.promo !== conds.promoOnly) return false;
      }
      if (typeof conds.firstEditionOnly === 'boolean') {
        if (!!hints?.firstEdition !== conds.firstEditionOnly) return false;
      }
      if (conds.era) {
        const eraHint = hints?.era || template.era as any;
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

    const toPx = (entry?: ROIEntry): Rectangle => {
      if (!entry) return { x: 0, y: 0, width: 0, height: 0 };
      const anyEntry = entry as any;
      if (typeof anyEntry.x_pct === 'number') {
        // Percent based; compute directly from target image size
        return {
          x: Math.round((anyEntry.x_pct as number) * imageWidth),
          y: Math.round((anyEntry.y_pct as number) * imageHeight),
          width: Math.round((anyEntry.width_pct as number) * imageWidth),
          height: Math.round((anyEntry.height_pct as number) * imageHeight),
        };
      } else {
        // Pixel based at calibration; scale to target image
        const r = entry as Rectangle;
        return {
          x: Math.round(r.x * scaleX),
          y: Math.round(r.y * scaleY),
          width: Math.round(r.width * scaleX),
          height: Math.round(r.height * scaleY),
        };
      }
    };

    const scaled: Required<ROIDefinition> = {
      set_icon: toPx(pickEntry(rois.set_icon)),
      bottom_band: toPx(pickEntry(rois.bottom_band)),
      promo_star: toPx(pickEntry(rois.promo_star)),
      first_edition_stamp: toPx(pickEntry(rois.first_edition_stamp)),
      regulation_mark: toPx(pickEntry(rois.regulation_mark)),
      card_name: toPx(pickEntry(rois.card_name)),
      artwork: toPx(pickEntry(rois.artwork)),
      card_bounds: toPx(pickEntry(rois.card_bounds)),
    } as Required<ROIDefinition>;

    return { rois: scaled, rotation, scaleX, scaleY };
  }
}

// Global registry instance
export const roiRegistry = new ROIRegistry();
