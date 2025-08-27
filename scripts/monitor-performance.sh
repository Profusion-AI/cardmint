#!/bin/bash
# scripts/monitor-performance.sh
# Performance monitoring and baseline establishment for CardMint controller integration

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
MONITOR_DURATION=${1:-300}  # Default 5 minutes
SAMPLE_INTERVAL=1
LOG_DIR="./performance-logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Create log directory
mkdir -p "$LOG_DIR"

# Log files
IOSTAT_LOG="$LOG_DIR/iostat_$TIMESTAMP.log"
VMSTAT_LOG="$LOG_DIR/vmstat_$TIMESTAMP.log"
PIDSTAT_LOG="$LOG_DIR/pidstat_$TIMESTAMP.log"
NETWORK_LOG="$LOG_DIR/network_$TIMESTAMP.log"
SYSTEM_LOG="$LOG_DIR/system_$TIMESTAMP.log"
REPORT_FILE="$LOG_DIR/performance_report_$TIMESTAMP.md"

# PID tracking
CARDMINT_PID=""
VITE_PID=""

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}"
}

log_success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

cleanup() {
    log "Stopping monitoring processes..."
    
    # Kill monitoring processes
    pkill -f "iostat" 2>/dev/null || true
    pkill -f "vmstat" 2>/dev/null || true  
    pkill -f "pidstat" 2>/dev/null || true
    pkill -f "ss.*-tn" 2>/dev/null || true
    
    log_success "Monitoring cleanup completed"
}

trap cleanup EXIT

find_cardmint_processes() {
    # Find CardMint main process
    CARDMINT_PID=$(pgrep -f "tsx watch src/index.ts" || echo "")
    VITE_PID=$(pgrep -f "vite.*dev" || echo "")
    
    if [ -z "$CARDMINT_PID" ]; then
        log_warning "CardMint main process not found"
    else
        log "Found CardMint process: PID $CARDMINT_PID"
    fi
    
    if [ -z "$VITE_PID" ]; then
        log_warning "Vite process not found"
    else
        log "Found Vite process: PID $VITE_PID"
    fi
}

start_system_monitoring() {
    log "Starting system monitoring for ${MONITOR_DURATION}s..."
    
    # System-wide I/O statistics
    iostat -x $SAMPLE_INTERVAL > "$IOSTAT_LOG" &
    
    # Virtual memory statistics
    vmstat $SAMPLE_INTERVAL > "$VMSTAT_LOG" &
    
    # Network connections
    while true; do
        echo "$(date '+%Y-%m-%d %H:%M:%S')" >> "$NETWORK_LOG"
        ss -tn | grep -E ':(3000|3001|3002|5173|5174|5175|5176|5177)' >> "$NETWORK_LOG" 2>/dev/null || true
        echo "" >> "$NETWORK_LOG"
        sleep $SAMPLE_INTERVAL
    done &
    
    # System load and processes
    while true; do
        echo "=== $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$SYSTEM_LOG"
        echo "Load Average: $(uptime | awk -F'load average:' '{print $2}')" >> "$SYSTEM_LOG"
        echo "Memory Usage:" >> "$SYSTEM_LOG"
        free -h >> "$SYSTEM_LOG"
        echo "Top processes:" >> "$SYSTEM_LOG"
        ps aux --sort=-%cpu | head -10 >> "$SYSTEM_LOG"
        echo "" >> "$SYSTEM_LOG"
        sleep $SAMPLE_INTERVAL
    done &
}

start_process_monitoring() {
    if [ ! -z "$CARDMINT_PID" ] || [ ! -z "$VITE_PID" ]; then
        log "Starting process-specific monitoring..."
        
        # Monitor specific processes
        local pids=""
        [ ! -z "$CARDMINT_PID" ] && pids="$CARDMINT_PID"
        [ ! -z "$VITE_PID" ] && pids="$pids,$VITE_PID"
        
        # Remove leading comma if exists
        pids=$(echo $pids | sed 's/^,//')
        
        if [ ! -z "$pids" ]; then
            pidstat -p $pids $SAMPLE_INTERVAL > "$PIDSTAT_LOG" &
        fi
    fi
}

wait_for_monitoring() {
    log "Monitoring for ${MONITOR_DURATION} seconds..."
    
    # Show progress every 30 seconds
    local elapsed=0
    while [ $elapsed -lt $MONITOR_DURATION ]; do
        sleep 30
        elapsed=$((elapsed + 30))
        local remaining=$((MONITOR_DURATION - elapsed))
        log "Monitoring... ${elapsed}s elapsed, ${remaining}s remaining"
        
        # Show current system status
        echo "  Current load: $(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}')"
        echo "  Free memory: $(free -h | grep '^Mem:' | awk '{print $7}')"
    done
}

