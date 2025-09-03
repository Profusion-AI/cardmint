# GitHub Workflows & PR Review

This repo uses CI, policy checks (Danger), and two AI reviewers to keep PRs consistent and high quality.

Workflows
- CI: `.github/workflows/ci.yml` – lint, typecheck, tests, builds, arch lint
- Policy Checks: `.github/workflows/policy.yml` – Danger policy checks
- Codex PR Review: `.github/workflows/codex-pr-review.yml` – OpenAI `gpt-5`
- Claude Advisory Review: `.github/workflows/claude-advisory.yml` – `claude-sonnet-4-20250514`
- Claude Security Review: `.github/workflows/claude-security.yml` – `claude-sonnet-4-20250514`

Secrets (GitHub → Settings → Secrets and variables → Actions)
- `OPENAI_API_KEY` (for Codex PR Review)
- `ANTHROPIC_API_KEY` (for Claude Code actions)

Notes
- Do NOT commit keys or `.env` to the repo. CI reads keys from Actions secrets only.
- `.env` and `.env.*` are ignored by git (see .gitignore) and are for local dev only.
- Required checks (branch protection): CI, Policy Checks (Danger), Codex PR Review, Claude Advisory Review; optionally Claude Security Review.

Fetch comments locally (GitHub CLI)
```bash
gh auth login
gh pr view <number> --comments
# Or open the PR in a browser
gh pr view --web
```

Prompts
- PR prompts for Claude live under `.github/claude/` and are injected explicitly by workflows.
- Top-level `CLAUDE.md` documents this separation to avoid conflicts with local Claude CLI usage.
