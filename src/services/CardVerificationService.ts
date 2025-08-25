import { logger } from '../utils/logger';
import { getDatabase } from '../storage/sqlite-database';
import type { DatabaseMatch, VerificationResult } from '../adapters/lmstudio/QwenVerifierInference';
import type { InferenceResult } from '../core/infer/InferencePort';
import { getGlobalProfiler } from '../utils/performanceProfiler';

/**
 * Card embedding for semantic similarity matching
 */
export interface CardEmbedding {
  card_id: string;
  card_name: string;
  set_name: string;
  embedding: number[]; // 384-dim sentence transformer embedding
  created_at: Date;
}

/**
 * Database verification service with precomputed embeddings
 * Provides fuzzy matching, GIN/Trigram indexes, and cosine similarity fallback
 * Designed for <5ms database checks during verification
 */
export class CardVerificationService {
  private readonly EXACT_MATCH_THRESHOLD = 1.0;
  private readonly FUZZY_MATCH_THRESHOLD = 0.8;
  private readonly EMBEDDING_MATCH_THRESHOLD = 0.75;
  private readonly MAX_MATCHES = 5;

  // In-memory embedding cache for fastest lookups
  private embeddingCache: Map<string, CardEmbedding> = new Map();
  private cacheLoaded = false;

  constructor() {
    // Preload embeddings cache on service startup
    this.preloadEmbeddings().catch(error => {
      logger.error('Failed to preload embeddings cache:', error);
    });
  }

  /**
   * Main verification method - checks primary result against database
   */
  async verifyAgainstDatabase(
    primaryResult: InferenceResult,
    options: { max_matches?: number; enable_embeddings?: boolean } = {}
  ): Promise<DatabaseMatch[]> {
    const profiler = getGlobalProfiler();
    const matches: DatabaseMatch[] = [];

    try {
      profiler?.startStage('database_check', {
        primary_card: primaryResult.card_title,
        enable_embeddings: options.enable_embeddings ?? true
      });

      // 1. Exact match (fastest)
      const exactMatches = await this.findExactMatches(primaryResult);
      matches.push(...exactMatches);

      // 2. Fuzzy match using trigram similarity
      if (matches.length === 0 || matches[0].similarity_score < this.EXACT_MATCH_THRESHOLD) {
        const fuzzyMatches = await this.findFuzzyMatches(primaryResult);
        matches.push(...fuzzyMatches);
      }

      // 3. Embedding-based semantic similarity (if enabled and no good matches)
      if (options.enable_embeddings !== false && 
          (matches.length === 0 || matches[0].similarity_score < this.FUZZY_MATCH_THRESHOLD)) {
        const embeddingMatches = await this.findEmbeddingMatches(primaryResult);
        matches.push(...embeddingMatches);
      }

      // Sort by similarity and limit results
      matches.sort((a, b) => b.similarity_score - a.similarity_score);
      const limitedMatches = matches.slice(0, options.max_matches || this.MAX_MATCHES);

      profiler?.endStage('database_check', {
        total_matches: limitedMatches.length,
        best_score: limitedMatches[0]?.similarity_score || 0,
        match_types: limitedMatches.map(m => m.match_type).join(',')
      });

      logger.debug(`Database verification found ${limitedMatches.length} matches for "${primaryResult.card_title}"`);
      return limitedMatches;

    } catch (error) {
      profiler?.endStage('database_check', { error: String(error) });
      logger.error('Database verification failed:', error);
      return [];
    }
  }

