#!/usr/bin/env bash
# Kill all dev servers (backend + frontend)
# Usage: ./scripts/kill-dev-servers.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔════════════════════════════════════════╗"
echo "║  Killing All Dev Servers               ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Kill backend
echo "┌─ Backend (port 4000)"
"$SCRIPT_DIR/kill-backend.sh"
echo ""

# Kill frontend
echo "┌─ Frontend (port 5173)"
"$SCRIPT_DIR/kill-frontend.sh"
echo ""

# Remove stale compiled JS that can shadow TS/TSX sources in dev
echo "┌─ Frontend stale JS cleanup (src/**/*.js shadowing TSX)"
JS_CLEAN_COUNT=0
while IFS= read -r -d '' jsfile; do
  base="${jsfile%.js}"
  if [[ -f "${base}.tsx" || -f "${base}.ts" ]]; then
    rm -f "$jsfile" && JS_CLEAN_COUNT=$((JS_CLEAN_COUNT+1))
    echo "    removed: ${jsfile#$(git rev-parse --show-toplevel)/}"
  fi
done < <(find "$(cd "$SCRIPT_DIR/.." && pwd)/apps/frontend/src" -type f -name "*.js" -print0)
echo "    cleaned $JS_CLEAN_COUNT stale JS file(s)"
echo ""

# Kill LM Studio and KeepWarm
echo "┌─ LM Studio & KeepWarm"
# Match both AppImage and mounted processes (.mount_LM-Stu*/lm-studio)
LM_PIDS=$(pgrep -fi "lm-studio|lms server|[.]mount.*lm-studio" 2>/dev/null || true)
if [[ -n "$LM_PIDS" ]]; then
    echo "==> Stopping LM Studio (nuclear cleanup)..."
    # Force kill all lm-studio processes (including stopped/zombie)
    pkill -9 -fi "lm-studio" 2>/dev/null || true
    pkill -9 -fi "lms server" 2>/dev/null || true
    pkill -9 -fi "[.]mount.*lm-studio" 2>/dev/null || true
    sleep 1
    # Clean state files
    rm -f /tmp/cardmint-lmstudio-initialized.json 2>/dev/null || true
    echo "    ✅ LM Studio stopped (all processes cleaned)"
else
    echo "    LM Studio not running"
fi

# Force cleanup all keepwarm processes (including stopped/zombie)
KEEPWARM_PIDS=$(pgrep -f "cardmint-keepwarm-enhanced.py" 2>/dev/null || true)
if [[ -n "$KEEPWARM_PIDS" ]]; then
    echo "==> Stopping KeepWarm daemon (force cleanup)..."
    # Try graceful stop first
    python3 "$SCRIPT_DIR/cardmint-keepwarm-enhanced.py" --stop 2>/dev/null || true
    sleep 1
    # Force kill any remaining (stopped/zombie) processes
    pkill -9 -f "cardmint-keepwarm-enhanced.py" 2>/dev/null || true
    # Clean up state files
    rm -f /tmp/cardmint-keepwarm-enhanced.pid /tmp/cardmint-keepwarm-enhanced.state 2>/dev/null || true
    echo "    ✅ KeepWarm daemon stopped (all processes cleaned)"
else
    echo "    KeepWarm daemon not running"
fi
echo ""

echo "╔════════════════════════════════════════╗"
echo "║  ✅ All dev servers cleaned up         ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Ready to restart with:"
echo "  npm run dev:keepwarm   # Start LM Studio + model (1st)"
echo "  npm run dev:backend    # Start backend API (2nd)"
echo "  npm run dev:frontend   # Start operator UI (3rd)"
