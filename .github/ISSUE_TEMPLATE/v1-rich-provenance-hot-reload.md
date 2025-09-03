---
name: v1 — Rich provenance + hot-reload
about: Track v1 tasks for Mangle spike productization
title: 'v1: Rich provenance for price_for + hot-reload rules'
labels: enhancement, v1
assignees: ''
---

Summary

Add rich provenance for price_for/3 (list vendor rows + weights used), and support hot-reloading rules without a service restart.

Scope

- price_for provenance
  - Include vendor_price(S,V,P,Ts) rows and weight(V,W) used
  - Compute and return effective weight-normalized contributions
  - Preserve whitelist and arg validations
- Hot-reload rules
  - Watch rules/*.mg hash; rebuild program atomically
  - Clear caches; preserve current facts if compatible
  - Expose /rules:reload and /rules:status

Acceptance Criteria

- /query?predicate=price_for returns derivation with vendor rows and weights
- /rules:reload rebuilds without downtime; ongoing queries remain safe
- Hash change via file edit triggers rebuild
- Snapshot tests for provenance structure

Guardrails

- No recursion-through-negation; aggregates only post-group
- No imports into capture loop; kill switch remains enforced
- Budget provenance collection (cap rows, truncate long lists)

Out of Scope

- NL→Rules bridge; gRPC transport

Notes

- Keep rule text portable; perform vendor normalization in service code

