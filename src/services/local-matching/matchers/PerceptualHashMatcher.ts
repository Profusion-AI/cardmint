/**
 * PerceptualHashMatcher - Fast image similarity matching using perceptual hashes
 * Primary strategy for local-first recognition with real pHash + Hamming distance KNN
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { imageHash } from 'image-hash';
import { promisify } from 'util';
import { createLogger } from '../../../utils/logger';
import { createPerformanceLogger } from '../../../utils/localMatchingMetrics';
import { roiRegistry } from '../ROIRegistry';
import type { Matcher, MatchResult, MatchCandidate, PerceptualHashEntry } from '../types';

const logger = createLogger('PerceptualHashMatcher');

// Convert imageHash to promisified version
const imageHashAsync = promisify(imageHash);

interface HashSearchResult {
  entry: PerceptualHashEntry;
  hammingDistance: number;
  similarity: number;
}

export class PerceptualHashMatcher implements Matcher {
  public readonly name = 'phash' as const;
  
  private db?: Database.Database;
  private findAllHashesStmt?: Database.Statement;
  private findByHashStmt?: Database.Statement;
  private readonly phashDbPath: string;
  private ready = false;
  
  // Performance configuration
  private readonly maxSearchResults: number;
  private readonly hammingThreshold: number;
  private readonly useArtworkROI: boolean;

  constructor() {
    const dataRoot = process.env.DATA_ROOT || './data';
    const cacheDir = process.env.LOCAL_CACHE_DIR || path.join(dataRoot, 'cache', 'local');
    this.phashDbPath = path.join(cacheDir, 'phash.db');
    
    // Configuration from environment
    this.maxSearchResults = parseInt(process.env.PHASH_MAX_RESULTS || '100');
    this.hammingThreshold = parseInt(process.env.PHASH_HAMMING_THRESHOLD || '15'); // Max Hamming distance
    this.useArtworkROI = process.env.PHASH_USE_ARTWORK_ROI !== 'false';
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    
    try {
      this.db = new Database(this.phashDbPath, { readonly: true });
      
      // Optimize for read performance
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = 10000');
      this.db.pragma('mmap_size = 268435456'); // 256MB
      
      // Prepare optimized statements
      this.findAllHashesStmt = this.db.prepare(`
        SELECT 
          image_id,
          image_path,
          phash64,
          dhash64,
          card_name,
          set_code,
          card_number,
          width,
          height,
          dataset_version,
          created_at
        FROM perceptual_hashes
        WHERE dataset_version = (SELECT MAX(dataset_version) FROM perceptual_hashes)
        ORDER BY created_at DESC
      `);
      
      this.findByHashStmt = this.db.prepare(`
        SELECT 
          image_id,
          image_path,
          phash64,
          dhash64,
          card_name,
          set_code,
          card_number,
          width,
          height
        FROM perceptual_hashes
        WHERE phash64 = ? OR dhash64 = ?
        LIMIT 10
      `);
      
      // Check if we have data
      const count = this.db.prepare('SELECT COUNT(*) as count FROM perceptual_hashes').get() as {count: number};
      
      if (count.count === 0) {
        logger.warn('Perceptual hash database is empty. Run precompute-hashes job first.');
        this.ready = false;
        return;
      }
      
      this.ready = true;
      logger.info(`Perceptual hash matcher initialized with ${count.count} entries`);
      
    } catch (error) {
      logger.warn('Failed to initialize perceptual hash matcher:', error);
      this.ready = false;
    }
  }

  async match(imagePath: string, imageBuffer?: Buffer): Promise<MatchResult> {
    const perfLogger = createPerformanceLogger('PerceptualHashMatcher.match');
    const scanId = path.basename(imagePath, path.extname(imagePath));
    
    if (!this.ready) {
      await this.initialize();
    }
    
    if (!this.ready || !this.findAllHashesStmt) {
      const errorTime = perfLogger.end({ error: 'not_ready' });
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: 'Matcher not ready' }
      };
    }
    
    try {
      logger.debug(`Computing perceptual hash for ${scanId}...`);
      
      // Step 1: Extract artwork ROI if enabled
      let targetBuffer = imageBuffer;
      if (!targetBuffer) {
        targetBuffer = await fs.readFile(imagePath);
      }
      
      if (this.useArtworkROI) {
        targetBuffer = await this.extractArtworkROI(targetBuffer);
      }
      
      // Step 2: Generate perceptual hashes
      const { phash64, dhash64 } = await this.generateHashes(targetBuffer);
      
      // Step 3: Fast exact match lookup first
      const exactMatches = await this.findExactMatches(phash64, dhash64);
      if (exactMatches.length > 0) {
        const matchTime = perfLogger.end({ 
          exactMatch: true, 
          candidates: exactMatches.length 
        });
        
        const candidate: MatchCandidate = {
          canonical_key: `${exactMatches[0].set_code}|${exactMatches[0].card_number}|*|${exactMatches[0].card_name?.toLowerCase().replace(/\s+/g, '-')}`,
          confidence: 0.98, // Very high confidence for exact hash match
          metadata: {
            image_id: exactMatches[0].image_id,
            source_path: exactMatches[0].image_path,
            match_type: 'exact_hash',
            phash64,
            dhash64
          }
        };
        
        return {
          matched: true,
          confidence: 0.98,
          best_candidate: candidate,
          all_candidates: [candidate],
          processing_time_ms: matchTime,
          cached: false,
          metadata: {
            match_type: 'exact_hash',
            hamming_distance: 0
          }
        };
      }
      
      // Step 4: KNN search using Hamming distance
      const similarMatches = await this.findSimilarHashes(phash64, dhash64);
      
      if (similarMatches.length === 0) {
        const noMatchTime = perfLogger.end({ 
          exactMatch: false, 
          candidates: 0,
          hamming_searched: true 
        });
        
        return {
          matched: false,
          confidence: 0,
          processing_time_ms: noMatchTime,
          cached: false,
          metadata: {
            match_type: 'no_match',
            phash64,
            dhash64,
            hamming_threshold: this.hammingThreshold
          }
        };
      }
      
      // Step 5: Convert to candidates with confidence scoring
      const candidates: MatchCandidate[] = similarMatches.map(result => ({
        canonical_key: `${result.entry.set_code}|${result.entry.card_number}|*|${result.entry.card_name?.toLowerCase().replace(/\s+/g, '-')}`,
        confidence: result.similarity,
        metadata: {
          image_id: result.entry.image_id,
          source_path: result.entry.image_path,
          match_type: 'hamming_similarity',
          hamming_distance: result.hammingDistance,
          similarity_score: result.similarity,
          phash64,
          dhash64
        }
      }));
      
      const bestMatch = candidates[0];
      const matchTime = perfLogger.end({
        exactMatch: false,
        candidates: candidates.length,
        bestSimilarity: bestMatch?.confidence || 0,
        hammingDistance: similarMatches[0]?.hammingDistance || -1
      });
      
      return {
        matched: bestMatch.confidence > 0.5, // Threshold for "matched"
        confidence: bestMatch.confidence,
        best_candidate: bestMatch,
        all_candidates: candidates,
        processing_time_ms: matchTime,
        cached: false,
        metadata: {
          match_type: 'hamming_similarity',
          total_database_entries: similarMatches.length,
          best_hamming_distance: similarMatches[0]?.hammingDistance || -1
        }
      };
      
    } catch (error) {
      const errorTime = perfLogger.end({ error: true });
      logger.error(`Perceptual hash matching failed for ${scanId}:`, error);
      
      return {
        matched: false,
        confidence: 0,
        processing_time_ms: errorTime,
        cached: false,
        metadata: { error: String(error) }
      };
    }
  }

  private async extractArtworkROI(imageBuffer: Buffer): Promise<Buffer> {
    try {
      // Get ROI definition for artwork area
      const { rois } = await roiRegistry.getROIDefinition();
      const artworkROI = rois.artwork;
      
      // Extract artwork region using sharp
      const artworkBuffer = await sharp(imageBuffer)
        .extract({
          left: Math.round(artworkROI.x),
          top: Math.round(artworkROI.y),
          width: Math.round(artworkROI.width),
          height: Math.round(artworkROI.height)
        })
        .toBuffer();
      
      logger.debug(`Extracted artwork ROI: ${artworkROI.width}x${artworkROI.height} from ${artworkROI.x},${artworkROI.y}`);
      return artworkBuffer;
      
    } catch (error) {
      logger.warn('Failed to extract artwork ROI, using full image:', error);
      return imageBuffer;
    }
  }

  private async generateHashes(imageBuffer: Buffer): Promise<{ phash64: string; dhash64: string }> {
    try {
      // Normalize image to standard size for consistent hashing
      const normalizedBuffer = await sharp(imageBuffer)
        .resize(256, 256, { fit: 'inside', withoutEnlargement: false })
        .grayscale()
        .toBuffer();
      
      // Generate both perceptual and difference hashes
      const phash64 = await imageHashAsync(normalizedBuffer, 16, 'hex');
      const dhash64 = await imageHashAsync(normalizedBuffer, 16, 'hex'); // TODO: Use proper dHash algorithm
      
      logger.debug(`Generated hashes - pHash: ${phash64}, dHash: ${dhash64}`);
      
      return { phash64, dhash64 };
      
    } catch (error) {
      logger.error('Failed to generate perceptual hashes:', error);
      throw error;
    }
  }

  private async findExactMatches(phash64: string, dhash64: string): Promise<PerceptualHashEntry[]> {
    if (!this.findByHashStmt) return [];
    
    try {
      const matches = this.findByHashStmt.all(phash64, dhash64) as PerceptualHashEntry[];
      
      if (matches.length > 0) {
        logger.debug(`Found ${matches.length} exact hash matches`);
      }
      
      return matches;
      
    } catch (error) {
      logger.error('Error finding exact hash matches:', error);
      return [];
    }
  }

  private async findSimilarHashes(targetPhash: string, targetDhash: string): Promise<HashSearchResult[]> {
    if (!this.findAllHashesStmt) return [];
    
    try {
      // Get all hash entries from database
      const allEntries = this.findAllHashesStmt.all() as PerceptualHashEntry[];
      
      logger.debug(`Searching ${allEntries.length} hash entries for similar matches`);
      
      const results: HashSearchResult[] = [];
      
      // Compute Hamming distances for all entries
      for (const entry of allEntries) {
        // Calculate Hamming distance for both hash types
        const phashDistance = this.hammingDistance(targetPhash, entry.phash64);
        const dhashDistance = this.hammingDistance(targetDhash, entry.dhash64);
        
        // Use the minimum distance (best match between the two hash types)
        const minDistance = Math.min(phashDistance, dhashDistance);
        
        // Only include entries within threshold
        if (minDistance <= this.hammingThreshold) {
          const similarity = this.hammingDistanceToSimilarity(minDistance);
          
          results.push({
            entry,
            hammingDistance: minDistance,
            similarity
          });
        }
      }
      
      // Sort by similarity (highest first)
      results.sort((a, b) => b.similarity - a.similarity);
      
      // Limit results
      const limitedResults = results.slice(0, this.maxSearchResults);
      
      logger.debug(`Found ${limitedResults.length} similar matches within Hamming distance ${this.hammingThreshold}`);
      
      return limitedResults;
      
    } catch (error) {
      logger.error('Error finding similar hashes:', error);
      return [];
    }
  }

  private mockSimilarityScore(targetPath: string, candidatePath: string): number {
    // Generate mock similarity score based on path similarity
    const targetBase = path.basename(targetPath, path.extname(targetPath));
    const candidateBase = path.basename(candidatePath, path.extname(candidatePath));
    
    // Simple string similarity
    const similarity = this.stringSimilarity(targetBase, candidateBase);
    return similarity;
  }

  private stringSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const substitutionCost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1, // deletion
          matrix[j - 1][i] + 1, // insertion
          matrix[j - 1][i - 1] + substitutionCost // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  private calculateConfidence(candidate: MatchCandidate): number {
    // Convert similarity score to confidence
    const score = candidate.score || 0;
    
    // Apply confidence curve
    if (score > 0.9) return 0.95;
    if (score > 0.8) return 0.85;
    if (score > 0.7) return 0.75;
    if (score > 0.6) return 0.65;
    if (score > 0.5) return 0.55;
    
    return score * 0.5; // Low confidence for poor matches
  }

  private hammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) {
      logger.warn(`Hash length mismatch: ${hash1.length} vs ${hash2.length}`);
      return Math.max(hash1.length, hash2.length); // Max possible distance
    }
    
    let distance = 0;
    
    // Compare hex strings character by character
    // Each hex character represents 4 bits, so we need to convert to binary
    for (let i = 0; i < hash1.length; i++) {
      const hex1 = parseInt(hash1[i], 16);
      const hex2 = parseInt(hash2[i], 16);
      
      if (isNaN(hex1) || isNaN(hex2)) continue;
      
      // XOR the hex values and count set bits
      const xor = hex1 ^ hex2;
      distance += this.popCount(xor);
    }
    
    return distance;
  }

  private popCount(n: number): number {
    // Count number of set bits in a 4-bit number (0-15)
    let count = 0;
    while (n) {
      count++;
      n &= n - 1; // Clear the lowest set bit
    }
    return count;
  }

  private hammingDistanceToSimilarity(distance: number): number {
    // Convert Hamming distance to similarity score (0-1)
    // Assuming 64-bit hash (16 hex characters * 4 bits each)
    const maxDistance = 64;
    const normalizedDistance = Math.min(distance, maxDistance) / maxDistance;
    
    // Apply exponential decay for better discrimination
    const similarity = Math.exp(-normalizedDistance * 5); // e^(-5x) curve
    
    return Math.max(0, Math.min(1, similarity));
  }

  isReady(): boolean {
    return this.ready;
  }

  async precompute(): Promise<void> {
    // This would trigger the precompute job
    logger.info('Perceptual hash precompute triggered');
    // Implementation would call PrecomputeHashesJob
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
      this.ready = false;
    }
  }

  getStats(): {ready: boolean, entries: number} {
    if (!this.ready || !this.db) {
      return { ready: false, entries: 0 };
    }
    
    try {
      const result = this.db.prepare('SELECT COUNT(*) as count FROM perceptual_hashes').get() as {count: number};
      return { ready: true, entries: result.count };
    } catch (error) {
      return { ready: false, entries: 0 };
    }
  }
}