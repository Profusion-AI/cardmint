import sharp from "sharp";
import { performance } from "node:perf_hooks";
import { runtimeConfig } from "../../config";
import type { ExtractedFields } from "../../domain/job";

export interface InferencePayload {
  extracted: ExtractedFields;
  infer_ms: number;
}

interface LmStudioResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const SYSTEM_PROMPT =
  "Pokemon card identifier. Provide name, hp, and set_number. " +
  "Include visible variant suffix letters in the name (e.g., 'V', 'EX', 'GX', 'VMAX', 'VSTAR') when printed as part of the name. " +
  "CRITICAL: Set number is the printed collector number in the bottom corner. " +
  "Format: 'NNN/TTT' or 'NNN'. NOT level (LV.XX) and NOT National Dex. " +
  "If a field is unclear, return null. Do not guess.";

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "pokemon_card_identity",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        hp: { type: "integer" },
        set_number: { type: "string" },
      },
      required: ["name", "hp", "set_number"],
      additionalProperties: false,
    },
  },
};

export async function runLmStudioInference(imagePath: string): Promise<InferencePayload> {
  const baseUrl = runtimeConfig.lmStudioBaseUrl.replace(/\/$/, "");
  const model = runtimeConfig.lmStudioModel;

  const pngBuffer = await sharp(imagePath).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      seed: 0,
      max_tokens: 42,
      response_format: RESPONSE_FORMAT,
      extra_body: {
        context_length: 777,
        top_k: 0,
        top_p: 1.0,
        min_p: 0.0,
        n_keep: -1,
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Identify this Pokemon card." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LMStudio request failed: ${response.status} ${response.statusText} — ${text}`);
  }

  const payload = (await response.json()) as LmStudioResponse;
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LMStudio response missing content");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse LMStudio JSON: ${(error as Error).message}`);
  }

  const name = typeof parsed?.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : undefined;
  const hpRaw = parsed?.hp;
  const setNumber = typeof parsed?.set_number === "string" && parsed.set_number.trim().length > 0 ? parsed.set_number.trim() : undefined;

  const hpValue =
    typeof hpRaw === "number" && Number.isFinite(hpRaw)
      ? hpRaw > 0
        ? hpRaw
        : null
      : null;

  const extracted: ExtractedFields = {
    card_name: name,
    hp_value: hpValue ?? null,
    set_number: setNumber,
  };

  if (extracted.hp_value === undefined) {
    extracted.hp_value = null;
  }

  const infer_ms = Math.round(performance.now() - started);

  return {
    extracted,
    infer_ms,
  };
}
