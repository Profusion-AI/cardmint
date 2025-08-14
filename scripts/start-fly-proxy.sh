#!/bin/bash

# Start Fly.io Managed Postgres Proxy
# Cluster: gjpkdon11dy0yln4
# Region: IAD

FLYCTL="flyctl"
if ! command -v flyctl &> /dev/null; then
    FLYCTL="/home/profusionai/.fly/bin/flyctl"
fi

echo "====================================="
echo "Starting Fly.io Database Proxy"
echo "====================================="
echo "Cluster ID: gjpkdon11dy0yln4"
echo "Region: IAD"
echo "Local Port: 16360"
echo "====================================="
echo ""

# Check if proxy is already running
if lsof -Pi :16360 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️ Port 16360 is already in use."
    echo "A proxy might already be running."
    echo ""
    echo "To stop the existing proxy:"
    echo "  kill \$(lsof -Pi :16360 -sTCP:LISTEN -t)"
    echo ""
    read -p "Kill existing proxy? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill $(lsof -Pi :16360 -sTCP:LISTEN -t) 2>/dev/null
        echo "✓ Killed existing proxy"
        sleep 2
    else
        echo "Exiting..."
        exit 1
    fi
fi

echo "Starting proxy..."
echo "Keep this terminal open while developing."
echo "Press Ctrl+C to stop the proxy."
echo ""

# Start the proxy using managed postgres command
# Note: For direct connection, use: fly mpg connect
$FLYCTL mpg proxy 16360 --cluster gjpkdon11dy0yln4