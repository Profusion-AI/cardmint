#!/bin/bash
# Pi5 Systemd Service SFTP Host Configuration Update
# Run this script ON THE PI5 to set the correct Fedora IP

set -e

FEDORA_IP="127.0.0.1"
SERVICE_FILE="/etc/systemd/system/cardmint-kiosk.service"
BACKUP_FILE="/etc/systemd/system/cardmint-kiosk.service.backup-$(date +%Y%m%d-%H%M%S)"

echo "=== Pi5 SFTP Host Configuration Update ==="
echo "Target Fedora IP: $FEDORA_IP"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ This script must be run as root (use sudo)"
    exit 1
fi

# Check if service file exists
if [ ! -f "$SERVICE_FILE" ]; then
    echo "❌ Service file not found: $SERVICE_FILE"
    exit 1
fi

# Backup current service file
echo "Creating backup: $BACKUP_FILE"
cp "$SERVICE_FILE" "$BACKUP_FILE"
echo "✅ Backup created"
echo ""

# Check current SFTP_HOST value
CURRENT_HOST=$(grep -E "^Environment=\"CARDMINT_SFTP_HOST=" "$SERVICE_FILE" | sed 's/.*CARDMINT_SFTP_HOST=\(.*\)"/\1/')
echo "Current CARDMINT_SFTP_HOST: '$CURRENT_HOST'"

if [ -z "$CURRENT_HOST" ]; then
    echo "⚠️  SFTP host is currently empty"
elif [ "$CURRENT_HOST" = "$FEDORA_IP" ]; then
    echo "✅ Already configured with correct IP: $FEDORA_IP"
    echo ""
    read -p "Restart service anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Exiting without changes"
        exit 0
    fi
else
    echo "⚠️  Different IP configured: $CURRENT_HOST"
fi

echo ""
echo "Updating service file with: CARDMINT_SFTP_HOST=$FEDORA_IP"

# Update the service file
sed -i "s|^Environment=\"CARDMINT_SFTP_HOST=.*\"|Environment=\"CARDMINT_SFTP_HOST=$FEDORA_IP\"|" "$SERVICE_FILE"

# Verify the change
NEW_HOST=$(grep -E "^Environment=\"CARDMINT_SFTP_HOST=" "$SERVICE_FILE" | sed 's/.*CARDMINT_SFTP_HOST=\(.*\)"/\1/')

if [ "$NEW_HOST" = "$FEDORA_IP" ]; then
    echo "✅ Service file updated successfully"
else
    echo "❌ Update failed. Restoring backup..."
    cp "$BACKUP_FILE" "$SERVICE_FILE"
    exit 1
fi

echo ""
echo "Reloading systemd daemon..."
systemctl daemon-reload
echo "✅ Daemon reloaded"

echo ""
echo "Restarting cardmint-kiosk service..."
systemctl restart cardmint-kiosk.service

# Wait for service to stabilize
sleep 3

# Check service status
if systemctl is-active --quiet cardmint-kiosk.service; then
    echo "✅ Service restarted successfully"
else
    echo "❌ Service failed to start. Check logs:"
    echo "   sudo journalctl -u cardmint-kiosk -n 50"
    exit 1
fi

echo ""
echo "Verifying service configuration..."
systemctl show cardmint-kiosk.service | grep CARDMINT_SFTP_HOST

echo ""
echo "Checking service health..."
sleep 2
curl -s http://localhost:8000/health | jq '.sftp'

echo ""
echo "=== Configuration Update Complete ==="
echo "✅ SFTP host set to: $FEDORA_IP"
echo "✅ Service restarted and healthy"
echo ""
echo "Next steps:"
echo "1. Test SFTP connection:"
echo "   sudo -u cardmint sftp cardmint@$FEDORA_IP"
echo ""
echo "2. Verify queue drain:"
echo "   curl -s http://localhost:8000/health | jq '.spool.queued_pairs'"
echo ""
echo "3. Trigger test capture:"
echo "   curl -X POST http://localhost:8000/capture"
echo ""
