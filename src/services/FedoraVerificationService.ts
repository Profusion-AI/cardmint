import type { InferenceResult } from '../core/infer/InferencePort';
import { createLogger } from '../utils/logger';
import { getGlobalProfiler } from '../utils/performanceProfiler';
import { searchCards } from '../storage/sqlite-database';

/**
 * Fedora Verification Service using GPT-OSS-20B
 * Provides semantic validation of card data extracted by Mac vision model
 * August 29, 2025 - E2E Pipeline Integration
 */

export interface VerificationRequest {
  card_title: string;
  identifier: {
    number?: string;
    set_size?: string;
    promo_code?: string;
  };
  set_name?: string;
  first_edition?: boolean;
  confidence: number;
  source_model: string;
}

export interface VerificationResult {
  agrees_with_primary: boolean;
  confidence_adjustment: number; // -0.2 to +0.1
  database_matches: DatabaseMatch[];
  semantic_flags: string[];
  verification_time_ms: number;
  verifier_confidence: number;
  raw_response?: any;
}

export interface DatabaseMatch {
  card_id?: string;
  similarity_score: number;
  match_type: 'exact' | 'fuzzy' | 'semantic';
  matched_fields: string[];
  discrepancies: string[];
}

interface GPTVerificationResponse {
  semantic_consistency: number; // 0-1 score
  format_validation: {
    card_title_valid: boolean;
    identifier_format_correct: boolean;
    set_name_plausible: boolean;
    first_edition_logical: boolean;
  };
  concerns: string[];
  confidence_modifier: number; // -0.2 to +0.1
  reasoning: string;
}

export class FedoraVerificationService {
  private readonly log = createLogger('fedora-verifier');
  private totalRequests = 0;
  private totalLatency = 0;
  private errorCount = 0;
  private agreementCount = 0;
  
  constructor(
    private baseUrl: string = 'http://localhost:41343',
    private modelId: string = 'cardmint-verifier',
    private fetchImpl: typeof fetch = fetch
  ) {
    this.log.info(`Initialized Fedora verification service: ${baseUrl}`);
  }

  /**
   * Main verification method - validates card data from vision model
   */
  async verify(
    visionResult: VerificationRequest,
    options: { 
      timeout?: number;
      skip_database_check?: boolean;
      signal?: AbortSignal;
    } = {}
  ): Promise<VerificationResult> {
    const startTime = Date.now();
    this.totalRequests++;
    const profiler = getGlobalProfiler();

    try {
      profiler?.startStage('fedora_verification', {
        card: visionResult.card_title,
        confidence: visionResult.confidence,
        source: visionResult.source_model
      });

      // Step 1: GPT-OSS-20B semantic validation
      const gptResult = await this.performGPTVerification(visionResult, options);
      
      // Step 2: Database cross-reference (unless skipped)
      let dbMatches: DatabaseMatch[] = [];
      if (!options.skip_database_check) {
        dbMatches = await this.performDatabaseLookup(visionResult);
      }

      // Step 3: Combine results and determine final adjustment
      const verificationTime = Date.now() - startTime;
      const result = this.synthesizeVerificationResult(
        visionResult, 
        gptResult, 
        dbMatches, 
        verificationTime
      );

      // Update statistics
      this.totalLatency += verificationTime;
      if (result.agrees_with_primary) {
        this.agreementCount++;
      }

      profiler?.endStage('fedora_verification', {
        agrees: result.agrees_with_primary,
        adjustment: result.confidence_adjustment,
        flags: result.semantic_flags.length,
        db_matches: result.database_matches.length
      });

      this.log.debug(
        `Verification complete for "${visionResult.card_title}": ` +
        `${result.agrees_with_primary ? 'AGREES' : 'DISAGREES'} ` +
        `(adjustment: ${result.confidence_adjustment.toFixed(3)}) ` +
        `in ${verificationTime}ms`
      );

      return result;

    } catch (error) {
      const verificationTime = Date.now() - startTime;
      this.totalLatency += verificationTime;
      this.errorCount++;

      profiler?.endStage('fedora_verification', {
        error: String(error),
        time_ms: verificationTime
      });

      this.log.error(`Verification failed for "${visionResult.card_title}": ${error}`);
      
      // Return neutral result on error
      return {
        agrees_with_primary: true, // Default to agreeing on error
        confidence_adjustment: 0,
        database_matches: [],
        semantic_flags: ['verification_error'],
        verification_time_ms: verificationTime,
        verifier_confidence: 0.5,
        raw_response: { error: String(error) }
      };
    }
  }

