import { promises as fs } from "fs";
import type { InferencePort, InferenceResult, InferenceStatus } from "../../core/infer/InferencePort";
import { logger } from "../../utils/logger";
import { getGlobalProfiler } from "../../utils/performanceProfiler";
import { searchCards } from "../../storage/sqlite-database";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Verification Result from secondary model
 */
export interface VerificationResult {
  agrees_with_primary: boolean;
  confidence_adjustment: number; // -0.2 to +0.1
  database_matches: DatabaseMatch[];
  semantic_flags: string[]; // "rarity_mismatch", "set_inconsistent"
  verification_time_ms: number;
  verifier_confidence: number;
  raw_response?: any;
}

export interface DatabaseMatch {
  card_id?: string;
  similarity_score: number;
  match_type: 'exact' | 'fuzzy' | 'embedding';
  matched_fields: string[];
  discrepancies: string[];
}

/**
 * Tool calling result for verification
 */
export interface ToolCallVerificationResult {
  extracted_result: InferenceResult;
  database_lookup?: {
    card_name: string;
    set_code?: string;
    confidence: number;
  };
  tool_confidence: number;
  raw_response: any;
  parsing_success: boolean;
}

export interface VerifyOptions {
  signal?: AbortSignal;
  timeout?: number;
  skip_database_check?: boolean;
  primary_confidence?: number;
}

/**
 * Lightweight verification adapter using Qwen2.5-0.5B model
 * Optimized for 50-100ms response times and database cross-checks
 * Focuses on consistency checking, not full card recognition
 * 
 * Model Configuration:
 * - Verifier: Qwen2.5-0.5B (full precision, ~500MB, always loaded)
 * - Primary: Qwen2.5-VL-7B (8-bit quantization, ~6-8GB, no KV cache for vision models)
 * - MLX Engine: Native Apple Silicon acceleration
 * - Memory: Verifier kept in memory for instant verification calls
 */
export class QwenVerifierInference implements InferencePort {
  private totalRequests = 0;
  private totalLatency = 0;
  private errorCount = 0;
  private lastError?: string;
  private agreementCount = 0;
  
  constructor(
    private baseUrl: string,       // e.g., http://10.0.24.174:1234
    private model: string,         // e.g., "qwen2.5-0.5b-instruct-mlx"
    private fetchImpl: FetchLike = fetch
  ) {}

