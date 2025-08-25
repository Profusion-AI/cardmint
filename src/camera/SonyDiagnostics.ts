import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('sony-diagnostics');

// Sony SDK Error Code Mappings (from CrError.h)
export const SONY_ERROR_CODES: Record<string, { category: string; message: string; solution: string; critical: boolean }> = {
  // Generic Errors (0x8000 series)
  '0x8000': { category: 'Generic', message: 'Unknown error', solution: 'Restart camera and SDK', critical: true },
  '0x8001': { category: 'Generic', message: 'Not implemented', solution: 'Feature not supported on this camera model', critical: false },
  '0x8002': { category: 'Generic', message: 'Operation aborted', solution: 'Retry operation', critical: false },
  '0x8003': { category: 'Generic', message: 'Not supported', solution: 'Operation not supported by camera', critical: false },
  '0x8004': { category: 'Generic', message: 'Serious error - not supported', solution: 'Camera may need firmware update', critical: true },
  '0x8005': { category: 'Generic', message: 'Invalid handle', solution: 'Reconnect to camera', critical: true },
  '0x8006': { category: 'Generic', message: 'Invalid parameter', solution: 'Check command parameters', critical: false },

  // File Errors (0x8100 series)
  '0x8100': { category: 'File', message: 'File operation failed', solution: 'Check file permissions and disk space', critical: true },
  '0x8101': { category: 'File', message: 'Illegal file operation', solution: 'Check file is not in use', critical: false },
  '0x8102': { category: 'File', message: 'Illegal parameter', solution: 'Check file path is valid', critical: false },
  '0x8103': { category: 'File', message: 'End of file reached', solution: 'Normal end of file condition', critical: false },
  '0x8104': { category: 'File', message: 'Out of range', solution: 'File operation exceeded bounds', critical: false },
  '0x8105': { category: 'File', message: 'File not found', solution: 'Check file exists and path is correct', critical: true },
  '0x8106': { category: 'File', message: 'Directory not found', solution: 'Create directory or check path', critical: true },
  '0x8107': { category: 'File', message: 'File already opened', solution: 'Close file before reopening', critical: false },
  '0x8108': { category: 'File', message: 'Permission denied', solution: 'Check file permissions (chmod 664)', critical: true },
  '0x8109': { category: 'File', message: 'Storage full', solution: 'Free disk space in captures directory', critical: true },

  // Connection Errors (0x8200 series)  
  '0x8200': { category: 'Connection', message: 'Connection failed', solution: 'Check USB cable and camera power', critical: true },
  '0x8201': { category: 'Connection', message: 'Connect failed', solution: 'Reconnect USB cable, check camera mode', critical: true },
  '0x8202': { category: 'Connection', message: 'IP connection failed', solution: 'Check network settings and IP address', critical: true },
  '0x8203': { category: 'Connection', message: 'Release failed', solution: 'Camera disconnect failed, restart SDK', critical: false },
  '0x8204': { category: 'Connection', message: 'Get property failed', solution: 'Camera not responding, check connection', critical: true },
  '0x8205': { category: 'Connection', message: 'Send command failed', solution: 'Communication error, retry command', critical: false },
  '0x8206': { category: 'Connection', message: 'Handle plugin failed', solution: 'SDK plugin error, restart application', critical: true },
  '0x8207': { category: 'Connection', message: 'Camera disconnected', solution: 'Camera was unplugged, reconnect USB', critical: true },
  '0x8208': { category: 'Connection', message: 'Connection timeout', solution: 'Camera not responding, check power and USB', critical: true },
  '0x8209': { category: 'Connection', message: 'Reconnection timeout', solution: 'Auto-reconnect failed, manual reconnect needed', critical: true },
  '0x820A': { category: 'Connection', message: 'Connection rejected', solution: 'Camera refused connection, check mode', critical: true },
  '0x820B': { category: 'Connection', message: 'Camera busy', solution: 'Wait 800ms and retry up to 3x', critical: false },
  '0x820C': { category: 'Connection', message: 'Connection failed (unspecified)', solution: 'General connection error, restart camera', critical: true },

  // Memory Errors (0x8300 series)
  '0x8300': { category: 'Memory', message: 'Memory error', solution: 'Restart application to free memory', critical: true },
  '0x8301': { category: 'Memory', message: 'Out of memory', solution: 'Close other applications, restart CardMint', critical: true },
  '0x8302': { category: 'Memory', message: 'Invalid pointer', solution: 'SDK internal error, restart application', critical: true },
  '0x8303': { category: 'Memory', message: 'Insufficient memory', solution: 'System low on memory, close applications', critical: true },

  // API Errors (0x8400 series)
  '0x8400': { category: 'API', message: 'API error', solution: 'SDK API call failed, check parameters', critical: true },
  '0x8401': { category: 'API', message: 'Insufficient API data', solution: 'API call missing required data', critical: false },
  '0x8402': { category: 'API', message: 'Invalid API call', solution: 'API called in wrong sequence', critical: false },
  '0x8403': { category: 'API', message: 'No applicable information', solution: 'API call not applicable to camera state', critical: false },
  '0x8404': { category: 'API', message: 'Model not in list', solution: 'Camera model not recognized', critical: true },
  '0x8405': { category: 'API', message: 'USB model not supported', solution: 'Camera model not supported via USB', critical: true },
  '0x8406': { category: 'API', message: 'Ethernet model not supported', solution: 'Camera model not supported via Ethernet', critical: true },

  // Adaptor Errors (0x8700 series)
  '0x8700': { category: 'Adaptor', message: 'Adaptor error', solution: 'USB adaptor issue, try different USB port', critical: true },
  '0x8701': { category: 'Adaptor', message: 'Invalid property', solution: 'Camera property not available', critical: false },
  '0x8702': { category: 'Adaptor', message: 'Get info failed', solution: 'Cannot get camera information', critical: true },
  '0x8703': { category: 'Adaptor', message: 'Create adaptor failed', solution: 'USB adaptor creation failed', critical: true },
  '0x8704': { category: 'Adaptor', message: 'Send command failed', solution: 'Command transmission failed', critical: false },
  '0x8705': { category: 'Adaptor', message: 'Handle plugin failed', solution: 'Plugin handling error', critical: true },
  '0x8706': { category: 'Adaptor', message: 'Create device failed', solution: 'Device creation failed', critical: true },
  '0x8707': { category: 'Adaptor', message: 'Enum device failed', solution: 'Device enumeration failed', critical: true },
  '0x8708': { category: 'Adaptor', message: 'Reset failed', solution: 'Adaptor reset failed', critical: true },
  '0x8709': { category: 'Adaptor', message: 'Read failed', solution: 'Data read from camera failed', critical: true },
  '0x870F': { category: 'Adaptor', message: 'Device busy', solution: 'Camera is busy, wait and retry', critical: false },
  '0x8712': { category: 'Adaptor', message: 'Camera status error', solution: 'Camera in invalid state', critical: true },

  // Device Errors (0x8800 series)
  '0x8800': { category: 'Device', message: 'Device error', solution: 'Camera device error, restart camera', critical: true },
};

