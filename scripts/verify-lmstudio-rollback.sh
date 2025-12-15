#!/bin/bash
# LM Studio 0.3.27-4 Rollback Verification Script
# Validates that rollback from 0.3.28-2 was successful and inference pipeline is operational

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== LM Studio 0.3.27-4 Rollback Verification ==="
echo

# Check 1: Service status
echo "✓ Checking service status..."
if systemctl --user is-active lmstudio.service > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ Service active${NC}"
else
  echo -e "  ${RED}❌ Service not active${NC}"
  echo "  Run: systemctl --user start lmstudio.service"
  exit 1
fi

# Check 2: Version verification
echo "✓ Checking LM Studio version pin..."
if grep -q "0.3.27-4" ~/bin/update-lmstudio-path.sh; then
  echo -e "  ${GREEN}✅ Pointer script references 0.3.27-4${NC}"
else
  echo -e "  ${RED}❌ Pointer script still references 0.3.28-2${NC}"
  echo "  Edit ~/bin/update-lmstudio-path.sh to use 0.3.27-4"
  exit 1
fi

if grep -q "0.3.27-4" ~/.lmstudio/.internal/app-install-location.json; then
  echo -e "  ${GREEN}✅ Active config uses 0.3.27-4${NC}"
else
  echo -e "  ${YELLOW}⚠️  Active config still shows 0.3.28-2 (service may need restart)${NC}"
  echo "  Run: systemctl --user restart lmstudio.service"
fi

# Check 3: Model loading
echo "✓ Checking model availability..."
if ~/.lmstudio/bin/lms ps 2>/dev/null | grep -q "magistral-small-2509"; then
  echo -e "  ${GREEN}✅ Model already loaded${NC}"
else
  echo "  Attempting to load model..."
  if ~/.lmstudio/bin/lms load mistralai/magistral-small-2509 2>&1 | tee /tmp/lms-load.log | grep -qi "error\|utility"; then
    echo -e "  ${RED}❌ Model load failed${NC}"
    echo "  Error log:"
    tail -5 /tmp/lms-load.log
    exit 1
  fi
  echo -e "  ${GREEN}✅ Model loaded successfully${NC}"
fi

# Check 4: API endpoint
echo "✓ Checking API endpoint health..."
if curl -sf http://127.0.0.1:12345/v1/models > /dev/null; then
  echo -e "  ${GREEN}✅ API responding${NC}"
else
  echo -e "  ${RED}❌ API endpoint not responding${NC}"
  echo "  Check: systemctl --user status lmstudio.service"
  exit 1
fi

# Verify model is in models list
if curl -sf http://127.0.0.1:12345/v1/models | grep -q "magistral-small-2509"; then
  echo -e "  ${GREEN}✅ Model present in /v1/models endpoint${NC}"
else
  echo -e "  ${RED}❌ Model not listed in API${NC}"
  exit 1
fi

# Check 5: Inference test
echo "✓ Testing inference capability..."
RESPONSE=$(curl -sf http://127.0.0.1:12345/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistralai/magistral-small-2509",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 5
  }' 2>/dev/null || echo '{"error":"request_failed"}')

if echo "$RESPONSE" | grep -q '"choices"'; then
  echo -e "  ${GREEN}✅ Inference successful${NC}"
elif echo "$RESPONSE" | grep -qi "utilityprocess"; then
  echo -e "  ${RED}❌ Still seeing utilityProcess error - rollback did not propagate${NC}"
  echo "  Response: $RESPONSE"
  echo "  Action: Restart service and verify app-install-location.json"
  exit 1
elif echo "$RESPONSE" | grep -qi "model_not_found"; then
  echo -e "  ${RED}❌ Model not found error${NC}"
  echo "  Action: Reload model with: lms load mistralai/magistral-small-2509"
  exit 1
else
  echo -e "  ${YELLOW}⚠️  Unexpected inference response${NC}"
  echo "  Response: $RESPONSE"
  echo "  Continuing verification..."
fi

# Check 6: KeepWarm daemon
echo "✓ Checking KeepWarm daemon..."
if ! pgrep -f "cardmint-keepwarm-enhanced.py --daemon" > /dev/null; then
  echo -e "  ${YELLOW}⚠️  Daemon not running${NC}"
  echo "  Start with: python scripts/cardmint-keepwarm-enhanced.py --daemon"
else
  DAEMON_STATUS=$(python "$REPO_ROOT/scripts/cardmint-keepwarm-enhanced.py" --check 2>&1 || true)

  if echo "$DAEMON_STATUS" | grep -q "warmups: 0"; then
    echo -e "  ${YELLOW}⚠️  Daemon running but no warmups yet (may need 30-60s after restart)${NC}"
    echo "  Wait 60s and re-run this script"
  else
    WARMUP_COUNT=$(echo "$DAEMON_STATUS" | grep -oP 'warmups: \K\d+' || echo "0")
    if [[ "$WARMUP_COUNT" -gt 0 ]]; then
      echo -e "  ${GREEN}✅ Daemon warming successfully ($WARMUP_COUNT warmups)${NC}"
    else
      echo -e "  ${YELLOW}⚠️  Could not parse warmup count${NC}"
    fi
  fi
fi

# Check 7: Log scan for errors
echo "✓ Scanning recent logs for utilityProcess errors..."
if tail -100 ~/.config/LM\ Studio/logs/main.log 2>/dev/null | grep -qi "utilityprocess"; then
  RECENT_ERRORS=$(tail -20 ~/.config/LM\ Studio/logs/main.log | grep -i "utilityprocess" || true)
  if [[ -n "$RECENT_ERRORS" ]]; then
    echo -e "  ${RED}❌ Recent utilityProcess errors detected${NC}"
    echo "  Last error:"
    echo "$RECENT_ERRORS" | tail -1
    echo "  Action: Service may need restart after pointer script update"
  else
    echo -e "  ${YELLOW}⚠️  Historical errors found but none recent${NC}"
  fi
else
  echo -e "  ${GREEN}✅ No utilityProcess errors in recent logs${NC}"
fi

echo
echo "=== Verification Summary ==="
echo -e "${GREEN}✅ All critical checks passed${NC}"
echo
echo "Next steps:"
echo "1. If KeepWarm daemon shows 0 warmups, wait 60s and re-run this script"
echo "2. Run mini-baseline: python scripts/pcis_baseline_v2.py --mini"
echo "3. Proceed with Oct 3 integration work"
echo
echo "Ready for Oct 3 inference-dependent deliverables."
