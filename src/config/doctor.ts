#!/usr/bin/env node

import { validatedConfig, SLO_TARGETS } from './validator';
import { createLogger } from '../utils/logger';
import axios from 'axios';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const logger = createLogger('config-doctor');

interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  details?: any;
  critical?: boolean;
}

class ConfigDoctor {
  private checks: HealthCheck[] = [];
  
  async run(): Promise<boolean> {
    console.log('🏥 CardMint Configuration Doctor');
    console.log('================================');
    console.log();
    
    // Run all health checks
    await this.checkConfig();
    await this.checkLMStudioConnectivity();
    await this.checkMacHostnameResolution();
    await this.checkDatabaseAccess();
    await this.checkRedisConnectivity();
    await this.checkCameraSDK();
    await this.checkFileSystemPermissions();
    await this.checkSLOTargets();
    
    // Print results
    this.printResults();
    
    // Return overall health
    const criticalFailures = this.checks.filter(c => c.status === 'fail' && c.critical).length;
    const totalFailures = this.checks.filter(c => c.status === 'fail').length;
    
    console.log();
    console.log('📊 Summary');
    console.log('==========');
    console.log(`✅ Passed: ${this.checks.filter(c => c.status === 'pass').length}`);
    console.log(`⚠️  Warnings: ${this.checks.filter(c => c.status === 'warn').length}`);
    console.log(`❌ Failed: ${totalFailures}`);
    console.log(`🚨 Critical failures: ${criticalFailures}`);
    
    if (criticalFailures > 0) {
      console.log();
      console.log('🚨 CRITICAL: System not ready for production');
      console.log('Fix critical issues before proceeding.');
      return false;
    }
    
    if (totalFailures > 0) {
      console.log();
      console.log('⚠️  System has warnings but is functional');
      return true;
    }
    
    console.log();
    console.log('🎉 All systems green! Ready for production.');
    return true;
  }
  
  private async checkConfig(): Promise<void> {
    try {
      // Config is already validated by validator.ts
      this.checks.push({
        name: 'Configuration Validation',
        status: 'pass',
        message: 'All configuration values are valid',
        details: {
          env: validatedConfig.env,
          remoteMLEnabled: validatedConfig.remoteML.enabled,
          metricsEnabled: validatedConfig.performance.enableMetrics
        }
      });
    } catch (error) {
      this.checks.push({
        name: 'Configuration Validation',
        status: 'fail',
        message: `Configuration validation failed: ${error}`,
        critical: true
      });
    }
  }
  
  private async checkLMStudioConnectivity(): Promise<void> {
    const { remoteML } = validatedConfig;
    const baseUrl = `${remoteML.protocol}://${remoteML.host}:${remoteML.port}`;
    
    try {
      // Test basic connectivity
      const startTime = Date.now();
      const response = await axios.get(`${baseUrl}/v1/models`, {
        timeout: remoteML.timeout,
        headers: { 'Accept': 'application/json' }
      });
      const latency = Date.now() - startTime;
      
      if (response.status === 200) {
        this.checks.push({
          name: 'LMStudio Connectivity',
          status: 'pass',
          message: `Connected to LMStudio at ${baseUrl}`,
          details: {
            endpoint: baseUrl,
            latency: `${latency}ms`,
            modelsAvailable: Array.isArray(response.data?.data) ? response.data.data.length : 'unknown'
          },
          critical: true
        });
        
        // Check latency against budget
        if (latency > SLO_TARGETS.lmstudio_budget_ms) {
          this.checks.push({
            name: 'LMStudio Latency',
            status: 'warn',
            message: `High latency: ${latency}ms > ${SLO_TARGETS.lmstudio_budget_ms}ms budget`,
            details: { latency, budget: SLO_TARGETS.lmstudio_budget_ms }
          });
        } else {
          this.checks.push({
            name: 'LMStudio Latency',
            status: 'pass',
            message: `Latency within budget: ${latency}ms ≤ ${SLO_TARGETS.lmstudio_budget_ms}ms`
          });
        }
      }
    } catch (error: any) {
      this.checks.push({
        name: 'LMStudio Connectivity',
        status: 'fail',
        message: `Cannot reach LMStudio at ${baseUrl}`,
        details: {
          endpoint: baseUrl,
          error: error.message,
          code: error.code
        },
        critical: true
      });
    }
  }
  
