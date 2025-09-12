/**
 * Operator-specific Feature Flags for CardMint UI
 * 
 * Runtime toggles for Five-Slashes functionality with kill-switch capability.
 * Per 12sep-imp-tracker.md: roiQuality, top3Ranker, nameRetrievalNorm, retryUpscale
 */

export interface OperatorFeatures {
  // ROI quality metrics display (Laplacian variance, Tenengrad)
  roiQuality: boolean;
  
  // Deterministic Top-3 ranking with diagnostics
  top3Ranker: 'v1' | 'off';
  
  // Retrieval-only name normalization for Pokemon patterns
  nameRetrievalNorm: boolean;
  
  // Retry upscale on numeric regex failure (×1.2 with Lanczos)
  retryUpscale: boolean;
  
  // ROI editor mode - 'modal' for current fullscreen, 'inline' for preview overlay
  roiEditorMode: 'modal' | 'inline';
  
  // Kill switch for emergency rollback
  emergencyDisable: boolean;
}

/**
 * Get operator feature flags from environment with safe defaults
 */
export function getOperatorFeatures(): OperatorFeatures {
  return {
    // ROI quality metrics in UI (lap_var/tenengrad warnings)
    roiQuality: process.env.CARDMINT_ROI_QUALITY !== 'false',
    
    // Top-3 ranking system ('v1' for new deterministic ranker, 'off' for baseline)
    top3Ranker: (process.env.CARDMINT_TOP3_RANKER as 'v1' | 'off') || 'v1',
    
    // Name normalization for retrieval (not storage)
    nameRetrievalNorm: process.env.CARDMINT_NAME_RETRIEVAL_NORM !== 'false',
    
    // Retry upscale on regex failure
    retryUpscale: process.env.CARDMINT_RETRY_UPSCALE !== 'false',
    
    // ROI editor mode ('modal' for current, 'inline' for preview overlay)
    roiEditorMode: (process.env.CARDMINT_ROI_EDITOR_MODE as 'modal' | 'inline') || 'modal',
    
    // Emergency kill switch to disable all new features
    emergencyDisable: process.env.CARDMINT_EMERGENCY_DISABLE === 'true'
  };
}

/**
 * Check if ROI quality metrics should be displayed
 */
export function shouldShowRoiQuality(): boolean {
  const features = getOperatorFeatures();
  if (features.emergencyDisable) return false;
  return features.roiQuality;
}

/**
 * Check if Top-3 ranking should use new algorithm
 */
export function shouldUseTop3Ranker(): 'v1' | 'off' {
  const features = getOperatorFeatures();
  if (features.emergencyDisable) return 'off';
  return features.top3Ranker;
}

/**
 * Check if retrieval-only name normalization should be used
 */
export function shouldUseNameNormalization(): boolean {
  const features = getOperatorFeatures();
  if (features.emergencyDisable) return false;
  return features.nameRetrievalNorm;
}

/**
 * Check if retry upscale should be attempted
 */
export function shouldRetryUpscale(): boolean {
  const features = getOperatorFeatures();
  if (features.emergencyDisable) return false;
  return features.retryUpscale;
}

/**
 * Get ROI editor mode with URL override support for quick testing
 */
export function getROIEditorMode(): 'modal' | 'inline' {
  // Check for URL parameter override first (for quick testing)
  if (typeof window !== 'undefined') {
    const urlParams = new URLSearchParams(window.location.search);
    const roiModeParam = urlParams.get('roiMode');
    if (roiModeParam === 'inline' || roiModeParam === 'modal') {
      return roiModeParam as 'modal' | 'inline';
    }
  }
  
  const features = getOperatorFeatures();
  if (features.emergencyDisable) return 'modal'; // Fall back to modal on emergency
  return features.roiEditorMode;
}

/**
 * Get feature status for diagnostics/logging
 */
export function getFeatureStatus(): Record<string, any> {
  const features = getOperatorFeatures();
  return {
    roiQuality: features.roiQuality,
    top3Ranker: features.top3Ranker,
    nameRetrievalNorm: features.nameRetrievalNorm,
    retryUpscale: features.retryUpscale,
    roiEditorMode: features.roiEditorMode,
    emergencyDisable: features.emergencyDisable,
    
    // Runtime environment values for debugging
    env: {
      CARDMINT_ROI_QUALITY: process.env.CARDMINT_ROI_QUALITY,
      CARDMINT_TOP3_RANKER: process.env.CARDMINT_TOP3_RANKER,
      CARDMINT_NAME_RETRIEVAL_NORM: process.env.CARDMINT_NAME_RETRIEVAL_NORM,
      CARDMINT_RETRY_UPSCALE: process.env.CARDMINT_RETRY_UPSCALE,
      CARDMINT_ROI_EDITOR_MODE: process.env.CARDMINT_ROI_EDITOR_MODE,
      CARDMINT_EMERGENCY_DISABLE: process.env.CARDMINT_EMERGENCY_DISABLE
    }
  };
}

/**
 * Log current feature flag status
 */
export function logFeatureStatus(): void {
  const status = getFeatureStatus();
  console.log('[Operator Feature Flags]', {
    roiQuality: status.roiQuality,
    top3Ranker: status.top3Ranker,
    nameRetrieval: status.nameRetrievalNorm,
    retryUpscale: status.retryUpscale,
    roiEditor: status.roiEditorMode,
    emergency: status.emergencyDisable
  });
}

// Export for testing
export const _testing = {
  getOperatorFeatures
};