# Changelog

## v0 (SPIKE)
- Predicate whitelist & arg validation for `valid_card/1`, `duplicate_of/2`, `price_for/3`.
- Coarse provenance (`rule_id` + inputs).
- Service-side dup detection (phash bucket + Hamming ≤ `PHASH_HAMMING_MAX`).
- Deterministic `ruleset_hash` (SHA-256 over sorted filenames+contents).
- Telemetry logs, `/metrics`, `/healthz`.
- CI: lint, rule checks (negation/aggregates), snapshot tests.