  private async checkMacHostnameResolution(): Promise<void> {
    const { remoteML } = validatedConfig;
    const hostname = 'cardmint-mac.local';
    
    try {
      // Try mDNS hostname resolution first
      const { stdout } = await execAsync(`ping -c 1 -W 2 ${hostname}`, { timeout: 5000 });
      const ipMatch = stdout.match(/\(([^)]+)\)/);
      const resolvedIp = ipMatch ? ipMatch[1] : 'unknown';
      
      this.checks.push({
        name: 'Mac Hostname Resolution (mDNS)',
        status: 'pass',
        message: `Resolved ${hostname} to ${resolvedIp}`,
        details: { hostname, resolvedIp }
      });
      
      // Check if it matches configured IP
      if (resolvedIp !== remoteML.host) {
        this.checks.push({
          name: 'Hostname vs IP Consistency',
          status: 'warn',
          message: `mDNS resolved to ${resolvedIp}, but config uses ${remoteML.host}`,
          details: { mdnsIp: resolvedIp, configIp: remoteML.host }
        });
      }
    } catch (error: any) {
      this.checks.push({
        name: 'Mac Hostname Resolution (mDNS)',
        status: 'warn',
        message: `Cannot resolve ${hostname} - using IP fallback`,
        details: { hostname, fallbackIp: remoteML.host, error: error.message }
      });
      
      // Test direct IP connectivity
      try {
        await execAsync(`ping -c 1 -W 2 ${remoteML.host}`, { timeout: 5000 });
        this.checks.push({
          name: 'Mac IP Connectivity',
          status: 'pass',
          message: `Direct IP ${remoteML.host} is reachable`
        });
      } catch (ipError: any) {
        this.checks.push({
          name: 'Mac IP Connectivity',
          status: 'fail',
          message: `Cannot reach Mac at ${remoteML.host}`,
          details: { ip: remoteML.host, error: ipError.message },
          critical: true
        });
      }
    }
  }
  
  private async checkDatabaseAccess(): Promise<void> {
    try {
      const dbPath = resolve(validatedConfig.database.path);
      await fs.access(dbPath);
      
      this.checks.push({
        name: 'SQLite Database Access',
        status: 'pass',
        message: `Database accessible at ${dbPath}`,
        details: { path: dbPath }
      });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.checks.push({
          name: 'SQLite Database Access',
          status: 'warn',
          message: 'Database file does not exist - will be created on first run',
          details: { path: validatedConfig.database.path }
        });
      } else {
        this.checks.push({
          name: 'SQLite Database Access',
          status: 'fail',
          message: `Database access error: ${error.message}`,
          details: { path: validatedConfig.database.path, error: error.code },
          critical: true
        });
      }
    }
  }
  
  private async checkRedisConnectivity(): Promise<void> {
    const { redis } = validatedConfig;
    
    try {
      // Simple TCP connection test
      const { stdout } = await execAsync(`timeout 3 bash -c "echo > /dev/tcp/${redis.host}/${redis.port}"`, { timeout: 5000 });
      
      this.checks.push({
        name: 'Redis Connectivity',
        status: 'pass',
        message: `Redis reachable at ${redis.host}:${redis.port}`,
        details: { host: redis.host, port: redis.port }
      });
    } catch (error: any) {
      this.checks.push({
        name: 'Redis Connectivity',
        status: 'fail',
        message: `Cannot reach Redis at ${redis.host}:${redis.port}`,
        details: { host: redis.host, port: redis.port, error: error.message },
        critical: true
      });
    }
  }
  
  private async checkCameraSDK(): Promise<void> {
    const sdkPath = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build/sony-cli';
    
    try {
      await fs.access(sdkPath, fs.constants.X_OK);
      
      this.checks.push({
        name: 'Sony Camera SDK',
        status: 'pass',
        message: 'Sony SDK binary is accessible',
        details: { path: sdkPath }
      });
    } catch (error: any) {
      this.checks.push({
        name: 'Sony Camera SDK',
        status: 'fail',
        message: 'Sony SDK binary not found or not executable',
        details: { 
          path: sdkPath, 
          error: error.message,
          suggestion: 'Run: npm run camera:build'
        },
        critical: true
      });
    }
  }
  
  private async checkFileSystemPermissions(): Promise<void> {
    const testPaths = [
      './captures',
      './processed', 
      './data',
      './logs'
    ];
    
    let allGood = true;
    const results: any[] = [];
    
    for (const path of testPaths) {
      try {
        await fs.access(path, fs.constants.W_OK);
        results.push({ path, status: 'writable' });
      } catch {
        try {
          await fs.mkdir(path, { recursive: true });
          results.push({ path, status: 'created' });
        } catch (error: any) {
          results.push({ path, status: 'error', error: error.message });
          allGood = false;
        }
      }
    }
    
    this.checks.push({
      name: 'File System Permissions',
      status: allGood ? 'pass' : 'fail',
      message: allGood ? 'All required directories are writable' : 'Some directories are not writable',
      details: results,
      critical: !allGood
    });
  }
  
  private async checkSLOTargets(): Promise<void> {
    this.checks.push({
      name: 'SLO Configuration',
      status: 'pass',
      message: 'Performance targets configured',
      details: {
        'End-to-end p95': `≤ ${SLO_TARGETS.e2e_p95_ms}ms`,
        'Error rate': `≤ ${SLO_TARGETS.error_rate_max * 100}%`,
        'Capture budget': `≤ ${SLO_TARGETS.capture_budget_ms}ms`,
        'LMStudio budget': `≤ ${SLO_TARGETS.lmstudio_budget_ms}ms`,
        'Database budget': `≤ ${SLO_TARGETS.db_budget_ms}ms`
      }
    });
  }
  
  private printResults(): void {
    console.log();
    console.log('🔍 Health Check Results');
    console.log('=====================');
    
    for (const check of this.checks) {
      const icon = check.status === 'pass' ? '✅' : 
                   check.status === 'warn' ? '⚠️' : '❌';
      const critical = check.critical ? ' [CRITICAL]' : '';
      
      console.log();
      console.log(`${icon} ${check.name}${critical}`);
      console.log(`   ${check.message}`);
      
      if (check.details && typeof check.details === 'object') {
        for (const [key, value] of Object.entries(check.details)) {
          console.log(`   - ${key}: ${value}`);
        }
      }
    }
  }
}

// Run the doctor if called directly
if (require.main === module) {
  const doctor = new ConfigDoctor();
  doctor.run().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    logger.error('Config doctor failed:', error);
    process.exit(1);
  });
}

export { ConfigDoctor };