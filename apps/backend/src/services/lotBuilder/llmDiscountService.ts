/**
 * LLM Discount Service
 * Real-time discount preview with AI-enhanced copy and theme detection
 *
 * Primary: OpenAI gpt-5-mini
 * Fallback: OpenRouter mistralai/mistral-small-creative
 *
 * IMPORTANT: Monetary values are ALWAYS deterministic (system-calculated).
 * LLM only enhances:
 * - Creative reason text (more engaging than templates)
 * - Theme bundle detection (e.g., "Gen 1 Collection")
 *
 * This ensures price consistency between preview and checkout.
 */

import { createHash } from "crypto";
import { runtimeConfig } from "../../config";
import { lotBuilderService } from "./lotBuilderService";
import type {
  LotBuilderResult,
  LotPreviewItem,
  LotPreviewResult,
} from "./types";

// In-memory cache for LLM responses
interface CacheEntry {
  result: LotPreviewResult;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();

// System prompt for creative copy generation (NOT price adjustment)
const SYSTEM_PROMPT = `You are a Pokemon card bundle copywriter for CardMint, an AI-powered card marketplace.

Your job is to:
1. Generate creative, engaging reason text for the bundle discount
2. Detect thematic bundles (e.g., "Gen 1 Collection", "Charizard Evolution Line", "Team Rocket Set")
3. Make collectors excited about their bundle

Rules:
- The discount percentage is FIXED by the system - do NOT suggest changes
- Keep reason text under 80 characters, exciting but not salesy
- Detect themes based on: same set, evolution lines, character collections, era (Gen 1-9)
- Return JSON only, no markdown`;

interface LlmResponse {
  reasonText: string;
  themeBundle: string | null;
  confidence: number;
}

/**
 * Generate cache key from cart items
 * Uses hash of sorted product UIDs to ensure consistent keys
 */
function generateCacheKey(items: LotPreviewItem[]): string {
  const sortedUids = items
    .map((i) => i.product_uid)
    .sort()
    .join("|");
  return createHash("sha256").update(sortedUids).digest("hex").slice(0, 16);
}

/**
 * Check if cache entry is valid
 */
function getCachedResult(cacheKey: string): LotPreviewResult | null {
  const entry = responseCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(cacheKey);
    return null;
  }
  return { ...entry.result, cached: true };
}

/**
 * Store result in cache
 */
function setCachedResult(cacheKey: string, result: LotPreviewResult): void {
  const ttlMs = runtimeConfig.lotBuilderLlmCacheTtlSec * 1000;
  responseCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Build user prompt from cart items
 */
function buildUserPrompt(
  items: LotPreviewItem[],
  systemResult: LotBuilderResult
): string {
  const cardList = items
    .map(
      (i) =>
        `- ${i.card_name} (${i.set_name}, ${i.rarity}, ${i.condition}) - $${(i.price_cents / 100).toFixed(2)}`
    )
    .join("\n");

  return `Cart contains ${items.length} cards:
${cardList}

Bundle discount: ${systemResult.discountPct}% off (${systemResult.reasonCode})
Synergies detected: ${systemResult.reasonTags.join(", ") || "none"}
Subtotal: $${(systemResult.subtotalBeforeDiscountCents / 100).toFixed(2)}
You save: $${(systemResult.discountAmountCents / 100).toFixed(2)}

Write creative copy for this bundle. Respond with JSON only:
{
  "reasonText": "<string, max 80 chars, exciting copy about the discount>",
  "themeBundle": "<string or null, detected theme like 'Team Rocket Collection'>",
  "confidence": <number 0-1>
}`;
}

/**
 * Call OpenAI API (primary model)
 */
async function callOpenAI(userPrompt: string): Promise<LlmResponse | null> {
  const apiKey = runtimeConfig.openaiApiKey;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    runtimeConfig.lotBuilderLlmTimeoutMs
  );

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: runtimeConfig.lotBuilderLlmPrimaryModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7, // Add some creativity
        max_tokens: 200,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(
        `[llmDiscountService] OpenAI error: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as LlmResponse;
    return validateResponse(parsed);
  } catch (err) {
    clearTimeout(timeout);
    console.error("[llmDiscountService] OpenAI call failed:", err);
    return null;
  }
}

/**
 * Call OpenRouter API (fallback model)
 */
async function callOpenRouter(userPrompt: string): Promise<LlmResponse | null> {
  const apiKey = runtimeConfig.openrouterApiKey;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    runtimeConfig.lotBuilderLlmTimeoutMs
  );

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: runtimeConfig.lotBuilderLlmFallbackModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 200,
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(
        `[llmDiscountService] OpenRouter error: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    // OpenRouter may return markdown, try to extract JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as LlmResponse;
    return validateResponse(parsed);
  } catch (err) {
    clearTimeout(timeout);
    console.error("[llmDiscountService] OpenRouter call failed:", err);
    return null;
  }
}

