#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI 'gh' not found. Install from https://cli.github.com/" >&2
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-number-or-url>" >&2
  exit 1
fi

PR="$1"

echo "Fetching comments for PR: $PR" >&2
gh pr view "$PR" --comments || {
  echo "Failed to fetch PR comments. Ensure you ran 'gh auth login' and have repo access." >&2
  exit 1
}
