# Search Corpus Expansion — Phased Implementation Plan

**Date:** 2026-03-11
**Status:** APPROVED FOR IMPLEMENTATION
**Codex review:** Incorporated (see Review Notes section)
**Supersedes:** `search-app-6mar-status.md` (deprecated), partial notes in `10mar-codex-reviewed.md`

---

## Product Framing (Codex)

> "The search app is now at an inflection point. Up to now it has mostly been a clever inventory
> resolver. What you actually want next is an operator decision tool: tell me what card this is,
> tell me whether we own it, and tell me what to do next."

The next move optimizes for **operator trust and coverage**, not architectural neatness alone.

### Two-Layer Product Model

| Layer | Question answered | Source |
|-------|------------------|--------|
| **Inventory truth** | Do we already have this exact card in stock? | `products` table (live inventory) |
| **Catalog fallback** | If not, what is the most likely card in the broader market universe? | TCGPlayer snapshot corpus |

These two states must be **explicit and visually distinct**. If they blur together, operators stop
trusting the tool. If they are clearly separated, the tool becomes useful even before it is perfect.

### Three UX States the Page Must Communicate

```
Found in inventory          → inventory badge, full confidence, action available
Not in inventory            → catalog badge, reference label, more conservative auto-resolve
No confident match          → disambiguation panel, no auto-resolve, no badge
```

---

## Current State (as of 2026-03-11)

| Component | Status |
|-----------|--------|
| `InventoryAdapter` | LIVE — FTS5, set-constrained, 69 cards |
| `ReferenceAdapter` | CODE EXISTS — queries `tcg_search_corpus` which does not exist yet |
| `searchPipeline.ts` | WIRED — already falls back to reference when inventory returns 0 |
| `tcg_rows` | LIVE on prod — has the data, wrong shape for ReferenceAdapter |
| `tcg_search_corpus` | MISSING — the planned table ReferenceAdapter expects |
| Reference corpus | `reference.connected: false` in prod |
| TCG snapshots on prod | Empty (no uploads yet) |

The gap is exactly one table and one query change. The pipeline is already correct.

---

## Phase 1 — Business Unlock: Wire Reference to `tcg_rows` Directly

**Goal:** Turn `reference.connected: true` in prod today. No schema migration required.

**What changes:**
- Modify `ReferenceAdapter.deterministicSearch()` and `likeSearch()` to query `tcg_rows` instead of
  `tcg_search_corpus`, deduplicating by `(product_name, set_name, card_number)` and scoping to the
  latest complete snapshot.
- Add the same set-constrained filtering just applied to `InventoryAdapter` (Option A fix, already
  deployed).
- Point `referenceAdapter` at `db` (inventory DB) instead of `null` in the server startup.
- Add `SEARCH_APP_REFERENCE_DB_PATH` env var (or reuse inventory DB path) on prod.

**SQL shape for Phase 1 `likeSearch`:**

```sql
SELECT product_name   AS card_name,
       set_name,
       card_number    AS collector_no_raw,
       rarity,
       AVG(market_price_cents) / 100.0 AS market_price,
       photo_url      AS image_url,
       MAX(created_at) AS freshness_ts,
       tcgplayer_id   AS product_id,
       condition_bucket AS sub_type_name
FROM tcg_rows
WHERE snapshot_id = (SELECT MAX(id) FROM tcg_snapshots WHERE status = 'complete')
  AND LOWER(product_name) LIKE '%' || LOWER(?) || '%'
  -- set constraint when parsed.setName is present (same pattern as InventoryAdapter)
GROUP BY product_name, set_name, card_number
ORDER BY market_price DESC
LIMIT 25
```

**Product rule (Codex requirement):**
Reference fallback results must be visually and behaviorally distinct from inventory results:
- Different badge: `IN STOCK` vs `CATALOG MATCH`
- Different copy: "Found in your inventory" vs "Not in inventory — market reference"
- More conservative auto-resolution: reference results require a higher effective confidence before
  auto-resolving in the UI (even if backend threshold stays at 0.70, the UX should prompt confirmation)
- Source label `reference_aggregate` is already returned in the search response — the UI should use it

**Caveat to communicate to operator:**
Reference results reflect the most recent TCGPlayer snapshot loaded into the system. Until a snapshot
is uploaded, reference fallback returns no results. The corpus only grows when a CSV is uploaded.

**Definition of Done:**
- `reference.connected: true` in prod health endpoint
- `jungle flareon` → clean no-results (inventory miss, no snapshot loaded yet)
- After uploading a TCGPlayer CSV → `jungle flareon` resolves against catalog
- Inventory results and reference results render with distinct visual treatment in the UI
- 149 existing tests still pass; new tests cover reference adapter querying `tcg_rows`

**Complexity:** ★★★☆☆
**Codex gate:** Required before Phase 2

---

## Phase 2 — Real Foundation: `tcg_search_corpus` + FTS5 + Snapshot Hook

**Goal:** Replace the `tcg_rows` LIKE hack with a purpose-built, indexed corpus. Make search quality
an owned asset rather than a side effect of analytics tables.