analyze_performance() {
    log "Analyzing performance data..."
    
    # Create performance report
    cat > "$REPORT_FILE" << EOF
# CardMint Performance Analysis Report

**Test Date:** $(date)  
**Duration:** ${MONITOR_DURATION} seconds  
**Sample Interval:** ${SAMPLE_INTERVAL} seconds  

## System Configuration
- **OS:** $(uname -a)
- **CPU:** $(grep 'model name' /proc/cpuinfo | head -1 | cut -d':' -f2 | xargs)
- **Memory:** $(free -h | grep '^Mem:' | awk '{print $2}') total
- **Disk:** $(df -h / | tail -1 | awk '{print $2}') available

## Process Information
EOF

    if [ ! -z "$CARDMINT_PID" ]; then
        echo "- **CardMint PID:** $CARDMINT_PID" >> "$REPORT_FILE"
    fi
    if [ ! -z "$VITE_PID" ]; then
        echo "- **Vite PID:** $VITE_PID" >> "$REPORT_FILE"
    fi
    
    echo "" >> "$REPORT_FILE"
    
    # Analyze CPU usage
    if [ -f "$VMSTAT_LOG" ] && [ -s "$VMSTAT_LOG" ]; then
        local avg_cpu=$(tail -n +3 "$VMSTAT_LOG" | awk '{cpu+=$13+$14} END {if(NR>0) print 100-(cpu/NR); else print 0}')
        local avg_idle=$(tail -n +3 "$VMSTAT_LOG" | awk '{idle+=$15} END {if(NR>0) print idle/NR; else print 0}')
        
        cat >> "$REPORT_FILE" << EOF
## CPU Performance
- **Average CPU Usage:** $(printf "%.2f" $avg_cpu)%
- **Average Idle:** $(printf "%.2f" $avg_idle)%
EOF
    fi
    
    # Analyze memory usage
    if [ -f "$VMSTAT_LOG" ] && [ -s "$VMSTAT_LOG" ]; then
        local avg_memory=$(tail -n +3 "$VMSTAT_LOG" | awk '{mem+=$4} END {if(NR>0) print mem/NR/1024; else print 0}')
        
        cat >> "$REPORT_FILE" << EOF
- **Average Free Memory:** $(printf "%.2f" $avg_memory) MB

EOF
    fi
    
    # Analyze process-specific stats
    if [ -f "$PIDSTAT_LOG" ] && [ -s "$PIDSTAT_LOG" ]; then
        cat >> "$REPORT_FILE" << EOF
## Process Performance

### CardMint Process Statistics
EOF
        
        # Extract process stats (skip header lines)
        if [ ! -z "$CARDMINT_PID" ]; then
            local cardmint_cpu=$(grep -E "^[0-9].*$CARDMINT_PID" "$PIDSTAT_LOG" | awk '{cpu+=$7} END {if(NR>0) print cpu/NR; else print 0}')
            local cardmint_mem=$(grep -E "^[0-9].*$CARDMINT_PID" "$PIDSTAT_LOG" | awk '{mem+=$8} END {if(NR>0) print mem/NR; else print 0}')
            
            cat >> "$REPORT_FILE" << EOF
- **Average CPU Usage:** $(printf "%.2f" $cardmint_cpu)%
- **Average Memory Usage:** $(printf "%.2f" $cardmint_mem)%
EOF
        fi
    fi
    
    # Network analysis
    if [ -f "$NETWORK_LOG" ] && [ -s "$NETWORK_LOG" ]; then
        local connection_count=$(grep -c "ESTAB" "$NETWORK_LOG" 2>/dev/null || echo "0")
        cat >> "$REPORT_FILE" << EOF

## Network Performance
- **Active Connections:** $connection_count (total during monitoring)
- **Monitored Ports:** 3000 (API), 3001/3002 (WebSocket), 5173-5177 (Dashboard)

EOF
    fi
    
    # Performance verdict
    cat >> "$REPORT_FILE" << EOF
## Performance Assessment

### Benchmarks vs Targets
EOF

    # Check against targets
    local cpu_target=10.0
    local memory_target=200.0  # MB
    local idle_target=90.0
    
    if (( $(echo "$avg_cpu <= $cpu_target" | bc -l) )); then
        echo "- ✅ **CPU Usage:** $(printf "%.2f" $avg_cpu)% ≤ ${cpu_target}% (Target met)" >> "$REPORT_FILE"
    else
        echo "- ❌ **CPU Usage:** $(printf "%.2f" $avg_cpu)% > ${cpu_target}% (Target exceeded)" >> "$REPORT_FILE"
    fi
    
    if (( $(echo "$avg_idle >= $idle_target" | bc -l) )); then
        echo "- ✅ **System Idle:** $(printf "%.2f" $avg_idle)% ≥ ${idle_target}% (Target met)" >> "$REPORT_FILE"  
    else
        echo "- ❌ **System Idle:** $(printf "%.2f" $avg_idle)% < ${idle_target}% (Target not met)" >> "$REPORT_FILE"
    fi
    
    cat >> "$REPORT_FILE" << EOF

### Recommendations
EOF

    # Generate recommendations based on results
    if (( $(echo "$avg_cpu > 5.0" | bc -l) )); then
        echo "- Consider investigating high CPU usage processes" >> "$REPORT_FILE"
    fi
    
    if (( $(echo "$avg_idle < 95.0" | bc -l) )); then
        echo "- System may be under load - verify no background processes interfering" >> "$REPORT_FILE"
    fi
    
    echo "- Monitor controller event latency during next test phase" >> "$REPORT_FILE"
    echo "- Validate WebSocket message throughput under load" >> "$REPORT_FILE"
    
    cat >> "$REPORT_FILE" << EOF

## Raw Data Files
- System I/O: \`$(basename "$IOSTAT_LOG")\`
- Virtual Memory: \`$(basename "$VMSTAT_LOG")\`
- Process Stats: \`$(basename "$PIDSTAT_LOG")\`
- Network Connections: \`$(basename "$NETWORK_LOG")\`
- System Overview: \`$(basename "$SYSTEM_LOG")\`

---
*Generated by CardMint Performance Monitor - $(date)*
EOF
    
    log_success "Performance report generated: $REPORT_FILE"
}

display_summary() {
    echo ""
    echo -e "${GREEN}=== Performance Monitoring Complete ===${NC}"
    echo ""
    echo "📊 Summary:"
    echo "  Duration: ${MONITOR_DURATION}s"
    echo "  Log Directory: $LOG_DIR"
    echo "  Report File: $REPORT_FILE"
    echo ""
    echo "📁 Generated Files:"
    ls -la "$LOG_DIR"/*_$TIMESTAMP.* | sed 's/^/  /'
    echo ""
    echo -e "${YELLOW}📖 View Performance Report:${NC}"
    echo "  cat '$REPORT_FILE'"
    echo ""
    echo -e "${YELLOW}🔍 Analyze Raw Data:${NC}"
    echo "  tail '$VMSTAT_LOG'     # System stats"
    echo "  tail '$PIDSTAT_LOG'    # Process stats"
    echo "  tail '$SYSTEM_LOG'     # System overview"
}

# Main execution
main() {
    echo -e "${GREEN}CardMint Performance Monitor${NC}"
    echo "Duration: ${MONITOR_DURATION}s | Interval: ${SAMPLE_INTERVAL}s"
    echo ""
    
    # Check prerequisites
    for cmd in iostat vmstat pidstat ss bc; do
        if ! command -v $cmd &> /dev/null; then
            log_error "$cmd not found. Install: apt-get install sysstat iproute2 bc"
            exit 1
        fi
    done
    
    # Find processes
    find_cardmint_processes
    
    # Start monitoring
    start_system_monitoring
    start_process_monitoring
    
    # Wait for monitoring period
    wait_for_monitoring
    
    # Stop all monitoring
    cleanup
    
    # Wait for logs to flush
    sleep 2
    
    # Analyze results
    analyze_performance
    
    # Display summary
    display_summary
    
    log_success "Performance monitoring completed successfully!"
}

# Show usage if help requested
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Usage: $0 [duration_seconds]"
    echo ""
    echo "Monitor CardMint system performance for specified duration"
    echo ""
    echo "Arguments:"
    echo "  duration_seconds    Monitoring duration (default: 300)"
    echo ""
    echo "Examples:"
    echo "  $0              # Monitor for 5 minutes"
    echo "  $0 60           # Monitor for 1 minute"
    echo "  $0 1800         # Monitor for 30 minutes"
    echo ""
    echo "Output: Performance logs and report in ./performance-logs/"
    exit 0
fi

# Run main function
main