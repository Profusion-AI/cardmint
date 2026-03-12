# Execution Tracker — CardMint Search (Claude Handoff)

Date: 2026-02-06  
Owner: Kyle (Product), Claude (Implementation), Codex (QA Gate)  
Source PRD: `docs/february/cardmint-search-hybrid-scorecard-prd.md`  
Rule: Use complexity stars only. No time estimates.

## Execution Reference

- Default Internal MVP framework: `docs/february/cardmint-search-internal-mvp-framework.md`
- Use this tracker for chunk execution + handoff packets; use the framework doc for Goal -> Objective -> KPI mapping, Internal MVP exit criteria, and `/api/search` business logic sequence.

## Purpose

- Keep CardMint Search execution in 3-issue chunks.
- Standardize Claude handoff packets for Codex QA.
- Enforce staged go/no-go gates (Internal GA -> Trusted Alpha -> Public Beta).

## Decision Lock

- Product split is mandatory:
1. Operator Truth Engine (internal correctness first)
2. Public Search Experience (external only after quality gates)
- TCGCSV is a baseline/reference feed, not final live listing authority.

## Working Rules

- Default workflow: 3 issues per chunk.
- `★★★★☆` and `★★★★★` items require Codex GREEN before advancing.
- Any stop-the-line condition pauses work immediately.
- No unapproved scope expansion inside a chunk.

## Current Stage Board

- Current stage: `A → B transition` (Internal Dev → Internal Operator GA)
- Stage status: `IN PROGRESS` — Stage A complete; corpus expansion Phase 1 deployed; Stage B baselines pending
- Last Codex decision: `GREEN` (Phase 1 corpus expansion, 2026-03-12)

### Stage A Closeout Summary

All Stage A chunks complete with Codex GREEN:

| Chunk | Scope | Codex Decision | Tests | Eval |
|---|---|---|---|---|
| 1 — Truth Engine Hardening | Dedup + normalization parity + regression tests | **GREEN** | 145 pass | 7/7 GREEN |
| 2 — Search Contract + Transparency | Response schema + UI labeling + disambiguation | **GREEN** (YELLOW → fixed) | 145 pass | 7/7 GREEN |
| 3 — Hybrid Retrieval Expansion | Vector index + tier policy + telemetry | **GREEN** (YELLOW → fixed) | 145 pass | 7/7 GREEN |

### Post–Stage A: Corpus Expansion (March 2026)

Work tracked in `docs/11mar-search-corpus-expansion-plan.md`. Executed against `feat/search-app-stage-a`, deployed as `prod-2026-03-12a`.

| Phase | Scope | Codex Decision | Tests | Deploy |
|---|---|---|---|---|
| Phase 1 — Reference Fallback | ReferenceAdapter → tcg_rows; health probe; source badges; catalog confirmation gate | **GREEN** (YELLOW → fixed) | 163 pass | `prod-2026-03-12a` ✅ |
| Phase 2 — tcg_search_corpus + FTS5 | Purpose-built corpus, snapshot rebuild hook | **PENDING** | — | — |
| Phase 3 — CSV upload → corpus refresh | Stream-safe ingest, auto-rebuild on upload | **PENDING** | — | — |

### Stage B Prerequisites (before advancing to Operator GA)

1. ~~Inventory adapter `freshness: null` must be resolved~~ **DONE** (2026-02-09) — `toCandidate()` now returns ISO-8601 from `products.updated_at`
2. Production deployment of search app with real inventory data
3. Inventory checksum parity metric needs live measurement
4. Daily ingest success, price freshness, and search availability metrics need production baselines

### Stage B Baseline Collection Runbook

Prerequisites #2–#4 require live observation, not code changes. Steps:

