#Codex-CTO

# Separation of Concerns Charter

This document restates the architecture boundaries for CardMint and how the Local‑First work must fit within them.

## Layering & Imports
- `core/`: Pure domain logic; no imports from `adapters/` or `app/`.
- `adapters/`: Platform and IO specifics (camera, FS, network). Wire only from `app/wiring.ts`.
- `services/`: Stateless or state‑light application services (matching, pricing, DB read helpers).
- `worker/`: Queue consumers, ETL, precompute jobs, long‑running work. No hot‑loop logic.
- `api/` and `dashboard/`: Presentation; no direct DB access—call services.

Enforcement: Use dependency‑cruiser rules already present; new modules must keep imports within their layer.

## Data & Performance Rules
- No network/DB writes in the capture loop; target ~400ms/photo.
- Heavy work (hashing, OCR, joins) runs async in workers with retries/backoff.
- Use `DATA_ROOT=./data`; all datasets/DBs are read‑only for recognition paths.
- Cache precomputes under `LOCAL_CACHE_DIR` with versioned keys; avoid recomputation.

## Local‑First Placement
- LocalMatchingService → `src/services/local-matching/`
- PriceChartingLookupService → `src/services/valuation/`
- DatabaseQueryService (read‑only) → `src/services/db/`
- Precompute jobs → `src/worker/jobs/`
- Pipeline integration (Local‑First stage) → `src/worker/verification/`

## Configuration & Flags
- Flags live in `.env` and are read via the app config module.
- Rollout modes: `LOCAL_MODE=local-only | hybrid | ml-only` (default: `hybrid`).
- Confidence threshold via `LOCAL_MATCH_MIN_CONF`.

## Observability
- Structured logs with timings, confidence, and chosen path.
- Metrics for success/fallback ratios and latencies.

## Testing
- Unit tests beside services; integration tests under `src/test/` with curated samples.
- No reliance on full dataset for tests; use small fixtures.

