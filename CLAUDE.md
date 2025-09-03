# Claude Prompting Notes (PRs)

This repository uses Claude Code GitHub Actions for advisory and security reviews.

Important:
- This top-level `CLAUDE.md` is intentionally NOT consumed by our GitHub Actions.
- The Actions are configured with explicit prompts stored under `.github/claude/`:
  - `.github/claude/ADVISORY_PROMPT.md`
  - `.github/claude/SECURITY_PROMPT.md`

Why not load from `CLAUDE.md`?
- Local Claude CLI tools may auto-read `CLAUDE.md` as a global system prompt.
- To avoid conflicts between local development and CI prompts, we keep PR-specific prompts in `.github/claude/` and pass them explicitly in workflows.

If you update our PR advisory/security style, edit the files in `.github/claude/` and not this notice.

