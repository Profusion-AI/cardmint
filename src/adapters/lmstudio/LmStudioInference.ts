import { promises as fs } from "fs";
import type { InferencePort, InferenceResult, InferenceStatus } from "../../core/infer/InferencePort";
import { logger } from "../../utils/logger";
import { getGlobalProfiler } from "../../utils/performanceProfiler";
import { buildStrictMessages, type StrictHints, type ImageInput } from "./prompt-strict";
import { validateCompleteCard, calculateConfidenceScore } from "../../validation/CardData";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
            content: "You are an expert at identifying Pokémon trading cards. Focus on printed text over artwork, but make your best identification attempt. Output JSON with exact fields: card_title (string), identifier (object with number/set_size as digit strings OR promo_code as uppercase alphanumeric), set_name (string), first_edition (boolean). Reply ONLY with compact JSON."
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
        temperature: options.temperature || 0.02,
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
      
      // Calculate validation-based confidence
      const validationConfidence = calculateConfidenceScore({
        card_title: parsed.card_title,
        set_name: parsed.set_name,
        identifier: parsed.identifier
      });
      
      const result: InferenceResult = {
        card_title: parsed.card_title || "",
        identifier: parsed.identifier || {},
        set_name: parsed.set_name,
        first_edition: !!parsed.first_edition,
        confidence: Math.max(validationConfidence, 0.1), // Use validation-based confidence
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
      
      logger.error('LMStudio inference failed');
      throw error;
    }
  }

  /**
   * Rich classification with multi-image + hints and strict JSON prompt
   * Intended for higher accuracy on name/set/number.
   */
  async classifyRich(
    imagePaths: { label: string; path: string }[],
    opts: {
      signal?: AbortSignal;
      timeout?: number;
      temperature?: number;
      max_tokens?: number;
      hints?: StrictHints;
      includeFewShots?: boolean;
    } = {}
  ): Promise<InferenceResult> {
    const startTime = Date.now();
    this.totalRequests++;
    const profiler = getGlobalProfiler();

    try {
      // Read and encode images
      const images: ImageInput[] = [];
      profiler?.startStage('file_read_multi', { count: imagePaths.length });
      for (const { label, path } of imagePaths) {
        const buf = await fs.readFile(path);
        images.push({ label, mime: this.getImageMimeType(path), base64: buf.toString('base64') });
      }
      profiler?.endStage('file_read_multi');

      // Build strict messages
      const messages = buildStrictMessages(images, opts.hints, opts.includeFewShots !== false);

      const url = `${this.baseUrl}/v1/chat/completions`;
      const body = {
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.02,
        max_tokens: opts.max_tokens ?? 220,
        stream: false
      };

      const controller = new AbortController();
      const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
      if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());

      profiler?.startStage('network_request', { url: this.baseUrl, model: this.model, timeout: opts.timeout || 'none' });
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      profiler?.endStage('network_request', { status: res.status, ok: res.ok });
      if (timeoutId) clearTimeout(timeoutId);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.errorCount++;
        this.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        throw new Error(this.lastError);
      }

      profiler?.startStage('vlm_infer', { model: this.model, note: 'server-side processing' });
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || "";
      const usage = data?.usage;
      profiler?.endStage('vlm_infer', { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens, total_tokens: usage?.total_tokens });

      // Parse JSON
      profiler?.startStage('json_parse');
      let parsed: any;
      try {
        const clean = content.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(clean);
        // Coerce alternative shapes into expected identifier format
        if (!parsed.identifier) parsed.identifier = {};
        // If card_number like "052/189", split into number/set_size
        if (parsed.card_number && typeof parsed.card_number === 'string') {
          const m = String(parsed.card_number).match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
          if (m) parsed.identifier = { number: m[1], set_size: m[2] };
        }
        // If identifier is a string like "SWSH021", interpret as promo_code
        if (typeof parsed.identifier === 'string') {
          const promo = String(parsed.identifier).match(/^[A-Z]{2,5}\d{1,4}$/i);
          const frac = String(parsed.identifier).match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
          if (promo) parsed.identifier = { promo_code: promo[0].toUpperCase() };
          else if (frac) parsed.identifier = { number: frac[1], set_size: frac[2] };
          else parsed.identifier = {};
        }
        profiler?.endStage('json_parse', { success: true });
      } catch (e) {
        parsed = this.extractFallbackData(content);
        profiler?.endStage('json_parse', { success: false, fallback: true, error: String(e) });
      }

      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;
      
      // Calculate validation-based confidence for rich classification
      const validationConfidence = calculateConfidenceScore({
        card_title: parsed.card_title,
        set_name: parsed.set_name,
        identifier: parsed.identifier
      });
      
      const result: InferenceResult = {
        card_title: parsed.card_title || "",
        identifier: parsed.identifier || {},
        set_name: parsed.set_name,
        first_edition: !!parsed.first_edition,
        confidence: Math.max(validationConfidence, 0.1), // Use validation-based confidence
        inference_time_ms: inferenceTime,
        model_used: this.model,
        raw: data
      };
      logger.info(`LMStudio rich inference: ${result.card_title} (${inferenceTime}ms)`);
      return result;
    } catch (error) {
      const inferenceTime = Date.now() - startTime;
      this.totalLatency += inferenceTime;
      this.errorCount++;
      this.lastError = String(error);
      logger.error('LMStudio rich inference failed');
      throw error;
    }
  }

  /**
   * Micro re-ask: extract only card number or promo_code from a single ROI image.
   */
  async extractNumber(
    roiPath: string,
    opts: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<{ identifier?: { number?: string; set_size?: string; promo_code?: string } }> {
    const profiler = getGlobalProfiler();
    try {
      profiler?.startStage('file_read_number_roi');
      const buf = await fs.readFile(roiPath);
      profiler?.endStage('file_read_number_roi', { size: buf.length });
      const imageBase64 = buf.toString('base64');
      const imageMime = this.getImageMimeType(roiPath);
      const messages = [
        { role: 'system', content: 'Extract the printed card identifier from the image. Output strict JSON: {"identifier": {"number": "NNN", "set_size": "NNN"}} OR {"identifier": {"promo_code": "SWSH###"}}. Use digits as printed. No text other than JSON.' },
        { role: 'user', content: [
          { type: 'text', text: 'Return only JSON with identifier as above.' },
          { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } }
        ] }
      ];
      const body = { model: this.model, messages, temperature: 0.0, max_tokens: 80, stream: false };
      const controller = new AbortController();
      if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
      const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
      });
      if (timeoutId) clearTimeout(timeoutId);
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || '';
      const clean = content.replace(/```json\n?|\n?```/g, '').trim();
      try {
        const j = JSON.parse(clean);
        return { identifier: j?.identifier };
      } catch {
        // Try regex
        const promo = content.match(/\b([A-Z]{2,5}\d{1,4})\b/);
        const frac = content.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
        if (promo) return { identifier: { promo_code: promo[1].toUpperCase() } };
        if (frac) return { identifier: { number: frac[1], set_size: frac[2] } };
        return {};
      }
    } catch {
      return {};
    }
  }

  /**
   * Micro re-ask: classify set from symbol ROI with candidate list (optional).
   */
  async extractSet(
    roiPath: string,
    candidates?: { set_name: string }[],
    opts: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<{ set_name?: string }> {
    try {
      const buf = await fs.readFile(roiPath);
      const imageBase64 = buf.toString('base64');
      const imageMime = this.getImageMimeType(roiPath);
      const hint = candidates && candidates.length > 0 ? `Pick one of: ${candidates.map(c => c.set_name).join(', ')}` : '';
      const messages = [
        { role: 'system', content: 'Identify the Pokémon TCG set name from the set symbol image. Output JSON only: {"set_name": "..."}. If unsure, pick the closest from the provided list.' },
        { role: 'user', content: [
          { type: 'text', text: hint || 'Return only JSON with set_name.' },
          { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } }
        ] }
      ];
      const body = { model: this.model, messages, temperature: 0.0, max_tokens: 50, stream: false };
      const controller = new AbortController();
      if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
      const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (timeoutId) clearTimeout(timeoutId);
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || '';
      const clean = content.replace(/```json\n?|\n?```/g, '').trim();
      try { const j = JSON.parse(clean); return { set_name: j?.set_name }; } catch { return { set_name: content.replace(/[^\w\s&'-]/g, '').trim() }; }
    } catch { return {}; }
  }

  /**
   * Micro re-ask: extract card title from name-bar ROI only.
   */
  async extractName(
    roiPath: string,
    opts: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<{ card_title?: string }> {
    try {
      const buf = await fs.readFile(roiPath);
      const imageBase64 = buf.toString('base64');
      const imageMime = this.getImageMimeType(roiPath);
      const messages = [
        { role: 'system', content: 'Read only the printed Pokémon card name from the image. Output JSON only: {"card_title": "..."}. No set, no number.' },
        { role: 'user', content: [
          { type: 'text', text: 'Return only JSON with card_title as printed on the card name bar.' },
          { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } }
        ] }
      ];
      const body = { model: this.model, messages, temperature: 0.0, max_tokens: 40, stream: false };
      const controller = new AbortController();
      if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());
      const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : undefined;
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (timeoutId) clearTimeout(timeoutId);
      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() || '';
      const clean = content.replace(/```json\n?|\n?```/g, '').trim();
      try { const j = JSON.parse(clean); return { card_title: j?.card_title }; } catch { return { card_title: content.replace(/[^\w\s\-']/g, '').trim() }; }
    } catch { return {}; }
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
    // Try promo code first
    const promoMatch = content.match(/\b([A-Z]{2,5}\d{1,4})\b/);
    // Try fraction pattern for number/set_size
    const fracMatch = content.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    // Or a standalone number
    const numberMatch = content.match(/(?:\bnumber\b)["']?\s*:\s*["']?(\d{1,3})["']?/i);
    const setMatch = content.match(/(?:set_name|set)["']?\s*:\s*["']([^"']+)["']/i);
    
    return {
      card_title: titleMatch?.[1] || "Unknown",
      identifier: promoMatch
        ? { promo_code: promoMatch[1].toUpperCase() }
        : (fracMatch ? { number: fracMatch[1], set_size: fracMatch[2] } : (numberMatch ? { number: numberMatch[1] } : {})),
      set_name: setMatch?.[1],
      confidence: 0.5 // Lower confidence for fallback parsing
    };
  }
}