  /**
   * Store verification result in card_validation table
   */
  async storeVerificationResult(
    cardId: string,
    primaryResult: InferenceResult,
    verificationResult: VerificationResult
  ): Promise<void> {
    try {
      const db = getDatabase();
      
      const validationRecord = {
        id: crypto.randomUUID ? crypto.randomUUID() : this.generateUUID(),
        card_id: cardId,
        validation_type: 'dual_model',
        
        // Verification scores
        overall_similarity: verificationResult.agrees_with_primary ? 0.95 : 0.6,
        
        // API validation (from verifier)
        api_match_confidence: verificationResult.verifier_confidence,
        api_discrepancies: verificationResult.semantic_flags,
        
        // Results
        is_valid: verificationResult.agrees_with_primary && verificationResult.confidence_adjustment >= -0.1,
        validation_notes: `Primary: ${primaryResult.confidence.toFixed(3)}, Verifier: ${verificationResult.verifier_confidence.toFixed(3)}, Adjustment: ${verificationResult.confidence_adjustment.toFixed(3)}`,
        validated_by: 'dual_verify_system',
        validated_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };

      const stmt = db.prepare(`
        INSERT INTO card_validation (
          id, card_id, validation_type, overall_similarity, api_match_confidence,
          api_discrepancies, is_valid, validation_notes, validated_by, validated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        validationRecord.id,
        validationRecord.card_id,
        validationRecord.validation_type,
        validationRecord.overall_similarity,
        validationRecord.api_match_confidence,
        JSON.stringify(validationRecord.api_discrepancies),
        validationRecord.is_valid ? 1 : 0,
        validationRecord.validation_notes,
        validationRecord.validated_by,
        validationRecord.validated_at,
        validationRecord.created_at
      );

      logger.debug(`Stored verification result for card ${cardId}`);

    } catch (error) {
      logger.error('Failed to store verification result:', error);
      // Don't throw - verification storage failure shouldn't break the pipeline
    }
  }

  /**
   * Get verification statistics for monitoring
   */
  async getVerificationStats(): Promise<{
    total_verifications: number;
    agreement_rate: number;
    avg_confidence_adjustment: number;
    top_semantic_flags: Array<{ flag: string; count: number }>;
  }> {
    try {
      const db = getDatabase();
      
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total_verifications,
          AVG(CASE WHEN is_valid THEN 1.0 ELSE 0.0 END) as agreement_rate,
          AVG(api_match_confidence) as avg_confidence_adjustment
        FROM card_validation 
        WHERE validation_type = 'dual_model'
        AND created_at > datetime('now', '-24 hours')
      `).get() as any;

      // Get top semantic flags
      const flagCounts = db.prepare(`
        SELECT flag, COUNT(*) as count
        FROM (
          SELECT json_each.value as flag
          FROM card_validation, json_each(api_discrepancies)
          WHERE validation_type = 'dual_model'
          AND created_at > datetime('now', '-24 hours')
        )
        GROUP BY flag
        ORDER BY count DESC
        LIMIT 5
      `).all() as Array<{ flag: string; count: number }>;

      return {
        total_verifications: stats?.total_verifications || 0,
        agreement_rate: stats?.agreement_rate || 0,
        avg_confidence_adjustment: stats?.avg_confidence_adjustment || 0,
        top_semantic_flags: flagCounts || []
      };

    } catch (error) {
      logger.error('Failed to get verification stats:', error);
      return {
        total_verifications: 0,
        agreement_rate: 0,
        avg_confidence_adjustment: 0,
        top_semantic_flags: []
      };
    }
  }

  private async findExactMatches(result: InferenceResult): Promise<DatabaseMatch[]> {
    try {
      const db = getDatabase();
      
      const matches = db.prepare(`
        SELECT 
          id as card_id,
          card_name,
          set_name,
          card_number,
          rarity
        FROM pokemon_cards 
        WHERE LOWER(card_name) = LOWER(?)
        AND LOWER(set_name) = LOWER(?)
        LIMIT ?
      `).all(
        result.card_title,
        result.set_name || '',
        this.MAX_MATCHES
      ) as any[];

      return matches.map(match => ({
        card_id: match.card_id,
        similarity_score: 1.0,
        match_type: 'exact' as const,
        matched_fields: ['card_name', 'set_name'],
        discrepancies: []
      }));

    } catch (error) {
      logger.error('Exact match search failed:', error);
      return [];
    }
  }

  private async findFuzzyMatches(result: InferenceResult): Promise<DatabaseMatch[]> {
    try {
      const db = getDatabase();
      
      // Use trigram similarity for fuzzy matching
      const matches = db.prepare(`
        SELECT 
          id as card_id,
          card_name,
          set_name,
          card_number,
          rarity,
          -- Trigram similarity scores
          (similarity(card_name, ?) + similarity(set_name, ?)) / 2 as similarity_score
        FROM pokemon_cards 
        WHERE similarity(card_name, ?) > 0.3
        OR similarity(set_name, ?) > 0.3
        ORDER BY similarity_score DESC
        LIMIT ?
      `).all(
        result.card_title,
        result.set_name || '',
        result.card_title,
        result.set_name || '',
        this.MAX_MATCHES
      ) as any[];

      return matches
        .filter(match => match.similarity_score >= 0.5)
        .map(match => {
          const discrepancies = [];
          if (match.card_name.toLowerCase() !== result.card_title.toLowerCase()) {
            discrepancies.push('card_name_fuzzy');
          }
          if (match.set_name.toLowerCase() !== (result.set_name || '').toLowerCase()) {
            discrepancies.push('set_name_fuzzy');
          }

          return {
            card_id: match.card_id,
            similarity_score: match.similarity_score,
            match_type: 'fuzzy' as const,
            matched_fields: ['card_name', 'set_name'],
            discrepancies
          };
        });

    } catch (error) {
      logger.error('Fuzzy match search failed (possibly missing pg_trgm):', error);
      // Fallback to simple LIKE matching
      return this.findSimpleFuzzyMatches(result);
    }
  }

