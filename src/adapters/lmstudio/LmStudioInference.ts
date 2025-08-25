import { promises as fs } from "fs";
import type { InferencePort, InferenceResult, InferenceStatus } from "../../core/infer/InferencePort";
import { logger } from "../../utils/logger";
import { getGlobalProfiler } from "../../utils/performanceProfiler";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * LMStudio-based inference adapter for card recognition.
 * Connects to LMStudio running Qwen2.5-VL or similar vision-language model.
 * 
 * Apple Silicon Optimizations:
 * - Model Quantization: 8-bit weights for 7B VLM (full precision until KV cache support)
 * - Note: LM Studio does not currently support KV caching for vision models
 * - MLX Engine: Native Apple Silicon acceleration via LM Studio 0.3.4+
 * - Memory: ~6-8GB for 8-bit Qwen2.5-VL-7B model
 */
export class LmStudioInference implements InferencePort {
  private totalRequests = 0;
  private totalLatency = 0;
  private errorCount = 0;
  private lastError?: string;
  
  constructor(
    private baseUrl: string,       // e.g., http://10.0.24.174:1234
    private model: string,         // model id loaded in LMStudio
    private fetchImpl: FetchLike = fetch
  ) {}
  
  async classify(
    imagePath: string, 
    options: { signal?: AbortSignal; timeout?: number; temperature?: number; max_tokens?: number } = {}
  ): Promise<InferenceResult> {
    const startTime = Date.now();
    this.totalRequests++;
    const profiler = getGlobalProfiler();
    
    try {
      // Read image file for base64 encoding (VLM requirement)
      profiler?.startStage('file_read', { path: imagePath });
      const imageBuffer = await fs.readFile(imagePath);
      const fileSize = imageBuffer.length;
      profiler?.endStage('file_read', { size_bytes: fileSize });
      
      profiler?.startStage('base64_encode');
      const imageBase64 = imageBuffer.toString('base64');
      const imageMime = this.getImageMimeType(imagePath);
      profiler?.endStage('base64_encode', { mime: imageMime });
      
      const url = `${this.baseUrl}/v1/chat/completions`;
      // Note: LM Studio with MLX engine optimizations:
      // - 8-bit model weight quantization (vision models don't support KV caching yet)
      // - Native Apple Silicon acceleration through MLX backend
      const body = {
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are an expert at identifying Pokémon trading cards. Extract card metadata as JSON with these exact fields: card_title, identifier (with number, set_size, or promo_code), set_name, first_edition (boolean). Reply ONLY with compact JSON."
          },
          {
            role: "user", 
            content: [
              {
                type: "text",
                text: "Identify this Pokémon card and extract its metadata:"
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
        temperature: options.temperature || 0.1,
        max_tokens: options.max_tokens || 200,
        stream: false
      };
      
      const controller = new AbortController();
      const timeoutId = options.timeout 
        ? setTimeout(() => controller.abort(), options.timeout)
        : undefined;
      
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
      }
      
      let res: Response;
      try {
        profiler?.startStage('network_request', { 
          url: this.baseUrl,
          model: this.model,
          timeout: options.timeout || 'none'
        });
        
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        
        profiler?.endStage('network_request', { 
          status: res.status,
          ok: res.ok
        });
      } catch (e: any) {
        profiler?.endStage('network_request', { error: e?.message || String(e) });
        if (timeoutId) clearTimeout(timeoutId);
        this.errorCount++;
        this.lastError = `Request failed: ${e?.message || e}`;
        throw new Error(this.lastError);
      }
      
      if (timeoutId) clearTimeout(timeoutId);
      
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.errorCount++;
        this.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        throw new Error(this.lastError);
      }
      
      // Note: The actual VLM inference happens server-side between request and response
      profiler?.startStage('vlm_infer', { 
        model: this.model,
        note: 'server-side processing'
      });
      
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || "";
      
      // End VLM inference stage when we get response
      const usage = data?.usage;
      profiler?.endStage('vlm_infer', {
        prompt_tokens: usage?.prompt_tokens,
        completion_tokens: usage?.completion_tokens,
        total_tokens: usage?.total_tokens
      });
      
      // Parse JSON response
      profiler?.startStage('json_parse');
      let parsed: any;
      try {
        // Clean up response (remove markdown code blocks if present)
        const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(cleanContent);
        profiler?.endStage('json_parse', { success: true });
      } catch (parseError) {
        // Fallback parsing for malformed JSON
        parsed = this.extractFallbackData(content);
        profiler?.endStage('json_parse', { 
          success: false, 
          fallback: true,
          error: String(parseError)
        });
      }
      
      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;
      
      const result: InferenceResult = {
        card_title: parsed.card_title || "",
        identifier: parsed.identifier || {},
        set_name: parsed.set_name,
        first_edition: !!parsed.first_edition,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
        inference_time_ms: inferenceTime,
        model_used: this.model,
        raw: data
      };
      
      logger.info(`LMStudio inference completed: ${result.card_title} (${inferenceTime}ms)`);
      return result;
      
    } catch (error) {
      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;
      this.errorCount++;
      this.lastError = String(error);
      
      logger.error('LMStudio inference failed:', error);
      throw error;
    }
  }
  
  async healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }> {
    try {
      const startTime = Date.now();
      const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(5000) // 5s timeout for health check
      });
      
      const latency = Date.now() - startTime;
      
      if (response.ok) {
        return { healthy: true, latency };
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
    
    return {
      model_loaded: true,
      model_name: this.model,
      total_requests: this.totalRequests,
      average_latency_ms: Math.round(averageLatency),
      error_rate: Math.round(errorRate * 100) / 100,
      last_error: this.lastError
    };
  }
  
  /**
   * Determine MIME type from file extension
   */
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
        return 'image/jpeg'; // Default fallback
    }
  }
  
  /**
   * Fallback JSON extraction when parsing fails
   */
  private extractFallbackData(content: string): any {
    // Simple regex-based extraction as fallback
    const titleMatch = content.match(/(?:card_title|title)["']?\s*:\s*["']([^"']+)["']/i);
    const numberMatch = content.match(/(?:number)["']?\s*:\s*["']?([^"',}]+)["']?/i);
    const setMatch = content.match(/(?:set_name|set)["']?\s*:\s*["']([^"']+)["']/i);
    
    return {
      card_title: titleMatch?.[1] || "Unknown",
      identifier: { 
        number: numberMatch?.[1] 
      },
      set_name: setMatch?.[1],
      confidence: 0.5 // Lower confidence for fallback parsing
    };
  }
}