1. **Deploy search app to prod** with `SEARCH_APP_RELEASE_STAGE=internal_ga`, real `SEARCH_APP_API_KEY`, and `SEARCH_APP_INVENTORY_DB_PATH` pointing at `cardmint_prod.db`.
2. **Inventory checksum parity** — After first prod ingest, run: `SELECT COUNT(*), SUM(market_price) FROM products WHERE total_quantity > 0` against both staging and prod DBs. Record delta. Gate: exact parity or <=0.5% mismatch.
3. **Price freshness** — Query `SELECT MIN(updated_at), MAX(updated_at) FROM products WHERE market_price IS NOT NULL` on prod. Confirm max freshness <=36h for external reference data. Internal truth freshness tracks operator workflow cadence.
4. **Daily ingest success** — Monitor for 3+ consecutive days. Record success/failure in this tracker. Gate: >=99%.
5. **Search availability** — Monitor `/health` endpoint uptime over 72h window. Gate: >=99.5%.
6. After baselines collected, submit Stage B gate review to Codex.

## Chunk Tracker

### Chunk 1 — Truth Engine Hardening (`★★★★☆`)

Scope:

1. Fix progress duplicate inflation (`COUNT(DISTINCT ...)` semantics)
2. Symmetric collector number normalization (`X` and `X/Y`)
3. Regression tests for duplicate rows + number parity

Status:

- [x] Issue 1 complete — `dedupCandidates()` in searchPipeline.ts deduplicates by card identity key (cardName + setName + normalizedCollectorNo + conditionBucket), keeping highest-confidence representative. Prevents duplicate product rows from inflating candidate lists.
- [x] Issue 2 complete — `normalizeCollectorNo()` + `normalize_cno` UDF already handle symmetric X/X+Y normalization. Added normalization parity eval metric (10 query pairs, 100% parity).
- [x] Issue 3 complete — Added 7 regression tests: dedup same-condition duplicates, preserve condition variety, keep highest-priced representative, no inflation on name-only queries, X vs X/Y parity, leading-zero parity, prefixed collector# parity. Added duplicate stability eval metric (6 queries, 0% variance).
- [x] Claude handoff packet submitted
- [x] Codex QA result recorded — **GREEN** (Approved)

### Chunk 2 — Search Contract + Transparency (`★★★☆☆`)

Scope:

1. Search response schema with confidence + source + freshness
2. UI labeling: "reference aggregate" for non-live prices
3. Low-confidence disambiguation path

Status:

- [x] Issue 1 complete
- [x] Issue 2 complete
- [x] Issue 3 complete
- [x] Claude handoff packet submitted
- [x] Codex QA result recorded — **YELLOW** then **GREEN** (Request changes → Approved after fixes)

Codex QA Round 1: **YELLOW** — Request changes

Action items resolved:
1. **Legacy mixed-source contract (P3):** Added single-source filter guard in `searchService.ts` + 2 regression tests
2. **UI labeling scope gap:** Delivered `src/ui/search-result-preview.html` — zero-dependency static HTML/CSS/JS with source badges for `internal_truth` and `reference_aggregate`
3. **Inventory freshness follow-up:** Tracked below for Stage B prerequisite

Codex QA Round 2: **GREEN** — Approved. All action items verified.

~~Stage B prerequisite: Inventory adapter freshness was null.~~ **RESOLVED** (2026-02-09) — `toCandidate()` now returns ISO-8601 from `products.updated_at`. See prerequisite #1 above.

### Chunk 3 — Hybrid Retrieval Expansion (`★★★★☆`)

Scope:

1. Optional local vector index path
2. Device-tier inference policy and fallback
3. Telemetry + scorecard report endpoint

Status:

