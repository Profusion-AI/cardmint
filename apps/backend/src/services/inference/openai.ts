import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { runtimeConfig } from "../../config";
import type { ExtractedFields } from "../../domain/job";
import type { Logger } from "pino";
import OpenAI from "openai";

export interface InferencePayload {
  extracted: ExtractedFields;
  infer_ms: number;
  retriedOnce?: boolean;
}

export class OpenAIFallbackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAIFallbackError";
  }
}

const SYSTEM_PROMPT =
  "Extract: name, hp, set_number, set_name, rarity, artist, card_type, variant markers. " +
  "CRITICAL: set_number must be the printed collector number (e.g. 26/264 or 26), not level ('LV.XX') and not National Dex. " +
  "If both appear as 'NNN/TTT', return that full string; otherwise return just 'NNN'. " +
  "name should include visible variant suffix letters (e.g., 'V', 'EX', 'GX', 'VMAX', 'VSTAR') when printed as part of the name. " +
  "set_name is the expansion name ONLY if clearly printed on the card (e.g., 'Base Set', 'Jungle', 'Evolving Skies'). " +
  "Return null for set_name if: (1) no set name text is visible, (2) you are unsure, or (3) you can only infer from the set symbol. " +
  "NEVER guess set_name from memory. Common confusions: Base Set vs Base Set 2, Team Rocket vs Team Rocket Returns. " +
  "rarity: Read the rarity symbol (bottom-right). Mapping: " +
  "● = 'Common', ◆ = 'Uncommon', ★ = 'Rare', ★★ (black) = 'Double Rare', " +
  "★★ (silver) = 'Ultra Rare', ★ (gold) = 'Illustration Rare', " +
  "★★ (gold) = 'Special Illustration Rare', ★★★ (gold) = 'Hyper Rare'. Return null if unclear. " +
  "artist: Extract from 'Illus. Artist Name' at card bottom. Return null if not visible. " +
  "card_type: Pokemon type (Grass, Fire, Lightning, Water, Fighting, Colorless, Psychic, Darkness, Metal, Dragon, Fairy) " +
  "or card category (Trainer, Supporter, Item, Stadium, Tool, Basic Energy, Special Energy). " +
  "Dual types like 'Darkness Psychic' and variants like 'Trainer - Supporter' are valid. Return null if unclear. " +
  "If a field is not visible/unclear, return null or 'unknown'. Do NOT guess any field. " +
  "If you cannot read set_number clearly, return null rather than guessing. " +
  "Variant markers: " +
  "• first_edition_stamp: true only if '1st Edition' stamp visible; else false. " +
  "• shadowless: true only if NO drop shadow on art box; else false. " +
  "• holo_type: 'holo' | 'reverse_holo' | 'non_holo' | 'unknown'. " +
  "Output must conform to the JSON schema exactly.";

const RESPONSE_TEXT_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "pokemon_card_identity",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        hp: { type: ["integer", "null"] },
        set_number: { type: ["string", "null"] },
        set_name: { type: ["string", "null"] },
        first_edition_stamp: { type: "boolean" },
        shadowless: { type: "boolean" },
        holo_type: { type: "string", enum: ["holo", "reverse_holo", "non_holo", "unknown"] },
        // New fields (Dec 2025)
        rarity: {
          type: ["string", "null"],
          enum: [
            "Common",
            "Uncommon",
            "Rare",
            "Double Rare",
            "Ultra Rare",
            "Illustration Rare",
            "Special Illustration Rare",
            "Hyper Rare",
            null,
          ],
        },
        artist: { type: ["string", "null"] },
        card_type: { type: ["string", "null"] },
      },
      required: [
        "name",
        "hp",
        "set_number",
        "set_name",
        "first_edition_stamp",
        "shadowless",
        "holo_type",
        "rarity",
        "artist",
        "card_type",
      ],
      additionalProperties: false,
    },
  },
};

/**
 * Call Responses API with single retry on 5xx errors only
 * Retries transient HTTP 5xx with exponential backoff; fails loudly on 4xx
 */
async function callResponsesWithRetry(openai: OpenAI, payload: any): Promise<any> {
  try {
    return await openai.responses.create(payload);
  } catch (error: any) {
    // Only retry on 5xx server errors (not 4xx client errors)
    if (error.status >= 500 && error.status < 600) {
      const backoffMs = 300 + Math.random() * 300;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return await openai.responses.create(payload);
    }
    throw error;
  }
}

/**
 * Upload image to OpenAI Files API with purpose: "vision"
 * Returns file_id for use in Responses API
 */
async function uploadImageToOpenAI(processedPath: string, openai: OpenAI, logger?: Logger): Promise<string> {
  const { size } = fs.statSync(processedPath);
  logger?.info({ processedPath, size }, "Uploading image to OpenAI Files API");

  const upload = await openai.files.create({
    purpose: "vision",
    file: fs.createReadStream(processedPath),
  });

  logger?.info({ fileId: upload.id, size }, "Image uploaded to OpenAI");
  return upload.id;
}

