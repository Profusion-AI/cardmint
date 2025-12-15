#!/usr/bin/env bash
# Kill all backend dev processes and free port 4000
# Usage: ./scripts/kill-backend.sh

set -euo pipefail

echo "==> Checking for processes on port 4000..."
PIDS=$(lsof -ti:4000 2>/dev/null || true)

if [ -z "$PIDS" ]; then
    echo "    No processes found on port 4000"
else
    echo "    Found PIDs on port 4000: $PIDS"
    for pid in $PIDS; do
        # Get parent PID
        PARENT_PID=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
        if [ -n "$PARENT_PID" ] && [ "$PARENT_PID" != "1" ]; then
            echo "    Killing parent process $PARENT_PID and child $pid"
            kill -9 "$PARENT_PID" "$pid" 2>/dev/null || true
        else
            echo "    Killing process $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    sleep 1
fi

echo "==> Checking for tsx watch processes..."
TSX_PIDS=$(pgrep -f "tsx watch src/server.ts" 2>/dev/null || true)

if [ -z "$TSX_PIDS" ]; then
    echo "    No tsx watch processes found"
else
    echo "    Found tsx watch PIDs: $TSX_PIDS"
    for pid in $TSX_PIDS; do
        echo "    Killing tsx watch process $pid"
        kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
fi

echo "==> Checking for npm parent processes..."
NPM_PIDS=$(pgrep -f "npm.*dev:backend" 2>/dev/null || true)

if [ -z "$NPM_PIDS" ]; then
    echo "    No npm dev:backend processes found"
else
    echo "    Found npm dev:backend PIDs: $NPM_PIDS"
    for pid in $NPM_PIDS; do
        echo "    Killing npm parent process $pid and its children"
        # Kill the entire process group
        pkill -9 -P "$pid" 2>/dev/null || true
        kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
fi

# Final verification
echo "==> Final verification..."
if lsof -ti:4000 >/dev/null 2>&1; then
    echo "    ❌ Port 4000 is still occupied"
    exit 1
else
    echo "    ✅ Port 4000 is free"
fi

if pgrep -f "tsx watch src/server.ts" >/dev/null 2>&1; then
    echo "    ❌ tsx watch processes still running"
    exit 1
else
    echo "    ✅ No stale tsx watch processes"
fi

echo ""
echo "✅ Backend processes cleaned up - ready to restart"
