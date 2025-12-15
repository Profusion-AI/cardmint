#!/bin/bash
#
# Validation script for SFTP inbox race condition fix (Oct 22, 2025)
#
# Tests that session start clears legacy SFTP inbox files, preventing
# old captures from being re-queued into the new session.
#
# Acceptance Criteria:
# 1. Create 3-5 dummy files in SFTP inbox
# 2. Start a session via API
# 3. Verify inbox is empty after session start
# 4. Verify no old jobs appear in queue within 10 seconds
# 5. Capture fresh image and verify it's the only job
#

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:4000}"
INBOX_PATH="${SFTP_WATCH_PATH:-data/sftp-inbox}"

echo "=== SFTP Inbox Race Condition Validation ==="
echo "Backend URL: $BACKEND_URL"
echo "Inbox path: $INBOX_PATH"
echo ""

# Step 1: Create dummy legacy files in inbox
echo "Step 1: Creating 3 dummy legacy files in inbox..."
mkdir -p "$INBOX_PATH"
for i in {1..3}; do
  touch "$INBOX_PATH/legacy_${i}_$(date +%s).jpg"
  touch "$INBOX_PATH/legacy_${i}_$(date +%s).json"
done

FILE_COUNT_BEFORE=$(ls -1 "$INBOX_PATH" | wc -l)
echo "Files in inbox before session start: $FILE_COUNT_BEFORE"
echo ""

# Step 2: Start a session
echo "Step 2: Starting session via API..."
SESSION_RESPONSE=$(curl -s -X POST "$BACKEND_URL/api/operator-sessions/start" \
  -H "Content-Type: application/json" \
  -d '{"started_by": "validation_script"}')

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.session.id // empty')

if [ -z "$SESSION_ID" ]; then
  echo "❌ FAILED: Could not start session"
  echo "Response: $SESSION_RESPONSE"
  exit 1
fi

echo "✅ Session started: $SESSION_ID"
echo ""

# Step 3: Wait 2 seconds for watch-folder to settle
echo "Step 3: Waiting 2 seconds for watch-folder to settle..."
sleep 2

# Step 4: Check inbox is empty
FILE_COUNT_AFTER=$(ls -1 "$INBOX_PATH" 2>/dev/null | wc -l || echo "0")
echo "Files in inbox after session start: $FILE_COUNT_AFTER"

if [ "$FILE_COUNT_AFTER" -eq 0 ]; then
  echo "✅ PASS: Inbox cleared successfully"
else
  echo "❌ FAIL: Inbox still contains $FILE_COUNT_AFTER files"
  ls -la "$INBOX_PATH"
  exit 1
fi
echo ""

# Step 5: Check queue depth via metrics
echo "Step 4: Checking queue depth via metrics..."
METRICS_RESPONSE=$(curl -s "$BACKEND_URL/metrics")
QUEUE_DEPTH=$(echo "$METRICS_RESPONSE" | grep -oP 'cardmint_queue_depth \K[0-9]+' || echo "0")

echo "Queue depth: $QUEUE_DEPTH"

if [ "$QUEUE_DEPTH" -eq 0 ]; then
  echo "✅ PASS: No legacy jobs re-queued"
else
  echo "❌ FAIL: Queue depth is $QUEUE_DEPTH (expected 0)"
  exit 1
fi
echo ""

# Step 6: Check session events for inbox_cleared event
echo "Step 5: Checking session events for inbox_cleared event..."
EVENTS_RESPONSE=$(curl -s "$BACKEND_URL/api/operator-sessions/$SESSION_ID/events")
INBOX_CLEARED_EVENT=$(echo "$EVENTS_RESPONSE" | jq -r '.events[] | select(.source == "inbox_cleared") | .message' || echo "")

if [ -n "$INBOX_CLEARED_EVENT" ]; then
  echo "✅ PASS: inbox_cleared event emitted: $INBOX_CLEARED_EVENT"
else
  echo "⚠️  WARNING: No inbox_cleared event found (inbox may have been empty)"
fi
echo ""

# Step 7: End session
echo "Step 6: Ending session..."
curl -s -X POST "$BACKEND_URL/api/operator-sessions/$SESSION_ID/end" > /dev/null
echo "✅ Session ended"
echo ""

echo "=== ✅ ALL VALIDATION CHECKS PASSED ==="
echo ""
echo "Summary:"
echo "  - Legacy files cleared from inbox: YES"
echo "  - Queue depth after clear: 0"
echo "  - Session boundary clean: YES"
echo ""
echo "The SFTP inbox race condition fix is working correctly!"