/**
 * Delete file from OpenAI storage (non-blocking cleanup)
 */
async function deleteFile(openai: OpenAI, fileId: string, logger?: Logger): Promise<void> {
  try {
    await openai.files.delete(fileId);
    logger?.debug({ fileId }, "Deleted file from OpenAI storage");
  } catch (error) {
    // Non-blocking cleanup; log at debug level
    logger?.debug({ fileId, err: error }, "Failed to delete file from OpenAI storage");
  }
}

/**
 * Extract card data using OpenAI GPT-5-mini with single retry policy.
 * Implements 30s timeout + single retry with 250-500ms jitter.
 * Falls back to LM Studio on double failure.
 */
export async function runOpenAIInference(
  imagePath: string,
  metricsCallback?: {
    recordRetry: () => void;
    recordRetrySuccess: () => void;
    recordFallback: () => void;
  },
  logger?: Logger
): Promise<InferencePayload> {
  const started = performance.now();
  let retriedOnce = false;

  try {
    const result = await attemptOpenAICall(imagePath, logger);
    const infer_ms = Math.round(performance.now() - started);

    // Log successful Path A telemetry
    logger?.info(
      {
        inference_path: "openai",
        pathA_ms: infer_ms,
        retriedOnce: false,
        model: runtimeConfig.openaiModel,
      },
      "Path A inference successful (first attempt)"
    );

    return {
      extracted: result,
      infer_ms,
      retriedOnce,
    };
  } catch (firstError) {
    // Log first-attempt failure details for debugging
    const isTimeout = firstError instanceof Error && firstError.name === "AbortError";
    const isAPIError = firstError instanceof Error && firstError.message.includes("OpenAI request failed");
    const isParseError = firstError instanceof Error && firstError.message.includes("Failed to parse");
    const errorMessage = firstError instanceof Error ? firstError.message : String(firstError);
    const failureCause = isTimeout ? "timeout" : isAPIError ? "api_error" : isParseError ? "parse_error" : "unknown";

    logger?.warn(
      {
        err: firstError,
        message: errorMessage,
        failureCause,
        isTimeout,
        timeoutMs: runtimeConfig.openaiTimeoutMs,
        inference_path: "openai",
      },
      "Path A first attempt failed; retrying with jittered backoff"
    );

    if (!runtimeConfig.openaiRetryOnce) {
      throw firstError;
    }

    // Record retry attempt
    metricsCallback?.recordRetry();
    retriedOnce = true;

    // Jittered backoff: 250-500ms
    const backoffMs = 250 + Math.floor(Math.random() * 250);
    logger?.info({ backoffMs, inference_path: "openai" }, "Path A retry backoff delay");
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      const result = await attemptOpenAICall(imagePath, logger);
      metricsCallback?.recordRetrySuccess();
      const infer_ms = Math.round(performance.now() - started);

      // Log successful Path A retry telemetry
      logger?.info(
        {
          inference_path: "openai",
          pathA_ms: infer_ms,
          retriedOnce: true,
          backoffMs,
          model: runtimeConfig.openaiModel,
        },
        "Path A inference successful (retry succeeded)"
      );

      return {
        extracted: result,
        infer_ms,
        retriedOnce,
      };
    } catch (secondError) {
      metricsCallback?.recordFallback();
      const secondErrorMessage = secondError instanceof Error ? secondError.message : String(secondError);
      logger?.error(
        {
          err: secondError,
          message: secondErrorMessage,
          inference_path: "openai",
          totalMs: Math.round(performance.now() - started),
        },
        "Path A retry failed; falling back to LM Studio"
      );
      throw new OpenAIFallbackError("A-lane retry failed", { cause: secondError });
    }
  }
}

