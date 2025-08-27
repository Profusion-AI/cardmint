#!/bin/bash
# Debug Info Collection - Run when you encounter issues
# Gathers comprehensive system state for copy/paste feedback

echo "🔍 CardMint Debug Info Collection"
echo "=================================="

# Timestamp
echo "📅 Timestamp: $(date)"
echo

# Service Status
echo "🚀 Service Status:"
echo "  API Health: $(curl -s http://localhost:3000/api/health | jq -r .status 2>/dev/null || echo 'OFFLINE')"
echo "  Port 3000: $(ss -tlnp | grep :3000 | wc -l) listeners"
echo "  Port 3001: $(ss -tlnp | grep :3001 | wc -l) listeners"
echo

# Recent Telemetry
echo "📊 Recent Telemetry (last 5 entries):"
tail -n 5 data/input-telemetry.csv
echo "  Total entries: $(( $(wc -l < data/input-telemetry.csv) - 1 ))"
echo

# API Status
echo "🔌 API Endpoints:"
curl -s http://localhost:3000/api/telemetry/input/summary 2>/dev/null | jq . || echo "  Summary API: ERROR"
echo

# Browser Files
echo "📁 Browser Assets:"
for file in input-bus-browser.js input-integration.js; do
    if curl -s "http://localhost:3000/lib/$file" | head -1 | grep -q "^//"; then
        echo "  ✅ /lib/$file: Available"
    else
        echo "  ❌ /lib/$file: Missing/Error"
    fi
done
echo

# Memory/CPU
echo "💻 System Resources:"
echo "  Memory: $(free -h | grep Mem | awk '{print $3 "/" $2}')"
echo "  CPU: $(top -bn1 | grep load | awk '{print $10 $11 $12}')"
echo

echo "📋 Copy this output for debugging assistance"