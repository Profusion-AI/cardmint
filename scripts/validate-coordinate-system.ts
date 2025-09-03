#!/usr/bin/env npx ts-node

/**
 * Coordinate System Validation Script
 * 
 * Quick validation to ensure the new coordinate abstraction layer
 * maintains compatibility with existing ROI system.
 */

import { UnifiedCoordinateSystem } from '../src/core/roi/CoordinateSystem';
import { EnhancedROIRegistry } from '../src/core/roi/EnhancedROIRegistry';
import { ROIRegistry } from '../src/services/local-matching/ROIRegistry';
// import { createLogger } from '../src/utils/logger';

// Remove unused logger for now
// const logger = createLogger('CoordinateValidation');

interface ValidationResult {
  testName: string;
  passed: boolean;
  details: string;
  metrics?: {
    conversionTimeMs: number;
    accuracy: number;
  };
}

class CoordinateSystemValidator {
  private coordinateSystem: UnifiedCoordinateSystem;
  private enhancedRegistry: EnhancedROIRegistry;
  private legacyRegistry: ROIRegistry;
  private results: ValidationResult[] = [];

  constructor() {
    this.coordinateSystem = new UnifiedCoordinateSystem({
      enableCaching: true,
      performanceTracking: true,
      validationMode: 'lenient',
    });
    
    this.enhancedRegistry = new EnhancedROIRegistry();
    this.legacyRegistry = new ROIRegistry();
  }

  async validateAll(): Promise<void> {
    console.log('🔧 Starting Coordinate System Validation...\n');

    await this.initializeRegistries();
    
    // Core coordinate system tests
    this.testCoordinateDetection();
    this.testCoordinateConversion();
    this.testPerformance();
    
    // ROI Registry integration tests
    await this.testROICompatibility();
    await this.testTemplateResolution();
    
    // Report results
    this.reportResults();
  }

  private async initializeRegistries(): Promise<void> {
    try {
      await this.enhancedRegistry.initialize();
      await this.legacyRegistry.initialize();
      this.addResult('Registry Initialization', true, 'All registries initialized successfully');
    } catch (error) {
      this.addResult('Registry Initialization', false, `Failed to initialize: ${error}`);
    }
  }

  private testCoordinateDetection(): void {
    const testCases = [
      { coord: { x: 100, y: 200, width: 300, height: 400 }, expected: 'absolute' },
      { coord: { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 }, expected: 'percentage' },
      { coord: { x_norm: 0.1, y_norm: 0.2, width_norm: 0.3, height_norm: 0.4 }, expected: 'normalized' },
      { coord: { invalid: 'data' }, expected: null },
    ];

    let passed = 0;
    for (const testCase of testCases) {
      const detected = this.coordinateSystem.detectFormat(testCase.coord);
      if (detected === testCase.expected) {
        passed++;
      }
    }

    this.addResult(
      'Coordinate Format Detection',
      passed === testCases.length,
      `${passed}/${testCases.length} detection tests passed`
    );
  }

  private testCoordinateConversion(): void {
    const referenceSize = { width: 6000, height: 4000 };
    const testCoord = { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 };

    try {
      const startTime = performance.now();
      
      // Test conversions
      const absolute = this.coordinateSystem.toAbsolute(testCoord, referenceSize);
      // Test that percentage and normalized conversions work without using the results
      this.coordinateSystem.toPercentage(absolute, referenceSize);
      this.coordinateSystem.toNormalized(testCoord, referenceSize);
      
      const conversionTime = performance.now() - startTime;

      // Verify conversion accuracy
      const expectedAbsolute = {
        x: 600,   // 10% of 6000
        y: 800,   // 20% of 4000
        width: 1800,  // 30% of 6000
        height: 1600, // 40% of 4000
      };

      const accurate = 
        absolute.x === expectedAbsolute.x &&
        absolute.y === expectedAbsolute.y &&
        absolute.width === expectedAbsolute.width &&
        absolute.height === expectedAbsolute.height;

      this.addResult(
        'Coordinate Conversion',
        accurate && conversionTime < 5,
        accurate ? `Conversions accurate in ${conversionTime.toFixed(2)}ms` : 'Conversion accuracy failed',
        { conversionTimeMs: conversionTime, accuracy: accurate ? 100 : 0 }
      );
    } catch (error) {
      this.addResult('Coordinate Conversion', false, `Conversion failed: ${error}`);
    }
  }

  private testPerformance(): void {
    const referenceSize = { width: 6000, height: 4000 };
    const testCoords = [
      { x_pct: 10, y_pct: 20, width_pct: 30, height_pct: 40 },
      { x: 600, y: 800, width: 1800, height: 1600 },
      { x_norm: 0.1, y_norm: 0.2, width_norm: 0.3, height_norm: 0.4 },
    ];

    const TARGET_TIME_MS = 1; // Sub-millisecond target per conversion
    const times: number[] = [];

    for (const coord of testCoords) {
      const start = performance.now();
      try {
        this.coordinateSystem.toAbsolute(coord, referenceSize);
        this.coordinateSystem.toPercentage(coord, referenceSize);
      } catch (error) {
        // Ignore errors for performance test
      }
      times.push(performance.now() - start);
    }

    const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
    const maxTime = Math.max(...times);

    this.addResult(
      'Performance Target',
      maxTime < TARGET_TIME_MS,
      `Avg: ${avgTime.toFixed(3)}ms, Max: ${maxTime.toFixed(3)}ms (Target: <${TARGET_TIME_MS}ms)`,
      { conversionTimeMs: avgTime, accuracy: maxTime < TARGET_TIME_MS ? 100 : 0 }
    );
  }

