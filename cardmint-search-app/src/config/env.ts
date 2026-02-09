import { z } from "zod";
import type { ReleaseStage } from "../policy/releaseStage.js";
import { assertReleasePolicy } from "../policy/releaseStage.js";

const ReleaseStageSchema = z.enum([
  "internal_dev",
  "internal_ga",
  "trusted_alpha",
  "public_beta"
]);

const EnvSchema = z.object({
  SEARCH_APP_INVENTORY_DB_PATH: z.string().optional(),
  SEARCH_APP_REFERENCE_DB_PATH: z.string().optional(),
  SEARCH_APP_RELEASE_STAGE: ReleaseStageSchema.default("internal_dev"),
  SEARCH_APP_ALLOW_PUBLIC: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  SEARCH_APP_REQUIRE_AUTH: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  SEARCH_APP_API_KEY: z.string().optional().default("dev-internal-key-change-me"),
  SEARCH_APP_MIN_CONFIDENCE: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = value ? Number(value) : 0.85;
      return Number.isFinite(parsed) ? parsed : 0.85;
    }),
  SEARCH_APP_PORT: z
    .string()
    .optional()
    .transform((value) => {
      const parsed = value ? Number(value) : 4310;
      return Number.isInteger(parsed) ? parsed : 4310;
    }),
  SEARCH_APP_DEVICE_TIER: z.string().optional(),
  SEARCH_APP_VECTOR_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export interface SearchAppEnv {
  inventoryDbPath: string | null;
  referenceDbPath: string | null;
  stage: ReleaseStage;
  allowPublic: boolean;
  requireAuth: boolean;
  apiKey: string;
  minConfidence: number;
  port: number;
  deviceTier: string | null;
  vectorEnabled: boolean;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): SearchAppEnv {
  const parsed = EnvSchema.parse(source);

  const config: SearchAppEnv = {
    inventoryDbPath: parsed.SEARCH_APP_INVENTORY_DB_PATH ?? null,
    referenceDbPath: parsed.SEARCH_APP_REFERENCE_DB_PATH ?? null,
    stage: parsed.SEARCH_APP_RELEASE_STAGE as ReleaseStage,
    allowPublic: parsed.SEARCH_APP_ALLOW_PUBLIC,
    requireAuth: parsed.SEARCH_APP_REQUIRE_AUTH,
    apiKey: parsed.SEARCH_APP_API_KEY,
    minConfidence: parsed.SEARCH_APP_MIN_CONFIDENCE,
    port: parsed.SEARCH_APP_PORT,
    deviceTier: parsed.SEARCH_APP_DEVICE_TIER ?? null,
    vectorEnabled: parsed.SEARCH_APP_VECTOR_ENABLED,
  };

  assertReleasePolicy({
    stage: config.stage,
    allowPublic: config.allowPublic,
    minConfidence: config.minConfidence
  });

  if (config.stage !== "internal_dev" && config.apiKey === "dev-internal-key-change-me") {
    throw new Error(
      `SEARCH_APP_API_KEY must be set to a real secret when stage is "${config.stage}". ` +
      "The default placeholder key is only allowed for internal_dev."
    );
  }

  return config;
}