- [x] Issue 1 complete — `VectorAdapter` interface + `TfIdfVectorAdapter` implementation (zero-dep TF-IDF cosine similarity). Wired into pipeline as optional reranking step. `SEARCH_APP_VECTOR_ENABLED` env var for opt-in. 6 tests.
- [x] Issue 2 complete — `deviceTier.ts`: tier detection from system memory (tier0/tier1/tier2), latency budget caps per tier, model class allowlists, fallback cascade. `SEARCH_APP_DEVICE_TIER` env var for explicit override or auto-detect. 17 tests.
- [x] Issue 3 complete — `QueryTelemetry` ring buffer records per-query metrics (latency, confidence bucket, retrieval path, source). `generateScorecard()` produces live report from telemetry. `GET /api/scorecard` endpoint. `GET /health` now includes tier + telemetry stats. 16 tests.
- [x] Claude handoff packet submitted
- [x] Codex QA result recorded — **YELLOW** then **GREEN** (Request changes → Approved after fixes)

Codex QA Round 1: **YELLOW** — Request changes

Action items resolved:
1. **[P2] Vector adapter not wired from runtime config:** `server.ts` now constructs `TfIdfVectorAdapter` and attaches to `pipelineOptions.vectorAdapter` when `SEARCH_APP_VECTOR_ENABLED=true` AND tier policy allows vector search. `/health` exposes `vectorAdapterActive` boolean.
2. **[P2] Retrieval path telemetry inaccurate:** `InventoryAdapter.search()` now returns `AdapterSearchResult { candidates, retrievalPath }` with real path (`deterministic`/`fts`/`like`). Pipeline threads path into `SearchResult.retrievalPath` (`fallback` for reference, `degraded` for no adapters). Server telemetry reads `result.retrievalPath` instead of hardcoded proxy. 3 new adapter-level tests + `RetrievalPath` type in `types.ts`.
3. **[P3] Scorecard correction rate not window-scoped:** Added `getRecentCorrections(windowMs)` to `QueryTelemetry`. `generateScorecard()` now uses window-filtered corrections. 2 new tests (telemetry window filter + scorecard window-scoped rate).

Codex QA Round 2: **GREEN** — Approved. All 3 action items verified in code and reproduced via gates (145/145 tests, 7/7 eval GREEN).

Residual non-blocking: Correction rate can show `100%` when `totalQueries=0` if correction events exist in-window (`scorecardReport.ts:77`). Minor, does not block approval.

## Scorecard Capture Sheet (per chunk)

Update all fields touched by the chunk. Mark `N/A` if not applicable.

| Metric | Target (GREEN) | Latest | Evidence path | Status |
|---|---|---|---|---|
| Inventory checksum parity | Exact parity | | | |
| Progress match stability | <=0.5% variance | 0.00% variance | `cardmint-search-app/eval/artifacts/duplicate-stability.json` | GREEN |
| Card-number normalization parity | >=99.5% | 100.00% | `cardmint-search-app/eval/artifacts/normalization-parity.json` | GREEN |
| Wrong-set rate Top-1 | <=1.0% | 0.00% | `cardmint-search-app/eval/artifacts/wrong-set-rate.json` | GREEN |
| High-confidence precision | >=97% | 100.00% | `cardmint-search-app/eval/artifacts/high-confidence-precision.json` | GREEN |
| Price source transparency | 100% labeled | 100.00% | `cardmint-search-app/eval/artifacts/source-transparency.json` | GREEN |
| Operator search API p95 | <=350ms | 1.92ms | `cardmint-search-app/eval/artifacts/api-latency-p95.json` | GREEN |
| Operator progress API p95 | <=500ms | N/A | | N/A |
| Index query p95 local | <=150ms | 0.42ms (pipeline synthetic) | `cardmint-search-app/eval/artifacts/pipeline-latency-p95.json` | GREEN |
| Tier 1 inference p95 | <=3.0s | Policy defined, no live inference yet | `src/policy/deviceTier.ts` | N/A |
| Tier 2 inference p95 | <=2.0s | Policy defined, no live inference yet | `src/policy/deviceTier.ts` | N/A |
| Daily ingest success | >=99% | | | |
| Price freshness | <=36h | | | |
| Search availability | >=99.5% | | | |
| Operator manual correction rate | <=2% | Tracking enabled via `/api/scorecard` | `src/telemetry/queryTelemetry.ts` | N/A |
| Decision-time reduction | >=30% | | | |

