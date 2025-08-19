#!/bin/bash
#
# Emergency Rollback Script for VLM Optimization
# 
# This script immediately disables VLM and reverts to legacy OCR processing.
# Use in case of critical issues with VLM implementation.
#

set -e

echo "🚨 EMERGENCY VLM ROLLBACK INITIATED 🚨"
echo "========================================="
echo "Timestamp: $(date)"
echo ""

# 1. Set emergency kill switch
echo "1. Activating emergency kill switch..."
export VLM_EMERGENCY_KILL=true
export VLM_ENABLED=false
export VLM_PERCENTAGE=0

# 2. Update .env.vlm file
echo "2. Updating .env.vlm configuration..."
if [ -f .env.vlm ]; then
    cp .env.vlm .env.vlm.backup.$(date +%Y%m%d-%H%M%S)
    sed -i 's/VLM_ENABLED=.*/VLM_ENABLED=false/' .env.vlm
    sed -i 's/VLM_SHADOW_MODE=.*/VLM_SHADOW_MODE=false/' .env.vlm
    sed -i 's/VLM_PERCENTAGE=.*/VLM_PERCENTAGE=0/' .env.vlm
    sed -i 's/VLM_EMERGENCY_KILL=.*/VLM_EMERGENCY_KILL=true/' .env.vlm
    echo "   ✓ .env.vlm updated"
fi

# 3. Restart services if running
echo "3. Checking for running services..."
if pgrep -f "npm run dev" > /dev/null; then
    echo "   - Stopping Node.js services..."
    pkill -f "npm run dev" || true
    sleep 2
    echo "   - Restarting with legacy configuration..."
    npm run dev &
    echo "   ✓ Services restarted"
else
    echo "   - No services currently running"
fi

# 4. Clear VLM cache if Redis is running
echo "4. Clearing VLM cache..."
if command -v redis-cli &> /dev/null; then
    redis-cli --scan --pattern "vlm:*" | xargs -r redis-cli del 2>/dev/null || true
    echo "   ✓ VLM cache cleared"
else
    echo "   - Redis not available, skipping cache clear"
fi

# 5. Log rollback event
echo "5. Logging rollback event..."
ROLLBACK_LOG="logs/vlm-rollback-$(date +%Y%m%d-%H%M%S).log"
mkdir -p logs
cat > "$ROLLBACK_LOG" << EOF
VLM Emergency Rollback Log
==========================
Timestamp: $(date)
Reason: Manual emergency rollback triggered
Previous State:
  - VLM_ENABLED: ${VLM_ENABLED:-unknown}
  - VLM_PERCENTAGE: ${VLM_PERCENTAGE:-unknown}
  - VLM_SHADOW_MODE: ${VLM_SHADOW_MODE:-unknown}
Current State:
  - VLM_ENABLED: false
  - VLM_PERCENTAGE: 0
  - VLM_EMERGENCY_KILL: true
System Info:
  - CPU Usage: $(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)%
  - Memory: $(free -m | awk 'NR==2{printf "%s/%sMB (%.2f%%)", $3,$2,$3*100/$2 }')
  - Load Average: $(uptime | awk -F'load average:' '{print $2}')
EOF
echo "   ✓ Rollback logged to $ROLLBACK_LOG"

# 6. Verify legacy OCR is working
echo "6. Verifying legacy OCR functionality..."
if [ -f "test-images/pikachu.jpg" ]; then
    echo "   - Testing OCR on sample image..."
    python3 -c "
import sys
sys.path.insert(0, 'src/ocr')
from paddleocr_service import CardOCRService
service = CardOCRService()
result = service.process_card('test-images/pikachu.jpg', high_accuracy=False)
if result.get('success'):
    print('   ✓ Legacy OCR verified working')
else:
    print('   ⚠ Legacy OCR test failed:', result.get('error'))
" 2>/dev/null || echo "   ⚠ Could not verify OCR (non-critical)"
else
    echo "   - No test image available, skipping verification"
fi

echo ""
echo "✅ EMERGENCY ROLLBACK COMPLETE"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Check $ROLLBACK_LOG for details"
echo "2. Investigate the issue that triggered rollback"
echo "3. Fix the issue before re-enabling VLM"
echo "4. To re-enable VLM, edit .env.vlm and set:"
echo "   - VLM_EMERGENCY_KILL=false"
echo "   - VLM_ENABLED=true (only after fixing issues)"
echo ""
echo "Legacy OCR processing is now active."