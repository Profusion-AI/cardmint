#!/bin/bash
# Profile M4 Mac GPU utilization during VLM inference
# Run this on the Mac while processing cards

echo "🖥️  M4 Mac GPU Profiler for Qwen2.5-VL"
echo "======================================"
echo ""
echo "This script monitors GPU usage during card processing."
echo "Run on Mac (10.0.24.174) while processing cards from Fedora."
echo ""

# Function to get GPU metrics on macOS
get_gpu_metrics() {
    # Check if we're on macOS
    if [[ "$OSTYPE" != "darwin"* ]]; then
        echo "❌ This script must be run on macOS"
        exit 1
    fi
    
    # Use powermetrics for GPU monitoring (requires sudo)
    echo "📊 Starting GPU monitoring (requires sudo)..."
    echo "Press Ctrl+C to stop"
    echo ""
    
    # Monitor GPU, CPU, and memory during inference
    sudo powermetrics --samplers gpu_power,cpu_power --show-process-energy -i 1000 | grep -E "GPU|CPU|Energy|Package" &
    METRICS_PID=$!
    
    # Also monitor LM Studio process
    echo "📈 Monitoring LM Studio process..."
    while true; do
        # Get LM Studio process info
        LM_STUDIO_PID=$(pgrep -f "LM Studio" || pgrep -f "lmstudio")
        
        if [ -n "$LM_STUDIO_PID" ]; then
            echo "----------------------------------------"
            echo "$(date '+%H:%M:%S') LM Studio Stats:"
            
            # CPU usage
            CPU_USAGE=$(ps -p $LM_STUDIO_PID -o %cpu= | tr -d ' ')
            echo "  CPU Usage: ${CPU_USAGE}%"
            
            # Memory usage
            MEM_USAGE=$(ps -p $LM_STUDIO_PID -o %mem= | tr -d ' ')
            echo "  Memory Usage: ${MEM_USAGE}%"
            
            # Get actual memory in GB
            MEM_KB=$(ps -p $LM_STUDIO_PID -o rss= | tr -d ' ')
            MEM_GB=$(echo "scale=2; $MEM_KB / 1048576" | bc)
            echo "  Memory (GB): ${MEM_GB} GB"
            
            # Check GPU usage via ioreg (Apple Silicon)
            GPU_UTIL=$(ioreg -r -d 1 -w 0 -c AGXAcceleratorG14X | grep "GPUCoreUtilization" | sed 's/.*"GPUCoreUtilization"=//' | sed 's/[^0-9]//g')
            if [ -n "$GPU_UTIL" ]; then
                echo "  GPU Utilization: ${GPU_UTIL}%"
            fi
            
            # Check Neural Engine usage (for M-series chips)
            ANE_UTIL=$(ioreg -r -d 1 -w 0 -c AppleNeuralEngine | grep "Utilization" | head -1 | sed 's/.*=//' | sed 's/[^0-9]//g')
            if [ -n "$ANE_UTIL" ]; then
                echo "  Neural Engine: ${ANE_UTIL}%"
            fi
            
        else
            echo "⚠️  LM Studio not running"
        fi
        
        sleep 2
    done
}

# Alternative: Use Activity Monitor data
activity_monitor_export() {
    echo "📱 Exporting Activity Monitor data..."
    echo "This will create a sample file for analysis"
    
    # Sample system for 30 seconds
    sudo sample System 30 -file gpu_profile.txt
    
    echo "✅ Profile saved to gpu_profile.txt"
    echo "Look for 'GPU' and 'Metal' entries"
}

# Simple metrics without sudo
simple_metrics() {
    echo "📊 Simple Metrics (no sudo required)"
    echo "===================================="
    
    while true; do
        echo ""
        echo "$(date '+%H:%M:%S') System Status:"
        
        # CPU load
        LOAD=$(uptime | awk -F'load average:' '{ print $2 }')
        echo "  Load Average: $LOAD"
        
        # Memory pressure
        MEM_PRESSURE=$(memory_pressure | grep "System-wide memory free percentage" | awk '{print $5}')
        echo "  Memory Free: ${MEM_PRESSURE}"
        
        # Disk I/O
        DISK_IO=$(iostat -c 2 1 | tail -n 1)
        echo "  Disk I/O: $DISK_IO"
        
        # Network (for monitoring data transfer from Fedora)
        NETWORK=$(netstat -ib | grep -E "en0|en1" | head -1 | awk '{print "RX: " $7 " TX: " $10}')
        echo "  Network: $NETWORK"
        
        # LM Studio specific
        LM_PORT_CHECK=$(lsof -i :1234 2>/dev/null | grep LISTEN)
        if [ -n "$LM_PORT_CHECK" ]; then
            echo "  ✅ LM Studio API: Active on :1234"
            
            # Count active connections
            CONNECTIONS=$(lsof -i :1234 2>/dev/null | grep -c ESTABLISHED)
            echo "  Active Connections: $CONNECTIONS"
        else
            echo "  ❌ LM Studio API: Not listening"
        fi
        
        sleep 3
    done
}

# Menu
echo "Select monitoring mode:"
echo "1) Full GPU monitoring (requires sudo)"
echo "2) Activity Monitor export (30s sample)"
echo "3) Simple metrics (no sudo)"
echo ""
read -p "Choice [1-3]: " choice

case $choice in
    1)
        get_gpu_metrics
        ;;
    2)
        activity_monitor_export
        ;;
    3)
        simple_metrics
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac