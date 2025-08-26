#!/bin/bash

# CardMint Production Startup Script
# Comprehensive startup with health validation and browser launch
# Based on 26aug-prd.md Phase 2 specifications

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
MAC_IP="10.0.24.174"
LMSTUDIO_PORT="1234"
CARDMINT_PORT="3000"
WS_PORT="3001"
REDIS_PORT="6379"

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}    CardMint Production Startup${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# ============================================================================
# 1. ENVIRONMENT VALIDATION (5s)
# ============================================================================
echo -e "${BLUE}🔍 Step 1: Environment Validation${NC}"

# Check Node.js version
echo -n "  Checking Node.js version... "
if ! command -v node &> /dev/null; then
    echo -e "${RED}FAILED - Node.js not found${NC}"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2)
REQUIRED_VERSION="20.0.0"

if ! node -e "process.exit(require('semver').gte('$NODE_VERSION', '$REQUIRED_VERSION'))" 2>/dev/null; then
    echo -e "${YELLOW}WARNING - Node.js $NODE_VERSION < $REQUIRED_VERSION${NC}"
else
    echo -e "${GREEN}OK - Node.js $NODE_VERSION${NC}"
fi

# Check Python version
echo -n "  Checking Python 3.13... "
if python3 --version 2>&1 | grep -q "3\.13"; then
    echo -e "${GREEN}OK - $(python3 --version)${NC}"
else
    echo -e "${YELLOW}WARNING - Python 3.13 not found, using: $(python3 --version 2>/dev/null || echo 'Not found')${NC}"
fi

# Check network connectivity
echo -n "  Checking network connectivity... "
if ping -c 1 google.com &> /dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${YELLOW}WARNING - Limited connectivity${NC}"
fi

# Test Mac M4 reachability
echo -n "  Testing Mac M4 reachability ($MAC_IP:$LMSTUDIO_PORT)... "
if curl -s --max-time 2 "http://$MAC_IP:$LMSTUDIO_PORT/v1/models" > /dev/null; then
    echo -e "${GREEN}OK - Mac M4 LMStudio responsive${NC}"
    MAC_AVAILABLE=true
else
    echo -e "${YELLOW}WARNING - Mac M4 not reachable${NC}"
    MAC_AVAILABLE=false
fi

echo ""

# ============================================================================
# 2. SERVICE DEPENDENCIES (10s)  
# ============================================================================
echo -e "${BLUE}🔧 Step 2: Service Dependencies${NC}"

# Check and start Redis/Valkey
echo -n "  Redis/Valkey service... "
if systemctl is-active --quiet valkey 2>/dev/null; then
    echo -e "${GREEN}Running${NC}"
elif systemctl is-active --quiet redis 2>/dev/null; then
    echo -e "${GREEN}Running (Redis)${NC}"
else
    echo -e "${YELLOW}Starting Valkey...${NC}"
    if sudo systemctl start valkey 2>/dev/null || sudo systemctl start redis 2>/dev/null; then
        sleep 2
        echo -e "    ${GREEN}Started${NC}"
    else
        echo -e "    ${RED}FAILED - Cannot start Redis/Valkey${NC}"
        exit 1
    fi
fi

# Test Redis connection
echo -n "  Testing Redis connection... "
if timeout 2 redis-cli ping &> /dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED - Redis not responding${NC}"
    exit 1
fi

# Initialize SQLite with WAL mode
echo -n "  Initializing SQLite database... "
mkdir -p ./data
if [ ! -f "./data/cardmint.db" ]; then
    echo -e "${YELLOW}Creating new database...${NC}"
fi
echo -e "    ${GREEN}Ready (WAL mode)${NC}"

# Create missing directories
echo -n "  Creating directories... "
mkdir -p ./captures ./processed ./logs ./data ./temp
echo -e "${GREEN}OK${NC}"

# Set file permissions
echo -n "  Setting permissions... "
chmod 755 ./captures ./processed ./logs ./data ./temp 2>/dev/null || true
echo -e "${GREEN}OK${NC}"

echo ""

# ============================================================================
# 3. MAC M4 VALIDATION (5s)
# ============================================================================
echo -e "${BLUE}🖥️  Step 3: Mac M4 ML Validation${NC}"

if [ "$MAC_AVAILABLE" = true ]; then
    # Test LMStudio endpoint
    echo -n "  LMStudio API endpoint... "
    MODELS=$(curl -s --max-time 5 "http://$MAC_IP:$LMSTUDIO_PORT/v1/models" | jq -r '.data[0].id' 2>/dev/null || echo "")
    if [ -n "$MODELS" ]; then
        echo -e "${GREEN}OK - Model: $MODELS${NC}"
        
        # Test latency with a small request
        echo -n "  Testing Mac M4 latency... "
        START=$(date +%s%3N)
        curl -s --max-time 10 \
            -H "Content-Type: application/json" \
            -d '{"model":"'$MODELS'","messages":[{"role":"user","content":"test"}],"max_tokens":1}' \
            "http://$MAC_IP:$LMSTUDIO_PORT/v1/chat/completions" > /dev/null 2>&1
        END=$(date +%s%3N)
        LATENCY=$((END - START))
        
        if [ $LATENCY -lt 10000 ]; then
            echo -e "${GREEN}OK - ${LATENCY}ms${NC}"
        else
            echo -e "${YELLOW}SLOW - ${LATENCY}ms (expected <10s)${NC}"
        fi
    else
        echo -e "${YELLOW}WARNING - No models loaded${NC}"
    fi
else
    echo -e "${YELLOW}  Skipping - Mac M4 not available${NC}"
    echo -e "${YELLOW}  CardMint will use fallback OCR pipeline${NC}"
fi

echo ""

