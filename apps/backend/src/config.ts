import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";

const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "") return undefined;
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean().default(defaultValue));

// Load .env from apps/backend directory, regardless of process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");
const envResult = loadEnv({ path: envPath });

if (envResult.error) {
  console.warn(`[config] Failed to load .env from ${envPath}:`, envResult.error.message);
} else {
  console.log(`[config] Loaded environment from ${envPath}`);
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  SQLITE_DB: z.string().default("data/cardmint.db"),
  CAPTURE_OUTPUT_DIR: z.string().default("data/captures"),
  CAPTURE_ADAPTER: z.string().default("gphoto2"),
  CAPTURE_BINARY: z.string().default("../SonySDK/CrSDK_v2.00.00_20250805a_Linux64PC/build/CardMintCapture"),
  CAPTURE_BACKEND_URL: z.string().default("http://127.0.0.1:4000"),
  CAPTURE_TIMEOUT_MS: z.coerce.number().default(30000),
  CAPTURE_DRIVER: z.enum(["sony", "pi-hq"]).default("pi-hq"),
  // Pi5 kiosk endpoint + token (supports legacy PI5_* env vars for backward compatibility)
  CAPTURE_PI_BASEURL: z.string().optional(),
  PI5_KIOSK_URL: z.string().optional(),
  CAPTURE_PI_TOKEN: z.string().optional(),
  PI5_QUEUE_TOKEN: z.string().optional(),
  CAPTURE_PI_TIMEOUT_MS: z.coerce.number().default(30000),
  CAPTURE_PI_EXPOSURE_US: z.coerce.number().default(10101),
  CAPTURE_PI_ANALOGUE_GAIN: z.coerce.number().default(1.115),
  CAPTURE_PI_COLOUR_GAINS: z.string().default("2.38,1.98"), // Format: "red_gain,blue_gain" e.g. "2.0,1.8"
  CAPTURE_PI_AE_ENABLE: boolFromEnv(false),
  CAPTURE_PI_AWB_ENABLE: boolFromEnv(false),
  SFTP_WATCH_PATH: z.string().default("/srv/cardmint/watch/incoming"),
  LMSTUDIO_BASE_URL: z.string().default("http://127.0.0.1:12345"),
  LMSTUDIO_MODEL: z.string().default("magistral-small-2509"),
  PRICECHARTING_CSV_PATH: z.string().default("../../data/pricecharting-pokemon-cards.csv"),
  QUEUE_WARN_DEPTH: z.coerce.number().default(11),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  PRICECHARTING_API_KEY: z.string().optional(),
  POKEMONTCG_API_KEY: z.string().optional(),
  POKEMONPRICETRACKER_API_KEY: z.string().optional(),
  POKEPRICETRACKER_API_TIER: z.enum(["free", "paid"]).default("free"),
  POKEPRICETRACKER_DAILY_LIMIT: z.coerce.number().default(100),
  POKEPRICETRACKER_TIMEOUT_MS: z.coerce.number().default(15000),
  PPT_PRICING_STRATEGY: z.enum(["cards_query", "parse_title", "shadow"]).default("cards_query"),
  EXTERNAL_LLM_BUDGET_CENTS: z.coerce.number().optional(),
  DEV_MODE: boolFromEnv(false),
  // Path A (OpenAI)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.1-2025-11-13"),
  OPENAI_TEMPERATURE: z.coerce.number().default(0),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().default(2048),
  OPENAI_SEED: z.coerce.number().optional(),
  OPENAI_TIMEOUT_MS: z.coerce.number().default(30000),
  OPENAI_RETRY_ONCE: boolFromEnv(true),
  OPENAI_STORE_DEFAULT: boolFromEnv(true),
  ALLOW_STORE_SESSION_TOGGLE: boolFromEnv(true),
  OPENAI_PROMPT_CACHE_RETENTION: z.enum(["in_memory", "24h"]).default("24h"),
  OPENAI_PROMPT_CACHE_KEY: z.string().default("cardmint-path-a-v2"),
  // Shadow lane (measurement only)
  SHADOW_SAMPLE_RATE: z.coerce.number().default(0.10),
  AUTO_PAUSE_DEPTH: z.coerce.number().default(11),
  AUTO_RESUME_DEPTH: z.coerce.number().default(8),
  // Hot-reload & queues
  GRACEFUL_SHUTDOWN_MS: z.coerce.number().default(10000),
  // CDN / Images
  CDN_IMAGES_ENABLED: boolFromEnv(false),
  CDN_BASE_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default("cardmint"),
  // ImageKit
  IMAGEKIT_PUBLIC_KEY: z.string().optional(),
  IMAGEKIT_PRIVATE_KEY: z.string().optional(),
  IMAGEKIT_URL_ENDPOINT: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Canonical catalog feature flags (Phase 3)
  CANONICAL_RETRIEVAL_ENABLED: boolFromEnv(true),
  CANONICAL_SEED_ENABLED: boolFromEnv(true),
  CANONICAL_CSV_FALLBACK: boolFromEnv(false), // Break-glass: set to true to allow CSV fallback
  // EverShop auto-import (Dec 2025)
  EVERSHOP_AUTO_IMPORT: boolFromEnv(false), // Auto-import to EverShop on Accept
  EVERSHOP_API_URL: z.string().default("https://cardmintshop.com"),
  EVERSHOP_ADMIN_TOKEN: z.string().optional(), // For future API auth if needed
  EVERSHOP_ENVIRONMENT: z.enum(["staging", "production"]).default("staging"),
  EVERSHOP_SSH_HOST: z.string().default("157.245.213.233"),
  EVERSHOP_SSH_USER: z.string().default("cardmint"),
  EVERSHOP_SSH_KEY_PATH: z.string().optional(), // Defaults to ~/.ssh/cardmint_droplet
  EVERSHOP_DOCKER_COMPOSE_PATH: z.string().default("/opt/cardmint/docker-compose.yml"),
  EVERSHOP_DB_USER: z.string().default("evershop"),
  EVERSHOP_DB_NAME: z.string().default("evershop"),
  // Stripe payments (Dec 2025)
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_RESERVATION_TTL_MINUTES: z.coerce.number().default(30),
  // Klaviyo email marketing (Dec 2025)
  KLAVIYO_PRIVATE_API_KEY: z.string().optional(),
  KLAVIYO_SUBSCRIBE_LIST_ID: z.string().optional(),
  // EverShop import safeguards (Dec 2025)
  EVERSHOP_IMPORT_ENABLE_CONFIRM: boolFromEnv(false),
  EVERSHOP_IMPORT_BATCH_LIMIT: z.coerce.number().default(25),
  // Sync infrastructure (Dec 2025 - RFC-fullduplexDB_triple)
  SYNC_ENABLED: boolFromEnv(false),
  SYNC_INTERVAL_MS: z.coerce.number().default(30000),
  SYNC_PRICE_BIDIRECTIONAL: boolFromEnv(false),
  SYNC_RETURNS_ENABLED: boolFromEnv(false),
  SYNC_AUTO_PUBLISH_EVERSHOP: boolFromEnv(false),
  SYNC_AUDIT_RETENTION_DAYS: z.coerce.number().default(90),
  // Prod SQLite connection (reuses SSH host from EverShop by default)
  PROD_SSH_HOST: z.string().optional(),
  PROD_SSH_USER: z.string().optional(),
  PROD_SSH_KEY_PATH: z.string().optional(),
  PROD_DB_PATH: z.string().default("/var/www/cardmint-backend/cardmint_prod.db"),
  // Local prod mode: bypass SSH when running on prod server itself
  PROD_SQLITE_LOCAL: boolFromEnv(false),
  // EverShop webhook receiver (Dec 2025 - bidirectional sync)
  EVERSHOP_WEBHOOK_ENABLED: boolFromEnv(false),
  EVERSHOP_WEBHOOK_SECRET: z.string().optional(),
  EVERSHOP_WEBHOOK_RATE_LIMIT_RPM: z.coerce.number().default(60), // Max requests per minute
  EVERSHOP_WEBHOOK_STALE_THRESHOLD_SEC: z.coerce.number().default(300), // Reject events older than 5 min
  EVERSHOP_WEBHOOK_CLEANUP_DAYS: z.coerce.number().default(30), // Prune processed webhook_events after N days
  // EverShop REST API (Dec 2025 - gradual migration from PostgreSQL)
  EVERSHOP_USE_REST_API: boolFromEnv(false),
  EVERSHOP_ADMIN_EMAIL: z.string().optional(),
  EVERSHOP_ADMIN_PASSWORD: z.string().optional(),
  // Lot Builder LLM Preview (Dec 2025)
  OPENROUTER_API_KEY: z.string().optional(),
  LOTBUILDER_LLM_PRIMARY_MODEL: z.string().default("gpt-5-mini"),
  LOTBUILDER_LLM_FALLBACK_MODEL: z.string().default("mistralai/mistral-small-creative"),
  LOTBUILDER_LLM_TIMEOUT_MS: z.coerce.number().default(5000),
  LOTBUILDER_LLM_CACHE_TTL_SEC: z.coerce.number().default(300), // 5 min cache for identical carts
  LOTBUILDER_LLM_MAX_VARIANCE_PP: z.coerce.number().default(5), // Max ±5 percentage points
  LOTBUILDER_ADMIN_TOKEN: z.string().optional(), // Admin token for cache endpoints
  LOTBUILDER_RATE_LIMIT_RPM: z.coerce.number().default(30), // Max requests per minute per IP
  // Path C: Set Disambiguation (Dec 2025)
  ENABLE_PATH_C_SET_DISAMBIG: boolFromEnv(false),
  PATH_C_HARD_FILTER_THRESHOLD: z.coerce.number().default(0.90),
  PATH_C_SOFT_RERANK_THRESHOLD: z.coerce.number().default(0.70),
  PATH_C_MIN_SIGNALS: z.coerce.number().default(2),
  PATH_C_PPT_QUERY_LIMIT: z.coerce.number().default(50),
  PATH_C_PPT_TIMEOUT_MS: z.coerce.number().default(900),
  PATH_C_QUOTA_WARNING_REMAINING: z.coerce.number().default(5000), // Warn at ~75% daily usage
});

