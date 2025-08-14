#!/usr/bin/env node

import { program } from 'commander';
import { CameraService } from './CameraService';
import { PresetType } from './CapturePresets';
import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';

const logger = createLogger('camera-cli');

async function captureCommand(
  mode: string,
  options: { output?: string; preset?: string; count?: string }
) {
  const cameraService = new CameraService();
  
  try {
    logger.info('Initializing camera...');
    const initialized = await cameraService.initialize();
    
    if (!initialized) {
      logger.error('Failed to initialize camera');
      process.exit(1);
    }
    
    const cameraPath = cameraService.getCameraPath();
    logger.info(`Camera initialized via: ${cameraPath}`);
    
    // Determine preset
    let preset: PresetType = PresetType.CATALOG;
    if (options.preset) {
      if (options.preset in PresetType) {
        preset = options.preset as PresetType;
      } else {
        logger.error(`Invalid preset: ${options.preset}`);
        logger.info(`Available presets: ${Object.values(PresetType).join(', ')}`);
        process.exit(1);
      }
    }
    
    // Set output directory
    const outputDir = options.output || `/tmp/cardmint_${Date.now()}`;
    logger.info(`Output directory: ${outputDir}`);
    
    // Capture based on mode
    if (mode === 'single') {
      logger.info(`Capturing single image with preset: ${preset}`);
      
      const session = await cameraService.capture({
        preset,
        outputDir,
        generateSidecar: true,
      });
      
      if (session) {
        logger.info(`✓ Capture completed: ${session.captures.length} images`);
        logger.info(`  Run ID: ${session.runId}`);
        logger.info(`  Duration: ${session.endTime! - session.startTime}ms`);
        
        for (const capture of session.captures) {
          logger.info(`  - ${capture.path}`);
          logger.info(`    ${capture.metadata.exposure} @ ISO ${capture.metadata.iso}, ${capture.metadata.aperture}`);
        }
      } else {
        logger.error('Capture failed');
        process.exit(1);
      }
      
    } else if (mode === 'burst') {
      const count = parseInt(options.count || '5');
      logger.info(`Capturing burst of ${count} images`);
      
      const results = [];
      for (let i = 0; i < count; i++) {
        logger.info(`Capturing ${i + 1}/${count}...`);
        
        const session = await cameraService.capture({
          preset: PresetType.CATALOG,
          outputDir: `${outputDir}/burst_${i}`,
          generateSidecar: true,
        });
        
        if (session) {
          results.push(session);
        }
        
        // Small delay between bursts
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      logger.info(`✓ Burst capture completed: ${results.length} successful`);
      
    } else if (mode === 'test') {
      logger.info('Running camera test sequence...');
      
      // Test all presets
      for (const presetType of Object.values(PresetType)) {
        logger.info(`Testing preset: ${presetType}`);
        
        const session = await cameraService.capture({
          preset: presetType as PresetType,
          outputDir: `${outputDir}/${presetType}`,
          generateSidecar: true,
        });
        
        if (session) {
          logger.info(`  ✓ ${presetType}: ${session.captures.length} captures in ${session.endTime! - session.startTime}ms`);
        } else {
          logger.error(`  ✗ ${presetType}: Failed`);
        }
      }
      
      // Display health metrics
      const health = cameraService.getHealthMetrics();
      logger.info('\nCamera Health Metrics:');
      logger.info(`  State: ${health.state}`);
      logger.info(`  Camera Path: ${health.cameraPath}`);
      logger.info(`  Success Ratio: ${(health.successRatio * 100).toFixed(1)}%`);
      logger.info(`  Last Capture Latency: ${health.lastCaptureLatency}ms`);
    }
    
    await cameraService.shutdown();
    
  } catch (error) {
    logger.error('Camera CLI error:', error);
    await cameraService.shutdown();
    process.exit(1);
  }
}

async function reliabilityTest(cycles: string) {
  const cameraService = new CameraService();
  const numCycles = parseInt(cycles);
  
  try {
    logger.info(`Starting ${numCycles}-cycle reliability test`);
    
    const initialized = await cameraService.initialize();
    if (!initialized) {
      logger.error('Failed to initialize camera');
      process.exit(1);
    }
    
    const results = {
      success: 0,
      failed: 0,
      latencies: [] as number[],
      errors: [] as string[],
    };
    
    for (let i = 0; i < numCycles; i++) {
      logger.info(`Cycle ${i + 1}/${numCycles}`);
      
      const startTime = Date.now();
      
      const session = await cameraService.capture({
        preset: PresetType.CATALOG,
        outputDir: `/tmp/reliability_test/${i}`,
      });
      
      if (session) {
        const latency = Date.now() - startTime;
        results.success++;
        results.latencies.push(latency);
        logger.info(`  ✓ Success (${latency}ms)`);
      } else {
        results.failed++;
        logger.error(`  ✗ Failed`);
      }
      
      // Small delay between cycles
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Calculate statistics
    const successRate = (results.success / numCycles * 100).toFixed(1);
    const avgLatency = results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length;
    const minLatency = Math.min(...results.latencies);
    const maxLatency = Math.max(...results.latencies);
    
    logger.info('\n=== Reliability Test Results ===');
    logger.info(`Success Rate: ${successRate}% (${results.success}/${numCycles})`);
    logger.info(`Average Latency: ${avgLatency.toFixed(0)}ms`);
    logger.info(`Min Latency: ${minLatency}ms`);
    logger.info(`Max Latency: ${maxLatency}ms`);
    
    // Save results to file
    const resultsPath = '/tmp/camera_reliability_results.json';
    await fs.writeFile(resultsPath, JSON.stringify({
      cycles: numCycles,
      successRate,
      ...results,
      stats: {
        avgLatency,
        minLatency,
        maxLatency,
      },
    }, null, 2));
    
    logger.info(`\nResults saved to: ${resultsPath}`);
    
    await cameraService.shutdown();
    
  } catch (error) {
    logger.error('Reliability test error:', error);
    await cameraService.shutdown();
    process.exit(1);
  }
}

// CLI setup
program
  .name('cardmint-cam')
  .description('CardMint Camera CLI')
  .version('1.0.0');

program
  .command('capture <mode>')
  .description('Capture images (modes: single, burst, test)')
  .option('-o, --output <dir>', 'Output directory')
  .option('-p, --preset <preset>', 'Capture preset (catalog, sweep, focus_stack)')
  .option('-c, --count <count>', 'Number of captures for burst mode', '5')
  .action(captureCommand);

program
  .command('reliability <cycles>')
  .description('Run reliability test with N capture cycles')
  .action(reliabilityTest);

program
  .command('list-presets')
  .description('List available capture presets')
  .action(() => {
    logger.info('Available capture presets:');
    logger.info('  - catalog: Single shot with diffuse lighting');
    logger.info('  - sweep: 5-9 frames with tilt variations');
    logger.info('  - focus_stack: 3-5 frames with focus bracketing');
  });

program.parse(process.argv);