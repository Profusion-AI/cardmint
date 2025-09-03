# Roadmap

## v1
- Rich provenance for `price_for/3` (emit vendor rows + weights used).
- Hot-reload rules without restart; invalidate caches on change.
- Per-predicate perf counters and basic dashboards.
- Minimal UI “why?” viewer for derivations.

## v2
- NL→Rules adapter with whitelisted templates and validation.
- gRPC transport and codegen (keeping HTTP as compatibility layer).
- Multi-TCG canonicalization modules (MTG/YGO); legality/rotation rules.
- Additional duplicate heuristics and dynamic thresholds per set/era.