**Why this matters after Phase 1:**
- `tcg_rows` has one row per (card, condition, snapshot). AVG/GROUP BY at query time is fragile and
  slow at scale.
- LIKE search over 23k+ rows without FTS5 works for now but will degrade as snapshots accumulate.
- The `ReferenceAdapter` code already references `tcg_search_corpus` — Phase 1 is a temporary
  redirect; Phase 2 builds what was always planned.
- Snapshot freshness metadata, finish normalization (Holo/Reverse/NonHolo), and edition tagging
  need a proper home.

**What changes:**

### Migration: `tcg_search_corpus` table

```sql
CREATE TABLE tcg_search_corpus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,           -- = snapshot_id of source snapshot
  product_id  INTEGER NOT NULL,           -- = tcgplayer_id
  card_name   TEXT NOT NULL,
  set_name    TEXT NOT NULL,
  collector_no_raw TEXT,
  rarity      TEXT,
  sub_type_name TEXT,                     -- finish: Holo | Reverse | NonHolo | null
  edition     TEXT,                       -- 1st | Unlimited | null
  market_price REAL,
  image_url   TEXT,
  freshness_ts TEXT,
  UNIQUE(run_id, product_id)
);

CREATE INDEX idx_tsc_run   ON tcg_search_corpus(run_id);
CREATE INDEX idx_tsc_set   ON tcg_search_corpus(run_id, set_name);

CREATE VIRTUAL TABLE tcg_search_corpus_fts USING fts5(
  card_name,
  content='tcg_search_corpus',
  content_rowid='rowid'
);
```

### Snapshot upload hook

When `tcg_snapshots.status` transitions to `'complete'`, run a corpus rebuild job:
1. Deduplicate `tcg_rows` for that snapshot: one row per `(product_name, set_name, card_number)`,
   taking the NM condition as the representative price where available.
2. Upsert into `tcg_search_corpus` with the new `run_id`.
3. Rebuild the FTS5 content table: `INSERT INTO tcg_search_corpus_fts(tcg_search_corpus_fts) VALUES('rebuild')`.
4. Old run corpus rows are retained for rollback; prune after N snapshots.

### `ReferenceAdapter` update

Revert Phase 1's `tcg_rows` query. Restore the original `tcg_search_corpus` query, but add FTS5
path (same pattern as `InventoryAdapter`):

```
Path 1: Deterministic (set + collector_no) → exact match on tcg_search_corpus
Path 2: FTS5 on card_name → fast, ranked
Path 3: LIKE fallback → same as before, kept for robustness
```

**Definition of Done:**
- `tcg_search_corpus` populated after snapshot upload
- FTS5 path measurably faster than LIKE (log query latency before/after)
- Scorecard p50 latency stays ≤ 10ms for reference queries
- Corpus rebuild triggered automatically on snapshot complete
- Rollback: revert to Phase 1 query if corpus is empty
- All existing tests pass; new tests cover FTS5 path and corpus rebuild

**Complexity:** ★★★★☆
**Codex gate:** Required before Phase 3

---

## Phase 3 — Product Story: CSV Upload = Corpus Refresh

**Goal:** The operator workflow of uploading a TCGPlayer export automatically expands the search
corpus. No separate catalog sync service, no manual corpus build step.

> "Upload TCG export → search corpus refreshes automatically."
> — Codex product narrative

**This is the right long-term operator story.** The data you are already managing drives search
quality. The 31 MB CSV you have today would flip `reference.connected` from false to true as a
side effect of the upload you have already done.

**What changes:**

### 1. Production-safe ingest path for large CSVs

Current upload route uses `multer.memoryStorage()` with a 10 MB limit. The real TCGPlayer export is
~31 MB and 216k rows. Fix:
- Switch to `multer.diskStorage()` with a temp file path
- Stream-parse with a CSV parser (e.g., `csv-parse` in streaming mode) rather than reading all
  rows into memory before insert
- Batch insert in transactions of 500–1000 rows
- Raise the file-size limit to 50 MB

### 2. Upload triggers corpus rebuild

Extend the snapshot upload completion handler (already exists in `tcgSnapshotService.ts`) to enqueue
a corpus rebuild. The rebuild is the Phase 2 job — Phase 3 just wires it automatically to the upload
event rather than requiring a manual trigger.

### 3. UI: Corpus freshness surfaced

The search dashboard should show:
- Last corpus refresh date/time (from `MAX(run_id)` join to `tcg_snapshots.snapshot_date`)
- Row count of current corpus
- A "Refresh corpus" button that re-triggers the rebuild from the latest complete snapshot

### 4. Operator-visible corpus state in health endpoint

`reference.connected: true` becomes `reference.connected: true, corpusRows: 23417, snapshotDate: 2026-03-06`

**Definition of Done:**
- 31 MB TCGPlayer CSV uploads without timeout or memory error
- Corpus rebuild triggers automatically on upload completion
- Health endpoint exposes corpus row count and snapshot date
- UI shows corpus freshness
- Full E2E: upload CSV → wait for rebuild → search "jungle flareon" → catalog match returned

**Complexity:** ★★★★☆
**Codex gate:** Required before any external exposure

---