  private async testROICompatibility(): Promise<void> {
    const testImageSize = { width: 3000, height: 2000 };
    
    try {
      // Test with default template
      const legacyResult = await this.legacyRegistry.getScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      const enhancedResult = await this.enhancedRegistry.getScaledROIs(
        testImageSize.width,
        testImageSize.height,
        { roi_template: 'modern_standard' }
      );

      // Check if results are compatible
      let compatible = true;
      let maxDiff = 0;

      for (const [roiName, legacyROI] of Object.entries(legacyResult.rois)) {
        const enhancedROI = enhancedResult.rois[roiName as keyof typeof enhancedResult.rois];
        
        // Both should be Rectangle type (absolute coordinates) after getScaledROIs
        const legacyRect = legacyROI as any;
        const enhancedRect = enhancedROI as any;
        
        const diff = Math.max(
          Math.abs(enhancedRect.x - legacyRect.x),
          Math.abs(enhancedRect.y - legacyRect.y),
          Math.abs(enhancedRect.width - legacyRect.width),
          Math.abs(enhancedRect.height - legacyRect.height)
        );
        
        maxDiff = Math.max(maxDiff, diff);
        
        if (diff > 2) { // Allow 2px tolerance
          compatible = false;
        }
      }

      this.addResult(
        'ROI Compatibility',
        compatible,
        compatible 
          ? `Legacy and enhanced ROI results match within ${maxDiff}px`
          : `Results differ by up to ${maxDiff}px (exceeds 2px tolerance)`
      );
    } catch (error) {
      this.addResult('ROI Compatibility', false, `Compatibility test failed: ${error}`);
    }
  }

  private async testTemplateResolution(): Promise<void> {
    const testCases = [
      { hint: { roi_template: 'modern_standard' }, expectedTemplate: 'modern_standard' },
      { hint: { layout_hint: 'neo' }, expectedTemplate: 'neo_era' },
      { hint: { layout_hint: 'modern' }, expectedTemplate: 'modern_standard' },
      { hint: {}, expectedTemplate: 'modern_standard' }, // Should fallback to default
    ];

    let passed = 0;
    for (const testCase of testCases) {
      try {
        const result = await this.enhancedRegistry.getEnhancedScaledROIs(
          3000, 2000, testCase.hint
        );
        
        if (result.metadata.templateId === testCase.expectedTemplate) {
          passed++;
        }
      } catch (error) {
        // Template resolution failed
      }
    }

    this.addResult(
      'Template Resolution',
      passed === testCases.length,
      `${passed}/${testCases.length} template resolution tests passed`
    );
  }

  private addResult(testName: string, passed: boolean, details: string, metrics?: { conversionTimeMs: number; accuracy: number }): void {
    this.results.push({ testName, passed, details, metrics });
  }

  private reportResults(): void {
    console.log('\n📊 Validation Results:\n');
    
    let totalPassed = 0;
    for (const result of this.results) {
      const status = result.passed ? '✅' : '❌';
      console.log(`${status} ${result.testName}`);
      console.log(`   ${result.details}`);
      if (result.metrics) {
        console.log(`   Performance: ${result.metrics.conversionTimeMs.toFixed(3)}ms, Accuracy: ${result.metrics.accuracy}%`);
      }
      console.log();
      
      if (result.passed) totalPassed++;
    }

    const overallSuccess = totalPassed === this.results.length;
    const successRate = (totalPassed / this.results.length * 100).toFixed(1);
    
    console.log('━'.repeat(60));
    console.log(`Overall: ${overallSuccess ? '✅' : '❌'} ${totalPassed}/${this.results.length} tests passed (${successRate}%)`);
    
    if (overallSuccess) {
      console.log('🎉 Coordinate system validation PASSED - ready for production!');
    } else {
      console.log('⚠️  Some validation tests failed - review before deployment');
      process.exit(1);
    }

    // Output performance metrics
    const performanceMetrics = this.coordinateSystem.getPerformanceMetrics();
    console.log('\n📈 System Metrics:');
    console.log(`   Total conversions: ${performanceMetrics.totalConversions}`);
    console.log(`   Cache hit rate: ${(performanceMetrics.cacheHitRate * 100).toFixed(1)}%`);
    console.log(`   Average conversion time: ${performanceMetrics.averageConversionTime.toFixed(3)}ms`);
  }
}

// Run validation if this script is executed directly
if (require.main === module) {
  const validator = new CoordinateSystemValidator();
  validator.validateAll().catch((error) => {
    console.error('❌ Validation failed:', error);
    process.exit(1);
  });
}

export { CoordinateSystemValidator };