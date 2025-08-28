#!/usr/bin/env bash

# CardMint E2E runner with controller env
# Usage: ./scripts/e2e-run.sh

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "🚀 Starting CardMint in E2E mode with controller integration"

# Optional: clean up stray evtest holders
pkill -f "evtest" >/dev/null 2>&1 || true

# Load env
set -a
[ -f .env ] && source .env
[ -f .env.controller ] && source .env.controller
set +a

export NODE_ENV=${NODE_ENV:-development}
export E2E_NO_REDIS=${E2E_NO_REDIS:-true}

echo "Environment:"
echo "  NODE_ENV=$NODE_ENV"
echo "  E2E_NO_REDIS=$E2E_NO_REDIS"
echo "  CONTROLLER_KBD_EVENT=${CONTROLLER_KBD_EVENT:-}" 
echo "  CONTROLLER_KBD_BYID=${CONTROLLER_KBD_BYID:-}"

echo "Launching services (API + Dashboard)..."
npm run dev:full

