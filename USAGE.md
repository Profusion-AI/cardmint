# Mangle “Rules Brain” — Usage Guide (v0)

This guide explains how to run the sidecar, load facts, query predicates, and interpret results. It also flags guardrails and future features so you won’t be surprised.

---

## 1) Quickstart

Prereqs: Go 1.21+, Node 18+, Make

```bash
export CARDMINT_RULES_BRAIN_ENABLED=1
cd ../cardmint-mangle-spike
make dev   # starts HTTP service on :8089
# In another shell:
make test  # runs lint, rule checks, snapshot tests, and the demo script
```

Health & metrics:

```bash
curl -s localhost:8089/healthz | jq
curl -s localhost:8089/metrics
```

---

## 2) What v0 can do

* Evaluate three whitelisted predicates:
  - `valid_card/1` — OCR confidence sanity
  - `duplicate_of/2` — near-duplicate detection (phash bucket + Hamming threshold)
  - `price_for/3` — strategy-weighted price aggregation (currently "weighted")
* Provenance (coarse): request `explain=true` to get `rule_id` + coarse inputs.
* Guardrails: recursion-through-negation blocked; aggregates in recursive strata blocked; predicate whitelist enforced; fact windows enforced.

---

## 3) Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `CARDMINT_RULES_BRAIN_ENABLED` | `0` | Kill switch (`1` to enable) |
| `WINDOW_MAX_FACTS` | `20000` | Hard cap on facts per request |
| `PHASH_HAMMING_MAX` | `5` | Max Hamming distance for duplicates |
| `FRESH_DAYS` | `7` | Window for `fresh/1` |
| `OCR_TITLE_MIN` | `0.93` | Min title OCR confidence |
| `OCR_SET_MIN` | `0.90` | Min set OCR confidence |
| `MANGLE_RULES_DIR` | `./rules` | Where .mg files live |
| `MANGLE_SERVICE_ADDR` | `:8089` | Listen address |

---

## 4) Facts → load

Facts are EDB atoms in JSON:

```json
{
  "ruleset_hash": "sha256-of-rules",
  "facts": [
    { "pred": "card", "args": ["c1","base","rare","en","7/102"] },
    { "pred": "ocr_field", "args": ["c1","title","Charizard",0.98] },
    { "pred": "ocr_field", "args": ["c1","set","Base Set",0.95] },
    { "pred": "img_phash", "args": ["c1","F00DBABE",42] },
    { "pred": "img_phash", "args": ["c2","F00DBABC",42] },
    { "pred": "map_id_to_sku", "args": ["c1","SKU-123"] },
    { "pred": "vendor_price", "args": ["SKU-123","pricecharting",125.50, 1725230400000] }
  ]
}
```

Load them:

```bash
curl -X POST http://localhost:8089/facts:load \
  -H "content-type: application/json" \
  --data @facts/sample.json -i
```

Notes:
- The server recomputes `ruleset_hash` from `rules/*.mg`. If it changed, the program rebuilds.
- `WINDOW_MAX_FACTS` enforces an upper bound per request.

---

## 5) Query → results + provenance

valid_card/1 (with provenance):

```bash
curl -s -X POST http://localhost:8089/query \
 -H 'content-type: application/json' \
 --data '{"predicate":"valid_card","args":["c1"],"explain":true}' | jq
```

duplicate_of/2:

```bash
curl -s -X POST http://localhost:8089/query \
 -H 'content-type: application/json' \
 --data '{"predicate":"duplicate_of","args":["c1","_"],"limit":50,"explain":true}' | jq
```

price_for/3:

```bash
curl -s -X POST http://localhost:8089/query \
 -H 'content-type: application/json' \
 --data '{"predicate":"price_for","args":["c1","weighted","_"],"explain":true}' | jq
```

---

## 6) Writing rules (dos & don’ts)

Do:
- Keep recursion simple and stratified (no negation through recursion).
- Use grouping (`|> do fn:group_by()`) for aggregates like min/sum/avg.
- Prefer canonical pairs (`A < B`) to avoid symmetric duplicates.

Don’t:
- Put aggregates in recursive strata.
- Join unbounded pairs (`A,B`) without a candidate filter (e.g., phash bucket).
- Mix project-specific logic into rule text; keep that in service functions.

Patterns used in this spike are in README.

---

## 7) Performance & telemetry

- Budgets (goldens): `/facts:load` ≤ 200ms @ 10k facts; `/query` p95 ≤ 50ms scoped.
- Logs per request: `{ predicate, args, fact_count, ms_eval, rows, explain }`.
- `/metrics` facilitates quick checks in CI or locally.

---

## 8) Troubleshooting

- 400 — predicate not allowed or wrong arity/shape. Check the whitelist.
- 422 — type issues or malformed args. Validate input JSON.
- 413 — too many facts. Lower batch size or raise `WINDOW_MAX_FACTS` (only if safe).
- Disabled — ensure `CARDMINT_RULES_BRAIN_ENABLED=1` and restart.

---

## 9) Future features (don’t rely on yet)

- Rich provenance for `price_for/3` (list vendor rows + weights).
- Hot reload of rules without service restart.
- gRPC transport and codegen.
- NL→Rules gateway (intent → whitelisted predicate templates).
- Multi-TCG schemas (MTG/YGO extensions, legality/rotation rules).

---

## 10) Pull Request Template (paste into PR description)

```
Title: spike/mangle v0 — <short change summary>

Summary
- What changed and why (one paragraph).

Scope
- Files touched (service/rules/adapter/scripts/docs).
- No imports into capture/camera; sidecar-only.

Guardrails
- Whitelist predicates intact; stratification passes; windowing enforced.
- Kill switch required (`CARDMINT_RULES_BRAIN_ENABLED=1`).

Acceptance
- `make lint`, `make check-rules`, `make test` pass locally.
- On goldens: valid_card, duplicate_of, price_for return expected rows.
- Budgets hold (logs show timings under targets on goldens).

Risks
- Note any perf or rule semantics risks and mitigations.

Checklist
- [ ] README/USAGE updated if needed
- [ ] Env knobs documented
- [ ] No capture/camera references
```
