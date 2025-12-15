#!/bin/bash
# Nuclear reset of LM Studio - kills all processes and cleans state

set -euo pipefail

echo "🔥 LM Studio Nuclear Reset"
echo ""

# Kill ALL lm-studio processes (including stopped/zombie)
echo "1️⃣  Killing all LM Studio processes..."
pkill -9 -fi "lm-studio" 2>/dev/null || true
pkill -9 -fi "lms server" 2>/dev/null || true
sleep 2

# Verify cleanup
remaining=$(ps aux | grep -Ei 'lm-studio|lms server|[.]mount.*lm-studio' | grep -v grep || true)
if [[ -n "$remaining" ]]; then
    echo "⚠️  Some processes still remain:"
    echo "$remaining"
    echo ""
    echo "Attempting force cleanup..."
    pkill -9 -fi "[.]mount.*lm-studio" 2>/dev/null || true
    sleep 1
fi

# Final check
final_check=$(ps aux | grep -Ei 'lm-studio|lms server|[.]mount.*lm-studio' | grep -v grep || true)
if [[ -z "$final_check" ]]; then
    echo "✅ All LM Studio processes terminated"
else
    echo "❌ Failed to kill all processes:"
    echo "$final_check"
    exit 1
fi

echo ""
echo "2️⃣  Cleaning state files..."
rm -f /tmp/cardmint-lmstudio-initialized.json 2>/dev/null || true
echo "✅ State files cleaned"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  ✅ LM Studio reset complete           ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Start LM Studio fresh:"
echo "     • From KDE: Press Super, type 'LM Studio'"
echo "     • From terminal: ./lmstudio-observability/start-lmstudio-intel.sh"
echo ""
echo "  2. Then start keepwarm:"
echo "     npm run dev:keepwarm"
echo ""
