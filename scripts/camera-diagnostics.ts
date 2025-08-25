#!/usr/bin/env tsx

import { sonyDiagnostics, SonyDiagnosticResult } from '../src/camera/SonyDiagnostics';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('camera-diagnostics');

class CameraDiagnosticsRunner {
  async run(): Promise<boolean> {
    console.log('🔍 Sony Camera Comprehensive Diagnostics');
    console.log('=======================================');
    console.log();
    
    try {
      const result = await sonyDiagnostics.runDiagnostics();
      
      this.printSystemInfo(result);
      this.printIssues(result);
      this.printRecommendations(result);
      this.printSummary(result);
      
      return result.healthy;
      
    } catch (error: any) {
      logger.error('Camera diagnostics failed:', { error: error.message });
      console.log(`❌ Diagnostics failed: ${error.message}`);
      return false;
    }
  }
  
  private printSystemInfo(result: SonyDiagnosticResult): void {
    console.log('📋 System Information');
    console.log('====================');
    console.log(`SDK Path: ${result.systemInfo.sdkPath}`);
    console.log(`Library Path: ${result.systemInfo.libraryPath}`);
    console.log(`Permissions OK: ${result.systemInfo.permissions ? '✅' : '❌'}`);
    console.log(`Disk Space: ${result.systemInfo.diskSpace || 'Unknown'}`);
    
    if (result.systemInfo.usbDevices.length > 0) {
      console.log('USB Devices:');
      result.systemInfo.usbDevices.forEach(device => {
        console.log(`  - ${device}`);
      });
    } else {
      console.log('USB Devices: None detected');
    }
    
    console.log();
  }
  
  private printIssues(result: SonyDiagnosticResult): void {
    if (result.issues.length === 0) {
      console.log('✅ No issues detected\n');
      return;
    }
    
    console.log('🔍 Issues Detected');
    console.log('==================');
    
    const errorIssues = result.issues.filter(issue => issue.level === 'error');
    const warningIssues = result.issues.filter(issue => issue.level === 'warning');
    const infoIssues = result.issues.filter(issue => issue.level === 'info');
    
    if (errorIssues.length > 0) {
      console.log('❌ ERRORS (must fix):');
      errorIssues.forEach(issue => {
        console.log(`   ${issue.category}: ${issue.message}`);
        console.log(`   Solution: ${issue.solution}`);
        console.log();
      });
    }
    
    if (warningIssues.length > 0) {
      console.log('⚠️  WARNINGS (should fix):');
      warningIssues.forEach(issue => {
        console.log(`   ${issue.category}: ${issue.message}`);
        console.log(`   Solution: ${issue.solution}`);
        console.log();
      });
    }
    
    if (infoIssues.length > 0) {
      console.log('ℹ️  INFO:');
      infoIssues.forEach(issue => {
        console.log(`   ${issue.category}: ${issue.message}`);
        console.log();
      });
    }
  }
  
  private printRecommendations(result: SonyDiagnosticResult): void {
    if (result.recommendations.length === 0) return;
    
    console.log('💡 Recommendations');
    console.log('==================');
    result.recommendations.forEach(rec => {
      console.log(`• ${rec}`);
    });
    console.log();
  }
  
  private printSummary(result: SonyDiagnosticResult): void {
    console.log('📊 Summary');
    console.log('==========');
    
    const errorCount = result.issues.filter(issue => issue.level === 'error').length;
    const warningCount = result.issues.filter(issue => issue.level === 'warning').length;
    const infoCount = result.issues.filter(issue => issue.level === 'info').length;
    
    console.log(`Errors: ${errorCount}`);
    console.log(`Warnings: ${warningCount}`);
    console.log(`Info: ${infoCount}`);
    
    if (result.healthy) {
      console.log('🎉 CAMERA SYSTEM READY FOR PRODUCTION');
    } else {
      console.log('⚠️  CAMERA SYSTEM NEEDS ATTENTION');
      console.log();
      console.log('Quick fixes to try:');
      console.log('1. Run: npm run camera:reset');
      console.log('2. Check USB cable and camera power');
      console.log('3. Restart CardMint: npm run dev');
      console.log('4. If issues persist, check camera mode (PC Remote)');
    }
  }
}

// Run if called directly
if (require.main === module) {
  const runner = new CameraDiagnosticsRunner();
  runner.run().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    logger.error('Camera diagnostics runner failed:', error);
    process.exit(1);
  });
}

export { CameraDiagnosticsRunner };