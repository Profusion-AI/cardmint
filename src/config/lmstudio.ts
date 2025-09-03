import { z } from 'zod';
import { createLogger } from '../utils/logger';

/**
 * LM Studio Dual Instance Configuration
 * Manages Mac M4 (vision) and Fedora (verification) LM Studio setups
 * August 29, 2025 - E2E Pipeline Integration
 */

const log = createLogger('lmstudio-config');

// Environment variable schema validation
const LMStudioConfigSchema = z.object({
  // Mac M4 Vision Instance
  mac: z.object({
    url: z.string().url().default('http://10.0.24.174:1234'),
    model: z.string().default('qwen2.5-vl-7b-instruct'),
    timeout_ms: z.number().min(1000).max(30000).default(10000),
    enabled: z.boolean().default(true)
  }),
  
  // Fedora Verification Instance
  fedora: z.object({
    url: z.string().url().default('http://localhost:41343'),
    model: z.string().default('openai/gpt-oss-20b'),
    identifier: z.string().default('cardmint-verifier'),
    timeout_ms: z.number().min(500).max(10000).default(2000),
    enabled: z.boolean().default(true)
  }),
  
  // Verification Pipeline Settings
  verification: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(1).default(0.70),
    max_tokens: z.number().min(50).max(500).default(200),
    temperature: z.number().min(0).max(1).default(0.1),
    fallback_on_error: z.boolean().default(true),
    skip_high_confidence: z.boolean().default(true),
    high_confidence_threshold: z.number().min(0.8).max(1).default(0.90)
  }),
  
  // CLI Management Settings
  cli: z.object({
    path: z.string().default('/home/profusionai/.lmstudio/bin/lms'),
    auto_start_fedora: z.boolean().default(true),
    model_ttl_seconds: z.number().min(300).max(86400).default(3600), // 5 min to 24 hours
    gpu_offload: z.string().default('auto'), // 'auto', 'max', 'off', or 0.0-1.0
    context_length: z.number().min(512).max(8192).default(4096)
  })
});

export type LMStudioConfig = z.infer<typeof LMStudioConfigSchema>;

/**
 * Load and validate LM Studio configuration from environment variables
 */
export function loadLMStudioConfig(): LMStudioConfig {
  try {
    const rawConfig = {
      mac: {
        url: process.env.LMSTUDIO_MAC_URL || 'http://10.0.24.174:1234',
        model: process.env.LMSTUDIO_MAC_MODEL || 'qwen2.5-vl-7b-instruct',
        timeout_ms: parseInt(process.env.LMSTUDIO_MAC_TIMEOUT_MS || '10000'),
        enabled: process.env.LMSTUDIO_MAC_ENABLED !== 'false'
      },
      fedora: {
        url: process.env.LMSTUDIO_LOCAL_URL || 'http://localhost:41343',
        model: process.env.LMSTUDIO_LOCAL_MODEL || 'openai/gpt-oss-20b',
        identifier: process.env.LMSTUDIO_LOCAL_IDENTIFIER || 'cardmint-verifier',
        timeout_ms: parseInt(process.env.LMSTUDIO_LOCAL_TIMEOUT_MS || '2000'),
        enabled: process.env.LMSTUDIO_LOCAL_ENABLED !== 'false'
      },
      verification: {
        enabled: process.env.LMSTUDIO_VERIFIER_ENABLED !== 'false',
        threshold: parseFloat(process.env.LMSTUDIO_VERIFIER_THRESHOLD || '0.70'),
        max_tokens: parseInt(process.env.LMSTUDIO_VERIFIER_MAX_TOKENS || '200'),
        temperature: parseFloat(process.env.LMSTUDIO_VERIFIER_TEMPERATURE || '0.1'),
        fallback_on_error: process.env.LMSTUDIO_FALLBACK_ON_ERROR !== 'false',
        skip_high_confidence: process.env.LMSTUDIO_SKIP_HIGH_CONFIDENCE !== 'false',
        high_confidence_threshold: parseFloat(process.env.LMSTUDIO_HIGH_CONFIDENCE_THRESHOLD || '0.90')
      },
      cli: {
        path: process.env.LMSTUDIO_CLI_PATH || '/home/profusionai/.lmstudio/bin/lms',
        auto_start_fedora: process.env.LMSTUDIO_AUTO_START_FEDORA !== 'false',
        model_ttl_seconds: parseInt(process.env.LMSTUDIO_MODEL_TTL_SECONDS || '3600'),
        gpu_offload: process.env.LMSTUDIO_GPU_OFFLOAD || 'auto',
        context_length: parseInt(process.env.LMSTUDIO_CONTEXT_LENGTH || '4096')
      }
    };

    const config = LMStudioConfigSchema.parse(rawConfig);
    
    log.info('LM Studio configuration loaded successfully');
    log.debug('Mac instance:', { 
      url: config.mac.url, 
      model: config.mac.model,
      enabled: config.mac.enabled 
    });
    log.debug('Fedora instance:', { 
      url: config.fedora.url, 
      model: config.fedora.model,
      enabled: config.fedora.enabled 
    });
    log.debug('Verification settings:', {
      enabled: config.verification.enabled,
      threshold: config.verification.threshold
    });

    return config;
    
  } catch (error) {
    log.error('Failed to load LM Studio configuration:', error);
    
    // Return safe defaults on error
    const defaultConfig = LMStudioConfigSchema.parse({});
    log.warn('Using default LM Studio configuration');
    return defaultConfig;
  }
}

