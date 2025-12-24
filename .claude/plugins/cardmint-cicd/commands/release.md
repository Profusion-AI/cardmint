---
description: Create a production release (tag + deploy + smoke test)
argument-hint: [target] [--dry-run]
allowed-tools: Bash(git:*), Bash(curl:*), Bash(ssh:*), Bash(rsync:*), Bash(docker:*), Bash(ls:*), Bash(cat:*), Bash(echo:*), Bash(date:*), Bash(test:*), Bash(sudo:*), Read, Write, Grep, AskUserQuestion
---

# Production Release Workflow

Execute the CardMint production release workflow per `docs/december/prod-cicd-considerations.md`.

## Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Recent commits on main: !`git log origin/main -5 --oneline`
- Latest prod tag: !`git tag -l 'prod-*' | sort -V | tail -1`
- Today's date: !`date +%Y-%m-%d`

## Release Target

Target: **$1** (default: `all`)
- `backend` - CardMint backend only
- `extensions` - EverShop extensions only
- `debug-api` - Internal Debug API only
- `all` - Full deployment

Dry run: **$2** (if `--dry-run`, simulate without deploying)

## Pre-Flight Checks (Execute All)

### 1. Verify on main branch
Confirm current branch is `main`. If not, abort with instructions to merge first.

### 2. Verify clean working directory
`git status` must show no uncommitted changes. If dirty, abort.

### 3. Verify local health
```bash
curl -sS http://localhost:4000/health | jq
```
Health must return healthy status. If unhealthy, abort.

### 4. Create BTFRS snapshot (REQUIRED)
```bash
sudo btrfs subvolume snapshot /home/kyle/CardMint-workspace /home/kyle/.btrfs-restorepoints/CardMint-workspace-$(date +%Y%m%d-%H%M%S)
```
Verify snapshot was created:
```bash
ls -la /home/kyle/.btrfs-restorepoints/ | grep CardMint-workspace | tail -1
```

### 5. Run acceptance tests (conditional)
Run **only if the AI pipeline is touched** (grading, canonical, LLMs). Otherwise skip per Jan 2026 deferral.
```bash
scripts/validate/run_acceptance.sh --db apps/backend/cardmint_dev.db --size 20
```

## Create Release Tag

1. Determine next tag name:
   - Get latest: `git tag -l 'prod-*' | sort -V | tail -1`
   - If no tag for today: `prod-YYYY-MM-DDa`
   - If tag exists for today: increment letter (a→b→c)

2. Create annotated tag:
```bash
git tag -a "prod-YYYY-MM-DDx" -m "Release: [brief description of changes since last tag]"
```

3. Push tag:
```bash
git push origin "prod-YYYY-MM-DDx"
```

## Deploy (Skip if --dry-run)

Use the deployment procedures from `deploy-to-prod` skill based on target:

### For `backend` or `all`:
```bash
rsync -avz --delete \
  -e "ssh -i ~/.ssh/cardmint_droplet" \
  /home/kyle/CardMint-workspace/apps/backend/ \
  cardmint@157.245.213.233:/var/www/cardmint-backend/

ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
set -e
cd /var/www/cardmint-backend
npm ci --production
sudo systemctl restart cardmint-backend
EOF
```

### For `extensions` or `all`:
```bash
rsync -avz --delete \
  -e "ssh -i ~/.ssh/cardmint_droplet" \
  /home/kyle/CardMint-workspace/apps/evershop-extensions/ \
  cardmint@157.245.213.233:/opt/cardmint/extensions/

ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 << 'EOF'
set -e
cd /opt/cardmint
docker compose down
docker compose build --no-cache
docker compose up -d
EOF
```

### For `debug-api` or `all`:
Follow debug-api deploy procedure from deploy-to-prod skill.

## Post-Deploy Smoke Tests

1. HTTPS check:
```bash
curl -Is https://cardmintshop.com/ | head -1
```
Expected: `HTTP/2 200`

2. Backend health:
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'curl -sS http://localhost:4000/health | jq'
```

3. EverShop containers:
```bash
ssh -i ~/.ssh/cardmint_droplet cardmint@157.245.213.233 'docker compose -f /opt/cardmint/docker-compose.yml ps'
```

## Create Release Notes

Create file `docs/releases/prod-YYYY-MM-DDx.md` with:

```markdown
# Release prod-YYYY-MM-DDx

## What Changed
- [Summarize commits since last tag]

## Risk Notes
- [Production-critical paths touched]

## Rollback Steps
- Tag: [previous tag]
- DB: [Any migration notes]

## Deploy Target
- [backend/extensions/debug-api/all]
```

## Report Summary

Provide final summary:
- Tag created: `prod-YYYY-MM-DDx`
- Deployed to: [target]
- Smoke tests: [pass/fail]
- Release notes: [created/skipped]
- Rollback target: [previous tag]