  private async findSimpleFuzzyMatches(result: InferenceResult): Promise<DatabaseMatch[]> {
    try {
      const db = getDatabase();
      
      const namePattern = `%${result.card_title.toLowerCase()}%`;
      const setPattern = `%${(result.set_name || '').toLowerCase()}%`;
      
      const matches = db.prepare(`
        SELECT 
          id as card_id,
          card_name,
          set_name,
          card_number,
          rarity
        FROM pokemon_cards 
        WHERE LOWER(card_name) LIKE ?
        OR LOWER(set_name) LIKE ?
        LIMIT ?
      `).all(namePattern, setPattern, this.MAX_MATCHES) as any[];

      return matches.map(match => ({
        card_id: match.card_id,
        similarity_score: 0.7, // Default fuzzy score
        match_type: 'fuzzy' as const,
        matched_fields: ['card_name', 'set_name'],
        discrepancies: ['simple_fuzzy_match']
      }));

    } catch (error) {
      logger.error('Simple fuzzy match failed:', error);
      return [];
    }
  }

  private async findEmbeddingMatches(result: InferenceResult): Promise<DatabaseMatch[]> {
    if (!this.cacheLoaded || this.embeddingCache.size === 0) {
      logger.debug('Embedding cache not loaded, skipping embedding matches');
      return [];
    }

    try {
      // Generate embedding for query (placeholder - would use actual sentence transformer)
      const queryEmbedding = this.generateSimpleEmbedding(
        `${result.card_title} ${result.set_name || ''}`
      );

      const matches: DatabaseMatch[] = [];

      // Compare with cached embeddings
      for (const [key, cached] of this.embeddingCache) {
        const similarity = this.cosineSimilarity(queryEmbedding, cached.embedding);
        
        if (similarity >= this.EMBEDDING_MATCH_THRESHOLD) {
          matches.push({
            card_id: cached.card_id,
            similarity_score: similarity,
            match_type: 'embedding',
            matched_fields: ['semantic_similarity'],
            discrepancies: similarity < 0.9 ? ['semantic_approximate'] : []
          });
        }
      }

      // Sort by similarity and limit
      matches.sort((a, b) => b.similarity_score - a.similarity_score);
      return matches.slice(0, this.MAX_MATCHES);

    } catch (error) {
      logger.error('Embedding match failed:', error);
      return [];
    }
  }

  private async preloadEmbeddings(): Promise<void> {
    try {
      logger.info('Preloading card embeddings cache...');
      
      // In a real implementation, this would load actual sentence transformer embeddings
      // For now, create simple embeddings based on text features
      const db = getDatabase();
      
      const cards = db.prepare(`
        SELECT id, card_name, set_name 
        FROM pokemon_cards 
        LIMIT 1000
      `).all() as Array<{ id: string; card_name: string; set_name: string }>;

      for (const card of cards) {
        const embedding = this.generateSimpleEmbedding(`${card.card_name} ${card.set_name}`);
        
        this.embeddingCache.set(card.id, {
          card_id: card.id,
          card_name: card.card_name,
          set_name: card.set_name,
          embedding,
          created_at: new Date()
        });
      }

      this.cacheLoaded = true;
      logger.info(`Loaded ${this.embeddingCache.size} card embeddings into cache`);

    } catch (error) {
      logger.error('Failed to preload embeddings:', error);
    }
  }

  private generateSimpleEmbedding(text: string): number[] {
    // Simple text-based embedding (placeholder for real sentence transformer)
    // In production, would use a proper embedding model like sentence-transformers
    const words = text.toLowerCase().split(/\s+/);
    const embedding = new Array(384).fill(0);
    
    for (let i = 0; i < words.length && i < 10; i++) {
      const word = words[i];
      for (let j = 0; j < word.length && j < 20; j++) {
        const charCode = word.charCodeAt(j);
        embedding[(i * 20 + j) % 384] = (charCode / 128) - 1; // Normalize to [-1, 1]
      }
    }
    
    return embedding;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private generateUUID(): string {
    // Fallback UUID generator for environments without crypto.randomUUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}