  /**
   * Standard classify method for compatibility
   * For verifier, this performs lightweight card identification
   */
  async classify(
    imagePath: string,
    options: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<InferenceResult> {
    const startTime = Date.now();
    this.totalRequests++;
    const profiler = getGlobalProfiler();
    
    try {
      profiler?.startStage('vlm_verify', { 
        model: this.model,
        mode: 'lightweight_classification'
      });

      // Read and encode image (smaller resolution for verifier)
      profiler?.startStage('file_read');
      const imageBuffer = await fs.readFile(imagePath);
      profiler?.endStage('file_read', { size_bytes: imageBuffer.length });
      
      profiler?.startStage('base64_encode');
      const imageBase64 = imageBuffer.toString('base64');
      const imageMime = this.getImageMimeType(imagePath);
      profiler?.endStage('base64_encode');

      // Lightweight verification prompt (much simpler than primary)
      const body = {
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are a fast Pokemon card verifier. Extract only: card_name, set_name, card_number, rarity. Reply with compact JSON only."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Quick verification - extract key card info:"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${imageMime};base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        temperature: 0.05, // Lower temperature for consistency
        max_tokens: 100,   // Much smaller response
        stream: false
      };

      const controller = new AbortController();
      const timeoutId = options.timeout 
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;

      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
      }

      profiler?.startStage('network_request', {
        model: this.model,
        timeout: options.timeout || 'none'
      });

      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (timeoutId) clearTimeout(timeoutId);

      profiler?.endStage('network_request', {
        status: res.status,
        ok: res.ok
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.errorCount++;
        this.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        throw new Error(this.lastError);
      }

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || "";

      profiler?.startStage('json_parse');
      let parsed: any;
      try {
        const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(cleanContent);
        profiler?.endStage('json_parse', { success: true });
      } catch (parseError) {
        parsed = this.extractFallbackData(content);
        profiler?.endStage('json_parse', { 
          success: false, 
          fallback: true 
        });
      }

      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;

      const result: InferenceResult = {
        card_title: parsed.card_name || "",
        identifier: {
          number: parsed.card_number
        },
        set_name: parsed.set_name,
        first_edition: false, // Verifier doesn't detect variants
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        inference_time_ms: inferenceTime,
        model_used: this.model,
        raw: data
      };

      profiler?.endStage('vlm_verify', {
        confidence: result.confidence,
        card_name: result.card_title
      });

      logger.debug(`Verifier inference completed: ${result.card_title} (${inferenceTime}ms)`);
      return result;

    } catch (error) {
      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;
      this.errorCount++;
      this.lastError = String(error);

      profiler?.endStage('vlm_verify', { error: this.lastError });
      logger.error('Verifier inference failed:', error);
      throw error;
    }
  }

  /**
   * Main verification method - uses tool calling approach (Option A + C)
   * Takes primary VLM text output and verifies via database tool calls
   * No image processing - pure text-to-tool-call verification
   */
  async verify(
    primaryResult: InferenceResult,
    _imagePath: string, // Not used - kept for interface compatibility
    options: VerifyOptions = {}
  ): Promise<VerificationResult> {
    const startTime = Date.now();
    const profiler = getGlobalProfiler();

    try {
      profiler?.startStage('verification_full', {
        primary_card: primaryResult.card_title,
        primary_confidence: primaryResult.confidence
      });

      // NEW APPROACH: Tool-calling verification (no image needed)
      const toolCallResult = await this.verifyWithToolCalling(primaryResult, {
        signal: options.signal,
        timeout: options.timeout
      });

      // Database checks via tool calls
      let databaseMatches: DatabaseMatch[] = [];
      if (!options.skip_database_check && toolCallResult.database_lookup) {
        profiler?.startStage('database_check');
        databaseMatches = await this.executeDatabaseLookup(toolCallResult.database_lookup);
        profiler?.endStage('database_check', {
          matches_found: databaseMatches.length
        });
      }

      // Calculate agreement based on tool call verification
      const agreement = this.analyzeToolCallAgreement(primaryResult, toolCallResult);
      
      // Calculate confidence adjustment
      const adjustment = this.calculateConfidenceAdjustment(
        primaryResult,
        toolCallResult.extracted_result,
        agreement,
        databaseMatches
      );

      // Track agreement statistics
      if (agreement.agrees) {
        this.agreementCount++;
      }

      const result: VerificationResult = {
        agrees_with_primary: agreement.agrees,
        confidence_adjustment: adjustment,
        database_matches: databaseMatches,
        semantic_flags: this.generateSemanticFlags(primaryResult, toolCallResult.extracted_result, databaseMatches),
        verification_time_ms: Date.now() - startTime,
        verifier_confidence: toolCallResult.tool_confidence,
        raw_response: toolCallResult.raw_response
      };

      profiler?.endStage('verification_full', {
        agrees: result.agrees_with_primary,
        adjustment: result.confidence_adjustment,
        flags: result.semantic_flags.length
      });

      logger.debug(`Tool-calling verification completed: agreement=${result.agrees_with_primary}, adjustment=${result.confidence_adjustment}`);
      return result;

    } catch (error) {
      profiler?.endStage('verification_full', { error: String(error) });
      logger.error('Verification failed');
      throw error;
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    try {
      const startTime = Date.now();
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(5000)
      });
      
      const latency = Date.now() - startTime;
      
      if (response.ok) {
        const models: any = await response.json();
        const hasVerifierModel = Array.isArray(models?.data) && models.data.some((m: any) => 
          m?.id && (m.id.includes('0.5b') || m.id.includes('verifier'))
        );
        
        return { 
          healthy: true, 
          latency,
          error: hasVerifierModel ? undefined : 'Verifier model not loaded'
        };
      } else {
        return { 
          healthy: false, 
          latency, 
          error: `HTTP ${response.status}` 
        };
      }
    } catch (error) {
      return { 
        healthy: false, 
        error: String(error) 
      };
    }
  }