  /**
   * GPT-OSS-20B semantic validation
   */
  private async performGPTVerification(
    visionResult: VerificationRequest,
    options: { timeout?: number; signal?: AbortSignal }
  ): Promise<GPTVerificationResponse> {
    const profiler = getGlobalProfiler();
    
    try {
      profiler?.startStage('gpt_verification_request');

      // Build comprehensive prompt for GPT-OSS-20B
      const verificationPrompt = this.buildVerificationPrompt(visionResult);
      
      const payload = {
        model: this.modelId,
        messages: [
          {
            role: 'system',
            content: 'You are a Pokemon TCG expert specializing in card data validation. ' +
                     'Analyze card information for semantic consistency, format correctness, and plausibility. ' +
                     'Respond with JSON containing your analysis.'
          },
          {
            role: 'user',
            content: verificationPrompt
          }
        ],
        max_tokens: 200,
        temperature: 0.1, // Low temperature for consistent validation
        response_format: { type: "json_object" }
      };

      const controller = new AbortController();
      const timeoutId = options.timeout 
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;
      
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
      }

      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`GPT verification failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim() || '';

      profiler?.endStage('gpt_verification_request', {
        status: response.status,
        tokens: data?.usage?.total_tokens
      });

      // Parse GPT response
      return this.parseGPTResponse(content);

    } catch (error) {
      profiler?.endStage('gpt_verification_request', { error: String(error) });
      this.log.warning(`GPT verification request failed: ${error}`);
      
      // Return neutral response on GPT failure
      return {
        semantic_consistency: 0.7,
        format_validation: {
          card_title_valid: true,
          identifier_format_correct: true,
          set_name_plausible: true,
          first_edition_logical: true
        },
        concerns: ['gpt_verification_failed'],
        confidence_modifier: 0,
        reasoning: 'GPT verification unavailable'
      };
    }
  }

  /**
   * Database cross-reference lookup
   */
  private async performDatabaseLookup(
    visionResult: VerificationRequest
  ): Promise<DatabaseMatch[]> {
    const profiler = getGlobalProfiler();
    const matches: DatabaseMatch[] = [];

    try {
      profiler?.startStage('database_lookup');

      // Search by card name
      if (visionResult.card_title) {
        const nameResults = await searchCards({
          card_title: visionResult.card_title,
          limit: 3
        });

        for (const result of nameResults) {
          const match = this.analyzeDbMatch(visionResult, result);
          if (match.similarity_score > 0.6) {
            matches.push(match);
          }
        }
      }

      // Search by set + number if available
      if (visionResult.set_name && visionResult.identifier.number) {
        const setResults = await searchCards({
          set_name: visionResult.set_name,
          card_number: visionResult.identifier.number,
          limit: 2
        });

        for (const result of setResults) {
          const match = this.analyzeDbMatch(visionResult, result);
          if (match.similarity_score > 0.7) {
            matches.push(match);
          }
        }
      }

      profiler?.endStage('database_lookup', { matches: matches.length });
      
      this.log.debug(`Database lookup found ${matches.length} potential matches`);
      return matches;

    } catch (error) {
      profiler?.endStage('database_lookup', { error: String(error) });
      this.log.warning(`Database lookup failed: ${error}`);
      return [];
    }
  }

  /**
   * Build verification prompt for GPT-OSS-20B
   */
  private buildVerificationPrompt(visionResult: VerificationRequest): string {
    const identifierStr = visionResult.identifier.promo_code || 
      (visionResult.identifier.number && visionResult.identifier.set_size 
        ? `${visionResult.identifier.number}/${visionResult.identifier.set_size}`
        : visionResult.identifier.number || 'Unknown');

    return `
Validate this Pokemon card data extracted by a vision model:

Card Title: "${visionResult.card_title}"
Set Name: "${visionResult.set_name || 'Unknown'}"  
Card Number: "${identifierStr}"
First Edition: ${visionResult.first_edition || false}
Source Confidence: ${(visionResult.confidence * 100).toFixed(1)}%

Please analyze for:
1. Semantic consistency (do these fields make sense together?)
2. Format validation (proper card title, valid set name, correct number format)
3. Plausibility (realistic Pokemon card data?)
4. Any concerns or red flags

Respond with JSON in this exact format:
{
  "semantic_consistency": 0.85,
  "format_validation": {
    "card_title_valid": true,
    "identifier_format_correct": true, 
    "set_name_plausible": true,
    "first_edition_logical": true
  },
  "concerns": ["list", "of", "issues"],
  "confidence_modifier": -0.05,
  "reasoning": "Brief explanation"
}

Confidence modifier should be between -0.2 (major issues) and +0.1 (very confident).
`.trim();
  }

  /**
   * Parse GPT-OSS-20B JSON response
   */
  private parseGPTResponse(content: string): GPTVerificationResponse {
    try {
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleanContent);
      
      // Validate required fields and apply defaults
      return {
        semantic_consistency: Math.max(0, Math.min(1, parsed.semantic_consistency || 0.7)),
        format_validation: {
          card_title_valid: parsed.format_validation?.card_title_valid !== false,
          identifier_format_correct: parsed.format_validation?.identifier_format_correct !== false,
          set_name_plausible: parsed.format_validation?.set_name_plausible !== false,
          first_edition_logical: parsed.format_validation?.first_edition_logical !== false
        },
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
        confidence_modifier: Math.max(-0.2, Math.min(0.1, parsed.confidence_modifier || 0)),
        reasoning: parsed.reasoning || 'No reasoning provided'
      };
    } catch (error) {
      this.log.warning(`Failed to parse GPT response: ${error}`);
      this.log.debug(`Raw content: ${content}`);
      
      // Return neutral response on parse failure
      return {
        semantic_consistency: 0.7,
        format_validation: {
          card_title_valid: true,
          identifier_format_correct: true,
          set_name_plausible: true,
          first_edition_logical: true
        },
        concerns: ['parse_error'],
        confidence_modifier: -0.05,
        reasoning: 'Response parsing failed'
      };
    }
  }

  /**
   * Analyze database match quality
   */
  private analyzeDbMatch(visionResult: VerificationRequest, dbCard: any): DatabaseMatch {
    const matchedFields: string[] = [];
    const discrepancies: string[] = [];
    let totalScore = 0;
    let fieldCount = 0;

    // Compare card title
    if (dbCard.card_title && visionResult.card_title) {
      fieldCount++;
      const titleSimilarity = this.calculateStringSimilarity(
        visionResult.card_title.toLowerCase(),
        dbCard.card_title.toLowerCase()
      );
      totalScore += titleSimilarity;
      
      if (titleSimilarity > 0.8) {
        matchedFields.push('card_title');
      } else if (titleSimilarity < 0.5) {
        discrepancies.push(`title_mismatch: "${visionResult.card_title}" vs "${dbCard.card_title}"`);
      }
    }

    // Compare set name
    if (dbCard.set_name && visionResult.set_name) {
      fieldCount++;
      const setSimilarity = this.calculateStringSimilarity(
        visionResult.set_name.toLowerCase(),
        dbCard.set_name.toLowerCase()
      );
      totalScore += setSimilarity;
      
      if (setSimilarity > 0.8) {
        matchedFields.push('set_name');
      } else if (setSimilarity < 0.5) {
        discrepancies.push(`set_mismatch: "${visionResult.set_name}" vs "${dbCard.set_name}"`);
      }
    }

    // Compare card number
    if (dbCard.card_number && visionResult.identifier.number) {
      fieldCount++;
      const numberMatch = dbCard.card_number === visionResult.identifier.number;
      totalScore += numberMatch ? 1 : 0;
      
      if (numberMatch) {
        matchedFields.push('card_number');
      } else {
        discrepancies.push(`number_mismatch: "${visionResult.identifier.number}" vs "${dbCard.card_number}"`);
      }
    }

    const avgScore = fieldCount > 0 ? totalScore / fieldCount : 0;
    
    return {
      card_id: dbCard.id,
      similarity_score: avgScore,
      match_type: avgScore > 0.9 ? 'exact' : (avgScore > 0.7 ? 'fuzzy' : 'semantic'),
      matched_fields: matchedFields,
      discrepancies: discrepancies
    };
  }

  /**
   * Synthesize final verification result
   */
  private synthesizeVerificationResult(
    visionResult: VerificationRequest,
    gptResult: GPTVerificationResponse,
    dbMatches: DatabaseMatch[],
    verificationTime: number
  ): VerificationResult {
    const semanticFlags: string[] = [...gptResult.concerns];
    
    // Analyze database matches
    const exactMatches = dbMatches.filter(m => m.match_type === 'exact');
    const fuzzyMatches = dbMatches.filter(m => m.match_type === 'fuzzy');
    
    if (exactMatches.length === 0 && dbMatches.length > 0) {
      semanticFlags.push('no_exact_database_match');
    }
    
    if (dbMatches.some(m => m.discrepancies.length > 2)) {
      semanticFlags.push('multiple_field_discrepancies');
    }

    // Calculate final confidence adjustment
    let confidenceAdjustment = gptResult.confidence_modifier;
    
    // Database match adjustments
    if (exactMatches.length > 0) {
      confidenceAdjustment += 0.05; // Boost for exact match
    } else if (fuzzyMatches.length === 0 && dbMatches.length > 0) {
      confidenceAdjustment -= 0.03; // Slight penalty for no fuzzy matches
    }
    
    // Semantic consistency adjustments
    if (gptResult.semantic_consistency < 0.6) {
      confidenceAdjustment -= 0.05; // Penalty for poor consistency
    } else if (gptResult.semantic_consistency > 0.9) {
      confidenceAdjustment += 0.02; // Small boost for high consistency
    }

    // Clamp final adjustment
    confidenceAdjustment = Math.max(-0.2, Math.min(0.1, confidenceAdjustment));
    
    // Determine agreement
    const agrees = gptResult.semantic_consistency > 0.7 && 
                   semanticFlags.length < 3 && 
                   confidenceAdjustment > -0.1;

    return {
      agrees_with_primary: agrees,
      confidence_adjustment: confidenceAdjustment,
      database_matches: dbMatches,
      semantic_flags: semanticFlags,
      verification_time_ms: verificationTime,
      verifier_confidence: gptResult.semantic_consistency,
      raw_response: gptResult
    };
  }

  /**
   * Simple string similarity calculation (Levenshtein-based)
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;
    
    const distance = this.levenshteinDistance(str1, str2);
    return (maxLen - distance) / maxLen;
  }

  /**
   * Levenshtein distance calculation
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  /**
   * Health check for verification service
   */
  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    try {
      const startTime = Date.now();
      
      const testPayload = {
        model: this.modelId,
        messages: [
          { role: 'user', content: 'Test verification service health.' }
        ],
        max_tokens: 10,
        temperature: 0
      };

      const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testPayload),
        signal: AbortSignal.timeout(5000)
      });

      const latency = Date.now() - startTime;

      if (response.ok) {
        const data = await response.json();
        const hasValidResponse = data?.choices?.[0]?.message?.content;
        
        return { 
          healthy: !!hasValidResponse, 
          latency,
          error: hasValidResponse ? undefined : 'Invalid response format'
        };
      } else {
        return { healthy: false, latency, error: `HTTP ${response.status}` };
      }

    } catch (error) {
      return { healthy: false, error: String(error) };
    }
  }

  /**
   * Get verification service statistics
   */
  getStats() {
    const avgLatency = this.totalRequests > 0 ? this.totalLatency / this.totalRequests : 0;
    const agreementRate = this.totalRequests > 0 ? this.agreementCount / this.totalRequests : 0;
    const errorRate = this.totalRequests > 0 ? this.errorCount / this.totalRequests : 0;
    
    return {
      total_verifications: this.totalRequests,
      average_latency_ms: Math.round(avgLatency),
      agreement_rate: Math.round(agreementRate * 100) / 100,
      error_rate: Math.round(errorRate * 100) / 100,
      service_url: this.baseUrl,
      model_id: this.modelId
    };
  }
}