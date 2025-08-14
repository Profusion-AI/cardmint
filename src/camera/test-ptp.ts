#!/usr/bin/env tsx

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger';

const execAsync = promisify(exec);
const logger = createLogger('ptp-test');

async function testPTPConnection() {
  logger.info('Testing PTP (Picture Transfer Protocol) connection to Sony camera');
  
  try {
    // Check if the camera is visible as a PTP device
    logger.info('Checking USB PTP devices...');
    const { stdout: lsusbOutput } = await execAsync('lsusb -v 2>/dev/null | grep -A 10 -B 5 "Sony" || true');
    
    if (lsusbOutput) {
      logger.info('Sony device details:');
      console.log(lsusbOutput);
    }
    
    // Check for MTP/PTP mount points
    logger.info('\nChecking for MTP/PTP mounts...');
    const { stdout: mtpOutput } = await execAsync('ls -la /run/user/*/gvfs/ 2>/dev/null || true');
    if (mtpOutput) {
      console.log(mtpOutput);
    }
    
    // Try to use ptpcam if available
    logger.info('\nTrying ptpcam (if installed)...');
    try {
      const { stdout: ptpInfo } = await execAsync('ptpcam --info 2>&1 || true');
      console.log(ptpInfo);
    } catch (error) {
      logger.info('ptpcam not available');
    }
    
    // Check if we need to set camera to PC Remote mode
    logger.info('\n=== Camera Mode Requirements ===');
    logger.info('For Sony ZV-E10M2 to work with PC control:');
    logger.info('1. Set camera to PC Remote mode:');
    logger.info('   Menu → Network → Ctrl w/ Smartphone → Connection → PC Remote');
    logger.info('2. Set USB Connection mode:');
    logger.info('   Menu → Setup → USB Connection → PC Remote');
    logger.info('3. Set USB LUN Setting:');
    logger.info('   Menu → Setup → USB LUN Setting → Multi');
    logger.info('');
    logger.info('After setting these, disconnect and reconnect the USB cable.');
    
  } catch (error) {
    logger.error('PTP test failed:', error);
  }
}

async function checkCameraRequirements() {
  logger.info('\n=== Checking System Requirements ===');
  
  // Check for required packages
  const packages = [
    { name: 'gphoto2', check: 'gphoto2 --version' },
    { name: 'v4l-utils', check: 'v4l2-ctl --version' },
    { name: 'libusb', check: 'pkg-config --libs libusb-1.0' },
    { name: 'libudev', check: 'pkg-config --libs libudev' },
  ];
  
  for (const pkg of packages) {
    try {
      await execAsync(pkg.check + ' 2>&1');
      logger.info(`✓ ${pkg.name} is installed`);
    } catch {
      logger.warn(`✗ ${pkg.name} is not installed or not in PATH`);
    }
  }
  
  // Check user permissions
  logger.info('\n=== User Permissions ===');
  const { stdout: groups } = await execAsync('groups');
  logger.info(`User groups: ${groups.trim()}`);
  
  if (!groups.includes('video')) {
    logger.warn('User is not in "video" group. Run: sudo usermod -aG video $USER');
  }
  if (!groups.includes('plugdev')) {
    logger.warn('User is not in "plugdev" group. Run: sudo usermod -aG plugdev $USER');
  }
}

async function suggestNextSteps() {
  logger.info('\n=== Suggested Next Steps ===');
  logger.info('1. Install missing packages:');
  logger.info('   sudo dnf install gphoto2 libgphoto2 libgphoto2-devel v4l-utils');
  logger.info('');
  logger.info('2. Set camera to PC Remote mode (see instructions above)');
  logger.info('');
  logger.info('3. Install udev rules for Sony camera:');
  logger.info('   sudo cp /home/profusionai/CardMint/99-sony-camera.rules /etc/udev/rules.d/');
  logger.info('   sudo udevadm control --reload-rules');
  logger.info('   sudo udevadm trigger');
  logger.info('');
  logger.info('4. Reconnect the camera USB cable');
  logger.info('');
  logger.info('5. Test with gphoto2:');
  logger.info('   gphoto2 --auto-detect');
  logger.info('   gphoto2 --summary');
  logger.info('   gphoto2 --capture-image-and-download');
}

async function main() {
  logger.info('Sony ZV-E10M2 Camera Connection Diagnostics');
  logger.info('===========================================\n');
  
  await testPTPConnection();
  await checkCameraRequirements();
  await suggestNextSteps();
}

main().catch(error => {
  logger.error('Diagnostic failed:', error);
  process.exit(1);
});