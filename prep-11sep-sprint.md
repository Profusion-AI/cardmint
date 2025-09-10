Title: CardMint ROI_OCR MVP Sprint Prep (11 Sep)

Objective
- Achieve a lean, offline-first ROI_OCR MVP by 13 Sep on x86 CPU, extracting name, HP, and set_number with safe routing and schema-compliant observability artifacts.

Current State (codebase-aware)
- Pipeline/Plugins: Modular registry with lazy factories (cardmint/core/registry.py, factories.py). Preprocess light/advanced toggles present. ROI template plugin now consumes manifest-defined field ROIs and emits crops (with heuristic fallback gated off by default). PaddleOCR and OpenVINO adapters implemented with diagnostics, timeouts, and thread guards. Backend selection supports A/B with kill-switch. Retrieval (FTS + optional EmbeddingGemma) scaffolding present for diagnostics. Minimal validator and ConfidenceRouter are already wired in runners/cli.py (simple rules/thresholds). Consensus is stub (highest confidence). Observability and AJV validation flows are in place.

Blocking Gaps (must close for MVP)
- None blocking for the steel-thread. Field crops are enabled via manifest field_rois, and minimal validator/router are present. Remaining items are polish, tuning, and optional A/B.

Non‑Blocking/Optional (defer per PDF guidance)
- OpenVINO model packaging: Adapter is ready; ship as A/B treatment only if IR+meta.json available and validated. Otherwise, paddle_native is baseline.
- Consensus/ensembles and multi‑pass: Keep single‑pass with timeouts and early‑exit for MVP.
- Deep semantic embedding in hot path: Keep offline, optional; rely on rules/whitelists for MVP.
- Hardware offload (Pi/Hailo/TFLite) and ML template detector: Defer.
- Camera‑specific preproc: Use preprocess/advanced toggles; no bespoke camera driver.

MVP Goals and Deliverables (by 13 Sep)
- Enable field‑level ROIs (DONE)
  - 1a) Normalized field boxes added in data/roi_templates.json for modern_standard, neo_era, base_set.
  - 1b) ROI plugin emits crops (percent→pixels), enforces OCR_MAX_BOXES, passes np_crop with scale factors.
- Minimal validator and ConfidenceRouter (PRESENT)
  - Simple rules implemented (HP clamp to tens, set_number regex, basic name/card checks) and router gating via number_regex_ok.
- Maintain observability and schema validation
  - v3 envelope with timings/diagnostics; AJV‑valid demo artifacts; Node 20 preview parity.
- Optional: Enable OpenVINO as A/B treatment (10%) behind kill‑switch if IR is available and passes smoke; otherwise skip.

What to Stave Off for MVP (aligns with Feasibility PDF)
- ML‑based template/layout detector; multi‑pass/ensemble consensus beyond simple highest‑confidence; embedding‑heavy semantics in hot path; hardware offload; camera drivers; any cloud rerank.

Risks and Mitigations
- No crops → OCR skipped: Populate field ROIs or set allow_heuristic_field_rois=true in kiosk profile as stopgap.
- OV model not ready: Keep native baseline; retain A/B code path with kill‑switch.
- Validation gaps: Implement minimal rules; default to ask_user_top3 when regex/whitelist checks fail.
- Retrieval DB missing: Use local whitelist for validator; retrieval stays diagnostic until packaged.
- Latency creep: Enforce timeout_ms and OCR_MAX_BOXES; keep single‑pass.

Exit Criteria
- End‑to‑end run yields name, hp, set_number with diagnostics; zero schema violations. ROI path active with ≤8 crops; OCR executed; P95 ≤ 1.5s on dev x86 CPU. Router decisions logged; auto‑accepts meet thresholds and regex validity; otherwise top‑3 fallback is provided. Observability dashboard preview passes AJV validation.