export interface SonyDiagnosticResult {
  healthy: boolean;
  issues: Array<{
    level: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    solution: string;
  }>;
  recommendations: string[];
  systemInfo: {
    sdkPath: string;
    libraryPath: string;
    permissions: boolean;
    usbDevices: string[];
    diskSpace: string;
  };
}

export class SonyDiagnostics {
  private readonly SDK_PATH = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC';
  private readonly BUILD_PATH = join(this.SDK_PATH, 'build');
  private readonly CLI_PATH = join(this.BUILD_PATH, 'sony-cli');
  private readonly CAPTURES_PATH = '/home/profusionai/CardMint/captures';

  /**
   * Run comprehensive Sony camera diagnostics
   */
  async runDiagnostics(): Promise<SonyDiagnosticResult> {
    logger.info('Starting Sony camera diagnostics...');
    
    const result: SonyDiagnosticResult = {
      healthy: true,
      issues: [],
      recommendations: [],
      systemInfo: {
        sdkPath: this.SDK_PATH,
        libraryPath: this.getLibraryPath(),
        permissions: false,
        usbDevices: [],
        diskSpace: ''
      }
    };

    try {
      // Check SDK installation
      await this.checkSDKInstallation(result);
      
      // Check file permissions
      await this.checkPermissions(result);
      
      // Check USB devices
      await this.checkUSBDevices(result);
      
      // Check disk space
      await this.checkDiskSpace(result);
      
      // Test camera connectivity
      await this.testCameraConnection(result);
      
      // Generate recommendations
      this.generateRecommendations(result);
      
      // Determine overall health
      result.healthy = result.issues.filter(issue => issue.level === 'error').length === 0;
      
      logger.info('Sony camera diagnostics completed', { 
        healthy: result.healthy,
        issueCount: result.issues.length 
      });
      
    } catch (error: any) {
      result.healthy = false;
      result.issues.push({
        level: 'error',
        category: 'System',
        message: 'Diagnostics failed to run',
        solution: `Error: ${error.message}`
      });
    }

    return result;
  }

