#!/bin/bash

echo "Stopping CardMint..."
echo "==================="
echo

# Kill all CardMint related processes
pkill -f "tsx.*src/index.ts" 2>/dev/null || true
pkill -f "node.*src/index.ts" 2>/dev/null || true

# Check if any processes are still running
if pgrep -f "tsx.*src/index.ts" > /dev/null 2>&1; then
    echo "Some processes are still running. Force killing..."
    pkill -9 -f "tsx.*src/index.ts" 2>/dev/null || true
fi

if pgrep -f "node.*src/index.ts" > /dev/null 2>&1; then
    pkill -9 -f "node.*src/index.ts" 2>/dev/null || true
fi

echo "✓ CardMint stopped"
echo

# Show any remaining node processes
remaining=$(ps aux | grep -E "(tsx|node)" | grep -v grep | wc -l)
if [ "$remaining" -gt 0 ]; then
    echo "Note: $remaining Node.js processes are still running (may be unrelated to CardMint)"
    echo "Run 'ps aux | grep node' to see them"
fi