Remaining TODOs (pre-13 Sep)
- Acceptance bench refresh: Run a small labeled set to produce baseline CSV with field ROIs; verify p50/p95 and router behavior.
- ROI box refinement: Tune percent boxes per template based on sample images to stabilize OCR conf and reduce false crops.
- Retrieval packaging (optional for MVP): Provide a local whitelist/DB to improve name validation beyond non-empty checks.
- OpenVINO A/B (optional): Enable only if a valid IR is present; start at ~10% split; confirm kill-switch and diagnostics.
- Observability smoke: Re-run AJV validators and dashboard preview on Node 20; confirm tiles load and deltas obey precision.
- Operator UI assessment: Review GPT‑5 addendum for Operator UI vs existing Observability scaffolding; plan minimal integration path.

Operator UI Plan (MVP, staged)
- Objective: Single-screen, offline-first UI to run the steel-thread Capture → ROI → OCR → Validate → Route → Persist.
- UI bundle (stubs staged under src/operator/):
  - operator.html: offline CSP, strict localhost-only connect, single-screen layout (canvas with ROI overlays, field cards with crops/text/conf/validation, decision panel, history + export, operator emissions).
  - styles.css: accessible palette, 4.5:1 contrast, focus states.
  - main.ts: event wiring (drop/capture), API calls to /api, draw overlays, render decision + emissions. Currently stubbed with TODOs for Claude.
- Local API (skeleton staged under src/server/operator-api.ts):
  - Endpoints: GET /api/health; POST /api/scan; POST /api/accept; GET /api/history. Current responses are 501 placeholders for Claude to fill.
  - Port 3000 (aligns with existing proxy pattern). Offline-only.
- Runner additions (to implement):
  - --operator-crops {dir}: save crops as PNG per field (name/hp/set_number).
  - --emit-json: compact JSON to stdout with rois/fields/conf/decision/timings/scan_id.
  - Accept subcommand to persist to SQLite (WAL) without re-OCR; CSV append remains as export.
- Emissions: Natural-language one-liners + copyable dev payload JSON (codes per PRD: NAME_LOW_CONF, SETNUM_REGEX_FAIL, HP_CLAMPED, NO_FIELD_ROIS, OV_FALLBACK_BASELINE, etc.).
- Acceptance & QA: 50-scan trial (p95 ≤ 1.5s; OCR p95 ≤ 150ms), 100% DB+CSV on Accept, emissions readable + actionable, offline-only ops.

Timeline (11–13 Sep)
- 11 Sep: Define normalized field ROIs (3 templates), enable crops with cap; smoke confirmed OCR runs and diagnostics show crops per field. (DONE)
- 12 Sep: Bench small labeled set; tune ROI boxes; validate artifacts and preview; prepare optional A/B if IR present.
- 13 Sep: Confirm P50/P95 and router behavior; optional A/B OpenVINO smoke; finalize artifacts and dashboard snapshot.

COB Notes (10 Sep) — Preview/Operator
- Preview build: production bundle served on 5174 via `npm run preview:operator`; page at `/operator.html`. Dev build serves at `/` from `src/operator/index.html`.
- Operator API: CORS updated to allow `http://localhost:5174`; added scan cache (memory + `tmp/scans/{scan_id}.json`) so `/api/accept` can work with `scan_id` only. Crops land at `tmp/crops/{scan_id}/{field}.png`.
- Latest scan (Blissey) emissions observed: `NAME_LOW_CONF`, `PERF_SLOW` (≈6.6s stage; total ≈13.1s shown). Cached JSON present under `tmp/scans/<scan_id>.json` with `emissions` and `timings_ms`.
- ID Unification: After `/api/scan`, the server renames the crops folder to match the Python-emitted `scan_id`, ensuring `tmp/crops/{scan_id}` aligns with `tmp/scans/{scan_id}.json` going forward.
   - Robustness: If `rename` fails (e.g., cross-device), falls back to `cp -r` + remove. Existing scans before this change may still show temp IDs; new scans will be unified.

