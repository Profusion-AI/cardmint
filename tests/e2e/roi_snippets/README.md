# ROI Testing Snippets Directory

This directory contains ROI (Region of Interest) testing artifacts generated during development and debugging.

## Purpose
- Store ROI detection debug images and crops
- Keep spatial field detection test outputs
- Isolate ROI-specific test data from golden baseline

## Structure
```
roi_snippets/
├── debug_images/     # Annotated images showing ROI detection results
├── field_crops/      # Individual field region extractions
├── test_outputs/     # Raw ROI processing results (JSON)
└── benchmarks/       # Performance and accuracy measurements
```

## Usage
ROI testing code should dump artifacts here instead of polluting the golden baseline directory. This keeps the golden dataset clean for production accuracy testing while allowing ROI development iteration.

## Cleanup
This directory is automatically cleaned by `development-reset.sh` to prevent accumulation of stale debug data.