  async getStatus(): Promise<InferenceStatus> {
    const averageLatency = this.totalRequests > 0 
      ? this.totalLatency / this.totalRequests 
      : 0;
      
    const errorRate = this.totalRequests > 0 
      ? this.errorCount / this.totalRequests 
      : 0;

    const agreementRate = this.totalRequests > 0
      ? this.agreementCount / this.totalRequests
      : 0;

    return {
      model_loaded: true,
      model_name: this.model,
      total_requests: this.totalRequests,
      average_latency_ms: Math.round(averageLatency),
      error_rate: Math.round(errorRate * 100) / 100,
      last_error: this.lastError,
      // Additional verifier-specific metrics
      agreement_rate: Math.round(agreementRate * 100) / 100,
      verifier_model_size: '0.5B'
    } as InferenceStatus & { agreement_rate: number; verifier_model_size: string };
  }

  private getImageMimeType(filePath: string): string {
    const ext = filePath.toLowerCase().split('.').pop();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/jpeg';
    }
  }

  private extractFallbackData(content: string): any {
    const nameMatch = content.match(/(?:card_name|name)[\"']?\\s*:\\s*[\"']([^\"']+)[\"']/i);
    const setMatch = content.match(/(?:set_name|set)[\"']?\\s*:\\s*[\"']([^\"']+)[\"']/i);
    const numberMatch = content.match(/(?:card_number|number)[\"']?\\s*:\\s*[\"']?([^\"',}]+)[\"']?/i);
    
    return {
      card_name: nameMatch?.[1] || "Unknown",
      set_name: setMatch?.[1] || "Unknown",
      card_number: numberMatch?.[1] || "Unknown",
      confidence: 0.3 // Lower confidence for fallback
    };
  }

  private _analyzeAgreement(
    primary: InferenceResult,
    secondary: InferenceResult
  ): { agrees: boolean; similarity: number } {
    // Simple agreement analysis - can be enhanced
    const nameMatch = this.stringSimilarity(
      primary.card_title.toLowerCase(), 
      secondary.card_title.toLowerCase()
    );
    
    const setMatch = this.stringSimilarity(
      primary.set_name?.toLowerCase() || '',
      secondary.set_name?.toLowerCase() || ''
    );
    
    const overall = (nameMatch + setMatch) / 2;
    
    return {
      agrees: overall > 0.8,
      similarity: overall
    };
  }

  private stringSimilarity(str1: string, str2: string): number {
    // Simple Levenshtein-based similarity
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;
    
    const longer = str1.length > str2.length ? str1 : str2;
    
    if (longer.length === 0) return 1;
    
    const distance = this.levenshteinDistance(str1, str2);
    return (longer.length - distance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  private async _checkDatabase(_result: InferenceResult): Promise<DatabaseMatch[]> {
    // Placeholder for database integration
    // Will be implemented in CardVerificationService
    logger.debug('Database check placeholder - implement CardVerificationService integration');
    return [];
  }

  private calculateConfidenceAdjustment(
    _primary: InferenceResult,
    _secondary: InferenceResult,
    agreement: { agrees: boolean; similarity: number },
    databaseMatches: DatabaseMatch[]
  ): number {
    let adjustment = 0;

    // Agreement bonus/penalty
    if (agreement.agrees) {
      adjustment += 0.05; // Small boost for agreement
    } else {
      adjustment -= 0.15; // Penalty for disagreement
    }

    // Database validation
    if (databaseMatches.length > 0) {
      const bestMatch = Math.max(...databaseMatches.map(m => m.similarity_score));
      if (bestMatch > 0.9) {
        adjustment += 0.03;
      } else if (bestMatch < 0.5) {
        adjustment -= 0.1;
      }
    }

    // Clamp adjustment to reasonable range
    return Math.max(-0.2, Math.min(0.1, adjustment));
  }

  private generateSemanticFlags(
    primary: InferenceResult,
    secondary: InferenceResult,
    databaseMatches: DatabaseMatch[]
  ): string[] {
    const flags: string[] = [];

    // Check for major disagreements
    const nameSimilarity = this.stringSimilarity(
      primary.card_title.toLowerCase(),
      secondary.card_title.toLowerCase()
    );
    
    if (nameSimilarity < 0.6) {
      flags.push('name_disagreement');
    }

    const setSimilarity = this.stringSimilarity(
      primary.set_name?.toLowerCase() || '',
      secondary.set_name?.toLowerCase() || ''
    );
    
    if (setSimilarity < 0.6) {
      flags.push('set_disagreement');
    }

    // Database consistency flags
    if (databaseMatches.length === 0) {
      flags.push('no_database_match');
    } else if (databaseMatches.some(m => m.discrepancies.length > 0)) {
      flags.push('database_discrepancies');
    }

    return flags;
  }

  /**
   * Core tool-calling verification method
   * Implements Option A + C: Text-only verification with tool calls
   */
  private async verifyWithToolCalling(
    primaryResult: InferenceResult,
    options: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<ToolCallVerificationResult> {
    const profiler = getGlobalProfiler();

    try {
      profiler?.startStage('tool_call_verification', {
        primary_card: primaryResult.card_title,
        confidence: primaryResult.confidence
      });

      // Prepare tool call prompt (no image - pure text verification)
      const messages = this.prepareToolCallPrompt(primaryResult);

      // Define the verification tool schema
      const tools = [this.getVerificationToolSchema()];

      const body = {
        model: this.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.1, // Low temperature for consistency
        max_tokens: 150,  // Keep responses short
        stream: false
      };

      const controller = new AbortController();
      const timeoutId = options.timeout 
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;

      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
      }

      profiler?.startStage('tool_call_request', {
        model: this.model,
        timeout: options.timeout || 'none'
      });

      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (timeoutId) clearTimeout(timeoutId);

      profiler?.endStage('tool_call_request', {
        status: res.status,
        ok: res.ok
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data: any = await res.json();
      
      // Parse tool call response
      profiler?.startStage('tool_call_parsing');
      const toolCallResult = this.parseToolCallResponse(data, primaryResult);
      profiler?.endStage('tool_call_parsing', {
        success: toolCallResult.parsing_success,
        has_database_lookup: !!toolCallResult.database_lookup
      });

      profiler?.endStage('tool_call_verification', {
        tool_confidence: toolCallResult.tool_confidence,
        parsing_success: toolCallResult.parsing_success
      });

      logger.debug(`Tool call verification completed: ${toolCallResult.extracted_result.card_title} (confidence: ${toolCallResult.tool_confidence})`);
      return toolCallResult;

    } catch (error) {
      profiler?.endStage('tool_call_verification', { error: String(error) });
      logger.error('Tool call verification failed');
      throw error;
    }
  }

  /**
   * Prepare tool call prompt for 0.5B text model
   * No image data - just text from primary VLM result
   */
  private prepareToolCallPrompt(primaryResult: InferenceResult): any[] {
    return [
      {
        role: "system",
        content: "You are a Pokemon card verification assistant. Use the verify_pokemon_card tool to verify card details from vision model outputs. Extract the card name, set information, and assess confidence."
      },
      {
        role: "user", 
        content: `Vision model detected: "${primaryResult.card_title}" from set "${primaryResult.set_name}" with ${(primaryResult.confidence * 100).toFixed(1)}% confidence. 
Card number: ${primaryResult.identifier?.number || 'unknown'}
Please verify this card information using the database lookup tool.`
      },
      {
        role: "assistant",
        content: '{"name": "verify_pokemon_card", "arguments": {"card_name": "' // Pre-fill start as per implementation plan
      }
    ];
  }

  /**
   * Verification tool schema (simplified single-tool design)
   */
  private getVerificationToolSchema() {
    return {
      type: "function",
      function: {
        name: "verify_pokemon_card",
        description: "Verify Pokemon card identity against database",
        parameters: {
          type: "object",
          properties: {
            card_name: {
              type: "string",
              description: "Name of the Pokemon card"
            },
            set_code: {
              type: "string", 
              description: "Set code (e.g., 'base1', 'xy1', 'swsh1')"
            },
            confidence: {
              type: "number",
              description: "Confidence score from 0.0 to 1.0",
              minimum: 0.0,
              maximum: 1.0
            }
          },
          required: ["card_name"]
        }
      }
    };
  }

  /**
   * Parse tool call response with error recovery
   */
  private parseToolCallResponse(
    data: any, 
    primaryResult: InferenceResult
  ): ToolCallVerificationResult {
    try {
      const toolCalls = data?.choices?.[0]?.message?.tool_calls;
      
      if (toolCalls && toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        const args = typeof toolCall.function.arguments === 'string' 
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;

        const extracted: InferenceResult = {
          card_title: args.card_name || primaryResult.card_title,
          identifier: {
            number: args.card_number || primaryResult.identifier?.number
          },
          set_name: args.set_code || primaryResult.set_name,
          first_edition: false,
          confidence: args.confidence || 0.7,
          inference_time_ms: 0,
          model_used: this.model,
          raw: data
        };

        return {
          extracted_result: extracted,
          database_lookup: {
            card_name: args.card_name,
            set_code: args.set_code,
            confidence: args.confidence || 0.7
          },
          tool_confidence: args.confidence || 0.7,
          raw_response: data,
          parsing_success: true
        };
      }

      // Fallback: No tool calls - extract from message content
      return this.parseToolCallWithRecovery(data, primaryResult);

    } catch (error) {
      logger.warn('Tool call parsing failed, using recovery');
      return this.parseToolCallWithRecovery(data, primaryResult);
    }
  }

  /**
   * Error recovery parsing (handles malformed JSON)
   */
  private parseToolCallWithRecovery(
    data: any,
    primaryResult: InferenceResult
  ): ToolCallVerificationResult {
    const content = data?.choices?.[0]?.message?.content || '';
    
    // Try to extract card name with regex
    const cardNameMatch = content.match(/(?:card_name|name)[\"']?\s*:\s*[\"']([^\"']+)[\"']/i);
    const setCodeMatch = content.match(/(?:set_code|set)[\"']?\s*:\s*[\"']([^\"']+)[\"']/i);
    const confidenceMatch = content.match(/(?:confidence)[\"']?\s*:\s*([0-9.]+)/i);

    const cardName = cardNameMatch?.[1] || primaryResult.card_title;
    const setCode = setCodeMatch?.[1] || primaryResult.set_name;
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5;

    const extracted: InferenceResult = {
      card_title: cardName,
      identifier: {
        number: primaryResult.identifier?.number
      },
      set_name: setCode,
      first_edition: false,
      confidence: confidence,
      inference_time_ms: 0,
      model_used: this.model,
      raw: data
    };

    return {
      extracted_result: extracted,
      database_lookup: {
        card_name: cardName,
        set_code: setCode,
        confidence: confidence
      },
      tool_confidence: confidence,
      raw_response: data,
      parsing_success: false
    };
  }

  /**
   * Analyze agreement between primary and tool call results
   */
  private analyzeToolCallAgreement(
    primary: InferenceResult,
    toolResult: ToolCallVerificationResult
  ): { agrees: boolean; similarity: number } {
    const secondary = toolResult.extracted_result;
    
    const nameMatch = this.stringSimilarity(
      primary.card_title.toLowerCase(), 
      secondary.card_title.toLowerCase()
    );
    
    const setMatch = this.stringSimilarity(
      primary.set_name?.toLowerCase() || '',
      secondary.set_name?.toLowerCase() || ''
    );
    
    const overall = (nameMatch + setMatch) / 2;
    
    return {
      agrees: overall > 0.8,
      similarity: overall
    };
  }

  /**
   * Execute database lookup from tool call
   */
  private async executeDatabaseLookup(
    lookup: { card_name: string; set_code?: string; confidence: number }
  ): Promise<DatabaseMatch[]> {
    try {
      logger.debug(`Database lookup: ${lookup.card_name} (${lookup.set_code || 'no set'})`);
      
      // Search for cards in SQLite database
      const searchResults = searchCards(lookup.card_name, lookup.set_code);
      
      if (searchResults.length === 0) {
        logger.debug(`No database matches found for: ${lookup.card_name}`);
        return [];
      }
      
      // Convert search results to DatabaseMatch format
      const matches: DatabaseMatch[] = searchResults.slice(0, 5).map(card => {
        const similarityScore = this.calculateSimilarity(lookup.card_name, card.name || '', lookup.set_code, card.set_name);
        const matchedFields: string[] = [];
        const discrepancies: string[] = [];
        
        // Determine matched fields and discrepancies
        if (card.name && this.normalizeString(card.name) === this.normalizeString(lookup.card_name)) {
          matchedFields.push('card_name');
        } else if (card.name && this.normalizeString(card.name).includes(this.normalizeString(lookup.card_name))) {
          matchedFields.push('card_name_partial');
        } else {
          discrepancies.push('card_name_mismatch');
        }
        
        if (lookup.set_code && card.set_name) {
          if (this.normalizeString(card.set_name) === this.normalizeString(lookup.set_code)) {
            matchedFields.push('set_name');
          } else {
            discrepancies.push('set_name_mismatch');
          }
        } else if (lookup.set_code && !card.set_name) {
          discrepancies.push('missing_set_name');
        } else if (!lookup.set_code && card.set_name) {
          discrepancies.push('unexpected_set_name');
        }
        
        const matchType: 'exact' | 'fuzzy' | 'embedding' = 
          similarityScore > 0.95 ? 'exact' : 
          similarityScore > 0.7 ? 'fuzzy' : 'embedding';
        
        return {
          card_id: card.id,
          similarity_score: similarityScore,
          match_type: matchType,
          matched_fields,
          discrepancies
        };
      });
      
      logger.debug(`Found ${matches.length} database matches, best similarity: ${matches[0]?.similarity_score.toFixed(2) || 0}`);
      return matches;
      
    } catch (error) {
      logger.error('Database lookup failed:', error);
      // Return empty array instead of crashing
      return [];
    }
  }
  
  /**
   * Calculate similarity score between searched and stored card names
   */
  private calculateSimilarity(searchName: string, storedName: string, searchSet?: string, storedSet?: string): number {
    const normalizedSearch = this.normalizeString(searchName);
    const normalizedStored = this.normalizeString(storedName);
    
    // Exact match
    if (normalizedSearch === normalizedStored) {
      // Bonus for set match
      if (searchSet && storedSet && this.normalizeString(searchSet) === this.normalizeString(storedSet)) {
        return 1.0;
      }
      return 0.98;
    }
    
    // Partial matches
    const searchWords = normalizedSearch.split(' ').filter(w => w.length > 2);
    const storedWords = normalizedStored.split(' ').filter(w => w.length > 2);
    
    if (searchWords.length === 0 || storedWords.length === 0) {
      return 0.1;
    }
    
    let matchedWords = 0;
    for (const searchWord of searchWords) {
      for (const storedWord of storedWords) {
        if (searchWord === storedWord || 
            searchWord.includes(storedWord) || 
            storedWord.includes(searchWord)) {
          matchedWords++;
          break;
        }
      }
    }
    
    const wordMatchRatio = matchedWords / Math.max(searchWords.length, storedWords.length);
    
    // Set bonus
    let setBonus = 0;
    if (searchSet && storedSet && this.normalizeString(searchSet) === this.normalizeString(storedSet)) {
      setBonus = 0.1;
    }
    
    return Math.min(0.95, wordMatchRatio * 0.8 + setBonus);
  }
  
  /**
   * Normalize string for comparison
   */
  private normalizeString(str: string): string {
    return str.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
  }
}