Hot‑Dev Loop & Heads‑Up for Kyle (10 Sep)
- API server (Operator): now runs with hot‑reload via `tsx watch`. Changes under `src/server/**` auto‑restart the API; browser refresh is sufficient.
- UI (Vite): `src/operator/**` changes HMR‑reload in place. For Vite config changes, restart `dev:operator`.
- Python pipeline: each scan spawns fresh Python; changes in `cardmint/**.py` and YAML configs apply on next scan; no server restart needed.
- ROI templates (`data/roi_templates.json`): loaded by Python per scan; no restart.
- Env/ports/CORS changes: restart `dev:operator` to apply.
- Preview mode: rebuild required to test (`npm run build:operator && npm run preview:operator`). Page at `/operator.html`.
- Optional cleanup before reproducible runs: `rm -rf tmp/scans/* tmp/crops/*` (does not affect DB/CSV unless you reset those too).

10 Sep Addendum — Programmatic Snapshot Extraction (for 11 Sep consideration)
- Goal: Parse FireShot PNG (UI screenshot) or equivalent to auto‑collect evidence (badges, emissions, fields, timings) for QA.
- Primary approach (recommended, no OCR):
  - Source of truth = server cache `tmp/scans/<scan_id>.json` created by `/api/scan`.
  - Implement a tiny script to map recent files under `tmp/scans/` → emit `{scan_id, fields, conf, decision, emissions, timings_ms}` to `out/ui_snapshots.jsonl`.
- Optional fallback (image‑only):
  - Node `tesseract.js` or Python `pytesseract` pipeline to OCR key regions from the screenshot (badges row, decision chip, field outputs).
  - Scope for MVP: parse emissions chips and total‑ms badge; defer field‑value OCR unless needed.
- Success criteria:
  - On dev machines, running `npm run snapshot:collect` writes structured JSON from last N scans, zero external deps, offline.
  - If only a screenshot is available, `snapshot:ocr` extracts at least emissions[] and total_ms from the PNG.
- Notes:
  - Prefer cached JSON for accuracy and speed; image OCR is a fallback only.
  - Keep outputs under `out/` (JSONL) to align with existing CSV/JSONL artifacts.

11 Sep AM Checkpoints
- Smoke: `/api/health`, `/api/scan` → JSON present, crops saved; `/api/accept` persists to SQLite (WAL), CSV, JSONL; `/api/history` returns last 10.
- Verify CORS for 5174 and absolute API URLs work in dev and preview.
- Confirm cache merge on Accept works when UI sends only `{scan_id}`.
- Validate latest scan emissions/timings against targets; record p50/p95 locally.
- Optional: consider persistent Python worker to cut E2E latency; defer implementation decision to PM.

Role‑Targeted Notes
- CTO: Approve scope (x86 CPU baseline, offline‑first). Decide OV IR inclusion (A/B) based on availability. Confirm auto‑accept thresholds and router behavior.
- CEO: Align on user experience for ask_user_top3; accept deferral of hardware offload and ML classifier; focus on reliability and timing.
- External QA: Validate ROI crops exist/≤cap; schema compliance; offline guards; Node 20 parity; stage timings and router decisions recorded.

Plan for Claude – Next Deliverables
- Task 1a: Add minimal, normalized field ROIs (name, hp, set_number, card_number) to data/roi_templates.json for modern_standard, neo_era, base_set.
- Task 1b: Ensure ROI plugin emits crops: convert percent→pixel boxes, populate ROI.np_crop, apply OCR_MAX_BOXES cap, and include scale_w/scale_h.
- Task 2: Implement minimal validator (rules above) and wire in runners/cli.py Stage 4.
- Task 3: Wire ConfidenceRouter with strict auto‑accept and top‑3 fallback; plumb retrieval candidates where available.
- Task 4 (optional): If IR path present, enable OpenVINO as A/B treatment with kill‑switch; otherwise keep native.
