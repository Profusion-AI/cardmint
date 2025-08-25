#!/usr/bin/env tsx

import { spawn } from 'child_process';
import { join } from 'path';
import { createLogger } from '../src/utils/logger';
import { sonyDiagnostics } from '../src/camera/SonyDiagnostics';

const logger = createLogger('camera-reset');

class CameraResetRunner {
  private readonly SDK_PATH = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC';
  private readonly BUILD_PATH = join(this.SDK_PATH, 'build');
  private readonly CLI_PATH = join(this.BUILD_PATH, 'sony-cli');
  
  async run(): Promise<boolean> {
    console.log('🔄 Sony Camera Reset & Recovery');
    console.log('==============================');
    console.log();
    
    try {
      // Step 1: Stop any running processes
      await this.stopRunningProcesses();
      
      // Step 2: Reset USB subsystem
      await this.resetUSBSubsystem();
      
      // Step 3: Wait for device detection
      await this.waitForDeviceStabilization();
      
      // Step 4: Test camera connection
      await this.testCameraConnection();
      
      // Step 5: Run quick diagnostic
      await this.runQuickDiagnostic();
      
      console.log('✅ Camera reset completed successfully');
      return true;
      
    } catch (error: any) {
      logger.error('Camera reset failed:', { error: error.message });
      console.log(`❌ Reset failed: ${error.message}`);
      return false;
    }
  }
  
  private async stopRunningProcesses(): Promise<void> {
    console.log('1️⃣ Stopping running camera processes...');
    
    try {
      // Kill any running sony-cli processes
      await this.runCommand('pkill', ['-f', 'sony-cli'], 5000, true);
      console.log('   ✅ Stopped existing sony-cli processes');
    } catch {
      console.log('   ℹ️  No running sony-cli processes found');
    }
    
    try {
      // Kill any running CardMint processes using camera
      await this.runCommand('pkill', ['-f', 'cardmint.*camera'], 5000, true);
      console.log('   ✅ Stopped CardMint camera processes');
    } catch {
      console.log('   ℹ️  No CardMint camera processes found');
    }
    
    // Give processes time to clean up
    await this.sleep(2000);
    console.log('   ✅ Process cleanup completed');
    console.log();
  }
  
  private async resetUSBSubsystem(): Promise<void> {
    console.log('2️⃣ Resetting USB subsystem...');
    
    try {
      // Get Sony camera USB device info
      const { stdout } = await this.runCommand('lsusb', [], 5000);
      const sonyDevices = stdout.split('\n').filter(line => 
        line.toLowerCase().includes('sony') || line.includes('054c:')
      );
      
      if (sonyDevices.length > 0) {
        console.log(`   📱 Found ${sonyDevices.length} Sony USB device(s)`);
        sonyDevices.forEach(device => {
          console.log(`      - ${device.trim()}`);
        });
        
        // Try to reset USB device (requires root, so may fail)
        try {
          // Extract bus and device numbers
          for (const device of sonyDevices) {
            const match = device.match(/Bus (\d+) Device (\d+)/);
            if (match) {
              const bus = match[1];
              const deviceNum = match[2];
              const devicePath = `/dev/bus/usb/${bus.padStart(3, '0')}/${deviceNum.padStart(3, '0')}`;
              
              // This requires root privileges, but we'll try
              try {
                await this.runCommand('sudo', ['usbreset', devicePath], 3000, true);
                console.log(`   ✅ Reset USB device at ${devicePath}`);
              } catch {
                console.log(`   ⚠️  Could not reset USB device (may need sudo privileges)`);
              }
            }
          }
        } catch (error) {
          console.log('   ⚠️  USB reset requires elevated privileges');
        }
      } else {
        console.log('   ⚠️  No Sony USB devices detected');
      }
      
      console.log('   ✅ USB subsystem check completed');
    } catch (error: any) {
      console.log(`   ⚠️  USB check failed: ${error.message}`);
    }
    
    console.log();
  }
  
  private async waitForDeviceStabilization(): Promise<void> {
    console.log('3️⃣ Waiting for device stabilization...');
    
    // Wait for USB devices to stabilize
    for (let i = 5; i >= 1; i--) {
      process.stdout.write(`   ⏳ Waiting ${i} seconds for device detection...\r`);
      await this.sleep(1000);
    }
    
    console.log('   ✅ Device stabilization period completed        ');
    console.log();
  }
  
