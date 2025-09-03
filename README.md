# Mangle "Rules Brain" — Spike Plan, Worktree, and README

## Status
v0 SPIKE (side quest). Isolated worktree (`spike/mangle`), off-by-default via `CARDMINT_RULES_BRAIN_ENABLED`.

## What to expect in v0
| Capability | Status |
| --- | --- |
| Parse/stratify/eval rules | ✅ |
| Predicate whitelist & arg validation | ✅ (`valid_card/1`, `duplicate_of/2`, `price_for/3`) |
| Provenance | ✅ Coarse (`rule_id` + coarse inputs) |
| Dup detection | ✅ Service-side, bucket-gated + Hamming ≤ `PHASH_HAMMING_MAX` |
| Freshness window | ✅ via `FRESH_DAYS` |
| Telemetry & health | ✅ `/metrics`, `/healthz`, JSON logs |
| CI guardrails | ✅ lint, rule checks, snapshots |
| NL→Rules | ⏩ Planned (v2) |

Known limits: no rich vendor-level provenance; no gRPC in v0; no wiring to capture loop.

## Objectives (non-negotiable)

- Isolation: No code paths into the camera/capture loop. This runs as a sidecar service in workers only.
- Separation of concerns: Treat provenance/explain, stats, and predicate registration as service-layer features we implement, not built-ins.
- Bounded evaluation: Semi-naive helps inside a run, but there’s no turnkey incremental materialization. We will window facts (current inventory, recent scans) and budget custom functions.
- Portability: Rules stay portable and readable; no project-specific Go hacks leaking into rule text.

## Worktree + tmp layout

This directory is a Git worktree on branch `spike/mangle`. Structure:

```
./tmp/                      # transient artifacts only
./rules/                    # .mg rule modules (versioned)
  core.mg
  validation.mg
  pricing.mg
./service/                  # Go sidecar (our boundary)
  go.mod
  main.go
  handlers.go
  derivation.go             # provenance graph (service feature)
  api.proto                 # gRPC/HTTP; generate stubs
./adapter/
  mangle-adapter.js         # Node client for workers (no capture loop deps)
  examples/run.js           # demo script
./facts/
  sample.json               # seed facts for golden snapshot tests
README.md                   # this file
```

## Vision

- What: Mangle as CardMint’s declarative Rules Brain for validation, entity resolution (aliases, variants, languages), and pricing arbitration—with a provenance layer for explainable results.
- Why now: TCG sprawl and near-duplicates are graph-y. Hand-wired SQL/rules don’t scale or explain themselves.
- Beyond Pokémon: Design stays TCG-agnostic (MTG/Yu-Gi-Oh!).
- NL → Rules: Future path where an agentic LLM compiles user intents into whitelisted rule queries, returning derivations and clean aggregates (no SQL spelunking in the UI).

## Scope of the spike

- Build a Go sidecar exposing `/facts:load` and `/query` (HTTP; gRPC proto included).
- Ship three working predicates end-to-end:
  - `valid_card/1` (confidence-gated OCR sanity)
  - `duplicate_of/2` (candidate-filtered near-duplicate detection)
  - `price_for/3` (strategy-weighted vendor arbitration)
- Show a small derivation graph for “why is this fact true?” (service feature).
- No wiring into capture; integration only via the JS adapter.

## Architecture

- Engine: Mangle (Go) with semi-naive evaluation; rules in `rules/*.mg`.
- Service features (ours): provenance capture, performance budgets, stratification guardrails, golden snapshot tests.
- Adapter: `adapter/mangle-adapter.js` publishes fact batches and queries derived predicates.
- Working set: “Current inventory + last N scans”; larger facts persisted in SQLite, streamed into the service per request window.

## API contract

- POST `/facts:load`: idempotent batch load; accepts typed facts (JSON). Service computes a deterministic `ruleset_hash` over `rules/*.mg` (sorted filenames + contents) and rebuilds when it changes.
- POST `/query`: body `{ predicate, args?, explain?, limit? }`; returns rows; if `explain=true`, also return derivation edges `{rule_id, inputs}`.

## Fact schema (initial)

- `card(Id, set_code, rarity, lang, number)`
- `ocr_field(Id, field, value, conf)`
- `vendor_price(sku, vendor, price, ts)`
- `map_id_to_sku(Id, sku)`
- `name_alias(a, b)`
- `img_phash(Id, hash, bucket)`  // bucket precomputed for candidate filtering