## Claude Handoff Packet (required each chunk)

Copy/paste and fill:

```markdown
## Claude Handoff: [Chunk ID / Name]

**Complexity:** [★☆☆☆☆-★★★★★]  
**Change type:** [Production-critical / Non-critical]  
**Scope completed (3 issues):**
1. ...
2. ...
3. ...

**Files changed:**
- `path/to/file`

**Business intent:**
- Operator pain point solved: ...
- User trust impact: ...

**Definition of Done summary:**
- What changed: ...
- What was verified: ...
- What remains out of scope: ...

**Verification evidence:**
- Command: `...`
- Result summary: ...

**Scorecard updates:**
- Metric: ...
- Value: ...
- Evidence: `path/to/artifact`

**Security/guardrail check:**
- Stop-the-line triggered? [No/Yes]
- If deferred concern exists: [SEC-###]

**Rollback plan:**
1. Revert files/flag: ...
2. Data rollback (if any): ...
3. Validation after rollback: ...

**Open questions for Codex/Kyle:**
1. ...
```

## Codex QA Output Block (required each chunk)

Copy/paste and fill:

```markdown
## Codex Review: [GREEN/YELLOW/RED]

**Scope:** ...
**Change type:** ...
**Complexity:** ...

**Gates:**
- [ ] Scorecard targets for touched metrics: [PASS/FAIL]
- [ ] QA reproducible evidence: [PASS/FAIL]
- [ ] Rollback plan clear and tested conceptually: [PASS/FAIL]
- [ ] ≤3-file mindset respected for critical-risk paths: [PASS/FAIL/NA]

**Security:** [CLEAR / SEC-###]
**Business alignment:** ...
**Decision:** [Approve / Request changes / Reject]

**Action items (if YELLOW/RED):**
1. ...
2. ...
```

## Claude Handoff: Chunk 1 / Truth Engine Hardening

**Complexity:** ★★★★☆
**Change type:** Non-critical (internal correctness hardening)
**Scope completed (3 issues):**
1. Candidate dedup by card identity key — `dedupCandidates()` in searchPipeline.ts prevents duplicate product rows from inflating candidate lists. Dedup key: (cardName, setName, normalizedCollectorNo, conditionBucket). Keeps highest-confidence/highest-price representative.
2. Normalization parity eval — added 10-pair normalization parity metric to eval (X vs X/Y queries). 100% parity confirmed. Added duplicate stability metric (6 queries, 0% variance under 5x duplicate replay).
3. Regression tests — 7 new tests: dedup consolidation, condition variety preservation, price tiebreaking, inflation prevention, X/X+Y resolution parity, leading-zero parity, prefixed collector# parity.

**Files changed:**
- `cardmint-search-app/src/retrieval/searchPipeline.ts` — added `dedupCandidates()` export, wired into `buildResult()`
- `cardmint-search-app/tests/fixtures/seedInventory.ts` — added 3 duplicate product rows for testing
- `cardmint-search-app/tests/retrieval/searchPipeline.test.ts` — added 7 regression tests (dedup + normalization parity)
- `cardmint-search-app/eval/runEval.ts` — added normalization_parity and duplicate_stability eval metrics

**Business intent:**
- Operator pain point solved: duplicate physical cards (same SKU, different copies) no longer inflate search candidate lists, improving result quality
- User trust impact: normalization parity ensures users get identical results regardless of collector number format (X vs X/Y)

**Definition of Done summary:**
- What changed: dedup logic in pipeline, eval metrics for parity + stability, regression tests
- What was verified: 140 tests pass (12 files), 7 eval metrics all GREEN
- What remains out of scope: inventory checksum parity (requires production data), progress API endpoint (separate system)

