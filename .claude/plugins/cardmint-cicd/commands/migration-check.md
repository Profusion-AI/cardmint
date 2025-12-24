---
description: Validate migration has rollback posture before merge
argument-hint: [migration-file]
allowed-tools: Read, Grep, Glob, Bash(ls:*), Bash(cat:*), Bash(head:*)
---

# Migration Rollback Posture Check

Validate that database migrations declare proper rollback posture per CardMint CI/CD policy.

## Policy Requirement

Every migration must be one of:
- **Reversible**: Has a corresponding down migration
- **Forward-only**: Explicitly labeled with rollback plan

## Context

- Migration directory: !`ls -la apps/backend/src/db/migrations/*.sql 2>/dev/null | tail -10`
- Argument: **$1** (optional: specific migration file to check)

## Check Process

### 1. Identify Migrations to Check

If `$1` is provided:
- Check only that specific file

If no argument:
- Find all migrations added/modified in current branch vs main:
```bash
git diff --name-only origin/main...HEAD -- 'apps/backend/src/db/migrations/*.sql'
```

### 2. For Each Migration File

Check for rollback posture indicators:

**Reversible indicators:**
- Corresponding `*_down.sql` or `*.down.sql` file exists
- Contains `-- DOWN MIGRATION:` comment block
- Has paired CREATE/DROP statements

**Forward-only indicators:**
- Contains `-- FORWARD-ONLY:` comment
- Contains `-- ROLLBACK PLAN:` section

### 3. Validation Logic

For each migration file:

1. Extract filename base (e.g., `20251218_cart_reservation`)
2. Check for down migration: `*_down.sql`, `*.down.sql`, or `*_rollback.sql`
3. If no down file, scan for inline markers:
   - `-- FORWARD-ONLY` declaration
   - `-- ROLLBACK PLAN:` with actual plan text
4. Check if migration touches production-critical tables:
   - `orders`, `items`, `products`, `scans`, `pricing`, `auth`, `sessions`
   - If yes: Flag for CODEOWNER review

### 4. Determine Pass/Fail

**PASS conditions:**
- Has corresponding `_down.sql` or `.down.sql` file, OR
- Contains `-- FORWARD-ONLY` with `-- ROLLBACK PLAN:` section

**FAIL conditions:**
- No down migration AND no forward-only declaration
- Forward-only without rollback plan
- Touches production-critical tables without CODEOWNER flag

## Output Report

Generate a report in this format:

```
## Migration Rollback Posture Check

### Checked Files
- [ ] migration1.sql: [PASS/FAIL] [reason]
- [ ] migration2.sql: [PASS/FAIL] [reason]

### Production-Critical Tables
[List any migrations touching orders/items/products/scans/pricing/auth]
Requires CODEOWNER approval: [Yes/No]

### Summary
- Total checked: X
- Passed: Y
- Failed: Z
- Requires CODEOWNER: [Yes/No]
```

## Remediation Guidance

If a migration fails, provide specific instructions:

**Option A: Add down migration**
```sql
-- File: YYYYMMDD_name_down.sql
-- Reverses: YYYYMMDD_name.sql

DROP TABLE IF EXISTS new_table;
-- or
ALTER TABLE existing_table DROP COLUMN new_column;
```

**Option B: Declare forward-only**
Add to the migration file:
```sql
-- FORWARD-ONLY: This migration cannot be reversed automatically.
-- ROLLBACK PLAN:
-- 1. [Manual steps to recover if needed]
-- 2. [Data restoration procedure]
-- 3. [Service restart requirements]
```

## Quick Reference

**Production-critical tables (require CODEOWNER):**
- `orders`, `order_items`
- `items`, `products`, `scans`
- `pricing`, `market_prices`
- `auth`, `sessions`, `users`
- `checkout_sessions`, `payments`

**Always forward-only (cannot safely reverse):**
- Data migrations that transform values
- Column renames
- Index changes on large tables
