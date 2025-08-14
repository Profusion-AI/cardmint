import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getPool } from './database';

const logger = createLogger('run-storage');

export interface RunManifest {
  runId: string;
  timestamp: string;
  preset: string;
  status: 'running' | 'completed' | 'failed';
  files: {
    raw: string[];
    processed: string[];
    ocr: string[];
    signals: string[];
    metadata: string[];
  };
  summary: {
    captureCount: number;
    processedCount: number;
    successRate: number;
    totalDurationMs: number;
    averageProcessingMs: number;
  };
  extractedFields?: {
    cardName?: string;
    cardSet?: string;
    cardNumber?: string;
    rarity?: string;
  };
  qualityMetrics?: {
    overallQuality: number;
    edgeScore: number;
    surfaceScore: number;
    centeringScore: number;
    cornerScore: number;
  };
  error?: string;
}

export class RunStorage {
  private readonly baseDir: string;
  
  constructor(baseDir: string = '/data/cardmint') {
    this.baseDir = baseDir;
  }
  
  async createRun(runId: string, preset: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const runDir = path.join(this.baseDir, `${timestamp}_${runId}`);
    
    // Create directory structure
    const dirs = [
      path.join(runDir, 'raw'),
      path.join(runDir, 'proc'),
      path.join(runDir, 'ocr'),
      path.join(runDir, 'signals'),
      path.join(runDir, 'meta'),
    ];
    
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    
    // Create initial manifest
    const manifest: RunManifest = {
      runId,
      timestamp: new Date().toISOString(),
      preset,
      status: 'running',
      files: {
        raw: [],
        processed: [],
        ocr: [],
        signals: [],
        metadata: [],
      },
      summary: {
        captureCount: 0,
        processedCount: 0,
        successRate: 0,
        totalDurationMs: 0,
        averageProcessingMs: 0,
      },
    };
    
    await this.saveManifest(runDir, manifest);
    
    // Store in database
    await this.storeRunInDatabase(manifest, runDir);
    
    logger.info(`Created run ${runId} at ${runDir}`);
    return runDir;
  }
  
  async updateManifest(
    runDir: string,
    updates: Partial<RunManifest>
  ): Promise<RunManifest> {
    const manifestPath = path.join(runDir, 'manifest.json');
    
    let manifest: RunManifest;
    try {
      const data = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(data);
    } catch (error) {
      logger.error(`Failed to read manifest from ${runDir}:`, error);
      throw error;
    }
    
    // Merge updates
    manifest = { ...manifest, ...updates };
    
    // Deep merge for nested objects
    if (updates.files) {
      manifest.files = { ...manifest.files, ...updates.files };
    }
    if (updates.summary) {
      manifest.summary = { ...manifest.summary, ...updates.summary };
    }
    if (updates.extractedFields) {
      manifest.extractedFields = { ...manifest.extractedFields, ...updates.extractedFields };
    }
    if (updates.qualityMetrics) {
      manifest.qualityMetrics = { ...manifest.qualityMetrics, ...updates.qualityMetrics };
    }
    
    await this.saveManifest(runDir, manifest);
    await this.updateRunInDatabase(manifest);
    
    return manifest;
  }
  
  async addFile(
    runDir: string,
    fileType: keyof RunManifest['files'],
    filePath: string
  ): Promise<void> {
    const manifestPath = path.join(runDir, 'manifest.json');
    
    const data = await fs.readFile(manifestPath, 'utf-8');
    const manifest: RunManifest = JSON.parse(data);
    
    // Add file to appropriate array
    if (!manifest.files[fileType].includes(filePath)) {
      manifest.files[fileType].push(filePath);
    }
    
    await this.saveManifest(runDir, manifest);
  }
  
  async completeRun(
    runDir: string,
    summary: RunManifest['summary'],
    extractedFields?: RunManifest['extractedFields'],
    qualityMetrics?: RunManifest['qualityMetrics']
  ): Promise<void> {
    await this.updateManifest(runDir, {
      status: 'completed',
      summary,
      extractedFields,
      qualityMetrics,
    });
    
    logger.info(`Run completed: ${runDir}`);
  }
  
  async failRun(runDir: string, error: string): Promise<void> {
    await this.updateManifest(runDir, {
      status: 'failed',
      error,
    });
    
    logger.error(`Run failed: ${runDir} - ${error}`);
  }
  
  async getManifest(runDir: string): Promise<RunManifest> {
    const manifestPath = path.join(runDir, 'manifest.json');
    const data = await fs.readFile(manifestPath, 'utf-8');
    return JSON.parse(data);
  }
  
  async getRunByRunId(runId: string): Promise<RunManifest | null> {
    // Search for run directory
    const dirs = await fs.readdir(this.baseDir);
    
    for (const dir of dirs) {
      if (dir.includes(runId)) {
        const runDir = path.join(this.baseDir, dir);
        try {
          return await this.getManifest(runDir);
        } catch (error) {
          continue;
        }
      }
    }
    
    // Try database
    return await this.getRunFromDatabase(runId);
  }
  
  async listRuns(
    filters?: {
      startDate?: Date;
      endDate?: Date;
      preset?: string;
      status?: string;
      limit?: number;
    }
  ): Promise<RunManifest[]> {
    const runs: RunManifest[] = [];
    
    try {
      const dirs = await fs.readdir(this.baseDir);
      
      for (const dir of dirs) {
        const runDir = path.join(this.baseDir, dir);
        
        try {
          const manifest = await this.getManifest(runDir);
          
          // Apply filters
          if (filters) {
            const manifestDate = new Date(manifest.timestamp);
            
            if (filters.startDate && manifestDate < filters.startDate) continue;
            if (filters.endDate && manifestDate > filters.endDate) continue;
            if (filters.preset && manifest.preset !== filters.preset) continue;
            if (filters.status && manifest.status !== filters.status) continue;
          }
          
          runs.push(manifest);
          
          if (filters?.limit && runs.length >= filters.limit) {
            break;
          }
        } catch (error) {
          // Skip invalid directories
          continue;
        }
      }
      
      // Sort by timestamp descending
      runs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      
    } catch (error) {
      logger.error('Failed to list runs:', error);
    }
    
    return runs;
  }
  
