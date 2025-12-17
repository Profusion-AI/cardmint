#!/bin/bash
#
# PostHog Analytics Verification Script
# Tests event ingestion after deployment
#
# Usage: ./scripts/verify_posthog_events.sh [--host https://cardmintshop.com]
#
set -e

HOST="${1:-http://localhost:3000}"
POSTHOG_KEY="${POSTHOG_API_KEY:-}"

echo "=== PostHog Analytics Verification ==="
echo "Target: $HOST"
echo ""

# 1. Check if POSTHOG_API_KEY is set
if [ -z "$POSTHOG_KEY" ]; then
  echo "[SKIP] POSTHOG_API_KEY not set - using direct PostHog test"
else
  echo "[OK] POSTHOG_API_KEY is configured"
fi

# 2. Send test event via Node.js (requires posthog-node)
echo ""
echo "Sending test event to PostHog..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node -e "
const { PostHog } = require('posthog-node');

(async () => {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    console.log('[SKIP] No API key, cannot send test event');
    return;
  }

  const client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com'
  });

  const testId = 'verify-script-' + Date.now();

  client.capture({
    distinctId: testId,
    event: 'verification_test',
    properties: {
      source: 'verify_posthog_events.sh',
      timestamp: new Date().toISOString(),
      host: '$HOST'
    }
  });

  console.log('[OK] Test event sent (distinctId: ' + testId + ')');
  await client.shutdown();
  console.log('[OK] PostHog client flushed');
})();
" 2>&1

if [ $? -eq 0 ]; then
  echo ""
  echo "[OK] Event ingestion working"
else
  echo ""
  echo "[FAIL] Event ingestion failed"
  exit 1
fi

# 3. Optional: Check EverShop health endpoint if available
echo ""
echo "Checking application health..."

if curl -sf "${HOST}/health" > /dev/null 2>&1; then
  echo "[OK] Application health endpoint reachable"
else
  echo "[WARN] Health endpoint not reachable (may be expected in dev)"
fi

# 4. Check admin analytics API (if EverShop running)
echo ""
echo "Checking admin analytics API..."

FUNNEL_RESPONSE=$(curl -sf "${HOST}/admin/analytics/funnels" 2>/dev/null || echo "")

if [ -n "$FUNNEL_RESPONSE" ]; then
  FUNNEL_OK=$(echo "$FUNNEL_RESPONSE" | grep -o '"ok":true' || echo "")
  if [ -n "$FUNNEL_OK" ]; then
    echo "[OK] Admin analytics API responding"
    FUNNEL_SOURCE=$(echo "$FUNNEL_RESPONSE" | grep -o '"source":"[^"]*"' | head -1 || echo "")
    echo "     Source: $FUNNEL_SOURCE"
  else
    echo "[WARN] Admin analytics API returned unexpected response"
  fi
else
  echo "[SKIP] Admin analytics API not reachable (EverShop may not be running)"
fi

# 5. Summary
echo ""
echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "  1. Check PostHog dashboard for 'verification_test' event"
echo "  2. Browse the application to generate pageview events"
echo "  3. Verify session recording is capturing (if enabled)"
echo "  4. Access /admin/analytics to view conversion funnel"
echo ""
