#!/bin/bash
# Pi5 SFTP Handshake Smoke Test
# Run from Fedora after Pi5 systemd service is updated

set -e

FEDORA_IP="127.0.0.1"
PI5_IP="127.0.0.1"
PI5_HEALTH_URL="http://${PI5_IP}:8000/health"
PI5_CAPTURE_URL="http://${PI5_IP}:8000/capture"
WATCH_DIR="/srv/cardmint/watch/incoming"

echo "=== Pi5 SFTP Handshake Smoke Test ==="
echo "Date: $(date)"
echo ""

# Test 1: Verify Fedora setup
echo "TEST 1: Verify Fedora SFTP server setup"
echo "----------------------------------------"
if systemctl is-active --quiet sshd; then
    echo "✅ sshd is running"
else
    echo "❌ sshd is not running"
    exit 1
fi

if [ -d "$WATCH_DIR" ]; then
    echo "✅ Watch directory exists: $WATCH_DIR"
else
    echo "❌ Watch directory missing: $WATCH_DIR"
    exit 1
fi

if [ "$(stat -c '%U:%G' $WATCH_DIR)" = "cardmint:cardmint" ]; then
    echo "✅ Watch directory ownership correct (cardmint:cardmint)"
else
    echo "⚠️  Watch directory ownership: $(stat -c '%U:%G' $WATCH_DIR)"
fi

if grep -q "cardmint-kiosk@cardmint-pi5" /home/cardmint/.ssh/authorized_keys; then
    echo "✅ Pi5 SSH key authorized"
else
    echo "❌ Pi5 SSH key not found in authorized_keys"
    exit 1
fi

echo ""

# Test 2: Verify network connectivity
echo "TEST 2: Verify network connectivity to Pi5"
echo "-------------------------------------------"
if ping -c 2 -W 2 "$PI5_IP" > /dev/null 2>&1; then
    echo "✅ Pi5 reachable at $PI5_IP"
else
    echo "❌ Cannot ping Pi5 at $PI5_IP"
    exit 1
fi

if curl -s --max-time 5 "$PI5_HEALTH_URL" > /dev/null; then
    echo "✅ Pi5 HTTP API responding"
else
    echo "❌ Pi5 HTTP API not responding"
    exit 1
fi

echo ""

# Test 3: Check Pi5 spool status
echo "TEST 3: Check Pi5 spool status"
echo "-------------------------------"
HEALTH_JSON=$(curl -s --max-time 5 "$PI5_HEALTH_URL")
SPOOL_STATUS=$(echo "$HEALTH_JSON" | jq -r '.spool.enabled')
QUEUED_PAIRS=$(echo "$HEALTH_JSON" | jq -r '.spool.queued_pairs')
SFTP_STATUS=$(echo "$HEALTH_JSON" | jq -r '.sftp.status')

echo "Spool enabled: $SPOOL_STATUS"
echo "Queued pairs: $QUEUED_PAIRS"
echo "SFTP status: $SFTP_STATUS"

if [ "$SPOOL_STATUS" != "true" ]; then
    echo "❌ Spool not enabled on Pi5"
    exit 1
fi

if [ "$SFTP_STATUS" = "not_configured" ]; then
    echo "⚠️  SFTP still showing as 'not_configured' - Pi5 systemd service may need restart"
    echo "   Run on Pi5: sudo systemctl restart cardmint-kiosk.service"
    exit 1
else
    echo "✅ SFTP configured on Pi5"
fi

echo ""

# Test 4: Trigger capture and verify drain
echo "TEST 4: Trigger capture and verify queue drain"
echo "-----------------------------------------------"
INITIAL_QUEUED=$QUEUED_PAIRS
echo "Initial queue depth: $INITIAL_QUEUED"

# Count existing files
INITIAL_FILE_COUNT=$(ls -1 "$WATCH_DIR" | wc -l)
echo "Initial files in watch directory: $INITIAL_FILE_COUNT"

echo "Triggering capture on Pi5..."
CAPTURE_RESPONSE=$(curl -s -X POST "$PI5_CAPTURE_URL")
CAPTURE_UID=$(echo "$CAPTURE_RESPONSE" | jq -r '.uid')

if [ -z "$CAPTURE_UID" ] || [ "$CAPTURE_UID" = "null" ]; then
    echo "❌ Capture failed or returned invalid UID"
    echo "Response: $CAPTURE_RESPONSE"
    exit 1
fi

echo "✅ Capture triggered: UID=$CAPTURE_UID"
echo "Waiting 10 seconds for SFTP transfer..."
sleep 10

# Check queue depth after transfer
NEW_HEALTH=$(curl -s --max-time 5 "$PI5_HEALTH_URL")
NEW_QUEUED=$(echo "$NEW_HEALTH" | jq -r '.spool.queued_pairs')
echo "New queue depth: $NEW_QUEUED"

# Check for files in watch directory
NEW_FILE_COUNT=$(ls -1 "$WATCH_DIR" | wc -l)
echo "Files in watch directory: $NEW_FILE_COUNT"

if [ "$NEW_FILE_COUNT" -gt "$INITIAL_FILE_COUNT" ]; then
    echo "✅ Files appeared in watch directory"
    echo "New files:"
    ls -lh "$WATCH_DIR" | tail -4
else
    echo "❌ No new files in watch directory"
    echo "Queue may not be draining. Check Pi5 logs:"
    echo "  ssh <user>@$PI5_IP sudo journalctl -u cardmint-kiosk -n 50"
    exit 1
fi

# Verify specific capture files exist
if ls "$WATCH_DIR"/*"$CAPTURE_UID"* > /dev/null 2>&1; then
    echo "✅ Capture files found with UID $CAPTURE_UID"
else
    echo "⚠️  Expected files with UID $CAPTURE_UID not found (may have different timestamp)"
fi

echo ""

# Test 5: Verify queue is draining
echo "TEST 5: Verify queue drain behavior"
echo "------------------------------------"
if [ "$NEW_QUEUED" -lt "$INITIAL_QUEUED" ] || [ "$NEW_QUEUED" -eq 0 ]; then
    echo "✅ Queue is draining (initial: $INITIAL_QUEUED, now: $NEW_QUEUED)"
else
    echo "⚠️  Queue depth unchanged or increased"
    echo "   This might indicate SFTP transfer issues"
    echo "   Check Pi5 service logs for errors"
fi

echo ""
echo "=== Smoke Test Summary ==="
echo "✅ Fedora SFTP server configured correctly"
echo "✅ Pi5 kiosk accessible and operational"
echo "✅ SFTP handshake successful"
echo "✅ Capture → SFTP → Watch folder flow working"
echo ""
echo "Next steps:"
echo "1. Run Phase 2 validation drills (burst ingestion, latency baseline)"
echo "2. Test backend ingestion from watch folder"
echo "3. Execute acceptance tests (TP-3/4/6)"
echo ""
echo "Watch folder contents:"
ls -lh "$WATCH_DIR"