  async cleanupOldRuns(daysToKeep: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    let deletedCount = 0;
    
    try {
      const dirs = await fs.readdir(this.baseDir);
      
      for (const dir of dirs) {
        const runDir = path.join(this.baseDir, dir);
        
        try {
          const manifest = await this.getManifest(runDir);
          const manifestDate = new Date(manifest.timestamp);
          
          if (manifestDate < cutoffDate) {
            await this.deleteRun(runDir);
            deletedCount++;
            logger.info(`Deleted old run: ${dir}`);
          }
        } catch (error) {
          // Skip invalid directories
          continue;
        }
      }
      
    } catch (error) {
      logger.error('Failed to cleanup old runs:', error);
    }
    
    logger.info(`Cleaned up ${deletedCount} old runs`);
    return deletedCount;
  }
  
  private async saveManifest(runDir: string, manifest: RunManifest): Promise<void> {
    const manifestPath = path.join(runDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }
  
  private async deleteRun(runDir: string): Promise<void> {
    // Recursively delete directory
    await fs.rm(runDir, { recursive: true, force: true });
  }
  
  // Database operations
  
  private async storeRunInDatabase(manifest: RunManifest, runDir: string): Promise<void> {
    const pool = getPool();
    
    try {
      const query = `
        INSERT INTO runs (
          run_id, run_dir, preset, status, timestamp, manifest
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (run_id) DO UPDATE
        SET status = $3, manifest = $6
      `;
      
      await pool.query(query, [
        manifest.runId,
        runDir,
        manifest.preset,
        manifest.status,
        manifest.timestamp,
        JSON.stringify(manifest),
      ]);
      
    } catch (error) {
      logger.error('Failed to store run in database:', error);
      // Non-fatal: filesystem storage is primary
    }
  }
  
  private async updateRunInDatabase(manifest: RunManifest): Promise<void> {
    const pool = getPool();
    
    try {
      const query = `
        UPDATE runs
        SET status = $2, manifest = $3
        WHERE run_id = $1
      `;
      
      await pool.query(query, [
        manifest.runId,
        manifest.status,
        JSON.stringify(manifest),
      ]);
      
    } catch (error) {
      logger.error('Failed to update run in database:', error);
      // Non-fatal: filesystem storage is primary
    }
  }
  
  private async getRunFromDatabase(runId: string): Promise<RunManifest | null> {
    const pool = getPool();
    
    try {
      const result = await pool.query(
        'SELECT manifest FROM runs WHERE run_id = $1',
        [runId]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0].manifest as RunManifest;
      }
      
    } catch (error) {
      logger.error('Failed to get run from database:', error);
    }
    
    return null;
  }
  
  // Analysis helpers
  
  async generateRunReport(runId: string): Promise<string> {
    const manifest = await this.getRunByRunId(runId);
    
    if (!manifest) {
      throw new Error(`Run ${runId} not found`);
    }
    
    const report = [
      '# CardMint Run Report',
      `## Run ID: ${manifest.runId}`,
      `## Timestamp: ${manifest.timestamp}`,
      `## Preset: ${manifest.preset}`,
      `## Status: ${manifest.status}`,
      '',
      '### Summary',
      `- Capture Count: ${manifest.summary.captureCount}`,
      `- Processed Count: ${manifest.summary.processedCount}`,
      `- Success Rate: ${(manifest.summary.successRate * 100).toFixed(1)}%`,
      `- Total Duration: ${manifest.summary.totalDurationMs}ms`,
      `- Average Processing: ${manifest.summary.averageProcessingMs.toFixed(0)}ms`,
      '',
    ];
    
    if (manifest.extractedFields) {
      report.push('### Extracted Fields');
      report.push(`- Card Name: ${manifest.extractedFields.cardName || 'N/A'}`);
      report.push(`- Card Set: ${manifest.extractedFields.cardSet || 'N/A'}`);
      report.push(`- Card Number: ${manifest.extractedFields.cardNumber || 'N/A'}`);
      report.push(`- Rarity: ${manifest.extractedFields.rarity || 'N/A'}`);
      report.push('');
    }
    
    if (manifest.qualityMetrics) {
      report.push('### Quality Metrics');
      report.push(`- Overall Quality: ${manifest.qualityMetrics.overallQuality}/100`);
      report.push(`- Edge Score: ${manifest.qualityMetrics.edgeScore}/100`);
      report.push(`- Surface Score: ${manifest.qualityMetrics.surfaceScore}/100`);
      report.push(`- Centering Score: ${manifest.qualityMetrics.centeringScore}/100`);
      report.push(`- Corner Score: ${manifest.qualityMetrics.cornerScore}/100`);
      report.push('');
    }
    
    if (manifest.error) {
      report.push('### Error');
      report.push(manifest.error);
      report.push('');
    }
    
    report.push('### Files');
    report.push(`- Raw Images: ${manifest.files.raw.length}`);
    report.push(`- Processed Images: ${manifest.files.processed.length}`);
    report.push(`- OCR Results: ${manifest.files.ocr.length}`);
    report.push(`- Signal Files: ${manifest.files.signals.length}`);
    report.push(`- Metadata Files: ${manifest.files.metadata.length}`);
    
    return report.join('\n');
  }
}