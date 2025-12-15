#!/usr/bin/env bash
# Kill all frontend dev processes and free port 5173
# Usage: ./scripts/kill-frontend.sh

set -euo pipefail

echo "==> Checking for processes on port 5173..."
PIDS=$(lsof -ti:5173 2>/dev/null || true)

if [ -z "$PIDS" ]; then
    echo "    No processes found on port 5173"
else
    echo "    Found PIDs on port 5173: $PIDS"
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

echo "==> Checking for vite dev server processes..."
VITE_PIDS=$(pgrep -f "vite --strictPort" 2>/dev/null || true)

if [ -z "$VITE_PIDS" ]; then
    echo "    No vite dev server processes found"
else
    echo "    Found vite PIDs: $VITE_PIDS"
    for pid in $VITE_PIDS; do
        echo "    Killing vite process $pid"
        kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
fi

# Final verification
echo "==> Final verification..."
if lsof -ti:5173 >/dev/null 2>&1; then
    echo "    ❌ Port 5173 is still occupied"
    exit 1
else
    echo "    ✅ Port 5173 is free"
fi

if pgrep -f "vite --strictPort" >/dev/null 2>&1; then
    echo "    ❌ Vite dev server processes still running"
    exit 1
else
    echo "    ✅ No stale vite processes"
fi

echo ""
echo "✅ Frontend processes cleaned up - ready to restart"