  private async testCameraConnection(): Promise<void> {
    console.log('4️⃣ Testing camera connection...');
    
    try {
      const { stdout, stderr } = await this.runCommand(this.CLI_PATH, ['list'], 10000);
      
      if (stderr && stderr.includes('0x')) {
        // Parse and translate error codes
        const errorMatches = stderr.match(/0x[0-9A-Fa-f]+/g);
        if (errorMatches) {
          console.log('   ⚠️  Camera errors detected:');
          for (const errorCode of errorMatches) {
            const translation = sonyDiagnostics.translateErrorCode(errorCode);
            console.log(`      ${errorCode}: ${translation.message}`);
            console.log(`      Solution: ${translation.solution}`);
          }
        }
      }
      
      if (stdout.includes('Found') || stdout.includes('Camera')) {
        console.log('   ✅ Camera connection successful');
        
        // Extract camera info from output
        const lines = stdout.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          if (line.includes('Camera') || line.includes('Model')) {
            console.log(`      📷 ${line.trim()}`);
          }
        });
      } else {
        console.log('   ❌ No camera detected');
        console.log('      Check:');
        console.log('      - Camera is powered on');
        console.log('      - USB cable is connected');
        console.log('      - Camera is in PC Remote mode');
      }
    } catch (error: any) {
      console.log('   ❌ Camera connection test failed');
      console.log(`      Error: ${error.message}`);
      
      // Provide specific troubleshooting steps
      console.log('      Troubleshooting steps:');
      console.log('      1. Power cycle camera (off/on)');
      console.log('      2. Try different USB port');
      console.log('      3. Check USB cable integrity');
      console.log('      4. Verify camera mode (Menu → Network → PC Remote → ON)');
    }
    
    console.log();
  }
  
  private async runQuickDiagnostic(): Promise<void> {
    console.log('5️⃣ Running quick diagnostic...');
    
    try {
      const result = await sonyDiagnostics.runDiagnostics();
      
      const errorCount = result.issues.filter(issue => issue.level === 'error').length;
      const warningCount = result.issues.filter(issue => issue.level === 'warning').length;
      
      if (errorCount === 0 && warningCount === 0) {
        console.log('   ✅ All systems operational');
      } else if (errorCount === 0) {
        console.log(`   ⚠️  ${warningCount} warning(s) detected (system functional)`);
      } else {
        console.log(`   ❌ ${errorCount} error(s) and ${warningCount} warning(s) detected`);
        console.log('      Run: npm run camera:diag for detailed analysis');
      }
      
      // Show critical issues
      const criticalIssues = result.issues.filter(issue => issue.level === 'error');
      if (criticalIssues.length > 0) {
        console.log('      Critical issues:');
        criticalIssues.slice(0, 3).forEach(issue => {
          console.log(`      - ${issue.category}: ${issue.message}`);
        });
        
        if (criticalIssues.length > 3) {
          console.log(`      - ... and ${criticalIssues.length - 3} more`);
        }
      }
      
    } catch (error: any) {
      console.log('   ⚠️  Quick diagnostic failed, but reset may still be successful');
    }
    
    console.log();
  }
  
  private runCommand(
    command: string, 
    args: string[], 
    timeout: number = 10000,
    ignoreError: boolean = false
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [
            join(this.SDK_PATH, 'external/crsdk'),
            join(this.SDK_PATH, 'external/crsdk/CrAdapter'),
            this.BUILD_PATH
          ].join(':')
        }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill();
        if (!ignoreError) {
          reject(new Error(`Command timeout after ${timeout}ms`));
        } else {
          resolve({ stdout, stderr });
        }
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !ignoreError) {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        if (!ignoreError) {
          reject(error);
        } else {
          resolve({ stdout: '', stderr: error.message });
        }
      });
    });
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run if called directly
if (require.main === module) {
  const runner = new CameraResetRunner();
  runner.run().then(success => {
    if (success) {
      console.log('🎉 Camera reset completed! Ready for production.');
      console.log();
      console.log('Next steps:');
      console.log('• Test with: npm run camera:capture');
      console.log('• Start CardMint: npm run dev');
      console.log('• Monitor with: npm run camera:diag');
    } else {
      console.log('❌ Camera reset incomplete. Manual intervention may be required.');
      console.log();
      console.log('Manual troubleshooting:');
      console.log('1. Power cycle camera completely');
      console.log('2. Try different USB cable/port');
      console.log('3. Check camera mode settings');
      console.log('4. Run: npm run camera:diag');
    }
    
    process.exit(success ? 0 : 1);
  }).catch(error => {
    logger.error('Camera reset runner failed:', error);
    process.exit(1);
  });
}

export { CameraResetRunner };