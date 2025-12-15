#!/bin/bash
# Developer-friendly keepwarm launcher with automatic cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEPWARM_SCRIPT="$SCRIPT_DIR/cardmint-keepwarm-enhanced.py"
PID_FILE="/tmp/cardmint-keepwarm-enhanced.pid"

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

check_status() {
    python3 "$KEEPWARM_SCRIPT" --check
    return $?
}

stop_daemon() {
    python3 "$KEEPWARM_SCRIPT" --stop
}

cleanup_all_keepwarm_processes() {
    echo -e "${BLUE}🧹 Cleaning up any existing keepwarm processes...${NC}"

    # Find all keepwarm processes (including stopped/zombie)
    local pids
    pids=$(pgrep -f "cardmint-keepwarm-enhanced.py" 2>/dev/null || true)

    if [[ -z "$pids" ]]; then
        echo -e "${GREEN}✓ No existing keepwarm processes found${NC}"
        rm -f "$PID_FILE" /tmp/cardmint-keepwarm-enhanced.state
        return 0
    fi

    echo -e "${YELLOW}⚠️  Found existing keepwarm process(es):${NC}"

    # Kill all keepwarm processes
    for pid in $pids; do
        local state
        state=$(ps -p "$pid" -o stat= 2>/dev/null | tr -d ' ' || echo "?")
        local cmd
        cmd=$(ps -p "$pid" -o cmd= 2>/dev/null | cut -c1-50 || echo "?")

        if [[ "$state" == T* ]] || [[ "$state" == Z* ]]; then
            echo -e "   ${YELLOW}PID $pid (state: $state, stopped/zombie)${NC}"
            kill -9 "$pid" 2>/dev/null || true
        else
            echo -e "   ${BLUE}PID $pid (state: $state, running)${NC}"
            # Try graceful shutdown first
            kill -TERM "$pid" 2>/dev/null || true
            sleep 0.5
            # Force kill if still alive
            if ps -p "$pid" > /dev/null 2>&1; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
    done

    sleep 1

    # Clean up state files
    rm -f "$PID_FILE" /tmp/cardmint-keepwarm-enhanced.state

    # Verify cleanup
    remaining=$(pgrep -f "cardmint-keepwarm-enhanced.py" 2>/dev/null || true)
    if [[ -z "$remaining" ]]; then
        echo -e "${GREEN}✅ All keepwarm processes cleaned up${NC}"
        return 0
    else
        echo -e "${RED}⚠️  Some processes still remain (PIDs: $remaining)${NC}"
        echo -e "${RED}   Attempting force cleanup...${NC}"
        pkill -9 -f "cardmint-keepwarm-enhanced.py" || true
        sleep 1
        rm -f "$PID_FILE" /tmp/cardmint-keepwarm-enhanced.state
        return 0
    fi
}

main() {
    echo -e "${BLUE}🔧 CardMint KeepWarm Developer Launcher${NC}"
    echo ""

    # Always clean up all keepwarm processes first (dev workflow is idempotent)
    cleanup_all_keepwarm_processes
    echo ""

    # Start new daemon
    echo -e "${BLUE}🚀 Starting fresh keepwarm daemon...${NC}"
    echo ""

    if python3 "$KEEPWARM_SCRIPT" --daemon --startup-warmups 2; then
        sleep 2
        echo ""
        echo -e "${GREEN}✅ Daemon started successfully${NC}"

        # Verify it's running
        if check_status > /dev/null 2>&1; then
            echo -e "${GREEN}✅ Health check passed${NC}"
        else
            echo -e "${YELLOW}⚠️  Daemon started but health check pending (warming up...)${NC}"
        fi

        echo ""
        echo "Commands:"
        echo "  Check status:  python3 $KEEPWARM_SCRIPT --check"
        echo "  Stop daemon:   python3 $KEEPWARM_SCRIPT --stop"
        echo "  View logs:     tail -f /var/log/cardmint-keepwarm-enhanced.log"
    else
        echo ""
        echo -e "${RED}❌ Failed to start daemon${NC}"
        exit 1
    fi
}

main "$@"
