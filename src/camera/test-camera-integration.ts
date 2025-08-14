#!/usr/bin/env tsx

import { CameraService } from './CameraService';
import { PresetType } from './CapturePresets';
import { GPhoto2Camera } from './GPhoto2Camera';
import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';

const logger = createLogger('camera-test');

async function testV4L2Camera() {
  logger.info('=== Testing V4L2 Camera Interface ===');
  
  try {
    // Check for video devices
    const videoDevices = await fs.readdir('/dev').then(files => 
      files.filter(f => f.startsWith('video'))
    );
    
    logger.info(`Found video devices: ${videoDevices.join(', ')}`);
    
    for (const device of videoDevices) {
      const devicePath = `/dev/${device}`;
      try {
        // Check if it's a Sony camera
        const { execSync } = require('child_process');
        const info = execSync(`v4l2-ctl -d ${devicePath} --info 2>/dev/null || true`, { encoding: 'utf-8' });
        
        if (info.includes('Sony') || info.includes('ZV-E10')) {
          logger.info(`Sony camera found on ${devicePath}`);
          
          // Get device capabilities
          const caps = execSync(`v4l2-ctl -d ${devicePath} --list-formats-ext 2>/dev/null || true`, { encoding: 'utf-8' });
          logger.info('Supported formats:', caps.substring(0, 500));
          
          // Try to capture a frame
          const outputFile = `/tmp/v4l2_test_${Date.now()}.jpg`;
          try {
            execSync(`v4l2-ctl -d ${devicePath} --stream-mmap --stream-count=1 --stream-to=${outputFile}`, { encoding: 'utf-8' });
            logger.info(`✓ Frame captured to ${outputFile}`);
            
            const stats = await fs.stat(outputFile);
            logger.info(`  File size: ${stats.size} bytes`);
          } catch (captureError) {
            logger.warn(`Could not capture from ${devicePath}:`, captureError);
          }
        }
      } catch (error) {
        // Not a video capture device or not accessible
      }
    }
  } catch (error) {
    logger.error('V4L2 test failed:', error);
  }
}

async function testGPhoto2Camera() {
  logger.info('=== Testing GPhoto2 Camera Interface ===');
  
  const camera = new GPhoto2Camera();
  
  try {
    // Detect camera
    const detected = await camera.detectCamera();
    
    if (!detected) {
      logger.warn('No camera detected via gphoto2');
      logger.info('Make sure gphoto2 is installed: sudo dnf install gphoto2');
      return;
    }
    
    logger.info(`Camera detected: ${detected.model} on ${detected.port}`);
    logger.info(`Capabilities: ${detected.capabilities.join(', ')}`);
    
    // Connect to camera
    const connected = await camera.connect();
    
    if (!connected) {
      logger.error('Failed to connect to camera');
      return;
    }
    
    logger.info('✓ Connected to camera');
    
    // Get camera configuration
    const config = await camera.getConfig();
    logger.info('Camera configuration available');
    
    // Test capture
    logger.info('Testing image capture...');
    const startTime = Date.now();
    const imagePath = await camera.captureImage(`/tmp/gphoto2_test_${Date.now()}.jpg`);
    const captureTime = Date.now() - startTime;
    
    logger.info(`✓ Image captured in ${captureTime}ms`);
    logger.info(`  Path: ${imagePath}`);
    
    const stats = await fs.stat(imagePath);
    logger.info(`  Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    // Test preview (faster, lower quality)
    logger.info('Testing preview capture...');
    const previewStart = Date.now();
    const previewPath = await camera.capturePreview(`/tmp/gphoto2_preview_${Date.now()}.jpg`);
    const previewTime = Date.now() - previewStart;
    
    logger.info(`✓ Preview captured in ${previewTime}ms`);
    logger.info(`  Path: ${previewPath}`);
    
    // Disconnect
    await camera.disconnect();
    logger.info('✓ Disconnected from camera');
    
  } catch (error) {
    logger.error('GPhoto2 test failed:', error);
  }
}

async function testCameraService() {
  logger.info('=== Testing Camera Service ===');
  
  const cameraService = new CameraService();
  
  try {
    // Initialize camera service
    logger.info('Initializing camera service...');
    const initialized = await cameraService.initialize();
    
    if (!initialized) {
      logger.error('Failed to initialize camera service');
      return;
    }
    
    const cameraPath = cameraService.getCameraPath();
    const cameraState = cameraService.getCameraState();
    
    logger.info(`✓ Camera service initialized`);
    logger.info(`  Path: ${cameraPath}`);
    logger.info(`  State: ${cameraState}`);
    
    // Test single capture
    logger.info('Testing single capture...');
    const session = await cameraService.captureWithPreset(PresetType.CATALOG);
    
    if (session) {
      logger.info(`✓ Capture session completed`);
      logger.info(`  Run ID: ${session.runId}`);
      logger.info(`  Duration: ${session.endTime! - session.startTime}ms`);
      logger.info(`  Captures: ${session.captures.length}`);
      
      for (const capture of session.captures) {
        logger.info(`  - ${capture.path}`);
      }
    } else {
      logger.error('Capture session failed');
    }
    
    // Get health metrics
    const health = cameraService.getHealthMetrics();
    logger.info('Camera health metrics:');
    logger.info(`  State: ${health.state}`);
    logger.info(`  Camera Path: ${health.cameraPath}`);
    logger.info(`  Success Ratio: ${(health.successRatio * 100).toFixed(1)}%`);
    logger.info(`  Last Capture Latency: ${health.lastCaptureLatency}ms`);
    
    // Shutdown
    await cameraService.shutdown();
    logger.info('✓ Camera service shutdown complete');
    
  } catch (error) {
    logger.error('Camera service test failed:', error);
    await cameraService.shutdown();
  }
}

async function runIntegrationTests() {
  logger.info('Starting Camera Integration Tests');
  logger.info('================================\n');
  
  // Test V4L2 first (native Linux interface)
  await testV4L2Camera();
  
  logger.info('');
  
  // Test GPhoto2 (if installed)
  await testGPhoto2Camera();
  
  logger.info('');
  
  // Test our camera service
  await testCameraService();
  
  logger.info('\n================================');
  logger.info('Integration Tests Complete');
}

// Run tests
runIntegrationTests().catch(error => {
  logger.error('Test suite failed:', error);
  process.exit(1);
});