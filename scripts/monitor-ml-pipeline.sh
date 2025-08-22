#!/bin/bash

# CardMint ML Pipeline Real-time Monitor
# Shows live status of both Fedora and Mac components

# Configuration
ML_HOST="${REMOTE_ML_HOST:-10.0.24.174}"
ML_PORT="${REMOTE_ML_PORT:-5001}"
CARDMINT_HOST="${CARDMINT_HOST:-localhost}"
CARDMINT_PORT="${CARDMINT_PORT:-3000}"
REFRESH_INTERVAL=2

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Clear screen and hide cursor
clear
tput civis

# Cleanup on exit
trap 'tput cnorm; exit' INT TERM

# Header
print_header() {
    echo -e "${BLUE}${BOLD}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}${BOLD}║           CardMint ML Pipeline Monitor - Live Status          ║${NC}"
    echo -e "${BLUE}${BOLD}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Get ML server status
get_ml_status() {
    local status=$(curl -s -m 1 "http://${ML_HOST}:${ML_PORT}/status" 2>/dev/null)
    if [ -z "$status" ]; then
        echo "OFFLINE"
    else
        echo "$status"
    fi
}

# Get CardMint status
get_cardmint_status() {
    local status=$(curl -s -m 1 "http://${CARDMINT_HOST}:${CARDMINT_PORT}/api/health" 2>/dev/null)
    if [ -z "$status" ]; then
        echo "OFFLINE"
    else
        echo "$status"
    fi
}

# Get queue status
get_queue_status() {
    local status=$(curl -s -m 1 "http://${CARDMINT_HOST}:${CARDMINT_PORT}/api/queue/status" 2>/dev/null)
    if [ -z "$status" ]; then
        echo "{}"
    else
        echo "$status"
    fi
}

# Format uptime
format_uptime() {
    local seconds=$1
    local days=$((seconds / 86400))
    local hours=$(( (seconds % 86400) / 3600 ))
    local minutes=$(( (seconds % 3600) / 60 ))
    
    if [ $days -gt 0 ]; then
        echo "${days}d ${hours}h ${minutes}m"
    elif [ $hours -gt 0 ]; then
        echo "${hours}h ${minutes}m"
    else
        echo "${minutes}m"
    fi
}

# Main monitoring loop
monitor_loop() {
    local iteration=0
    
    while true; do
        # Clear screen and print header
        clear
        print_header
        
        # Timestamp
        echo -e "${CYAN}Last Update: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
        echo ""
        
        # ML Server Status
        echo -e "${BOLD}🖥️  M4 Mac ML Server (${ML_HOST}:${ML_PORT})${NC}"
        echo "─────────────────────────────────────────"
        
        ml_status=$(get_ml_status)
        if [ "$ml_status" == "OFFLINE" ]; then
            echo -e "Status: ${RED}● OFFLINE${NC}"
            echo -e "${YELLOW}Unable to connect to ML server${NC}"
        else
            # Parse ML status
            status=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('status', 'unknown'))" 2>/dev/null)
            models=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(', '.join(data.get('models_loaded', [])))" 2>/dev/null)
            uptime=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('uptime_seconds', 0))" 2>/dev/null)
            cpu=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('resources', {}).get('cpu_percent', 0))" 2>/dev/null)
            memory=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('resources', {}).get('memory_mb', 0))" 2>/dev/null)
            queue_depth=$(echo "$ml_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('queue', {}).get('depth', 0))" 2>/dev/null)
            
            if [ "$status" == "healthy" ]; then
                echo -e "Status: ${GREEN}● HEALTHY${NC}"
            else
                echo -e "Status: ${YELLOW}● DEGRADED${NC}"
            fi
            
            echo -e "Models: ${models:-none}"
            echo -e "Uptime: $(format_uptime ${uptime:-0})"
            echo -e "CPU: ${cpu}% | Memory: ${memory}MB | Queue: ${queue_depth}"
        fi
        
        echo ""
        
        # CardMint Server Status
        echo -e "${BOLD}🚀 Fedora CardMint Server (${CARDMINT_HOST}:${CARDMINT_PORT})${NC}"
        echo "─────────────────────────────────────────"
        
        cardmint_status=$(get_cardmint_status)
        if [ "$cardmint_status" == "OFFLINE" ]; then
            echo -e "Status: ${RED}● OFFLINE${NC}"
            echo -e "${YELLOW}Run: npm run dev${NC}"
        else
            # Parse CardMint status
            status=$(echo "$cardmint_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('status', 'unknown'))" 2>/dev/null)
            db_status=$(echo "$cardmint_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('database', 'unknown'))" 2>/dev/null)
            redis_status=$(echo "$cardmint_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('redis', 'unknown'))" 2>/dev/null)
            
            if [ "$status" == "ok" ]; then
                echo -e "Status: ${GREEN}● RUNNING${NC}"
            else
                echo -e "Status: ${YELLOW}● ISSUES${NC}"
            fi
            
            echo -e "Database: $db_status | Redis: $redis_status"
            
            # Queue status
            queue_status=$(get_queue_status)
            if [ "$queue_status" != "{}" ]; then
                ingestion=$(echo "$queue_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('ingestion', {}).get('waiting', 0))" 2>/dev/null)
                processing=$(echo "$queue_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('processing', {}).get('active', 0))" 2>/dev/null)
                completed=$(echo "$queue_status" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('processing', {}).get('completed', 0))" 2>/dev/null)
                
                echo -e "Queues: Ingestion: ${ingestion:-0} | Processing: ${processing:-0} | Completed: ${completed:-0}"
            fi
        fi
        
        echo ""
        
        # Pipeline Status
        echo -e "${BOLD}📊 Pipeline Metrics${NC}"
        echo "─────────────────────────────────────────"
        
        # Check if ML is enabled
        if [ "$ml_status" != "OFFLINE" ] && [ "$cardmint_status" != "OFFLINE" ]; then
            echo -e "ML Pipeline: ${GREEN}● ACTIVE${NC}"
            
            # Test a quick health check latency
            start_time=$(date +%s%N)
            curl -s -m 1 "http://${ML_HOST}:${ML_PORT}/status" > /dev/null 2>&1
            end_time=$(date +%s%N)
            latency=$(( (end_time - start_time) / 1000000 ))
            
            echo -e "Network Latency: ${latency}ms"
            
            # Show configuration
            mode=$(grep "PROCESSING_MODE" /home/profusionai/CardMint/.env 2>/dev/null | cut -d'=' -f2 | cut -d' ' -f1)
            ml_enabled=$(grep "REMOTE_ML_ENABLED" /home/profusionai/CardMint/.env 2>/dev/null | cut -d'=' -f2 | cut -d' ' -f1)
            
            echo -e "Mode: ${mode:-unknown} | ML Enabled: ${ml_enabled:-unknown}"
        else
            echo -e "ML Pipeline: ${RED}● INACTIVE${NC}"
            echo -e "${YELLOW}Start both servers to enable ML processing${NC}"
        fi
        
        echo ""
        
        # Recent Activity (if log file exists)
        if [ -f "/home/profusionai/CardMint/logs/cardmint.log" ]; then
            echo -e "${BOLD}📝 Recent Activity${NC}"
            echo "─────────────────────────────────────────"
            tail -n 3 /home/profusionai/CardMint/logs/cardmint.log 2>/dev/null | while read line; do
                if [[ $line == *"ERROR"* ]]; then
                    echo -e "${RED}$line${NC}"
                elif [[ $line == *"WARN"* ]]; then
                    echo -e "${YELLOW}$line${NC}"
                else
                    echo "$line"
                fi
            done | cut -c1-80
        fi
        
        echo ""
        echo -e "${CYAN}Refreshing every ${REFRESH_INTERVAL} seconds... Press Ctrl+C to exit${NC}"
        
        # Increment iteration counter
        ((iteration++))
        
        # Sleep before next update
        sleep $REFRESH_INTERVAL
    done
}

# Run the monitor
monitor_loop