**Verification evidence:**
- Command: `npm run typecheck && npm test && npm run eval`
- Result summary: typecheck clean, 140/140 tests pass, 7/7 eval metrics GREEN

**Scorecard updates:**
- Progress match stability: 0.00% variance → GREEN (`eval/artifacts/duplicate-stability.json`)
- Card-number normalization parity: 100.00% → GREEN (`eval/artifacts/normalization-parity.json`)

**Security/guardrail check:**
- Stop-the-line triggered? No
- No new auth surfaces, no secrets, no PII changes

**Rollback plan:**
1. Revert `searchPipeline.ts` to remove `dedupCandidates()` and restore `buildResult()` to use `scored` directly
2. No data changes — all in-memory
3. Run `npm test && npm run eval` to validate rollback

**Open questions for Codex/Kyle:**
1. The main backend's `tcgProgressService.ts` already has `COUNT(DISTINCT tr.sku_key)` for its progress matching — should we add a cross-system parity test that verifies the search app and main backend agree?

## Codex Review: Chunk 1 — GREEN

**Scope:** Truth Engine Hardening (dedup + normalization parity + regression tests)
**Change type:** Non-critical (internal correctness hardening)
**Complexity:** ★★★★☆

**Gates:**
- [x] Scorecard targets for touched metrics: PASS (stability 0.00%, parity 100.00%)
- [x] QA reproducible evidence: PASS (typecheck clean, 145/145 tests, 7/7 eval GREEN)
- [x] Rollback plan clear and tested conceptually: PASS
- [x] ≤3-file mindset respected for critical-risk paths: NA (non-critical)

**Security:** CLEAR
**Business alignment:** Dedup prevents duplicate inflation; normalization parity ensures consistent results regardless of collector number format
**Decision:** Approve

---

## Claude Handoff: Chunk 3 / Hybrid Retrieval Expansion

**Complexity:** ★★★★☆
**Change type:** Non-critical (capability expansion, all opt-in)
**Scope completed (3 issues):**
1. Optional vector index path — `VectorAdapter` interface + `TfIdfVectorAdapter` (TF-IDF cosine similarity, zero external deps). Wired into pipeline as optional reranking before confidence scoring. `SEARCH_APP_VECTOR_ENABLED=true` to opt in.
2. Device-tier inference policy — `deviceTier.ts`: auto-detect from system memory or explicit `SEARCH_APP_DEVICE_TIER=tier0|tier1|tier2`. Tier policies define latency budgets (500ms/3s/2s), allowed model classes, vector/image search enablement, fallback cascade.
3. Telemetry + scorecard endpoint — `QueryTelemetry` ring buffer (1000 entries). Records per-query: latency, confidence bucket, retrieval path, source, candidate count. `GET /api/scorecard` returns live scorecard report. Correction event tracking stub for future operator correction flow.

