import { OpenCvImageProcessor } from "../adapters/opencv/OpenCvImageProcessor";
import type { ImageProcessorPort } from "../core/image/ImageProcessorPort";
import { LmStudioInference } from "../adapters/lmstudio/LmStudioInference";
import type { InferencePort } from "../core/infer/InferencePort";
import { ImageValidationAdapter } from "../adapters/validation/ImageValidationAdapter";
import type { ValidationPort } from "../core/validate/ValidationPort";
import { LocalFirstPipeline } from "../worker/verification/LocalFirstPipeline";
import { logger } from "../utils/logger";

/**
 * Composition root for dependency injection.
 * This is the ONLY place that should import concrete adapter implementations.
 */

// Environment-based configuration
const LM_BASE = process.env.REMOTE_ML_HOST && process.env.REMOTE_ML_PORT
  ? `http://${process.env.REMOTE_ML_HOST}:${process.env.REMOTE_ML_PORT}`
  : "http://10.0.24.174:1234";
const LM_MODEL = process.env.LMSTUDIO_MODEL || "qwen2.5-vl-7b-instruct";

export type Ports = {
  image: ImageProcessorPort;
  infer: InferencePort;
  validate: ValidationPort;
  localFirst: LocalFirstPipeline; // Local-First recognition pipeline
  // persist: PersistencePort; // Future: database adapter
};

/**
 * Initialize and wire up all adapters
 */
function createPorts(): Ports {
  logger.info('Initializing CardMint ports/adapters...');
  
  const imageProcessor = new OpenCvImageProcessor();
  const inference = new LmStudioInference(LM_BASE, LM_MODEL);
  const validation = new ImageValidationAdapter();
  const localFirst = new LocalFirstPipeline();
  
  logger.info(`Configured LMStudio: ${LM_BASE} (model: ${LM_MODEL})`);
  logger.info(`Local-First enabled: ${process.env.LOCAL_FIRST_MATCH === 'true'}`);
  
  return {
    image: imageProcessor,
    infer: inference,
    validate: validation,
    localFirst: localFirst,
  };
}

// Singleton instance - initialize once and reuse
let _ports: Ports | null = null;

export const ports: Ports = new Proxy({} as Ports, {
  get(target, prop) {
    if (!_ports) {
      _ports = createPorts();
    }
    return _ports[prop as keyof Ports];
  }
});

/**
 * Health check all adapters
 */
export async function healthCheckPorts(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  
  try {
    // Test image processor (quick metadata check)
    results.image = true; // OpenCV processor doesn't have async healthCheck yet
  } catch {
    results.image = false;
  }
  
  try {
    // Test inference service
    const inferHealth = await ports.infer.healthCheck();
    results.infer = inferHealth.healthy;
  } catch {
    results.infer = false;
  }
  
  try {
    // Test validation service
    const validateHealth = await ports.validate.healthCheck();
    results.validate = validateHealth.healthy;
  } catch {
    results.validate = false;
  }
  
  return results;
}

/**
 * Get detailed status from all adapters
 */
export async function getPortsStatus(): Promise<Record<string, any>> {
  const status: Record<string, any> = {};
  
  try {
    status.infer = await ports.infer.getStatus();
  } catch (error) {
    status.infer = { error: String(error) };
  }
  
  // Image processor status (basic info for now)
  status.image = {
    adapter: "OpenCvImageProcessor", 
    ready: true
  };
  
  status.validate = {
    adapter: "ImageValidationAdapter",
    ready: true
  };
  
  return status;
}

/**
 * Force re-initialization of ports (useful for testing/recovery)
 */
export function resetPorts(): void {
  _ports = null;
  logger.info('Ports reset - will reinitialize on next access');
}