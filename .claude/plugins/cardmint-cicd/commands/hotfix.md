---
description: Create emergency hotfix from production tag
argument-hint: <slug> [--deploy]
allowed-tools: Bash(git:*), Bash(curl:*), Bash(ssh:*), Bash(rsync:*), Bash(docker:*), Bash(ls:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(test:*), Bash(sudo:*), Read, Write, Grep, AskUserQuestion
---

# Emergency Hotfix Workflow

Execute CardMint hotfix procedure per `docs/december/prod-cicd-considerations.md`.

**Use this for:**
- Checkout broken, payments failing
- Inventory minting broken (Stage 2 invariants)
- Promotion pushing bad listings
- Data corruption or security incident

## Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Currently deployed tag: !`git tag -l 'prod-*' | sort -V | tail -1`
- Today's date: !`date +%Y-%m-%d`

## Hotfix Slug

Slug: **$1** (required, describes the fix)
Deploy immediately: **$2** (if `--deploy`, deploy after tagging)

If no slug provided, ask the user for a brief description of the hotfix.

## Pre-Flight Checks

### 1. Verify clean working directory
If there are uncommitted changes, warn that they will NOT be included in the hotfix unless explicitly staged.

### 2. Get currently deployed tag
```bash
CURRENT_TAG=$(git tag -l 'prod-*' | sort -V | tail -1)
echo "Currently deployed: $CURRENT_TAG"
```

## Create Hotfix Branch

1. Create branch from the **currently deployed tag** (not main!):
```bash
git checkout -b "hotfix/$(date +%Y-%m-%d)-$1" "$CURRENT_TAG"
```

2. Confirm branch created:
```bash
git branch --show-current
```

## Implement Fix

Guide the user through implementing the smallest possible fix:

1. Identify the exact file(s) that need changes
2. Make ONLY the necessary changes - no refactoring, no cleanup
3. Test locally if possible
4. Stage changes: `git add <files>`

## Create PR to Main

After fix is implemented and staged:

1. Commit with clear message:
```bash
git commit -m "HOTFIX: $1

Fixes: [describe the issue]
Impact: [what was broken]
Root cause: [why it broke]

Rollback: Redeploy $CURRENT_TAG"
```

2. Push hotfix branch:
```bash
git push origin "hotfix/$(date +%Y-%m-%d)-$1"
```

3. Create PR:
```bash
gh pr create --title "HOTFIX: $1" --body "## Emergency Fix

**Issue:** [What was broken]
**Fix:** [What this changes]
**Impact:** Production was affected

## Checklist
- [ ] CODEOWNER approved (if production-critical path)
- [ ] CI checks pass
- [ ] Tested locally

## Rollback
Previous stable: \`$CURRENT_TAG\`"
```

## Tag and Deploy (if --deploy)

After PR is merged to main:

1. Checkout main and pull:
```bash
git checkout main && git pull origin main
```

2. Determine next tag (increment letter from current):
```bash
# If current is prod-2025-12-24a, next is prod-2025-12-24b
```

3. Create hotfix tag:
```bash
git tag -a "prod-YYYY-MM-DDx" -m "HOTFIX: $1

Emergency fix for [issue].
Previous stable: $CURRENT_TAG"
```

4. Push tag:
```bash
git push origin "prod-YYYY-MM-DDx"
```

5. Deploy using `/release` command procedures

## Post-Deploy Verification

Run the same smoke tests as `/release`:

1. HTTPS check: `curl -Is https://cardmintshop.com/ | head -1`
2. Backend health: `ssh ... 'curl localhost:4000/health'`
3. Specific verification of the fixed functionality

## Create Hotfix Release Notes

Create `docs/releases/prod-YYYY-MM-DDx.md`:

```markdown
# HOTFIX Release prod-YYYY-MM-DDx

## Issue
- [What was broken, when discovered]

## Fix
- [Exactly what was changed]

## Root Cause
- [Why it broke]

## Rollback
- Redeploy: $CURRENT_TAG

## Follow-up
- [ ] Post-mortem documented
- [ ] Prevention measures identified
```

## Report Summary

Provide final summary:
- Hotfix branch: `hotfix/YYYY-MM-DD-$1`
- PR: [link]
- Tag created: [if deployed]
- Status: [awaiting review / merged / deployed]
- Rollback target: $CURRENT_TAG