**Files changed:**
- `cardmint-search-app/src/retrieval/vectorAdapter.ts` — NEW: VectorAdapter interface + TfIdfVectorAdapter
- `cardmint-search-app/src/retrieval/searchPipeline.ts` — wired optional vectorAdapter into pipeline, threads `retrievalPath` from adapter through `buildResult`
- `cardmint-search-app/src/retrieval/types.ts` — added `RetrievalPath` type, `AdapterSearchResult` interface, `retrievalPath` field on `SearchResult`
- `cardmint-search-app/src/retrieval/inventoryAdapter.ts` — `search()` now returns `AdapterSearchResult` with real `retrievalPath` (deterministic/fts/like)
- `cardmint-search-app/src/search/searchService.ts` — added `retrievalPath` to `SearchResponse`, legacy path sets `"degraded"`
- `cardmint-search-app/src/policy/deviceTier.ts` — NEW: tier detection, policy, fallback chain
- `cardmint-search-app/src/telemetry/queryTelemetry.ts` — NEW: ring buffer telemetry recording, added `getRecentCorrections(windowMs)` for window-scoped corrections
- `cardmint-search-app/src/telemetry/scorecardReport.ts` — NEW: scorecard generation from telemetry, uses window-filtered corrections
- `cardmint-search-app/src/server.ts` — added `/api/scorecard`, telemetry uses `result.retrievalPath`, vector adapter wired when config+tier allow, `/health` shows `vectorAdapterActive`
- `cardmint-search-app/src/config/env.ts` — added `SEARCH_APP_DEVICE_TIER`, `SEARCH_APP_VECTOR_ENABLED`
- `cardmint-search-app/tests/retrieval/vectorAdapter.test.ts` — NEW: 6 tests
- `cardmint-search-app/tests/retrieval/inventoryAdapter.test.ts` — updated for `AdapterSearchResult` return type, added 3 retrievalPath reporting tests
- `cardmint-search-app/tests/policy/deviceTier.test.ts` — NEW: 17 tests
- `cardmint-search-app/tests/telemetry/queryTelemetry.test.ts` — NEW: 10 tests (9 original + 1 `getRecentCorrections` window test)
- `cardmint-search-app/tests/telemetry/scorecardReport.test.ts` — NEW: 8 tests (7 original + 1 window-scoped correction rate test)

**Business intent:**
- Operator pain point solved: live scorecard endpoint enables real-time quality monitoring without running offline eval
- User trust impact: device tier policy ensures edge inference respects memory/latency budgets, vector reranking improves result relevance
- Future readiness: VectorAdapter interface scaffolds LanceDB or external embedding backend without pipeline changes

**Definition of Done summary:**
- What changed: 4 new source modules, 4 new test files, server + env + pipeline + types + adapters + searchService updated
- What was verified: 145 tests pass (12 files), 7 eval metrics all GREEN, typecheck clean
- YELLOW action items resolved: vector adapter end-to-end wiring, real retrieval path telemetry, window-scoped correction rate
- What remains out of scope: LanceDB integration (no external deps added), live VLM inference, daily ingest pipeline, production deployment

**Verification evidence:**
- Command: `npm run typecheck && npm test && npm run eval`
- Result summary: typecheck clean, 145/145 tests pass, 7/7 eval metrics GREEN

**Scorecard updates:**
- Index query p95 local: 0.41ms (pipeline synthetic) → GREEN
- API latency p95: 1.30ms → GREEN
- Tier 1/2 inference: policy defined, no live inference measurement yet → N/A

**Security/guardrail check:**
- Stop-the-line triggered? No
- `/api/scorecard` is behind existing auth middleware (requires `x-search-api-key` when auth is enabled)
- No new secrets, no PII, telemetry stores query text only in ring buffer (bounded, in-memory)

**Rollback plan:**
1. Revert server.ts, env.ts, searchPipeline.ts to remove vector/tier/telemetry integration
2. New files (vectorAdapter.ts, deviceTier.ts, queryTelemetry.ts, scorecardReport.ts) can be deleted without side effects
3. Run `npm test && npm run eval` to validate rollback

**Open questions for Codex/Kyle:**
1. Should `/api/scorecard` be accessible without auth for monitoring tools, or keep it behind the API key?
2. TF-IDF vector adapter is a scaffold — when should we evaluate LanceDB integration (Stage B prerequisite or defer to Stage C)?

## Codex Review: Chunk 3 — GREEN (Round 2)

**Scope:** Hybrid Retrieval Expansion (vector index + tier policy + telemetry)
**Change type:** Non-critical (capability expansion, all opt-in)
**Complexity:** ★★★★☆

**Round 1 (YELLOW):**
- [P2] Vector adapter not wired from runtime config
- [P2] Retrieval path telemetry inaccurate (hardcoded proxy)
- [P3] Scorecard correction rate not window-scoped

**Round 2 (GREEN) — All 3 action items verified:**