## Option 4 — Separate Search DB (Deferred)

**Codex verdict:** Premature. At 23k rows on a 2 vCPU / 7.7 GiB droplet, there is no operational
reason to split databases. Revisit only when:
- Corpus grows beyond ~500k rows, OR
- The search service needs an independent release cadence (e.g., daily corpus swaps with no
  restart of the main backend), OR
- The inventory DB becomes a contention bottleneck under concurrent search + write load

At that point, the model becomes:
```
cardmint_prod.db      → inventory truth (transactional, write-heavy)
cardmint_search.db    → reference catalog (read-only, swappable)
```
Swapping the catalog becomes `mv new.db cardmint_search.db && systemctl restart cardmint-search-app`.
The corpus becomes a versioned artifact. Not needed now.

---

## UI Design Direction (Codex)

The page should tell one simple story, not expose retrieval internals.

### Result states (operator-visible)

```
┌─────────────────────────────────────────────────────┐
│ 🟢 IN STOCK — Charizard, Base Set, #4               │
│ 2× NM at $350 · 1× LP at $280                       │
│ Market: $347 NM · Confidence: 92%                   │
│ [Enrich]  [View Listing]                            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 📋 CATALOG MATCH — Jungle Flareon, #3/64            │
│ Not currently in your inventory                      │
│ Market: $28 NM · Confidence: 85% · Source: TCGPlayer│
│ [Enrich]  [Note for acquisition?]                   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ ❓ NO CONFIDENT MATCH                                │
│ Multiple candidates — select one to continue         │
│ [Candidate list with Accept buttons]                 │
└─────────────────────────────────────────────────────┘
```

### Confidence behavior by source

| Source | Auto-resolve threshold | Manual accept |
|--------|----------------------|---------------|
| `internal_truth` | 0.70 (current) | Always available |
| `reference_aggregate` | Requires explicit UI confirm even above threshold | Always available |

The backend threshold can stay at 0.70. The UX adds a confirmation step for reference results
so operators always know when they're accepting a catalog match versus an inventory match.

### Source label mapping

`sourceLabel` in the search response already carries `"internal_truth"` or `"reference_aggregate"`.
The UI reads this and applies the badge/copy accordingly. No new API fields needed.

---

## Implementation Order

```
Phase 1 ── Wire ReferenceAdapter to tcg_rows           (no migration, hours)
             └── UI: Add source badges / behavioral split
             └── Codex GREEN required

Phase 2 ── tcg_search_corpus + FTS5 + snapshot hook    (one migration, days)
             └── Retire Phase 1 tcg_rows query
             └── Codex GREEN required

Phase 3 ── CSV upload → corpus refresh E2E             (ingest + wiring, days)
             └── Production-safe for 31 MB file
             └── Codex GREEN required

Phase 4 ── Separate search DB (DEFERRED — revisit when operationally justified)
```

---

## Sequencing Rationale

Phase 1 is justified immediately because:
- The pipeline fallback is already coded and tested
- `tcg_rows` already contains the data
- The operator has a 31 MB TCGPlayer CSV they cannot yet upload
- Every search query for a card not in the 69-card inventory currently returns an inventory miss
  rather than anything useful — the corpus expansion is a pure improvement

Phase 2 follows quickly because:
- Once operators start using reference fallback, search quality becomes a daily-use concern
- FTS5 and proper dedup are cheap to build now vs. retrofitting under load
- The `ReferenceAdapter` code already expects `tcg_search_corpus` — Phase 1 is intentionally
  temporary

Phase 3 completes the product story:
- Upload path is currently broken for production-sized files (10 MB limit, all-in-memory)
- The workflow story ("upload CSV → search expands") is the canonical operator experience
- After Phase 3, the operator never needs to think about "corpus management" separately

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Phase 1 LIKE perf degrades under 23k rows | Low | Acceptable at operator tool scale; Phase 2 adds FTS5 |
| Reference results accepted as inventory truth by operator | Medium | **Required:** distinct visual treatment per Codex review |
| Large CSV upload times out or OOMs | High (current) | Phase 3 addresses; Phase 1/2 use already-loaded snapshot data |
| Snapshot upload pipeline not yet seeded in prod | Current reality | Phase 1 will return no reference results until first CSV upload succeeds |
| Set-constrained miss returns empty for catalog cards not in snapshot | By design | Source label and empty-state copy explains this to operator |

---

## References

- `cardmint-search-app/src/retrieval/referenceAdapter.ts` — ReferenceAdapter (targets `tcg_search_corpus`)
- `cardmint-search-app/src/retrieval/searchPipeline.ts` — Pipeline with reference fallback already wired
- `apps/backend/src/db/migrations/20260205_tcgplayer_snapshots.sql` — `tcg_rows` schema
- `apps/backend/src/services/tcgAnalytics/tcgSnapshotService.ts` — Snapshot upload + ingest pipeline
- `docs/february/cardmint-search-execution-tracker.md` — Stage A/B history and gate log
- `docs/february/cardmint-search-hybrid-scorecard-prd.md` — Source PRD and quality gates
- `docs/search-app-6mar-status.md` — March 6 production state audit (deprecated as active baseline)
