#!/bin/bash

echo "CardMint Clean Start"
echo "===================="
echo

# Kill any existing CardMint processes
echo "Cleaning up existing processes..."
pkill -f "tsx.*src/index.ts" 2>/dev/null || true
pkill -f "node.*src/index.ts" 2>/dev/null || true

# Wait for ports to be released
sleep 2

# Check if ports are free
for port in 3000 3001 9091; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "❌ Port $port is still in use. Killing process..."
        lsof -Pi :$port -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
done

echo "✓ All ports cleared"
echo

# Check if Redis is running
if ! redis-cli ping > /dev/null 2>&1; then
    echo "❌ Redis is not running. Please start it with: sudo systemctl start valkey"
    exit 1
fi
echo "✓ Redis is running"

# Check if PostgreSQL is running
if ! pg_isready -h localhost -p 5432 > /dev/null 2>&1; then
    echo "❌ PostgreSQL is not running. Please start it with: sudo systemctl start postgresql"
    exit 1
fi
echo "✓ PostgreSQL is running"

# Test database connection
export PGPASSWORD=changeme
if ! psql -h localhost -U cardmint -d cardmint -c "SELECT 1" > /dev/null 2>&1; then
    echo "❌ Cannot connect to database. Please run: ./setup-postgres.sh"
    exit 1
fi
echo "✓ Database connection successful"

echo
echo "Starting CardMint Server..."
echo "---------------------------"
echo "API:       http://localhost:3000"
echo "WebSocket: ws://localhost:3001"
echo "Metrics:   http://localhost:9091/metrics"
echo
echo "Press Ctrl+C to stop"
echo

# Start the server
npm run dev