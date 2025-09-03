#Codex-CTO

# Data Environment Prep (Local‑First)

This brief aligns the codebase on a Local‑First data strategy so Claude can implement tactical changes quickly without blocking on cloud ML/OCR.

## Context
- We intentionally retired the previous data directory by appending "-deprecated" and restored a new data directory from `data.zip`.
- The repo briefly flagged a missing `data/` directory; this is resolved. `./data` now symlinks to the extracted dataset at `./data_unzipped/data`.
- Goal: materially enhance local card‑scanning to reduce reliance on the Mac ML/OCR pipeline and potentially deprecate it later if local performance is sufficient.

## Status Snapshot
- Data root: `./data` (symlink)
- Sizes: `cache` ≈ 9.3G, `pokemon_dataset` ≈ 5.8G, `node_modules` ≈ 44M
- Key files: `pricecharting_pokemon.csv` (10MB), `pokemon_lexicon.json`, `canonical.db`, `pokemon_cards.db`, `card_database.sqlite`
- Assets: `assets/reference_images`, `assets/set_icons`, `assets/roi_templates`
- Note: `sqlite3` CLI isn’t installed; use Node libs (`sqlite3` or `better-sqlite3`).

## Objectives
- Establish Local‑First matching in workers before ML fallback.
- Preserve capture loop latency (~400ms) by keeping heavy work off the hot path.
- Provide offline enrichment via CSV/SQLite to improve confidence and pricing.
- Add observability around match confidence and decision flow (Local vs ML).

## Acceptance Criteria
- Capture path remains ~400ms/photo; no network/DB writes in the loop.
- Local‑First matching succeeds on curated samples with clear thresholds.
- ML pipeline remains available as a fallback under a feature flag.
- Structured logs show timings, confidence, and chosen path.

## Action Plan (for Claude)
1) Config & Flags
   - Read `DATA_ROOT=./data` and feature flags from `.env`.
   - Add `LOCAL_FIRST_MATCH=true` and `LOCAL_MATCH_MIN_CONF=0.85`.
   - Use `LOCAL_CACHE_DIR=./data/cache/local` for precompute artifacts.

2) Data Plumbing
   - Ensure all consumers read from `./data` (not `data-deprecated`).
   - Access CSV at `./data/pricecharting_pokemon.csv`.
   - Open SQLite files in read‑only mode using Node libs.

3) Local Matching Pipeline
   - Precompute perceptual hashes (pHash/aHash) for `pokemon_dataset/images` with a versioned index in `canonical.db` or a new lightweight table; cache under `LOCAL_CACHE_DIR`.
   - Candidate shortlist via image hash similarity, then refine with:
     - ROI/text cues (from `assets/roi_templates`).
     - Set icon match (from `assets/set_icons`).
   - Produce a confidence score; if `< LOCAL_MATCH_MIN_CONF`, enqueue ML fallback.

4) Pricing & Metadata
   - Load `pricecharting_pokemon.csv` and normalize keys (set, number, variant) for join with canonical records.
   - Provide a lookup helper: `lookupPrice(cardKey) -> {loose, cib, new, graded}`.

5) Observability
   - Structured logs for: shortlist time, refinement time, final confidence, fallback path.
   - Emit metrics counters: `local_match.success`, `local_match.fallback_ml`.

6) Safety & Performance
   - Do not block the capture loop; run matching in workers/queues.
   - Batch/cap expensive operations; reuse caches; avoid synchronous disk IO in hot paths.

## Data Artifacts (reference)
- CSV headers: `id,console-name,product-name,loose-price,cib-price,new-price,graded-price,...,release-date`.
- SQLite files: `canonical.db` (+ `-shm`, `-wal`), `pokemon_cards.db`, `card_database.sqlite`.

## Operational Notes
- macOS metadata (`__MACOSX`, `.DS_Store`) cleaned during extraction.
- If direct CLI schema inspection is needed, install `sqlite3` or rely on Node packages.
- Prefer async workers for ETL/precompute; write to `LOCAL_CACHE_DIR`.

## Next Steps
- Implement the Local‑First worker step and feature flag wiring.
- Add precompute job (one‑time + incremental updates) to generate hashes and indexes.
- Integrate price lookups and expose an API to the dashboard for local‑only valuations.

