#!/usr/bin/env bash
set -euo pipefail

# Oct 8 Smoke Test: Forced Timeout Retry/Fallback Validation
# Tests Path A retry with forced timeout → fallback to Path B

BACKEND_URL="http://localhost:4000"
METRICS_BEFORE=$(mktemp)
METRICS_AFTER=$(mktemp)
SERVER_LOG=$(mktemp)
SERVER_PID=""

cleanup() {
  echo
  echo "Cleaning up..."
  rm -f "$METRICS_BEFORE" "$METRICS_AFTER"
  # Kill server if still running
  if [ -n "${SERVER_PID}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  Killing server process $SERVER_PID..."
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 2
  fi
  # Ensure port 4000 is clear
  lsof -ti:4000 | xargs -r kill -9 2>/dev/null || true
  echo "  Cleanup complete"
}
trap cleanup EXIT

echo "=== Oct 8 Smoke Test: Forced Timeout Retry/Fallback ==="
echo

# Step 0: Pre-check - ensure no servers running on port 4000
echo "Step 0: Checking for existing servers on port 4000..."
if lsof -ti:4000 >/dev/null 2>&1; then
  echo "  Killing existing processes on port 4000..."
  lsof -ti:4000 | xargs kill -9 2>/dev/null || true
  sleep 2
fi
echo "  Port 4000 is clear"
echo

# Step 1: Start server with forced timeout
echo "Step 1: Starting server with OPENAI_TIMEOUT_MS=1 (forced timeout)..."
cd /home/kyle/CardMint-workspace/apps/backend
export OPENAI_TIMEOUT_MS=1
npm run dev > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "  Server PID: $SERVER_PID"
echo "  Waiting 10s for server to start..."
sleep 10

# Step 2: Check server health
echo "Step 2: Checking server health..."
HEALTH=$(curl -s "$BACKEND_URL/health" || echo "FAILED")
if [[ "$HEALTH" == "FAILED" ]]; then
  echo "  ERROR: Server failed to start"
  echo "  Server log:"
  cat "$SERVER_LOG"
  exit 1
fi
echo "  Server is healthy"
echo

# Step 3: Capture baseline metrics
echo "Step 3: Capturing baseline metrics..."
curl -s "$BACKEND_URL/metrics" > "$METRICS_BEFORE"
A_LANE_RETRIES_BEFORE=$(jq -r '.counters.a_lane_retries_total' "$METRICS_BEFORE")
A_LANE_RETRY_SUCCESS_BEFORE=$(jq -r '.counters.a_lane_retry_success_total' "$METRICS_BEFORE")
FALLBACKS_BEFORE=$(jq -r '.counters.fallbacks_to_lmstudio_total' "$METRICS_BEFORE")
QUEUE_DEPTH=$(jq -r '.gauges.queue_depth_current' "$METRICS_BEFORE")
SHADOW_ENABLED=$(jq -r '.gauges.shadow_lane_enabled' "$METRICS_BEFORE")

echo "  a_lane_retries_total: $A_LANE_RETRIES_BEFORE"
echo "  a_lane_retry_success_total: $A_LANE_RETRY_SUCCESS_BEFORE"
echo "  fallbacks_to_lmstudio_total: $FALLBACKS_BEFORE"
echo "  queue_depth_current: $QUEUE_DEPTH"
echo "  shadow_lane_enabled: $SHADOW_ENABLED"
echo

# Step 4: Find test image
echo "Step 4: Finding test image..."
TEST_IMAGE=$(ls /home/kyle/CardMint-workspace/pokemoncards/kyle-test/*.png | head -1)
echo "  Using: $TEST_IMAGE"
echo

# Step 5: Submit job (should trigger timeout → retry → fallback)
echo "Step 5: Submitting job with forced timeout..."
JOB_RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"imagePath\": \"$TEST_IMAGE\", \"sessionId\": \"smoke-test-timeout\"}")
JOB_ID=$(echo "$JOB_RESPONSE" | jq -r '.job.id')
echo "  Job created: $JOB_ID"
echo "  Waiting for job to complete (max 60s for LM Studio fallback)..."

for i in {1..60}; do
  sleep 1
  JOB_STATUS=$(curl -s "$BACKEND_URL/api/jobs/recent" | jq -r ".jobs[] | select(.id == \"$JOB_ID\") | .status" 2>/dev/null || echo "PENDING")
  if [ "$JOB_STATUS" = "OPERATOR_PENDING" ] || [ "$JOB_STATUS" = "FAILED" ]; then
    echo "  Job completed with status: $JOB_STATUS (after ${i}s)"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "  WARNING: Job did not complete within 60s (current status: $JOB_STATUS)"
  fi
done
echo

# Step 6: Check metrics after forced timeout
echo "Step 6: Checking metrics after forced timeout..."
curl -s "$BACKEND_URL/metrics" > "$METRICS_AFTER"
A_LANE_RETRIES_AFTER=$(jq -r '.counters.a_lane_retries_total' "$METRICS_AFTER")
A_LANE_RETRY_SUCCESS_AFTER=$(jq -r '.counters.a_lane_retry_success_total' "$METRICS_AFTER")
FALLBACKS_AFTER=$(jq -r '.counters.fallbacks_to_lmstudio_total' "$METRICS_AFTER")

echo "  a_lane_retries_total: $A_LANE_RETRIES_AFTER (delta: $((A_LANE_RETRIES_AFTER - A_LANE_RETRIES_BEFORE)))"
echo "  a_lane_retry_success_total: $A_LANE_RETRY_SUCCESS_AFTER (delta: $((A_LANE_RETRY_SUCCESS_AFTER - A_LANE_RETRY_SUCCESS_BEFORE)))"
echo "  fallbacks_to_lmstudio_total: $FALLBACKS_AFTER (delta: $((FALLBACKS_AFTER - FALLBACKS_BEFORE)))"
echo

# Step 7: Get job details to check retry metadata
echo "Step 7: Checking job retry metadata..."
JOB_DETAILS=$(curl -s "$BACKEND_URL/api/jobs/recent" | jq ".jobs[] | select(.id == \"$JOB_ID\")")
if [ -z "$JOB_DETAILS" ] || [ "$JOB_DETAILS" = "null" ]; then
  echo "  ERROR: Job $JOB_ID not found in /api/jobs/recent (queue lag?)"
  echo "  Available jobs:"
  curl -s "$BACKEND_URL/api/jobs/recent" | jq -r '.jobs[] | .id'
  exit 1
fi
RETRIED_ONCE=$(echo "$JOB_DETAILS" | jq -r '.timings.retried_once // false')
INFER_MS=$(echo "$JOB_DETAILS" | jq -r '.timings.infer_ms // 0')
echo "  retried_once: $RETRIED_ONCE"
echo "  infer_ms: $INFER_MS"
echo

# Step 8: Check server logs for retry/fallback messages
echo "Step 8: Checking server logs for retry/fallback evidence..."
if grep -q "Path A (OpenAI) failed after retry" "$SERVER_LOG"; then
  echo "  ✓ Found Path A retry failure log"
else
  echo "  ✗ Missing Path A retry failure log"
fi

if grep -q "falling back to Path B" "$SERVER_LOG"; then
  echo "  ✓ Found fallback to Path B log"
else
  echo "  ✗ Missing fallback log"
fi
echo

# Step 9: Validation summary
echo "=== Validation Summary ==="
PASS=true

if [ "$JOB_STATUS" != "OPERATOR_PENDING" ]; then
  echo "✗ Job did not complete successfully (status: $JOB_STATUS)"
  PASS=false
else
  echo "✓ Job completed successfully"
fi

if [ $((A_LANE_RETRIES_AFTER - A_LANE_RETRIES_BEFORE)) -ge 1 ]; then
  echo "✓ a_lane_retries_total incremented (expected: ≥1, actual: $((A_LANE_RETRIES_AFTER - A_LANE_RETRIES_BEFORE)))"
else
  echo "✗ a_lane_retries_total did NOT increment"
  PASS=false
fi

if [ $((FALLBACKS_AFTER - FALLBACKS_BEFORE)) -ge 1 ]; then
  echo "✓ fallbacks_to_lmstudio_total incremented (expected: ≥1, actual: $((FALLBACKS_AFTER - FALLBACKS_BEFORE)))"
else
  echo "✗ fallbacks_to_lmstudio_total did NOT increment"
  PASS=false
fi

if [ "$RETRIED_ONCE" = "true" ]; then
  echo "✓ Retry metadata preserved (retried_once: true)"
else
  echo "✗ Retry metadata NOT preserved (retried_once: $RETRIED_ONCE)"
  PASS=false
fi

if [ "$INFER_MS" -gt 10000 ]; then
  echo "✓ Inference time suggests LM Studio fallback (${INFER_MS}ms > 10000ms)"
else
  echo "⚠ Inference time lower than expected for LM Studio (${INFER_MS}ms)"
fi

echo
if [ "$PASS" = true ]; then
  echo "=== SMOKE TEST PASSED ==="
else
  echo "=== SMOKE TEST FAILED ==="
  echo
  echo "Server log tail (last 30 lines):"
  tail -30 "$SERVER_LOG"
  exit 1
fi

echo
echo "Full server log available at: $SERVER_LOG"
echo "(Copying to results/ for archival)"
mkdir -p /home/kyle/CardMint-workspace/results
cp "$SERVER_LOG" "/home/kyle/CardMint-workspace/results/forced-timeout-smoke-$(date +%Y%m%d-%H%M%S).log"
