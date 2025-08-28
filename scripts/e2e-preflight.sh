#!/bin/bash

# CardMint E2E Testing Preflight Script
# Ensures clean state and proper configuration before E2E tests
# Usage: ./scripts/e2e-preflight.sh

set -e

echo "🔍 CardMint E2E Preflight Check"
echo "================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check and report status
check_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
    else
        echo -e "${RED}❌ $2${NC}"
        return 1
    fi
}

# Function to safely kill process on port
kill_port() {
    local port=$1
    local pid=$(lsof -t -i :$port -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo -e "${YELLOW}⚠️  Found process on port $port (PID: $pid), terminating...${NC}"
        kill -TERM $pid 2>/dev/null || true
        sleep 1
        # Force kill if still running
        kill -9 $pid 2>/dev/null || true
    fi
}

echo "1️⃣  Environment Configuration Check"
echo "-----------------------------------"

# Check required environment variables
ENV_VALID=true
if [ -f .env ]; then
    # Parse .env safely - only lines with KEY=VALUE format, no comments
    while IFS='=' read -r key value; do
        if [[ "$key" && "$value" && ! "$key" =~ ^# ]]; then
            export "$key"="$value"
        fi
    done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env)
    
    # Check deterministic ports
    if [ "$API_PORT" != "3000" ]; then
        echo -e "${RED}❌ API_PORT should be 3000, found: $API_PORT${NC}"
        ENV_VALID=false
    else
        echo -e "${GREEN}✅ API_PORT=3000${NC}"
    fi
    
    if [ "$WS_PORT" != "3001" ]; then
        echo -e "${RED}❌ WS_PORT should be 3001, found: $WS_PORT${NC}"
        ENV_VALID=false
    else
        echo -e "${GREEN}✅ WS_PORT=3001${NC}"
    fi
    
    if [ "$DASH_PORT" != "5173" ]; then
        echo -e "${RED}❌ DASH_PORT should be 5173, found: $DASH_PORT${NC}"
        ENV_VALID=false
    else
        echo -e "${GREEN}✅ DASH_PORT=5173${NC}"
    fi
    
    if [ "$VITE_API_BASE" != "http://localhost:3000" ]; then
        echo -e "${RED}❌ VITE_API_BASE should be http://localhost:3000, found: $VITE_API_BASE${NC}"
        ENV_VALID=false
    else
        echo -e "${GREEN}✅ VITE_API_BASE=http://localhost:3000${NC}"
    fi
    
    if [ "$INPUT_TELEMETRY_PATH" != "./data/input-telemetry.csv" ]; then
        echo -e "${YELLOW}⚠️  INPUT_TELEMETRY_PATH is $INPUT_TELEMETRY_PATH${NC}"
    else
        echo -e "${GREEN}✅ INPUT_TELEMETRY_PATH=./data/input-telemetry.csv${NC}"
    fi
else
    echo -e "${RED}❌ .env file not found${NC}"
    ENV_VALID=false
fi

if [ "$ENV_VALID" = false ]; then
    echo -e "${RED}❌ Environment configuration invalid. Fix .env before proceeding.${NC}"
    exit 1
fi

echo ""
echo "1️⃣ .5  Controller Readiness Check"
echo "-----------------------------------"

# Ensure no stray exclusive grabs from previous runs
if command -v pkill >/dev/null 2>&1; then
    pkill -f "evtest" >/dev/null 2>&1 || true
fi

# Show input device links
if [ -d /dev/input/by-id ]; then
    echo "Controller by-id entries (if connected):"
    ls -l /dev/input/by-id | grep -i "8BitDo\|8bitdo" || echo "  (none found)"
else
    echo "No /dev/input/by-id directory available"
fi

# Run detection and generate .env.controller
if command -v npm >/dev/null 2>&1; then
    if npm run -s gamepad:detect -- --match 8bitdo | grep -q "READY"; then
        echo -e "${GREEN}✅ 8BitDo detected via gamepad:detect${NC}"
        # Generate env and verify
        if [ -f scripts/controller-env-setup.sh ]; then
            # shellcheck disable=SC1091
            source scripts/controller-env-setup.sh --generate-file || true
            if [ -f .env.controller ]; then
                echo -e "${GREEN}✅ .env.controller generated${NC}"
                grep -E 'CONTROLLER_KBD_EVENT|CONTROLLER_KBD_BYID' .env.controller | sed 's/^/  /'
            else
                echo -e "${YELLOW}⚠️  .env.controller not generated${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}⚠️  8BitDo not detected by gamepad:detect${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  npm not available; skipping controller detection${NC}"
fi

echo ""
echo "2️⃣  Port Availability Check"
echo "---------------------------"

# Check ports using ss or lsof
echo "Checking port status..."

# Function to check port with both ss and lsof fallback
check_port() {
    local port=$1
    local service=$2
    
    # Try ss first
    if command -v ss >/dev/null 2>&1; then
        if ss -ltn | grep -q ":$port "; then
            echo -e "${YELLOW}⚠️  Port $port ($service) is in use${NC}"
            return 1
        fi
    # Fallback to lsof
    elif command -v lsof >/dev/null 2>&1; then
        if lsof -i :$port -sTCP:LISTEN >/dev/null 2>&1; then
            echo -e "${YELLOW}⚠️  Port $port ($service) is in use${NC}"
            return 1
        fi
    fi
    
    echo -e "${GREEN}✅ Port $port ($service) is available${NC}"
    return 0
}

# Check and optionally kill processes on required ports
PORTS_BLOCKED=false
if ! check_port 3000 "API"; then
    kill_port 3000
    PORTS_BLOCKED=true
fi

if ! check_port 3001 "WebSocket"; then
    kill_port 3001
    PORTS_BLOCKED=true
fi

if ! check_port 5173 "Dashboard"; then
    kill_port 5173
    PORTS_BLOCKED=true
fi

if [ "$PORTS_BLOCKED" = true ]; then
    echo -e "${GREEN}✅ Cleared blocked ports${NC}"
fi

echo ""
echo "3️⃣  Data Directory Setup"
echo "------------------------"

# Create data directory if missing
if [ ! -d ./data ]; then
    mkdir -p ./data
    echo -e "${GREEN}✅ Created ./data directory${NC}"
else
    echo -e "${GREEN}✅ ./data directory exists${NC}"
fi

# Check/create CSV with header
CSV_PATH="./data/input-telemetry.csv"
CSV_HEADER="ts,source,action,cardId,cycleId,latencyMs,error"

if [ -f "$CSV_PATH" ]; then
    # Check if header is present
    FIRST_LINE=$(head -n1 "$CSV_PATH" 2>/dev/null || echo "")
    if [ "$FIRST_LINE" != "$CSV_HEADER" ]; then
        echo -e "${YELLOW}⚠️  CSV exists but header incorrect, backing up and recreating...${NC}"
        mv "$CSV_PATH" "${CSV_PATH}.backup.$(date +%s)"
        echo "$CSV_HEADER" > "$CSV_PATH"
        echo -e "${GREEN}✅ Created fresh CSV with correct header${NC}"
    else
        # Rotate if file is large (>1MB)
        FILE_SIZE=$(stat -f%z "$CSV_PATH" 2>/dev/null || stat -c%s "$CSV_PATH" 2>/dev/null || echo 0)
        if [ $FILE_SIZE -gt 1048576 ]; then
            echo -e "${YELLOW}⚠️  CSV is large ($(($FILE_SIZE / 1024))KB), rotating...${NC}"
            mv "$CSV_PATH" "${CSV_PATH}.$(date +%Y%m%d_%H%M%S)"
            echo "$CSV_HEADER" > "$CSV_PATH"
            echo -e "${GREEN}✅ Rotated large CSV${NC}"
        else
            LINE_COUNT=$(wc -l < "$CSV_PATH")
            echo -e "${GREEN}✅ CSV ready with $LINE_COUNT lines${NC}"
        fi
    fi
else
    echo "$CSV_HEADER" > "$CSV_PATH"
    echo -e "${GREEN}✅ Created CSV with header${NC}"
fi

echo ""
echo "4️⃣  Build Status Check"
echo "----------------------"

# Check if dist directory exists and is recent
if [ -d ./dist ]; then
    # Find newest file in dist
    NEWEST=$(find ./dist -type f -name "*.js" -exec stat -f "%m %N" {} \; 2>/dev/null | sort -rn | head -1 | cut -d' ' -f1 || \
             find ./dist -type f -name "*.js" -exec stat -c "%Y %n" {} \; 2>/dev/null | sort -rn | head -1 | cut -d' ' -f1 || \
             echo "0")
    
    if [ -n "$NEWEST" ] && [ "$NEWEST" != "0" ] && [[ "$NEWEST" =~ ^[0-9]+$ ]]; then
        AGE=$(($(date +%s) - $NEWEST))
        if [ $AGE -lt 3600 ]; then
            echo -e "${GREEN}✅ Build is recent ($(($AGE / 60)) minutes old)${NC}"
        else
            echo -e "${YELLOW}⚠️  Build is stale ($(($AGE / 3600)) hours old)${NC}"
            echo "   Run: npm run prod:build"
        fi
    else
        echo -e "${YELLOW}⚠️  Cannot determine build age${NC}"
    fi
else
    echo -e "${RED}❌ No build found (./dist missing)${NC}"
    echo "   Run: npm run prod:build"
fi

# Check dashboard build
if [ -d ./dashboard/dist ]; then
    echo -e "${GREEN}✅ Dashboard build exists${NC}"
else
    echo -e "${YELLOW}⚠️  Dashboard build missing${NC}"
    echo "   Run: npm run build:dashboard"
fi

echo ""
echo "5️⃣  Node.js Process Check"
echo "-------------------------"

# Check for any running CardMint processes
CARDMINT_PIDS=$(pgrep -f "node.*cardmint|tsx.*cardmint" || true)
if [ -n "$CARDMINT_PIDS" ]; then
    echo -e "${YELLOW}⚠️  Found existing CardMint processes:${NC}"
    ps -o pid,ppid,%mem,rss,cmd -p $CARDMINT_PIDS
    echo ""
    read -p "Kill these processes? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        kill -TERM $CARDMINT_PIDS 2>/dev/null || true
        sleep 1
        kill -9 $CARDMINT_PIDS 2>/dev/null || true
        echo -e "${GREEN}✅ Terminated existing processes${NC}"
    fi
else
    echo -e "${GREEN}✅ No existing CardMint processes${NC}"
fi

echo ""
echo "6️⃣  Quick Smoke Test Commands"
echo "------------------------------"

echo "Start server (production):"
echo -e "${YELLOW}  node dist/index.js${NC}"
echo ""
echo "Start server (development fallback):"
echo -e "${YELLOW}  node -r tsx/cjs src/index.ts${NC}"
echo ""
echo "Verify API:"
echo -e "${YELLOW}  curl -sS http://localhost:3000/api/telemetry/input/summary | jq .${NC}"
echo ""
echo "Open dashboard:"
echo -e "${YELLOW}  http://localhost:3000/dashboard/verification.html${NC}"
echo ""
echo "Test telemetry:"
echo -e "${YELLOW}  ./scripts/smoke-ab.sh${NC}"
echo ""

echo ""
echo "7️⃣  E2E Test Endpoints"
echo "----------------------"
echo "API:       http://localhost:3000"
echo "WebSocket: ws://localhost:3001"
echo "Dashboard: http://localhost:3000/dashboard/verification.html"
echo "Telemetry: ./data/input-telemetry.csv"
echo ""

# Final summary
echo "================================"
if [ "$ENV_VALID" = true ]; then
    echo -e "${GREEN}✅ Preflight checks complete!${NC}"
    echo ""
    echo "Ready for E2E testing. Start with:"
    echo "  1. npm run prod:build (if needed)"
    echo "  2. node dist/index.js"
    echo "  3. Open http://localhost:3000/dashboard/verification.html"
    exit 0
else
    echo -e "${RED}❌ Preflight checks failed${NC}"
    echo "Fix issues above before proceeding."
    exit 1
fi