const parsed = envSchema.parse(process.env);

const capturePiBaseUrl =
  parsed.CAPTURE_PI_BASEURL?.trim() ||
  parsed.PI5_KIOSK_URL?.trim() ||
  "http://127.0.0.1:8000";

const capturePiToken = parsed.CAPTURE_PI_TOKEN?.trim() || parsed.PI5_QUEUE_TOKEN?.trim() || "";

export const runtimeConfig = {
  port: parsed.PORT,
  sqlitePath: parsed.SQLITE_DB,
  logLevel: parsed.LOG_LEVEL,
  captureOutputDir: parsed.CAPTURE_OUTPUT_DIR,
  captureAdapter: parsed.CAPTURE_ADAPTER,
  captureBinary: parsed.CAPTURE_BINARY,
  captureBackendUrl: parsed.CAPTURE_BACKEND_URL,
  captureTimeoutMs: parsed.CAPTURE_TIMEOUT_MS,
  captureDriver: parsed.CAPTURE_DRIVER,
  capturePiBaseUrl,
  capturePiToken,
  capturePiTimeoutMs: parsed.CAPTURE_PI_TIMEOUT_MS,
  capturePiExposureUs: parsed.CAPTURE_PI_EXPOSURE_US,
  capturePiAnalogueGain: parsed.CAPTURE_PI_ANALOGUE_GAIN,
  capturePiColourGains: parsed.CAPTURE_PI_COLOUR_GAINS,
  capturePiAeEnable: parsed.CAPTURE_PI_AE_ENABLE,
  capturePiAwbEnable: parsed.CAPTURE_PI_AWB_ENABLE,
  sftpWatchPath: parsed.SFTP_WATCH_PATH,
  lmStudioBaseUrl: parsed.LMSTUDIO_BASE_URL,
  lmStudioModel: parsed.LMSTUDIO_MODEL,
  priceChartingCsvPath: parsed.PRICECHARTING_CSV_PATH,
  queueWarnDepth: parsed.QUEUE_WARN_DEPTH,
  redisUrl: parsed.REDIS_URL,
  priceChartingApiKey: parsed.PRICECHARTING_API_KEY ?? "",
  pokemonTcgApiKey: parsed.POKEMONTCG_API_KEY ?? "",
  pokemonPriceTrackerApiKey: parsed.POKEMONPRICETRACKER_API_KEY ?? "",
  pokemonPriceTrackerTier: parsed.POKEPRICETRACKER_API_TIER,
  pokemonPriceTrackerDailyLimit: parsed.POKEPRICETRACKER_DAILY_LIMIT,
  pokemonPriceTrackerTimeoutMs: parsed.POKEPRICETRACKER_TIMEOUT_MS,
  pptPricingStrategy: parsed.PPT_PRICING_STRATEGY,
  externalLlmBudgetCents: parsed.EXTERNAL_LLM_BUDGET_CENTS ?? 0,
  devMode: parsed.DEV_MODE,
  // Path A (OpenAI)
  openaiApiKey: parsed.OPENAI_API_KEY ?? "",
  openaiModel: parsed.OPENAI_MODEL,
  openaiTemperature: parsed.OPENAI_TEMPERATURE,
  openaiMaxOutputTokens: parsed.OPENAI_MAX_OUTPUT_TOKENS,
  openaiSeed: parsed.OPENAI_SEED,
  openaiTimeoutMs: parsed.OPENAI_TIMEOUT_MS,
  openaiRetryOnce: parsed.OPENAI_RETRY_ONCE,
  openaiStoreDefault: parsed.OPENAI_STORE_DEFAULT,
  allowStoreSessionToggle: parsed.ALLOW_STORE_SESSION_TOGGLE,
  openaiPromptCacheRetention: parsed.OPENAI_PROMPT_CACHE_RETENTION,
  openaiPromptCacheKey: parsed.OPENAI_PROMPT_CACHE_KEY,
  // Shadow lane (measurement only)
  shadowSampleRate: parsed.SHADOW_SAMPLE_RATE,
  autoPauseDepth: parsed.AUTO_PAUSE_DEPTH,
  autoResumeDepth: parsed.AUTO_RESUME_DEPTH,
  // Hot-reload & queues
  gracefulShutdownMs: parsed.GRACEFUL_SHUTDOWN_MS,
  // CDN / Images
  cdnImagesEnabled: parsed.CDN_IMAGES_ENABLED,
  cdnBaseUrl: parsed.CDN_BASE_URL ?? "",
  cloudinaryCloudName: parsed.CLOUDINARY_CLOUD_NAME ?? "",
  cloudinaryApiKey: parsed.CLOUDINARY_API_KEY ?? "",
  cloudinaryApiSecret: parsed.CLOUDINARY_API_SECRET ?? "",
  cloudinaryFolder: parsed.CLOUDINARY_FOLDER,
  // ImageKit
  imageKitPublicKey: parsed.IMAGEKIT_PUBLIC_KEY ?? "",
  imageKitPrivateKey: parsed.IMAGEKIT_PRIVATE_KEY ?? "",
  imageKitUrlEndpoint: parsed.IMAGEKIT_URL_ENDPOINT ?? "",
  // Canonical catalog feature flags (Phase 3)
  canonicalRetrievalEnabled: parsed.CANONICAL_RETRIEVAL_ENABLED,
  canonicalSeedEnabled: parsed.CANONICAL_SEED_ENABLED,
  canonicalCsvFallback: parsed.CANONICAL_CSV_FALLBACK,
  // EverShop auto-import (Dec 2025)
  evershopAutoImportEnabled: parsed.EVERSHOP_AUTO_IMPORT,
  evershopApiUrl: parsed.EVERSHOP_API_URL,
  evershopAdminToken: parsed.EVERSHOP_ADMIN_TOKEN ?? "",
  evershopEnvironment: parsed.EVERSHOP_ENVIRONMENT,
  evershopSshHost: parsed.EVERSHOP_SSH_HOST,
  evershopSshUser: parsed.EVERSHOP_SSH_USER,
  evershopSshKeyPath: parsed.EVERSHOP_SSH_KEY_PATH ?? `${process.env.HOME}/.ssh/cardmint_droplet`,
  evershopDockerComposePath: parsed.EVERSHOP_DOCKER_COMPOSE_PATH,
  evershopDbUser: parsed.EVERSHOP_DB_USER,
  evershopDbName: parsed.EVERSHOP_DB_NAME,
  // Stripe payments (Dec 2025)
  stripeSecretKey: parsed.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET ?? "",
  stripeReservationTtlMinutes: parsed.STRIPE_RESERVATION_TTL_MINUTES,
  // Klaviyo email marketing (Dec 2025)
  klaviyoPrivateApiKey: parsed.KLAVIYO_PRIVATE_API_KEY ?? "",
  klaviyoSubscribeListId: parsed.KLAVIYO_SUBSCRIBE_LIST_ID ?? "",
  // EverShop import safeguards (Dec 2025)
  evershopImportEnableConfirm: parsed.EVERSHOP_IMPORT_ENABLE_CONFIRM,
  evershopImportBatchLimit: parsed.EVERSHOP_IMPORT_BATCH_LIMIT,
  // Sync infrastructure (Dec 2025 - RFC-fullduplexDB_triple)
  syncEnabled: parsed.SYNC_ENABLED,
  syncIntervalMs: parsed.SYNC_INTERVAL_MS,
  syncPriceBidirectional: parsed.SYNC_PRICE_BIDIRECTIONAL,
  syncReturnsEnabled: parsed.SYNC_RETURNS_ENABLED,
  syncAutoPublishEvershop: parsed.SYNC_AUTO_PUBLISH_EVERSHOP,
  syncAuditRetentionDays: parsed.SYNC_AUDIT_RETENTION_DAYS,
  // Prod SQLite connection (falls back to EverShop SSH settings)
  prodSshHost: parsed.PROD_SSH_HOST ?? parsed.EVERSHOP_SSH_HOST,
  prodSshUser: parsed.PROD_SSH_USER ?? parsed.EVERSHOP_SSH_USER,
  prodSshKeyPath: parsed.PROD_SSH_KEY_PATH ?? parsed.EVERSHOP_SSH_KEY_PATH ?? `${process.env.HOME}/.ssh/cardmint_droplet`,
  prodDbPath: parsed.PROD_DB_PATH,
  // Local prod mode: bypass SSH when running on prod server itself
  prodSqliteLocal: parsed.PROD_SQLITE_LOCAL,
  // EverShop webhook receiver (Dec 2025 - bidirectional sync)
  evershopWebhookEnabled: parsed.EVERSHOP_WEBHOOK_ENABLED,
  evershopWebhookSecret: parsed.EVERSHOP_WEBHOOK_SECRET ?? "",
  evershopWebhookRateLimitRpm: parsed.EVERSHOP_WEBHOOK_RATE_LIMIT_RPM,
  evershopWebhookStaleThresholdSec: parsed.EVERSHOP_WEBHOOK_STALE_THRESHOLD_SEC,
  evershopWebhookCleanupDays: parsed.EVERSHOP_WEBHOOK_CLEANUP_DAYS,
  // EverShop REST API (Dec 2025 - gradual migration from PostgreSQL)
  evershopUseRestApi: parsed.EVERSHOP_USE_REST_API,
  evershopAdminEmail: parsed.EVERSHOP_ADMIN_EMAIL ?? "",
  evershopAdminPassword: parsed.EVERSHOP_ADMIN_PASSWORD ?? "",
  // Lot Builder LLM Preview (Dec 2025)
  openrouterApiKey: parsed.OPENROUTER_API_KEY ?? "",
  lotBuilderLlmPrimaryModel: parsed.LOTBUILDER_LLM_PRIMARY_MODEL,
  lotBuilderLlmFallbackModel: parsed.LOTBUILDER_LLM_FALLBACK_MODEL,
  lotBuilderLlmTimeoutMs: parsed.LOTBUILDER_LLM_TIMEOUT_MS,
  lotBuilderLlmCacheTtlSec: parsed.LOTBUILDER_LLM_CACHE_TTL_SEC,
  lotBuilderLlmMaxVariancePp: parsed.LOTBUILDER_LLM_MAX_VARIANCE_PP,
  lotBuilderAdminToken: parsed.LOTBUILDER_ADMIN_TOKEN ?? "",
  lotBuilderRateLimitRpm: parsed.LOTBUILDER_RATE_LIMIT_RPM,
  // Path C: Set Disambiguation (Dec 2025)
  enablePathCSetDisambig: parsed.ENABLE_PATH_C_SET_DISAMBIG,
  pathCHardFilterThreshold: parsed.PATH_C_HARD_FILTER_THRESHOLD,
  pathCSoftRerankThreshold: parsed.PATH_C_SOFT_RERANK_THRESHOLD,
  pathCMinSignals: parsed.PATH_C_MIN_SIGNALS,
  pathCPptQueryLimit: parsed.PATH_C_PPT_QUERY_LIMIT,
  pathCPptTimeoutMs: parsed.PATH_C_PPT_TIMEOUT_MS,
  pathCQuotaWarningRemaining: parsed.PATH_C_QUOTA_WARNING_REMAINING,
};

// Log API key detection status
const openaiKeyLen = runtimeConfig.openaiApiKey.length;
if (openaiKeyLen > 0) {
  console.log(`[config] OpenAI API key detected (length: ${openaiKeyLen}), Path A enabled`);
} else {
  console.log(`[config] OpenAI API key NOT detected, Path A disabled (will fall back to LM Studio)`);
}