  /**
   * Translate Sony error code to human-readable message
   */
  translateErrorCode(errorCode: string | number): { category: string; message: string; solution: string; critical: boolean } {
    const hexCode = typeof errorCode === 'number' ? 
      `0x${errorCode.toString(16).toUpperCase()}` : 
      errorCode.toString().toUpperCase();
      
    const translation = SONY_ERROR_CODES[hexCode];
    
    if (translation) {
      logger.warn('Sony camera error translated', {
        errorCode: hexCode,
        category: translation.category,
        message: translation.message
      });
      return translation;
    }
    
    // Unknown error code
    return {
      category: 'Unknown',
      message: `Unknown Sony error code: ${hexCode}`,
      solution: 'Consult Sony SDK documentation or restart camera',
      critical: true
    };
  }

  /**
   * Get suggested recovery actions for common issues
   */
  getRecoveryActions(errorCode: string | number): string[] {
    const translation = this.translateErrorCode(errorCode);
    
    const baseActions = [
      'Check USB cable connection',
      'Verify camera is powered on',
      'Restart CardMint application'
    ];
    
    const categoryActions: Record<string, string[]> = {
      'Connection': [
        'Try different USB port',
        'Check camera is in PC Remote mode',
        'Restart camera and reconnect USB'
      ],
      'File': [
        'Check disk space in captures directory',
        'Verify file permissions (chmod 755)',
        'Clear temporary files'
      ],
      'Memory': [
        'Close other applications',
        'Restart CardMint to free memory',
        'Check available system RAM'
      ],
      'Adaptor': [
        'Try different USB port',
        'Check USB 3.0 compatibility',
        'Reset USB controller'
      ]
    };
    
    return [...baseActions, ...(categoryActions[translation.category] || [])];
  }

  private async checkSDKInstallation(result: SonyDiagnosticResult): Promise<void> {
    // Check SDK directory exists
    try {
      await fs.access(this.SDK_PATH);
    } catch {
      result.issues.push({
        level: 'error',
        category: 'SDK',
        message: 'Sony SDK directory not found',
        solution: `Install Sony SDK at ${this.SDK_PATH}`
      });
      return;
    }

    // Check CLI binary exists and is executable
    try {
      await fs.access(this.CLI_PATH, fs.constants.X_OK);
    } catch {
      result.issues.push({
        level: 'error',
        category: 'SDK',
        message: 'Sony CLI binary not found or not executable',
        solution: 'Run: npm run camera:build'
      });
      return;
    }

    // Check required libraries
    const requiredLibs = [
      'libCr_Core.so',
      'CrAdapter/libCr_PTP_USB.so',
      'CrAdapter/libusb-1.0.so'
    ];

    for (const lib of requiredLibs) {
      try {
        await fs.access(join(this.SDK_PATH, 'external/crsdk', lib));
      } catch {
        result.issues.push({
          level: 'error',
          category: 'SDK',
          message: `Required library missing: ${lib}`,
          solution: 'Reinstall Sony SDK or run camera:build'
        });
      }
    }
  }

  private async checkPermissions(result: SonyDiagnosticResult): Promise<void> {
    try {
      // Check captures directory is writable
      await fs.access(this.CAPTURES_PATH, fs.constants.W_OK);
      result.systemInfo.permissions = true;
    } catch {
      result.issues.push({
        level: 'error',
        category: 'Permissions',
        message: 'Captures directory not writable',
        solution: `mkdir -p ${this.CAPTURES_PATH} && chmod 755 ${this.CAPTURES_PATH}`
      });
    }

    // Check udev rules for Sony camera
    try {
      await fs.access('/etc/udev/rules.d/99-sony-camera.rules');
    } catch {
      result.issues.push({
        level: 'warning',
        category: 'Permissions',
        message: 'Sony camera udev rules not installed',
        solution: 'Install udev rules for reliable USB access'
      });
    }
  }