/**
 * Validate that required LM Studio instances are accessible
 */
export async function validateLMStudioInstances(config: LMStudioConfig): Promise<{
  mac: { available: boolean; error?: string };
  fedora: { available: boolean; error?: string };
}> {
  const results = {
    mac: { available: false, error: undefined as string | undefined },
    fedora: { available: false, error: undefined as string | undefined }
  };

  // Test Mac M4 instance
  if (config.mac.enabled) {
    try {
      const response = await fetch(`${config.mac.url}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        const models = await response.json();
        const hasVisionModel = models?.data?.some((model: any) => 
          model.id === config.mac.model || model.id.includes('qwen') || model.id.includes('vl')
        );
        
        results.mac.available = hasVisionModel;
        if (!hasVisionModel) {
          results.mac.error = `Vision model ${config.mac.model} not found`;
        }
      } else {
        results.mac.error = `HTTP ${response.status}`;
      }
    } catch (error) {
      results.mac.error = String(error);
    }
  } else {
    results.mac.error = 'Mac instance disabled in configuration';
  }

  // Test Fedora instance
  if (config.fedora.enabled) {
    try {
      const response = await fetch(`${config.fedora.url}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      
      if (response.ok) {
        const models = await response.json();
        const hasVerifierModel = models?.data?.some((model: any) => 
          model.id === config.fedora.identifier || 
          model.id === config.fedora.model ||
          model.id.includes('gpt-oss') ||
          model.id.includes('verifier')
        );
        
        results.fedora.available = hasVerifierModel;
        if (!hasVerifierModel) {
          results.fedora.error = `Verifier model ${config.fedora.model} not loaded`;
        }
      } else {
        results.fedora.error = `HTTP ${response.status}`;
      }
    } catch (error) {
      results.fedora.error = String(error);
    }
  } else {
    results.fedora.error = 'Fedora instance disabled in configuration';
  }

  // Log validation results
  if (results.mac.available) {
    log.info('Mac M4 vision instance: AVAILABLE');
  } else {
    log.warn(`Mac M4 vision instance: UNAVAILABLE (${results.mac.error})`);
  }

  if (results.fedora.available) {
    log.info('Fedora verification instance: AVAILABLE');
  } else {
    log.warn(`Fedora verification instance: UNAVAILABLE (${results.fedora.error})`);
  }

  return results;
}

/**
 * Determine optimal routing strategy based on available instances
 */
export function getRoutingStrategy(
  macAvailable: boolean, 
  fedoraAvailable: boolean, 
  config: LMStudioConfig
): 'full_pipeline' | 'mac_only' | 'unavailable' {
  if (!macAvailable) {
    log.error('Mac vision instance unavailable - CardMint pipeline cannot function');
    return 'unavailable';
  }

  if (config.verification.enabled && fedoraAvailable) {
    log.info('Full pipeline available: Mac vision + Fedora verification');
    return 'full_pipeline';
  } else {
    const reason = !config.verification.enabled 
      ? 'verification disabled' 
      : 'Fedora instance unavailable';
    log.warn(`Running Mac-only pipeline (${reason})`);
    return 'mac_only';
  }
}

/**
 * Get CLI command for loading Fedora verification model
 */
export function getFedoraModelLoadCommand(config: LMStudioConfig): string {
  const { model, identifier } = config.fedora;
  const { gpu_offload, context_length, model_ttl_seconds } = config.cli;

  return [
    config.cli.path,
    'load',
    `"${model}"`,
    `--identifier="${identifier}"`,
    `--gpu=${gpu_offload}`,
    `--context-length=${context_length}`,
    `--ttl=${model_ttl_seconds}`,
    '--yes'
  ].join(' ');
}

/**
 * Get CLI command for starting Fedora server
 */
export function getFedoraServerStartCommand(config: LMStudioConfig): string {
  const port = new URL(config.fedora.url).port || '41343';
  
  return [
    config.cli.path,
    'server',
    'start',
    `--port=${port}`
  ].join(' ');
}

/**
 * Global configuration instance
 */
export const lmStudioConfig = loadLMStudioConfig();

// Export configuration for external use
export default lmStudioConfig;