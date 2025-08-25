# CardMint Deprecation Tracker

This file is the single source of truth for what's being quarantined, why, and when it's safe to delete.
Anything under `legacy/` must **not** be imported from `src/`. CI enforces this.

## Status Legend
- **Quarantine**: moved to `legacy/`, forbidden from runtime.
- **Pending**: slated for removal when replacement is live.
- **Removed**: deleted; historical reference in Git.

## Current Items

| File (original path) | Reason | Replacement/Plan | Owner | Status | Drop by |
|---|---|---|---|---|---|
| src/ml/model_manager_intel.py | Intel IPEX optimizations (experimental) | LMStudio-only path for now; future ONNX as fallback | CC | Quarantine | 2025-09-15 |
| src/ml/smolvlm_optimized_service.py | ONNX/optimization experiments | Same as above | CC | Quarantine | 2025-09-15 |
| src/processing/ImageProcessor.ts (placeholder methods) | OpenCV TODOs, partial impl | `adapters/opencv/OpenCvImageProcessor.ts` | CC | Quarantine | 2025-09-01 |

## Rules
- No imports from `legacy/**` into `src/**`. ESLint + CI will fail the build.
- No "TODO/PLACEHOLDER/NOT IMPLEMENTED" in `src/**` runtime code.
- All critical paths must route through **ports** (`src/core/**`) and **adapters** (`src/adapters/**`).

## Review Cadence
- Weekly review in PR: "Deprecation Sweep YYYY‑MM‑DD."

---

**Last Updated**: August 25, 2025  
**Architecture Version**: 2.0.0-cleanup