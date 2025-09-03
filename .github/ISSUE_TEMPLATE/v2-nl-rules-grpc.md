---
name: v2 — NL→Rules + gRPC
about: Track v2 tasks for NL templates and transport
title: 'v2: NL→Rules bridge and gRPC transport'
labels: enhancement, v2
assignees: ''
---

Summary

Introduce a whitelisted NL→Rules adapter and add a gRPC transport alongside HTTP.

Scope

- NL→Rules (agentic)
  - Define small set of predicate templates
  - YAML QueryPlan (predicate, args, window) validator
  - Adapter integrates with UI; always request explain=true
- gRPC
  - Implement Rules service from api.proto
  - Generate stubs; provide simple client example

Acceptance Criteria

- QueryPlan validator rejects non-whitelisted templates
- Demo NL prompt mapped to price_for/valid_card with explain
- gRPC endpoint parity with HTTP; snapshot tests through gRPC

Guardrails

- Whitelist only; no free-form rule execution
- No capture/camera integration; remains sidecar

Out of Scope

- Rich dashboards; multi-tenant auth