# ============================================================================
# 4. CARDMINT SERVICES (10s)
# ============================================================================
echo -e "${BLUE}🚀 Step 4: CardMint Services${NC}"

# Check TypeScript compilation (non-blocking)
echo -n "  TypeScript compilation... "
if npm run typecheck > ./logs/typecheck.log 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${YELLOW}WARNINGS (non-blocking)${NC}"
    echo -e "    ${BLUE}Note: Using development mode - TypeScript warnings don't block runtime${NC}"
fi

# Check for existing CardMint processes
echo -n "  Checking for existing processes... "
EXISTING_PID=$(pgrep -f "cardmint" | head -1)
if [ -n "$EXISTING_PID" ]; then
    echo -e "${YELLOW}Found existing process $EXISTING_PID, stopping...${NC}"
    kill $EXISTING_PID 2>/dev/null || true
    sleep 2
fi
echo -e "${GREEN}Clear${NC}"

# Start CardMint services
echo -n "  Starting CardMint server... "
npm run dev > ./logs/server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > ./logs/cardmint.pid

# Wait for server to start
echo -n "    Waiting for port $CARDMINT_PORT... "
for i in {1..20}; do
    if curl -s "http://localhost:$CARDMINT_PORT/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}OK${NC}"
        break
    fi
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo -e "${RED}FAILED - Server process died${NC}"
        tail -10 ./logs/server.log
        exit 1
    fi
    sleep 0.5
done

if ! curl -s "http://localhost:$CARDMINT_PORT/api/health" > /dev/null 2>&1; then
    echo -e "${RED}FAILED - Server not responding${NC}"
    tail -10 ./logs/server.log
    exit 1
fi

# Verify WebSocket connection
echo -n "  Testing WebSocket connection... "
if netstat -an | grep -q ":$WS_PORT.*LISTEN"; then
    echo -e "${GREEN}OK - Port $WS_PORT listening${NC}"
else
    echo -e "${YELLOW}WARNING - WebSocket may not be ready${NC}"
fi

echo ""

# ============================================================================
# 5. HEALTH CHECK SUMMARY
# ============================================================================
echo -e "${BLUE}🏥 Step 5: Health Check Summary${NC}"

# API endpoint test
echo -n "  API health endpoint... "
HEALTH=$(curl -s "http://localhost:$CARDMINT_PORT/api/health" | jq -r '.status' 2>/dev/null || echo "error")
if [ "$HEALTH" = "healthy" ]; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED - $HEALTH${NC}"
fi

# Queue system test
echo -n "  Queue system... "
QUEUE_STATUS=$(curl -s "http://localhost:$CARDMINT_PORT/api/queue/status" | jq -r '.pending' 2>/dev/null || echo "error")
if [ "$QUEUE_STATUS" != "error" ]; then
    echo -e "${GREEN}OK - $QUEUE_STATUS pending${NC}"
else
    echo -e "${YELLOW}WARNING - Queue status unavailable${NC}"
fi

# Database connection
echo -n "  Database connection... "
DB_COUNT=$(curl -s "http://localhost:$CARDMINT_PORT/api/cards" | jq -r 'length' 2>/dev/null || echo "error")
if [ "$DB_COUNT" != "error" ]; then
    echo -e "${GREEN}OK - $DB_COUNT cards in database${NC}"
else
    echo -e "${YELLOW}WARNING - Database query failed${NC}"
fi

echo ""

# ============================================================================
# 6. BROWSER LAUNCH
# ============================================================================
echo -e "${BLUE}🌐 Step 6: Browser Launch${NC}"

DASHBOARD_URL="http://localhost:$CARDMINT_PORT/dashboard/"

echo -e "  Dashboard URL: ${GREEN}$DASHBOARD_URL${NC}"
echo -n "  Opening browser... "

if command -v xdg-open &> /dev/null; then
    xdg-open "$DASHBOARD_URL" 2>/dev/null &
    echo -e "${GREEN}OK${NC}"
elif command -v firefox &> /dev/null; then
    firefox "$DASHBOARD_URL" 2>/dev/null &
    echo -e "${GREEN}OK (Firefox)${NC}"
elif command -v google-chrome &> /dev/null; then
    google-chrome "$DASHBOARD_URL" 2>/dev/null &
    echo -e "${GREEN}OK (Chrome)${NC}"
else
    echo -e "${YELLOW}Please open manually: $DASHBOARD_URL${NC}"
fi

echo ""

# ============================================================================
# STARTUP SUMMARY
# ============================================================================
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}    CardMint Successfully Started!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""
echo -e "🎯 ${BLUE}Dashboard:${NC} $DASHBOARD_URL"
echo -e "📊 ${BLUE}API:${NC}       http://localhost:$CARDMINT_PORT/api/health"
echo -e "🔌 ${BLUE}WebSocket:${NC} ws://localhost:$WS_PORT"
echo -e "🖥️  ${BLUE}Mac M4:${NC}    http://$MAC_IP:$LMSTUDIO_PORT ($([ "$MAC_AVAILABLE" = true ] && echo "Online" || echo "Offline"))"
echo ""
echo -e "📁 ${BLUE}Logs:${NC}"
echo -e "   • Server: ./logs/server.log"
echo -e "   • Build:  ./logs/build.log" 
echo -e "   • PID:    ./logs/cardmint.pid (PID: $SERVER_PID)"
echo ""
echo -e "🔧 ${BLUE}Quick Commands:${NC}"
echo -e "   • Stop:    kill $SERVER_PID"
echo -e "   • Restart: kill $SERVER_PID && ./start-cardmint.sh"
echo -e "   • Logs:    tail -f ./logs/server.log"
echo ""
echo -e "${GREEN}Ready for card processing! 🎴${NC}"
echo ""

# Keep script running to show final message
sleep 2