# PR Review Pipeline (AI + Policy)

This repo enforces a consistent, automated PR process combining CI, policy checks, and two AI reviewers – Codex (OpenAI) and Claude Code (Anthropic).

Required status checks (branch protection)
- CI (lint, typecheck, tests, build, arch lint)
- Policy Checks (Danger)
- Codex PR Review (line-by-line, OpenAI)
- Claude Advisory Review (exec/KPI/roadmap view)
- Optional: Claude Security Review (security checklist)

Workflows
- `.github/workflows/ci.yml`: Runs lint, typecheck, tests, builds, and arch lint.
- `.github/workflows/policy.yml`: Runs Danger policy checks:
  - PR title format (conventional commits)
  - No dist/, .env*, or secrets in PR
  - No // TODO
  - Architecture boundaries (no legacy/ into src/, core/ cannot import adapters/ or app/)
  - Reminds to add tests if src/ changed
- `.github/workflows/codex-pr-review.yml`: Codex PR Review via OpenAI (gpt-5)
- `.github/workflows/claude-advisory.yml`: Claude advisory summary (claude-sonnet-4-20250514)
- `.github/workflows/claude-security.yml`: Claude security pass (claude-sonnet-4-20250514)

Secrets
- `OPENAI_API_KEY` – required for Codex PR Review
- `ANTHROPIC_API_KEY` – required for Claude Code actions

Do NOT put API keys in repo or .env in CI.
- GitHub Actions read from repository/org secrets.
- Local `.env` is for local development only and is git-ignored. CI will not read local `.env`.

Models
- OpenAI model: `gpt-5` (primary reviewer)
- Anthropic model: `claude-sonnet-4-20250514` (advisory + security)

Fetching AI review comments locally
1) Install GitHub CLI: https://cli.github.com/
2) Authenticate: `gh auth login`
3) View PR and comments:
   - `gh pr view <number> --comments`
   - `gh pr view --web` to open in browser

Re-running checks
- In the PR Checks tab, click “Re-run all jobs”.
- Or push a new commit to the branch.

Tuning prompts
- Advisory/security prompts live under `.github/claude/` and are passed explicitly by workflows. Do not use top-level `CLAUDE.md` for CI prompts.