**Gates:**
- [x] Scorecard targets for touched metrics: PASS (API p95 1.92ms, pipeline p95 0.42ms)
- [x] QA reproducible evidence: PASS (typecheck clean, 145/145 tests, 7/7 eval GREEN)
- [x] Rollback plan clear and tested conceptually: PASS
- [x] ≤3-file mindset respected for critical-risk paths: NA (non-critical, all opt-in)

**Code paths verified:**
- Vector wiring: `server.ts:35,38,73`
- Retrieval path threading: `inventoryAdapter.ts:47`, `searchPipeline.ts:48,60`, `server.ts:115`
- Window-scoped corrections: `queryTelemetry.ts:72`, `scorecardReport.ts:61`

**Security:** CLEAR
**Business alignment:** Live scorecard, runtime-gated vector search, accurate telemetry for quality monitoring
**Decision:** Approve

**Residual non-blocking:**
- Correction rate edge case when `totalQueries=0` (`scorecardReport.ts:77`). Minor.

---

## Minimal Verification Commands

Run only what applies to changed surfaces:

- Backend TS sanity: `npx tsc -p apps/backend/tsconfig.json --noEmit`
- Targeted tests: `npm --prefix apps/backend exec vitest run src/services/tcgAnalytics/tcgProgressService.test.ts src/services/tcgAnalytics/tcgDeltaService.test.ts`
- Extension build: `npm --prefix apps/evershop-extensions/cardmint_analytics run build`
- API smoke (when endpoints touched): `/api/cm-admin/tcg/progress`, `/api/cm-admin/tcg/diff`, relevant search endpoints

## Stop-the-Line Checklist

Escalate immediately if any are true:

- Auth bypass or privilege escalation path
- Data corruption/loss risk in orders/inventory/payments
- Secrets persisted in repo/logs/docs
- Unbounded PII exposure
- Irreversible financial harm path

## Claude Handoff: Phase 1 / Reference Fallback via tcg_rows

**Complexity:** ★★★☆☆
**Change type:** Non-critical (search quality + operator UX)
**Scope completed:**
1. `ReferenceAdapter` redirected from `tcg_search_corpus` (non-existent) to `tcg_rows + tcg_snapshots`. Representative-row dedup: one candidate per `(product_name, set_name, card_number)`, LP-preferred price, `conditionBucket="UNK"` always.
2. `connection.ts` health probe updated to count `tcg_rows` in latest complete snapshot; probe failure degrades `connected=false` (wrong-schema detection) instead of silently appearing healthy.
3. `SearchDashboard`: visual source distinction (IN STOCK / CATALOG MATCH badges), catalog confirmation gate (no auto-promote for `reference_aggregate`), empty-corpus amber warning in status bar.

**Files changed:**
- `cardmint-search-app/src/retrieval/referenceAdapter.ts` — full rewrite to `tcg_rows` query path
- `cardmint-search-app/src/db/connection.ts` — health probe + wrong-schema degradation
- `cardmint-search-app/tests/fixtures/seedReference.ts` — full rewrite to `tcg_snapshots + tcg_rows` schema
- `cardmint-search-app/tests/retrieval/referenceAdapter.test.ts` — 20 tests (all new behaviors)
- `cardmint-search-app/tests/retrieval/searchPipeline.test.ts` — freshness date format fix
- `cardmint-search-app/tests/db/connection.test.ts` — NEW: 5 health probe contract tests
- `apps/evershop-extensions/cardmint_search/src/pages/admin/searchDashboard/SearchDashboard.jsx` — source badges, confirmation gate, empty-corpus warning

**Verification evidence:**
- `npm --prefix cardmint-search-app run test` → 163/163 passing
- `npx tsc -p cardmint-search-app/tsconfig.json --noEmit` → clean
- `npm --prefix apps/evershop-extensions run build` → clean
- Deployed: `prod-2026-03-12a`, `cardmint-search-app.service` active, container healthy