## Rule patterns (concrete, safe)

Confidence-gated validation (non-recursive, no negation):

```prolog
valid_card(Id) :-
  ocr_field(Id, "title", _, C1), C1 > 0.93,
  ocr_field(Id, "set",   _, C2), C2 > 0.90.
```

Alias closure (transitive, avoid recursion-through-negation; choose canon via aggregate):

```prolog
alias_sym(A,B) :- name_alias(A,B).
alias_sym(A,B) :- name_alias(B,A).

alias_tc(A,B)  :- alias_sym(A,B).
alias_tc(A,C)  :- alias_tc(A,B), alias_sym(B,C).

canon_name(C) :-
  alias_tc(C,_)
  |> do fn:group_by(), let C = fn:min(C).
```

Weighted pricing (grouping explicit—no accidental row multiplication):

```prolog
candidate_price(Id, V, P) :-
  map_id_to_sku(Id, S),
  vendor_price(S, V, P, Ts),
  fresh(Ts).

price_for(Id, "weighted", P) :-
  candidate_price(Id, V, Pv)
    |> do fn:group_by(Id),
       let P = fn:sum(weight(V) * Pv) / fn:sum(weight(V)).
```

Duplicate detection (O(n²) guarded by bucket join; distance via service-layer precompute):

```prolog
dup(A,B) :- img_phash(A, Ha, Ba), img_phash(B, Hb, Ba), A < B, hamming_within(Ha, Hb, 5).
duplicate_of(A,B) :- dup(A,B).
```

Note: For v0, we precompute `dup/2` service-side from `img_phash` buckets and a Hamming threshold to avoid forking Mangle for a builtin.

## Guardrails

- Kill switch: `CARDMINT_RULES_BRAIN_ENABLED=0` by default; required `=1` to run.
- CI lints: reject recursion-through-negation; forbid aggregates in recursive strata (enforced by Mangle stratification).
- Budget custom functions: limit candidate fan-out (bucket joins), timebox similarity calls.
- Snapshot tests: goldens for `valid_card/1`, `duplicate_of/2`, `price_for/3`.
- Performance budgets: `facts:load` ≤ 200 ms for 10k facts; `query` p95 ≤ 50 ms for scoped sets.
 - Predicate whitelist: `/query` only accepts `valid_card/1`, `duplicate_of/2`, `price_for/3`; wrong arity or types → 400/422.

## Quickstart

- See USAGE.md for the full guide.

```
export CARDMINT_RULES_BRAIN_ENABLED=1
cd ../cardmint-mangle-spike
make dev   # starts sidecar on :8089
make test  # lint + rule checks + snapshot tests + demo
```

## Roadmap
See docs/ROADMAP.md.

## NL → Rules (agentic path)

- Define a small, whitelisted mapping from natural intents → predicate templates.
- LLM outputs a QueryPlan YAML (predicate, args, window) validated before calling `/query`.
- Always request `explain=true` to render derivations in the UI; never allow free-form rules at runtime.

## Risks

- Engine maturity/community size → mitigate via service boundary and portable rules.
- Team learning curve → ship small rule cookbooks and snapshot tests as living docs.

## Configuration

- Env knobs with defaults:
  - `WINDOW_MAX_FACTS` (20000): hard cap on facts per load; exceed → 422.
  - `PHASH_HAMMING_MAX` (5): service-side duplicate threshold.
  - `FRESH_DAYS` (7): if no `fresh/1` facts are provided, derive from `vendor_price` timestamps within this window.
  - `OCR_TITLE_MIN` (0.93), `OCR_SET_MIN` (0.90): documented for v0; rules encode constants; v1 may parameterize.
  - `MANGLE_RULES_DIR` (../rules), `MANGLE_SERVICE_ADDR` (:8089).
  - `CARDMINT_RULES_BRAIN_ENABLED` (0): kill switch; set to 1 to run.

Invalid env values cause a fail-fast at startup and are surfaced in `/healthz`.

## Troubleshooting

- Go modules: if `go` prompts for modules, run `cd service && go get github.com/google/mangle@latest && go mod tidy`.
- Service won’t start: ensure `CARDMINT_RULES_BRAIN_ENABLED=1` and that port `:8089` is free.
- Rule errors: run `make check-rules` to parse/type-check and enforce stratification; inspect server logs for details.
- 400/422 from `/query`: check predicate whitelist and argument arity/types.
