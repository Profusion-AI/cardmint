#!/bin/bash
# Development State Reset - Run between testing iterations
# Ensures clean state for human-in-the-loop testing

set -e

echo "🧹 CardMint Development Reset"

# 1. Clear telemetry data but preserve headers
echo "Clearing CSV telemetry data..."
echo "ts,source,action,cardId,cycleId,latencyMs,error" > data/input-telemetry.csv

# 2. Clear browser localStorage (via API)
echo "Clearing browser storage..."
curl -s -X DELETE http://localhost:3000/api/dev/clear-storage || echo "API not running, skipping"

# 3. Reset queue state
if [ -f "data/queue-state.json" ]; then
    echo '{"currentIndex": 0, "items": []}' > data/queue-state.json
    echo "Reset queue state"
fi

# 4. Clear any temp files
find data/ -name "temp_*" -delete 2>/dev/null || true
find data/ -name "*.tmp" -delete 2>/dev/null || true

# 5. Show current state
echo "📊 Current State:"
echo "  - Telemetry CSV: $(wc -l < data/input-telemetry.csv) lines (header only)"
echo "  - Data directory: $(ls -la data/ | wc -l) files"
echo "  - Temp files: $(find . -name "*.tmp" | wc -l) remaining"

echo "✅ Reset complete - ready for fresh testing"