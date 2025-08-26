#!/bin/bash

# CardMint Health Check Script
# Comprehensive system health validation
# Returns consolidated status JSON as specified in PRD

set -e

# Configuration
MAC_IP="10.0.24.174"
LMSTUDIO_PORT="1234"
CARDMINT_PORT="3000"
WS_PORT="3001"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Initialize results
declare -A results
overall_status="healthy"
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo -e "${BLUE}CardMint Health Check${NC}"
echo -e "${BLUE}===================${NC}"
echo ""

# API Endpoint Test
echo -n "🌐 API Health... "
if api_response=$(curl -s --max-time 3 "http://localhost:$CARDMINT_PORT/api/health" 2>/dev/null); then
    if echo "$api_response" | jq -e '.status == "healthy"' >/dev/null 2>&1; then
        echo -e "${GREEN}OK${NC}"
        results["api"]="healthy"
    else
        echo -e "${YELLOW}DEGRADED${NC}"
        results["api"]="degraded"
        overall_status="degraded"
    fi
else
    echo -e "${RED}FAILED${NC}"
    results["api"]="failed"
    overall_status="failed"
fi

# WebSocket Test
echo -n "🔌 WebSocket... "
if netstat -an 2>/dev/null | grep -q ":$WS_PORT.*LISTEN"; then
    # Test actual WebSocket connection
    if timeout 3 bash -c "exec 3<>/dev/tcp/localhost/$WS_PORT" 2>/dev/null; then
        exec 3>&-
        echo -e "${GREEN}OK${NC}"
        results["websocket"]="healthy"
    else
        echo -e "${YELLOW}LISTENING (not tested)${NC}"
        results["websocket"]="degraded"
        overall_status="degraded"
    fi
else
    echo -e "${RED}FAILED${NC}"
    results["websocket"]="failed"
    overall_status="failed"
fi

# Database Connection Test
echo -n "🗄️  Database... "
if db_response=$(curl -s --max-time 3 "http://localhost:$CARDMINT_PORT/api/cards?limit=1" 2>/dev/null); then
    if echo "$db_response" | jq -e 'type == "array"' >/dev/null 2>&1; then
        card_count=$(echo "$db_response" | jq 'length')
        echo -e "${GREEN}OK ($card_count cards)${NC}"
        results["database"]="healthy"
        results["database_cards"]="$card_count"
    else
        echo -e "${YELLOW}RESPONDING (format error)${NC}"
        results["database"]="degraded"
        overall_status="degraded"
    fi
else
    echo -e "${RED}FAILED${NC}"
    results["database"]="failed"
    overall_status="failed"
fi

# Queue Status Test
echo -n "📋 Queue System... "
if queue_response=$(curl -s --max-time 3 "http://localhost:$CARDMINT_PORT/api/queue/status" 2>/dev/null); then
    if pending=$(echo "$queue_response" | jq -r '.pending // "unknown"' 2>/dev/null); then
        echo -e "${GREEN}OK ($pending pending)${NC}"
        results["queue"]="healthy"
        results["queue_pending"]="$pending"
    else
        echo -e "${YELLOW}RESPONDING (parse error)${NC}"
        results["queue"]="degraded"
        overall_status="degraded"
    fi
else
    echo -e "${RED}FAILED${NC}"
    results["queue"]="failed"
    overall_status="failed"
fi

# Mac ML Server Test
echo -n "🖥️  Mac M4 ML... "
if mac_response=$(curl -s --max-time 3 "http://$MAC_IP:$LMSTUDIO_PORT/v1/models" 2>/dev/null); then
    if model_count=$(echo "$mac_response" | jq -r '.data | length' 2>/dev/null); then
        if [ "$model_count" -gt 0 ]; then
            model_name=$(echo "$mac_response" | jq -r '.data[0].id' 2>/dev/null)
            echo -e "${GREEN}OK ($model_name)${NC}"
            results["mac_ml"]="healthy"
            results["mac_model"]="$model_name"
        else
            echo -e "${YELLOW}ONLINE (no models)${NC}"
            results["mac_ml"]="degraded"
            overall_status="degraded"
        fi
    else
        echo -e "${YELLOW}RESPONDING (parse error)${NC}"
        results["mac_ml"]="degraded"
        overall_status="degraded"
    fi
else
    echo -e "${RED}OFFLINE${NC}"
    results["mac_ml"]="offline"
    # Mac being offline is degraded, not failed (fallback available)
    if [ "$overall_status" = "healthy" ]; then
        overall_status="degraded"
    fi
fi

# Redis/Queue Backend Test
echo -n "🔴 Redis... "
if timeout 2 redis-cli ping >/dev/null 2>&1; then
    redis_info=$(redis-cli info memory 2>/dev/null | grep "used_memory_human" | cut -d: -f2 | tr -d '\r')
    echo -e "${GREEN}OK ($redis_info)${NC}"
    results["redis"]="healthy"
    results["redis_memory"]="$redis_info"
else
    echo -e "${RED}FAILED${NC}"
    results["redis"]="failed"
    overall_status="failed"
fi

echo ""

# Summary
case $overall_status in
    "healthy")
        echo -e "✅ ${GREEN}Overall Status: HEALTHY${NC}"
        exit_code=0
        ;;
    "degraded") 
        echo -e "⚠️  ${YELLOW}Overall Status: DEGRADED${NC}"
        exit_code=1
        ;;
    "failed")
        echo -e "❌ ${RED}Overall Status: FAILED${NC}"
        exit_code=2
        ;;
esac

# JSON Output
echo ""
echo -e "${BLUE}JSON Summary:${NC}"
cat << EOF
{
  "overall_status": "$overall_status",
  "timestamp": "$timestamp",
  "services": {
    "api": "${results[api]}",
    "websocket": "${results[websocket]}",
    "database": "${results[database]}",
    "queue": "${results[queue]}",
    "mac_ml": "${results[mac_ml]}",
    "redis": "${results[redis]}"
  },
  "metrics": {
    "database_cards": "${results[database_cards]:-0}",
    "queue_pending": "${results[queue_pending]:-0}",
    "mac_model": "${results[mac_model]:-null}",
    "redis_memory": "${results[redis_memory]:-unknown}"
  },
  "endpoints": {
    "dashboard": "http://localhost:$CARDMINT_PORT/dashboard/",
    "api": "http://localhost:$CARDMINT_PORT/api/health",
    "websocket": "ws://localhost:$WS_PORT",
    "mac_ml": "http://$MAC_IP:$LMSTUDIO_PORT/v1/models"
  }
}
EOF

exit $exit_code