/**
 * Inference Port Interface
 * 
 * Clean abstraction for ML inference operations.
 * Implementations provide LMStudio, ONNX, OpenCV, or other ML backends.
 */

export interface InferencePort {
  /**
   * Classify a card image and return extracted attributes.
   * Implementations must be idempotent and respect timeout/cancellation via AbortSignal.
   */
  classify(
    imagePath: string,
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<InferenceResult>;
  
  /**
   * Verify a primary inference result using a secondary model and database checks.
   * Optional method - only implemented by verifier adapters.
   */
  verify?(
    primaryResult: InferenceResult,
    imagePath: string,
    options?: VerifyOptions
  ): Promise<VerificationResult>;
  
  /**
   * Check if the inference service is healthy and ready.
   */
  healthCheck(): Promise<{ healthy: boolean; latency?: number; error?: string }>;
  
  /**
   * Get current resource usage and model status.
   */
  getStatus(): Promise<InferenceStatus>;
}

/**
 * Standardized inference result format
 */
export interface InferenceResult {
  card_title: string;
  identifier: {
    number?: string;
    set_size?: string; 
    promo_code?: string;
  };
  set_name?: string;
  first_edition?: boolean;
  confidence: number;
  inference_time_ms: number;
  model_used: string;
  raw?: any; // vendor-specific payload for debugging
}

/**
 * Inference service status information
 */
export interface InferenceStatus {
  model_loaded: boolean;
  model_name: string;
  memory_usage_mb?: number;
  cpu_usage_percent?: number;
  total_requests: number;
  average_latency_ms: number;
  error_rate: number;
  last_error?: string;
}

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

export interface VerifyOptions {
  signal?: AbortSignal;
  timeout?: number;
  skip_database_check?: boolean;
  primary_confidence?: number;
}

/**
 * Configuration options for inference
 */
export interface InferenceOptions {
  temperature?: number;
  max_tokens?: number;
  confidence_threshold?: number;
  enable_caching?: boolean;
  prompt_template?: string;
  // Apple Silicon optimizations
  model_quantization?: '8bit' | 'full'; // Model weight quantization (no KV cache for vision models)
}