async function attemptOpenAICall(imagePath: string, logger?: Logger): Promise<ExtractedFields> {
  if (!runtimeConfig.openaiApiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // GUARDRAIL: Block data:image URIs - only file paths allowed
  if (imagePath.startsWith("data:")) {
    throw new Error("data: URIs are not allowed in inference - use file paths only");
  }

  // GUARDRAIL: Enforce 400KB size limit before upload
  const { size } = fs.statSync(imagePath);
  if (size > 400 * 1024) {
    throw new Error(
      `Image exceeds 400 KB guardrail; reprocess at 1024px JPEG Q≈82 (target ≤250 KB). Current size: ${size}B`
    );
  }

  const openai = new OpenAI({
    apiKey: runtimeConfig.openaiApiKey,
  });

  // Upload to OpenAI Files API with timing
  const uploadStart = performance.now();
  const fileId = await uploadImageToOpenAI(imagePath, openai, logger);
  const uploadMs = Math.round(performance.now() - uploadStart);

  try {
    // Call Responses API with correct payload structure
    const inferenceStart = performance.now();

    const useNoneEffort = runtimeConfig.openaiModel.includes("gpt-5.1");
    const payload: Record<string, any> = {
      model: runtimeConfig.openaiModel,
      max_output_tokens: Math.max(runtimeConfig.openaiMaxOutputTokens, 512), // Ensure enough for full JSON
      stream: false, // Disable streaming to prevent truncation
      store: true,
      // GPT-5.1: temperature/top_p unsupported; use reasoning depth controls instead.
      reasoning: { effort: useNoneEffort ? "none" : "low" }, // GPT-5.1 allows "none"; older models use "low"
      text: {
        format: {
          type: "json_schema",
          ...RESPONSE_TEXT_FORMAT.json_schema, // Flatten schema fields
        },
        verbosity: "low",
      },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Identify this Pokemon card." },
            { type: "input_image", file_id: fileId }, // Direct file_id (Oct 28 style)
          ],
        },
      ],
    };

    // Prompt caching: pin cache retention + deterministic key for shared prefixes.
    payload.prompt_cache_retention = runtimeConfig.openaiPromptCacheRetention;
    if (runtimeConfig.openaiPromptCacheKey) {
      payload.prompt_cache_key = runtimeConfig.openaiPromptCacheKey;
    }

    const response = await openai.responses.create(payload);

    const inferenceMs = Math.round(performance.now() - inferenceStart);

    // Extract text from Responses API output
    // Debug: Log the full output array to understand structure
    logger?.info(
      {
        output_text_present: response.output_text !== undefined,
        output_text_value: response.output_text,
        output_array_length: Array.isArray(response.output) ? response.output.length : 0,
        full_output: response.output,
      },
      "DEBUG: Full OpenAI output structure"
    );

    const text =
      response.output_text ??
      (Array.isArray(response.output)
        ? response.output
            .flatMap((out: any) =>
              (out.content ?? [])
                .filter((c: any) => c.type === "output_text")
                .map((c: any) => c.text)
            )
            .join("\n")
        : null);

    if (!text || !text.trim()) {
      logger?.error(
        {
          extracted_text: text,
          output_text_field: response.output_text,
          output_count: Array.isArray(response.output) ? response.output.length : 0,
        },
        "Failed to extract text from Responses API"
      );
      throw new Error("Responses API returned no output_text");
    }

    // Parse the JSON from the text field
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Failed to parse OpenAI JSON: ${(error as Error).message}`);
    }

    const name =
      typeof parsed?.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : undefined;
    const hpRaw = parsed?.hp;
    const setNumber =
      typeof parsed?.set_number === "string" && parsed.set_number.trim().length > 0
        ? parsed.set_number.trim()
        : undefined;
    const setName =
      typeof parsed?.set_name === "string" && parsed.set_name.trim().length > 0
        ? parsed.set_name.trim()
        : undefined;

    const hpValue =
      typeof hpRaw === "number" && Number.isFinite(hpRaw) ? (hpRaw > 0 ? hpRaw : null) : null;

    // Variant fields with safe defaults (HT-001)
    const firstEditionStamp = typeof parsed?.first_edition_stamp === "boolean"
      ? parsed.first_edition_stamp
      : undefined;
    const shadowless = typeof parsed?.shadowless === "boolean"
      ? parsed.shadowless
      : undefined;
    const holoType =
      parsed?.holo_type === "holo" ||
      parsed?.holo_type === "reverse_holo" ||
      parsed?.holo_type === "non_holo" ||
      parsed?.holo_type === "unknown"
        ? parsed.holo_type
        : undefined;

    // New fields (Dec 2025)
    const rarityValues = [
      "Common",
      "Uncommon",
      "Rare",
      "Double Rare",
      "Ultra Rare",
      "Illustration Rare",
      "Special Illustration Rare",
      "Hyper Rare",
    ];
    const rarity = rarityValues.includes(parsed?.rarity) ? parsed.rarity : null;

    const artist =
      typeof parsed?.artist === "string" && parsed.artist.trim().length > 0
        ? parsed.artist.trim()
        : null;

    const cardType =
      typeof parsed?.card_type === "string" && parsed.card_type.trim().length > 0
        ? parsed.card_type.trim()
        : null;

    // Log detailed timing and token usage
    // Note: Cast usage to any for SDK compatibility (ResponseUsage shape varies by SDK version)
    const usage = response.usage as Record<string, unknown> | undefined;
    logger?.info(
      {
        upload_ms: uploadMs,
        inference_ms: inferenceMs,
        total_ms: uploadMs + inferenceMs,
        file_id: fileId,
        file_size_bytes: size,
        prompt_tokens: usage?.prompt_tokens,
        completion_tokens: usage?.completion_tokens,
        total_tokens: usage?.total_tokens,
        model: runtimeConfig.openaiModel,
      },
      "Path A timing breakdown and token usage"
    );

    return {
      card_name: name,
      hp_value: hpValue ?? null,
      set_number: setNumber,
      set_name: setName,
      first_edition_stamp: firstEditionStamp,
      shadowless: shadowless,
      holo_type: holoType,
      // New fields (Dec 2025)
      rarity: rarity,
      artist: artist,
      card_type: cardType,
    };
  } finally {
    // Cleanup: delete file from OpenAI storage (non-blocking)
    await deleteFile(openai, fileId, logger);
  }
}
