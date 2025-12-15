#!/usr/bin/env bash
# Launch Pi5 Capture Lab UI in browser
set -euo pipefail

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SELF_DIR/.." && pwd)
SERVER="$SELF_DIR/capture-lab-server.mjs"
PORT=3333
URL="http://localhost:$PORT"

echo "🔬 Starting Pi5 Capture Lab UI..."

# Open browser after short delay (background)
(sleep 2 && {
  if command -v xdg-open &>/dev/null; then
    xdg-open "$URL" 2>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$URL" 2>/dev/null || true
  else
    echo "   → Open manually: $URL"
  fi
}) &

# Start server (foreground, Ctrl+C to stop)
cd "$ROOT_DIR"
node "$SERVER"
