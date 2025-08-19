#!/usr/bin/env python3
"""
Feature flag system for Python components.
Mirrors the TypeScript implementation for consistency.
"""

import os
import hashlib
from typing import Dict, Any

def get_feature_flags() -> Dict[str, Any]:
    """
    Get current feature flags from environment variables.
    
    Returns:
        Dict with feature flag settings
    """
    return {
        "vlmEnabled": os.getenv("VLM_ENABLED", "false").lower() == "true",
        "vlmShadowMode": os.getenv("VLM_SHADOW_MODE", "false").lower() == "true",
        "vlmPercentage": int(os.getenv("VLM_PERCENTAGE", "0")),
        "legacyFallback": os.getenv("LEGACY_FALLBACK", "true").lower() == "true",
        "emergencyKillSwitch": os.getenv("EMERGENCY_KILL_SWITCH", "false").lower() == "true"
    }

def should_use_vlm(request_id: str) -> bool:
    """
    Determine if VLM should be used for this request based on rollout percentage.
    
    Args:
        request_id: Unique request identifier
        
    Returns:
        True if VLM should be used
    """
    flags = get_feature_flags()
    
    # Check emergency kill switch
    if flags["emergencyKillSwitch"]:
        return False
    
    # Check if VLM is enabled
    if not flags["vlmEnabled"]:
        return False
    
    # Shadow mode runs VLM but doesn't use it for primary processing
    if flags["vlmShadowMode"]:
        return False
    
    # Percentage rollout
    percentage = flags["vlmPercentage"]
    if percentage <= 0:
        return False
    if percentage >= 100:
        return True
    
    # Hash-based percentage rollout for consistent assignment
    hash_value = int(hashlib.md5(request_id.encode()).hexdigest(), 16)
    return (hash_value % 100) < percentage

def log_feature_status():
    """Log current feature flag status."""
    flags = get_feature_flags()
    
    print("=== VLM Feature Flags ===")
    print(f"VLM Enabled: {flags['vlmEnabled']}")
    print(f"Shadow Mode: {flags['vlmShadowMode']}")
    print(f"Rollout Percentage: {flags['vlmPercentage']}%")
    print(f"Legacy Fallback: {flags['legacyFallback']}")
    print(f"Emergency Kill Switch: {flags['emergencyKillSwitch']}")
    
    if flags["emergencyKillSwitch"]:
        print("\n⚠️  EMERGENCY KILL SWITCH ACTIVATED - VLM DISABLED")
    elif flags["vlmShadowMode"]:
        print("\n🔬 SHADOW MODE - VLM running in parallel for testing")
    elif flags["vlmEnabled"]:
        print(f"\n✅ VLM ACTIVE - {flags['vlmPercentage']}% of traffic")
    else:
        print("\n❌ VLM DISABLED - Using legacy OCR")

if __name__ == "__main__":
    log_feature_status()