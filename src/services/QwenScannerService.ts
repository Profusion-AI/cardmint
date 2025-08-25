import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import { startGlobalProfiler, endGlobalProfiler } from '../utils/performanceProfiler';

const execAsync = promisify(exec);

export interface QwenScanResult {
  name: string;
  set_name: string;
  number: string;
  rarity: string;
  hp?: string;
  type?: string;
  stage?: string;
  variant_flags: {
    first_edition: boolean;
    shadowless: boolean;
    reverse_holo: boolean;
    promo_stamp: boolean;
    stamped: boolean;
    misprint: boolean;
  };
  language: string;
  year?: string;
  confidence: number;
  source_file: string;
  processed_at: string;
  processing_time_ms?: number;
}

export class QwenScannerService {
  private readonly scannerPath = '/home/profusionai/CardMint/cardmint_scanner.py';
  private readonly scanDir = '/home/profusionai/CardMint/scans';
  private readonly processedDir = '/home/profusionai/CardMint/processed';
  private readonly inventoryPath = '/home/profusionai/CardMint/inventory.json';
  private readonly macServer = 'http://10.0.24.174:1234';

  constructor() {
    this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [this.scanDir, this.processedDir];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Check if the Qwen scanner is available and Mac server is accessible
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`python3 ${this.scannerPath} --test`);
      return stdout.includes('Connection successful');
    } catch (error) {
      logger.error('Qwen scanner not available:', error);
      return false;
    }
  }

  /**
   * Process a single card image using Qwen scanner
   */
  async processCard(imagePath: string): Promise<QwenScanResult | null> {
    const startTime = Date.now();
    const profiler = startGlobalProfiler(`qwen_${path.basename(imagePath)}`);
    
    try {
      // Copy image to scan directory if not already there
      const fileName = path.basename(imagePath);
      const scanPath = path.join(this.scanDir, fileName);
      
      profiler.startStage('copy_to_scan');
      if (imagePath !== scanPath) {
        await fs.copyFile(imagePath, scanPath);
      }
      profiler.endStage('copy_to_scan', { skipped: imagePath === scanPath });

      // Run the scanner
      logger.info(`Processing card with Qwen scanner: ${fileName}`);
      
      profiler.startStage('python_exec', { 
        scanner: this.scannerPath,
        file: fileName 
      });
      
      const { stdout, stderr } = await execAsync(
        `python3 ${this.scannerPath} --file "${scanPath}" --json`
      );
      
      profiler.endStage('python_exec', {
        stdout_length: stdout.length,
        has_stderr: !!stderr
      });

      if (stderr && !stderr.includes('INFO')) {
        logger.warn(`Scanner stderr: ${stderr}`);
      }

      // Parse the inventory file to get the latest result
      profiler.startStage('inventory_read');
      const inventory = await this.getInventory();
      const result = inventory.find(card => card.source_file === fileName);
      profiler.endStage('inventory_read', { 
        found: !!result,
        inventory_size: inventory.length 
      });

      if (result) {
        result.processing_time_ms = Date.now() - startTime;
        
        // Get profiler stats and log
        const report = endGlobalProfiler({ log: true });
        
        // Attach profiling data to result
        if (report) {
          (result as any).profiling = {
            stages: report.stages.map(s => ({
              name: s.name,
              duration_ms: s.duration
            })),
            total_ms: report.totalDuration
          };
        }
        
        logger.info(`Card processed successfully in ${result.processing_time_ms}ms`);
        return result;
      }

      endGlobalProfiler({ log: true });
      logger.warn('No result found in inventory after processing');
      return null;

    } catch (error) {
      endGlobalProfiler({ log: true });
      logger.error('Failed to process card:', error);
      return null;
    }
  }

  /**
   * Process all cards in the scan directory
   */
  async processAllCards(): Promise<QwenScanResult[]> {
    try {
      logger.info('Processing all cards in scan directory');
      const { stdout } = await execAsync(`python3 ${this.scannerPath} --scan --json`);
      
      const inventory = await this.getInventory();
      logger.info(`Processed ${inventory.length} cards total`);
      
      return inventory;
    } catch (error) {
      logger.error('Failed to process all cards:', error);
      return [];
    }
  }

  /**
   * Get the current inventory
   */
  async getInventory(): Promise<QwenScanResult[]> {
    try {
      const data = await fs.readFile(this.inventoryPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get scanner statistics
   */
  async getStats(): Promise<any> {
    try {
      const { stdout } = await execAsync(`python3 ${this.scannerPath} --stats --json`);
      return JSON.parse(stdout);
    } catch (error) {
      logger.error('Failed to get stats:', error);
      return null;
    }
  }

  /**
   * Export inventory to HTML
   */
  async exportHtml(): Promise<string> {
    try {
      await execAsync(`python3 ${this.scannerPath} --export html`);
      const htmlPath = '/home/profusionai/CardMint/inventory.html';
      return htmlPath;
    } catch (error) {
      logger.error('Failed to export HTML:', error);
      throw error;
    }
  }

  /**
   * Start watch mode (returns child process)
   */
  startWatchMode() {
    const { spawn } = require('child_process');
    const watchProcess = spawn('python3', [this.scannerPath, '--watch'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    watchProcess.stdout.on('data', (data: Buffer) => {
      logger.info(`Watch mode: ${data.toString().trim()}`);
    });

    watchProcess.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes('INFO')) {
        logger.error(`Watch mode error: ${msg}`);
      }
    });

    watchProcess.on('close', (code: number) => {
      logger.info(`Watch mode exited with code ${code}`);
    });

    return watchProcess;
  }

  /**
   * Convert Qwen result to database format
   */
  formatForDatabase(result: QwenScanResult): any {
    return {
      name: result.name,
      set_name: result.set_name,
      card_number: result.number,
      rarity: result.rarity,
      hp: result.hp ? parseInt(result.hp) : null,
      type: result.type,
      stage: result.stage,
      is_first_edition: result.variant_flags.first_edition,
      is_shadowless: result.variant_flags.shadowless,
      is_reverse_holo: result.variant_flags.reverse_holo,
      is_promo: result.variant_flags.promo_stamp,
      language: result.language,
      year: result.year ? parseInt(result.year) : null,
      confidence_score: result.confidence,
      source_file: result.source_file,
      processed_at: new Date(result.processed_at),
      processing_method: 'qwen2.5-vl',
      processing_time_ms: result.processing_time_ms || null
    };
  }
}

// Singleton instance
export const qwenScanner = new QwenScannerService();