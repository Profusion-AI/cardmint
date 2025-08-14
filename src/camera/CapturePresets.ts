import { CameraConfig } from './CameraStateMachine';
import { createLogger } from '../utils/logger';

const logger = createLogger('capture-presets');

export enum PresetType {
  CATALOG = 'catalog',
  SWEEP = 'sweep',
  FOCUS_STACK = 'focus_stack',
}

export interface PresetConfig extends CameraConfig {
  name: string;
  description: string;
  captureCount: number;
  delayBetweenCapturesMs?: number;
  lightingMode?: 'diffuse' | 'specular' | 'cross_polarized';
  exposureBracketing?: {
    enabled: boolean;
    steps: number;
    evStep: number;
  };
  focusBracketing?: {
    enabled: boolean;
    steps: number;
    stepSize: number;
  };
  tiltAngles?: number[]; // For sweep mode
}

export class CapturePresets {
  private presets: Map<PresetType, PresetConfig>;
  
  constructor() {
    this.presets = new Map();
    this.initializePresets();
  }
  
  private initializePresets(): void {
    // Flat catalog preset - single shot with diffuse lighting
    this.presets.set(PresetType.CATALOG, {
      name: 'Flat Catalog',
      description: 'Single shot with diffuse light for catalog documentation',
      captureCount: 1,
      shutterSpeed: '1/125',
      iso: 100,
      aperture: 'f/8',
      driveMode: 'single',
      imageFormat: 'RAW+JPEG',
      autoFocus: true,
      lightingMode: 'diffuse',
    });
    
    // Specular sweep - multiple frames with varying angles
    this.presets.set(PresetType.SWEEP, {
      name: 'Specular Sweep',
      description: '5-9 frames with small tilt changes to capture surface details',
      captureCount: 7,
      delayBetweenCapturesMs: 500,
      shutterSpeed: '1/125',
      iso: 100,
      aperture: 'f/8',
      driveMode: 'single',
      imageFormat: 'JPEG',
      autoFocus: true,
      lightingMode: 'specular',
      tiltAngles: [-6, -4, -2, 0, 2, 4, 6], // degrees
    });
    
    // Focus stack - multiple frames with focus variations
    this.presets.set(PresetType.FOCUS_STACK, {
      name: 'Focus Stack',
      description: '3-5 frames across micro-adjusted focus for depth mapping',
      captureCount: 5,
      delayBetweenCapturesMs: 300,
      shutterSpeed: '1/125',
      iso: 100,
      aperture: 'f/5.6', // Shallower DOF for stacking
      driveMode: 'single',
      imageFormat: 'RAW+JPEG',
      autoFocus: false, // Manual focus control
      lightingMode: 'diffuse',
      focusBracketing: {
        enabled: true,
        steps: 5,
        stepSize: 2, // Focus step units
      },
    });
  }
  
  getPreset(type: PresetType): PresetConfig | undefined {
    return this.presets.get(type);
  }
  
  getAllPresets(): PresetConfig[] {
    return Array.from(this.presets.values());
  }
  
  createCustomPreset(config: PresetConfig): void {
    logger.info(`Creating custom preset: ${config.name}`);
    // Store custom presets separately if needed
  }
  
  // Helper to generate camera configurations for each capture in a preset
  generateCaptureSequence(preset: PresetConfig): CameraConfig[] {
    const configs: CameraConfig[] = [];
    
    if (preset.focusBracketing?.enabled) {
      // Generate focus bracketing sequence
      const { steps, stepSize } = preset.focusBracketing;
      const centerStep = Math.floor(steps / 2);
      
      for (let i = 0; i < steps; i++) {
        const focusOffset = (i - centerStep) * stepSize;
        configs.push({
          ...this.extractCameraConfig(preset),
          // Focus offset would be applied via camera API
        });
      }
    } else if (preset.exposureBracketing?.enabled) {
      // Generate exposure bracketing sequence
      const { steps, evStep } = preset.exposureBracketing;
      const centerStep = Math.floor(steps / 2);
      
      for (let i = 0; i < steps; i++) {
        const evOffset = (i - centerStep) * evStep;
        configs.push({
          ...this.extractCameraConfig(preset),
          // EV compensation would be applied via camera API
        });
      }
    } else if (preset.tiltAngles) {
      // Generate tilt angle sequence for sweep
      for (const angle of preset.tiltAngles) {
        configs.push({
          ...this.extractCameraConfig(preset),
          // Tilt angle would trigger lighting change or stage movement
        });
      }
    } else {
      // Single capture
      configs.push(this.extractCameraConfig(preset));
    }
    
    return configs;
  }
  
  private extractCameraConfig(preset: PresetConfig): CameraConfig {
    return {
      shutterSpeed: preset.shutterSpeed,
      iso: preset.iso,
      aperture: preset.aperture,
      driveMode: preset.driveMode,
      imageFormat: preset.imageFormat,
      autoFocus: preset.autoFocus,
    };
  }
  
  // Validate preset compatibility with current camera
  validatePreset(preset: PresetConfig, cameraCapabilities: any): boolean {
    // Check if camera supports required features
    if (preset.imageFormat === 'RAW+JPEG' && !cameraCapabilities.supportsRAW) {
      logger.warn('Camera does not support RAW format');
      return false;
    }
    
    if (preset.focusBracketing?.enabled && !cameraCapabilities.supportsFocusBracketing) {
      logger.warn('Camera does not support focus bracketing');
      return false;
    }
    
    return true;
  }
  
  // Export preset configuration for persistence
  exportPreset(type: PresetType): string {
    const preset = this.presets.get(type);
    if (!preset) {
      throw new Error(`Preset ${type} not found`);
    }
    
    return JSON.stringify(preset, null, 2);
  }
  
  // Import preset configuration
  importPreset(jsonConfig: string): void {
    try {
      const config = JSON.parse(jsonConfig) as PresetConfig;
      
      // Validate required fields
      if (!config.name || !config.captureCount) {
        throw new Error('Invalid preset configuration');
      }
      
      logger.info(`Importing preset: ${config.name}`);
      // Store imported preset
      
    } catch (error) {
      logger.error('Failed to import preset:', error);
      throw error;
    }
  }
}