/**
 * Perceptual Hash Precompute Job
 * Generates and caches perceptual hashes for pokemon dataset images
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { createLogger } from '../../utils/logger';
import type { PerceptualHashEntry } from '../../services/local-matching/types';

const logger = createLogger('PrecomputeHashes');

interface ImageEntry {
  imagePath: string;
  cardName: string;
  setCode: string;
  cardNumber: string;
  relativePath: string;
}

export class PrecomputeHashesJob {
  private readonly dataRoot: string;
  private readonly cacheDir: string;
  private readonly phashDbPath: string;
  private readonly pokemonDatasetPath: string;
  
  private db?: Database.Database;
  private insertStmt?: Database.Statement;
  private checkStmt?: Database.Statement;
  
  constructor() {
    this.dataRoot = process.env.DATA_ROOT || './data';
    this.cacheDir = process.env.LOCAL_CACHE_DIR || path.join(this.dataRoot, 'cache', 'local');
    this.phashDbPath = path.join(this.cacheDir, 'phash.db');
    this.pokemonDatasetPath = path.join(this.dataRoot, 'pokemon_dataset');
  }

  async initialize(): Promise<void> {
    // Ensure cache directory exists
    await fs.mkdir(this.cacheDir, { recursive: true });
    
    // Initialize hash database
    this.db = new Database(this.phashDbPath);
    
    // Optimize database for writes
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    
    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS perceptual_hashes (
        image_id TEXT PRIMARY KEY,
        image_path TEXT NOT NULL,
        phash64 TEXT NOT NULL,
        dhash64 TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        card_name TEXT NOT NULL,
        set_code TEXT NOT NULL,
        card_number TEXT NOT NULL,
        dataset_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        file_size INTEGER,
        file_hash TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_phash ON perceptual_hashes(phash64);
      CREATE INDEX IF NOT EXISTS idx_dhash ON perceptual_hashes(dhash64);
      CREATE INDEX IF NOT EXISTS idx_card_info ON perceptual_hashes(set_code, card_number);
      CREATE INDEX IF NOT EXISTS idx_dataset_version ON perceptual_hashes(dataset_version);
    `);
    
    // Prepare statements
    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO perceptual_hashes 
      (image_id, image_path, phash64, dhash64, width, height, card_name, set_code, card_number, 
       dataset_version, created_at, file_size, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    this.checkStmt = this.db.prepare(`
      SELECT file_hash, created_at 
      FROM perceptual_hashes 
      WHERE image_id = ?
    `);
    
    logger.info('Precompute hashes job initialized');
  }

  async run(): Promise<{processed: number, skipped: number, errors: number}> {
    if (!this.db || !this.insertStmt || !this.checkStmt) {
      await this.initialize();
    }
    
    logger.info('Starting perceptual hash precomputation...');
    
    const stats = {
      processed: 0,
      skipped: 0,
      errors: 0
    };
    
    try {
      const datasetVersion = await this.getDatasetVersion();
      const imageEntries = await this.collectImageEntries();
      
      logger.info(`Found ${imageEntries.length} images to process`);
      
      // Process in batches for memory efficiency
      const batchSize = 100;
      
      for (let i = 0; i < imageEntries.length; i += batchSize) {
        const batch = imageEntries.slice(i, i + batchSize);
        const batchStats = await this.processBatch(batch, datasetVersion);
        
        stats.processed += batchStats.processed;
        stats.skipped += batchStats.skipped;
        stats.errors += batchStats.errors;
        
        // Progress logging
        const progress = Math.round(((i + batch.length) / imageEntries.length) * 100);
        logger.info(`Progress: ${progress}% (${i + batch.length}/${imageEntries.length})`);
      }
      
      // Cleanup old entries
      await this.cleanupOldEntries(datasetVersion);
      
      logger.info('Perceptual hash precomputation completed', stats);
      return stats;
      
    } catch (error) {
      logger.error('Error during hash precomputation:', error);
      throw error;
    }
  }

  private async getDatasetVersion(): Promise<string> {
    try {
      // Generate version hash from dataset directory
      const structuredPath = path.join(this.pokemonDatasetPath, 'structured');
      const files = await fs.readdir(structuredPath);
      const fileStats = await Promise.all(
        files.map(async (file) => {
          const stat = await fs.stat(path.join(structuredPath, file));
          return `${file}:${stat.mtime.getTime()}:${stat.size}`;
        })
      );
      
      const versionString = fileStats.sort().join('|');
      return crypto.createHash('sha256').update(versionString).digest('hex').substring(0, 16);
    } catch (error) {
      logger.warn('Failed to generate dataset version, using timestamp:', error);
      return Date.now().toString();
    }
  }

  private async collectImageEntries(): Promise<ImageEntry[]> {
    const entries: ImageEntry[] = [];
    const imagesDir = path.join(this.pokemonDatasetPath, 'images');
    
    try {
      const imageFiles = await fs.readdir(imagesDir);
      
      for (const fileName of imageFiles) {
        if (!this.isImageFile(fileName)) continue;
        
        const imagePath = path.join(imagesDir, fileName);
        const parsed = this.parseImageFileName(fileName);
        
        if (parsed) {
          entries.push({
            imagePath,
            relativePath: `images/${fileName}`,
            ...parsed
          });
        }
      }
    } catch (error) {
      logger.warn('Error collecting image entries:', error);
    }
    
    return entries;
  }

  private isImageFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
  }

  private parseImageFileName(fileName: string): {cardName: string, setCode: string, cardNumber: string} | null {
    // Parse filenames like "base1-6.png" or "neo4-5.jpg"
    const nameWithoutExt = path.parse(fileName).name;
    
    // Try pattern: setcode-number
    const match = nameWithoutExt.match(/^([a-zA-Z0-9]+)-(\d+)$/);
    if (match) {
      return {
        setCode: match[1],
        cardNumber: match[2],
        cardName: `Unknown ${match[1]} ${match[2]}` // Will be enhanced by lookup
      };
    }
    
    return null;
  }

  private async processBatch(batch: ImageEntry[], datasetVersion: string): Promise<{processed: number, skipped: number, errors: number}> {
    const stats = { processed: 0, skipped: 0, errors: 0 };
    
    const transaction = this.db!.transaction((entries: ImageEntry[]) => {
      for (const entry of entries) {
        try {
          this.processImageEntry(entry, datasetVersion);
          stats.processed++;
        } catch (error) {
          logger.debug(`Error processing ${entry.imagePath}:`, error);
          stats.errors++;
        }
      }
    });
    
    try {
      const processableEntries: ImageEntry[] = [];
      
      // Check which entries need processing
      for (const entry of batch) {
        const imageId = this.generateImageId(entry);
        const existing = this.checkStmt!.get(imageId) as {file_hash: string, created_at: number} | undefined;
        
        if (existing) {
          try {
            const currentHash = await this.getFileHash(entry.imagePath);
            if (existing.file_hash === currentHash) {
              stats.skipped++;
              continue;
            }
          } catch (error) {
            logger.debug(`File check error for ${entry.imagePath}:`, error);
          }
        }
        
        processableEntries.push(entry);
      }
      
      // Process new/changed entries in transaction
      if (processableEntries.length > 0) {
        transaction(processableEntries);
      }
      
    } catch (error) {
      logger.error('Batch processing error:', error);
      stats.errors += batch.length;
    }
    
    return stats;
  }

  private processImageEntry(entry: ImageEntry, datasetVersion: string): void {
    const imageId = this.generateImageId(entry);
    
    // Generate deterministic placeholder hashes for now
    // Real implementation would use image processing library
    const phash64 = this.generatePlaceholderHash(entry, 'phash');
    const dhash64 = this.generatePlaceholderHash(entry, 'dhash');
    
    this.insertStmt!.run(
      imageId,
      entry.imagePath,
      phash64,
      dhash64,
      1024, // placeholder width
      1024, // placeholder height
      entry.cardName,
      entry.setCode,
      entry.cardNumber,
      datasetVersion,
      Date.now(),
      0, // placeholder file size
      'placeholder_hash'
    );
  }

  private generatePlaceholderHash(entry: ImageEntry, type: 'phash' | 'dhash'): string {
    // Generate deterministic but unique placeholder hashes
    const input = `${type}:${entry.setCode}:${entry.cardNumber}:${entry.imagePath}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  private generateImageId(entry: ImageEntry): string {
    return `${entry.setCode}-${entry.cardNumber}`;
  }

  private async getFileHash(filePath: string): Promise<string> {
    try {
      const buffer = await fs.readFile(filePath);
      return crypto.createHash('md5').update(buffer).digest('hex');
    } catch (error) {
      return 'error';
    }
  }

  private async cleanupOldEntries(currentVersion: string): Promise<void> {
    try {
      const result = this.db!.prepare(`
        DELETE FROM perceptual_hashes 
        WHERE dataset_version != ?
      `).run(currentVersion);
      
      if (result.changes > 0) {
        logger.info(`Cleaned up ${result.changes} old hash entries`);
      }
    } catch (error) {
      logger.warn('Error cleaning up old entries:', error);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }
}

export async function runPrecomputeHashes(): Promise<{processed: number, skipped: number, errors: number}> {
  const root = process.env.DATA_ROOT ?? "./data";
  const cacheDir = process.env.LOCAL_CACHE_DIR ?? "./data/cache/local";
  console.log(`[precompute-hashes] DATA_ROOT=%s, CACHE_DIR=%s`, root, cacheDir);
  
  const job = new PrecomputeHashesJob();
  try {
    return await job.run();
  } finally {
    await job.close();
  }
}

// CLI interface
if (require.main === module) {
  runPrecomputeHashes()
    .then((stats) => {
      console.log('Precompute hashes job completed:', stats);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Precompute hashes job failed:', error);
      process.exit(1);
    });
}

