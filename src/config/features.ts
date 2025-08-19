/**
 * Feature Flag System for VLM Optimization
 * 
 * Safety-first gradual rollout system for VLM integration.
 * All VLM code paths MUST check these flags before execution.
 */

export interface FeatureFlags {
  vlmEnabled: boolean;
  vlmShadowMode: boolean;
  vlmPercentage: number;
  legacyFallback: boolean;
  emergencyKillSwitch: boolean;
}

/**
 * Get feature flags from environment with safe defaults
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    // Master switch for VLM functionality (default: disabled)
    vlmEnabled: process.env.VLM_ENABLED === 'true',
    
    // Run VLM in parallel without affecting production
    vlmShadowMode: process.env.VLM_SHADOW_MODE === 'true',
    
    // Percentage of requests to use VLM (0-100)
    vlmPercentage: parseInt(process.env.VLM_PERCENTAGE || '0', 10),
    
    // Automatic fallback to OCR on VLM failure
    legacyFallback: process.env.LEGACY_FALLBACK !== 'false', // Default: true
    
    // Emergency kill switch to disable all VLM instantly
    emergencyKillSwitch: process.env.VLM_EMERGENCY_KILL === 'true'
  };
}

/**
 * Check if VLM should be used for this request
 * @param requestId - Unique request identifier for percentage rollout
 */
export function shouldUseVLM(requestId: string): boolean {
  const flags = getFeatureFlags();
  
  // Check emergency kill switch first
  if (flags.emergencyKillSwitch) {
    console.warn('[VLM] Emergency kill switch activated - using legacy OCR');
    return false;
  }
  
  // Check if VLM is enabled at all
  if (!flags.vlmEnabled) {
    return false;
  }
  
  // Check percentage rollout
  if (flags.vlmPercentage < 100) {
    // Use hash of request ID for consistent routing
    const hash = requestId.split('').reduce((acc, char) => {
      return acc + char.charCodeAt(0);
    }, 0);
    const threshold = hash % 100;
    
    if (threshold >= flags.vlmPercentage) {
      console.log(`[VLM] Request ${requestId} not selected for VLM (${threshold} >= ${flags.vlmPercentage}%)`);
      return false;
    }
  }
  
  console.log(`[VLM] Request ${requestId} will use VLM (shadow=${flags.vlmShadowMode})`);
  return true;
}

/**
 * Log feature flag status for monitoring
 */
export function logFeatureStatus(): void {
  const flags = getFeatureFlags();
  console.log('[VLM Feature Flags]', {
    enabled: flags.vlmEnabled,
    shadowMode: flags.vlmShadowMode,
    percentage: `${flags.vlmPercentage}%`,
    fallback: flags.legacyFallback,
    emergency: flags.emergencyKillSwitch
  });
}

// Export for testing
export const _testing = {
  getFeatureFlags,
  shouldUseVLM
};