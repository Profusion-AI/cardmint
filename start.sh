#!/bin/bash

echo "Starting CardMint Server..."
echo "=============================="
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
echo "Starting CardMint in development mode..."
echo "----------------------------------------"
npm run dev