/**
 * Validate LLM response (copy and theme only, no price adjustment)
 */
function validateResponse(response: LlmResponse): LlmResponse {
  // Ensure reasonText is reasonable length and not empty
  const reasonText =
    typeof response.reasonText === "string" && response.reasonText.trim()
      ? response.reasonText.slice(0, 80)
      : "Bundle discount applied!";

  // Clamp confidence to valid range
  const confidence =
    typeof response.confidence === "number" && !isNaN(response.confidence)
      ? Math.max(0, Math.min(1, response.confidence))
      : 0.8;

  // Validate themeBundle is a string or null
  const themeBundle =
    typeof response.themeBundle === "string" && response.themeBundle.trim()
      ? response.themeBundle.slice(0, 50)
      : null;

  return {
    reasonText,
    themeBundle,
    confidence,
  };
}

/**
 * Create system-only fallback result (no LLM)
 */
function createSystemOnlyResult(
  systemResult: LotBuilderResult
): LotPreviewResult {
  return {
    ...systemResult,
    systemDiscountPct: systemResult.discountPct,
    llmAdjustedPct: systemResult.discountPct,
    llmReasonText: systemResult.reasonText,
    themeBundle: null,
    confidence: 1.0,
    cached: false,
    model: "system_only",
  };
}

/**
 * Main entry point: Get LLM-enhanced discount preview
 */
export async function getLotPreview(
  items: LotPreviewItem[]
): Promise<LotPreviewResult> {
  // Edge case: empty or single item
  if (items.length === 0) {
    const systemResult = lotBuilderService.calculateDiscount([]);
    return createSystemOnlyResult(systemResult);
  }

  if (items.length === 1) {
    const systemResult = lotBuilderService.calculateDiscount(items);
    return createSystemOnlyResult(systemResult);
  }

  // Check cache first
  const cacheKey = generateCacheKey(items);
  const cachedResult = getCachedResult(cacheKey);
  if (cachedResult) {
    console.log(`[llmDiscountService] Cache hit for ${cacheKey}`);
    return cachedResult;
  }

  // Calculate system discount
  const systemResult = lotBuilderService.calculateDiscount(items);

  // Build prompt
  const userPrompt = buildUserPrompt(items, systemResult);

  // Try primary model (OpenAI)
  let llmResponse = await callOpenAI(userPrompt);
  let model: "primary" | "fallback" | "system_only" = "primary";

  // Fallback to OpenRouter if primary fails
  if (!llmResponse) {
    console.log("[llmDiscountService] Primary failed, trying fallback...");
    llmResponse = await callOpenRouter(userPrompt);
    model = "fallback";
  }

  // If both fail, return system-only result
  if (!llmResponse) {
    console.log("[llmDiscountService] Both LLMs failed, using system copy");
    const result = createSystemOnlyResult(systemResult);
    setCachedResult(cacheKey, result); // Cache even system-only to prevent abuse
    return result;
  }

  // IMPORTANT: Monetary values ALWAYS use system-calculated discount
  // LLM only provides creative copy and theme detection
  const result: LotPreviewResult = {
    // Base fields - ALL from system (deterministic, price-consistent)
    discountPct: systemResult.discountPct,
    reasonCode: systemResult.reasonCode,
    reasonTags: systemResult.reasonTags,
    reasonText: llmResponse.reasonText, // LLM-enhanced copy
    subtotalBeforeDiscountCents: systemResult.subtotalBeforeDiscountCents,
    discountAmountCents: systemResult.discountAmountCents,
    finalTotalCents: systemResult.finalTotalCents,
    // LLM-enhanced fields (copy/theme only, not price)
    systemDiscountPct: systemResult.discountPct,
    llmAdjustedPct: systemResult.discountPct, // Same as system (no price adjustment)
    llmReasonText: llmResponse.reasonText,
    themeBundle: llmResponse.themeBundle,
    confidence: llmResponse.confidence,
    cached: false,
    model,
  };

  // Cache the result
  setCachedResult(cacheKey, result);
  console.log(
    `[llmDiscountService] ${model} model: discount=${systemResult.discountPct}%, theme=${llmResponse.themeBundle || "none"}`
  );

  return result;
}

/**
 * Clear cache (for testing or manual reset)
 */
export function clearLotPreviewCache(): void {
  responseCache.clear();
  console.log("[llmDiscountService] Cache cleared");
}

/**
 * Get cache stats
 */
export function getLotPreviewCacheStats(): { size: number; keys: string[] } {
  return {
    size: responseCache.size,
    keys: Array.from(responseCache.keys()),
  };
}