  private async checkUSBDevices(result: SonyDiagnosticResult): Promise<void> {
    try {
      const { stdout } = await this.runCommand('lsusb', []);
      const usbDevices = stdout.split('\n').filter(line => 
        line.toLowerCase().includes('sony') || 
        line.includes('054c:') // Sony vendor ID
      );
      
      result.systemInfo.usbDevices = usbDevices;
      
      if (usbDevices.length === 0) {
        result.issues.push({
          level: 'warning',
          category: 'USB',
          message: 'No Sony USB devices detected',
          solution: 'Connect Sony camera via USB and power on'
        });
      } else {
        result.issues.push({
          level: 'info',
          category: 'USB',
          message: `Found ${usbDevices.length} Sony USB device(s)`,
          solution: 'Sony camera detected via USB'
        });
      }
    } catch {
      result.issues.push({
        level: 'warning',
        category: 'USB',
        message: 'Could not check USB devices',
        solution: 'Install usbutils: sudo dnf install usbutils'
      });
    }
  }

  private async checkDiskSpace(result: SonyDiagnosticResult): Promise<void> {
    try {
      const { stdout } = await this.runCommand('df', ['-h', this.CAPTURES_PATH]);
      const lines = stdout.split('\n');
      const diskInfo = lines[1];  // First line is header
      result.systemInfo.diskSpace = diskInfo;
      
      // Parse available space (4th column)
      const parts = diskInfo.split(/\s+/);
      const availableSpace = parts[3];
      
      if (availableSpace.includes('G')) {
        const gb = parseFloat(availableSpace);
        if (gb < 5) {  // Less than 5GB available
          result.issues.push({
            level: 'warning',
            category: 'Storage',
            message: `Low disk space: ${availableSpace} available`,
            solution: 'Free disk space or configure archive to external drive'
          });
        }
      }
    } catch {
      result.issues.push({
        level: 'warning',
        category: 'Storage',
        message: 'Could not check disk space',
        solution: 'Manually verify sufficient disk space for captures'
      });
    }
  }

  private async testCameraConnection(result: SonyDiagnosticResult): Promise<void> {
    try {
      const { stdout, stderr } = await this.runCommand(this.CLI_PATH, ['list'], 5000);
      
      if (stderr && stderr.includes('0x')) {
        // Parse error codes from stderr
        const errorMatches = stderr.match(/0x[0-9A-Fa-f]+/g);
        if (errorMatches) {
          for (const errorCode of errorMatches) {
            const translation = this.translateErrorCode(errorCode);
            result.issues.push({
              level: translation.critical ? 'error' : 'warning',
              category: translation.category,
              message: translation.message,
              solution: translation.solution
            });
          }
        }
      }
      
      if (stdout.includes('Found') || stdout.includes('Camera')) {
        result.issues.push({
          level: 'info',
          category: 'Camera',
          message: 'Sony camera connection successful',
          solution: 'Camera ready for capture'
        });
      } else {
        result.issues.push({
          level: 'error',
          category: 'Camera',
          message: 'No Sony camera found',
          solution: 'Connect camera via USB and set to PC Remote mode'
        });
      }
    } catch (error: any) {
      result.issues.push({
        level: 'error',
        category: 'Camera',
        message: 'Camera connection test failed',
        solution: `Error: ${error.message}`
      });
    }
  }

  private generateRecommendations(result: SonyDiagnosticResult): void {
    const errorCount = result.issues.filter(issue => issue.level === 'error').length;
    const warningCount = result.issues.filter(issue => issue.level === 'warning').length;
    
    if (errorCount === 0 && warningCount === 0) {
      result.recommendations.push('✅ All systems operational - ready for production');
    } else if (errorCount === 0) {
      result.recommendations.push('⚠️ Minor issues detected - system functional but could be optimized');
    } else {
      result.recommendations.push('❌ Critical issues detected - resolve before production use');
    }

    // Add specific recommendations based on issues
    const categories = [...new Set(result.issues.map(issue => issue.category))];
    
    if (categories.includes('Connection')) {
      result.recommendations.push('🔌 Check all USB connections and camera power');
    }
    
    if (categories.includes('Permissions')) {
      result.recommendations.push('🔐 Review file permissions and udev rules');
    }
    
    if (categories.includes('Storage')) {
      result.recommendations.push('💾 Monitor disk space and configure archiving');
    }
    
    if (categories.includes('SDK')) {
      result.recommendations.push('🛠️ Rebuild Sony SDK components');
    }
  }

  private getLibraryPath(): string {
    return [
      join(this.SDK_PATH, 'external/crsdk'),
      join(this.SDK_PATH, 'external/crsdk/CrAdapter'),
      this.BUILD_PATH
    ].join(':');
  }

  private runCommand(command: string, args: string[], timeout: number = 10000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: this.getLibraryPath()
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
        reject(new Error(`Command timeout after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

// Export singleton instance
export const sonyDiagnostics = new SonyDiagnostics();