**Security/guardrail check:**
- Stop-the-line triggered? No
- No auth surface changes, no PII, no financial data touched

**Rollback plan:**
1. `git revert 48cd840` — reverts adapter + connection + tests
2. Rebuild search-app, rsync to `/var/www/cardmint-search-app`, `systemctl restart cardmint-search-app`
3. Rebuild + rsync `cardmint_search` extension, container rebuild + restart

---

## Codex Review: Phase 1 — GREEN (Round 2)

**Scope:** Reference fallback via tcg_rows + visual source distinction + health probe
**Change type:** Non-critical
**Complexity:** ★★★☆☆

**Round 1 (YELLOW) — Request changes:**
1. [Medium] Catalog-backed matches auto-resolved without explicit confirmation (backend `resolved` auto-promoted to working card)
2. [Low] Wrong-schema reference DB appeared healthy (`connected=true`, `corpusCount: undefined`)

**Round 2 (GREEN) — All action items resolved:**
- Auto-promote guard added (`data.sourceLabel !== "reference_aggregate"` in `handleSearch`)
- `needsCatalogConfirm` state: resolved reference results render in candidate table requiring explicit click
- `connected=false` on probe catch in `connection.ts`
- 5 new `tests/db/connection.test.ts` cover health contract

**Gates:**
- [x] Scorecard targets for touched metrics: N/A (non-critical, no scorecard gates)
- [x] QA reproducible evidence: PASS (163/163 tests, tsc clean, extension build clean)
- [x] Rollback plan clear: PASS
- [x] Security: CLEAR

**Decision:** Approve

---

## Artifact Index

Store links/paths used in review:

- Chunk 1 artifacts: `cardmint-search-app/eval/artifacts/normalization-parity.json`, `cardmint-search-app/eval/artifacts/duplicate-stability.json` (dated 2026-02-09)
- Chunk 2 artifacts: `cardmint-search-app/eval/artifacts/*.json` (5 files, dated 2026-02-09), `cardmint-search-app/src/ui/search-result-preview.html` (UI labeling artifact)
- Chunk 3 artifacts: `cardmint-search-app/src/retrieval/vectorAdapter.ts`, `cardmint-search-app/src/policy/deviceTier.ts`, `cardmint-search-app/src/telemetry/queryTelemetry.ts`, `cardmint-search-app/src/telemetry/scorecardReport.ts`
- Final eval artifacts (all chunks): `cardmint-search-app/eval/artifacts/*.json` (7 files, dated 2026-02-09)
- Phase 1 artifacts: `cardmint-search-app/src/retrieval/referenceAdapter.ts`, `cardmint-search-app/tests/db/connection.test.ts`, `docs/releases/prod-2026-03-12a.md`

## Final Gate Summary (Stage A Complete)

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck` clean |
| Tests | 145/145 PASS | 12 test files |
| Eval | 7/7 GREEN | `eval/artifacts/*.json` |
| Chunk 1 Codex | GREEN | Approved |
| Chunk 2 Codex | GREEN | YELLOW → fixed → Approved |
| Chunk 3 Codex | GREEN | YELLOW → fixed → Approved |
| Security | CLEAR | No stop-the-line triggers across all chunks |

Stage A is complete. P0 hardening applied 2026-02-09:
- Fail-loud API key check added (`env.ts`) — rejects default key on non-dev stages
- Inventory freshness wired from `updated_at` (`inventoryAdapter.ts`) — resolves prerequisite #1
- Dead guard cleaned in `scorecardReport.ts`
- `cardmint-search-app/` committed to monorepo on `feat/search-app-stage-a` branch (42 files)
- `eval/artifacts/` added to `.gitignore`

Stage B advancement requires resolving prerequisites #2–#4 (live baselines). See runbook above.

---

Tracker rule: No chunk is "complete" until Claude handoff packet is submitted and Codex records a QA decision.
