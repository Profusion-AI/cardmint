#!/bin/bash
# GPU-monitored baseline test runner for Phase 4E optimization validation
# Captures Arc A770 telemetry during inference to detect thermal throttling

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Default parameters
BASELINE_SCRIPT="${BASELINE_SCRIPT:-scripts/pcis_baseline_v2_kvopt.py}"
TEST_SIZE="${TEST_SIZE:-mini}"  # mini, medium, or full
GPU_INTERVAL="${GPU_INTERVAL:-0.5}"
OUTPUT_DIR="${REPO_ROOT}/results"
LOGS_DIR="${OUTPUT_DIR}/gpu_logs"

# Create logs directory
mkdir -p "$LOGS_DIR"

# Determine test name from script
SCRIPT_NAME=$(basename "$BASELINE_SCRIPT" .py)
GPU_LOG="${LOGS_DIR}/${SCRIPT_NAME}-${TEST_SIZE}-gpu-${TIMESTAMP}.log"
SUMMARY_LOG="${LOGS_DIR}/${SCRIPT_NAME}-${TEST_SIZE}-summary-${TIMESTAMP}.txt"

print_header() {
    echo "========================================================================"
    echo "CardMint GPU-Monitored Baseline Test"
    echo "========================================================================"
    echo "Script:    $BASELINE_SCRIPT"
    echo "Test size: $TEST_SIZE"
    echo "GPU log:   $GPU_LOG"
    echo "Summary:   $SUMMARY_LOG"
    echo "Timestamp: $TIMESTAMP"
    echo "========================================================================"
    echo
}

check_prerequisites() {
    # Check if virtual env activated
    if [[ -z "${VIRTUAL_ENV:-}" ]]; then
        echo "❌ Error: Python virtual environment not activated"
        echo "   Run: source .venv/bin/activate"
        exit 1
    fi

    # Check if baseline script exists
    if [[ ! -f "$BASELINE_SCRIPT" ]]; then
        echo "❌ Error: Baseline script not found: $BASELINE_SCRIPT"
        exit 1
    fi

    # Check if GPU monitoring script exists
    if [[ ! -f "scripts/monitor_arc_gpu.py" ]]; then
        echo "❌ Error: GPU monitor script not found"
        exit 1
    fi

    # Check KeepWarm daemon status
    echo "🔍 Checking KeepWarm daemon status..."
    if python scripts/cardmint-keepwarm-enhanced.py --check 2>&1 | grep -q "Enhanced daemon running"; then
        echo "✅ KeepWarm daemon active"
    else
        echo "⚠️  Warning: KeepWarm daemon not running"
        echo "   Recommend: python scripts/cardmint-keepwarm-enhanced.py --daemon"
        read -p "   Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

run_monitored_baseline() {
    echo "🚀 Starting GPU monitoring (interval: ${GPU_INTERVAL}s)..."
    python scripts/monitor_arc_gpu.py --interval "$GPU_INTERVAL" > "$GPU_LOG" 2>&1 &
    GPU_MONITOR_PID=$!
    echo "   GPU monitor PID: $GPU_MONITOR_PID"

    # Give monitor time to initialize
    sleep 2

    echo
    echo "🧪 Starting baseline test: $BASELINE_SCRIPT --$TEST_SIZE"
    echo "   (This will take several minutes...)"
    echo

    # Run baseline test
    TEST_START=$(date +%s)
    if python "$BASELINE_SCRIPT" "--$TEST_SIZE"; then
        TEST_STATUS="✅ PASSED"
        TEST_EXIT_CODE=0
    else
        TEST_STATUS="❌ FAILED"
        TEST_EXIT_CODE=$?
    fi
    TEST_END=$(date +%s)
    TEST_DURATION=$((TEST_END - TEST_START))

    echo
    echo "⏸️  Stopping GPU monitor..."
    kill $GPU_MONITOR_PID 2>/dev/null || true
    wait $GPU_MONITOR_PID 2>/dev/null || true

    echo
    echo "========================================================================"
    echo "Test Complete"
    echo "========================================================================"
    echo "Status:     $TEST_STATUS"
    echo "Duration:   ${TEST_DURATION}s"
    echo "Exit code:  $TEST_EXIT_CODE"
    echo "========================================================================"

    return $TEST_EXIT_CODE
}

analyze_gpu_log() {
    echo
    echo "📊 GPU Telemetry Analysis"
    echo "========================================================================"

    if [[ ! -f "$GPU_LOG" ]]; then
        echo "⚠️  GPU log not found: $GPU_LOG"
        return
    fi

    # Extract temperature stats
    echo "🌡️  Temperature Statistics:"
    if grep -q "Temp:" "$GPU_LOG"; then
        TEMPS=$(grep "Temp:" "$GPU_LOG" | awk -F'Temp: ' '{print $2}' | awk '{print $1}' | tr -d '°C')
        if [[ -n "$TEMPS" ]]; then
            echo "$TEMPS" | awk '
                BEGIN { min=999; max=0; sum=0; count=0 }
                {
                    temp = $1
                    if (temp < min) min = temp
                    if (temp > max) max = temp
                    sum += temp
                    count++
                }
                END {
                    if (count > 0) {
                        avg = sum / count
                        printf "   Min: %.1f°C | Max: %.1f°C | Avg: %.1f°C\n", min, max, avg
                        if (max > 85) {
                            print "   ⚠️  WARNING: Peak temp >85°C - possible thermal throttling"
                        }
                    }
                }
            '
        fi
    else
        echo "   No temperature data captured"
    fi

    # Extract frequency stats
    echo
    echo "⚡ GPU Frequency Statistics:"
    if grep -q "Freq:" "$GPU_LOG"; then
        FREQS=$(grep "Freq:" "$GPU_LOG" | awk -F'Freq: ' '{print $2}' | awk '{print $1}')
        if [[ -n "$FREQS" ]]; then
            echo "$FREQS" | awk '
                BEGIN { min=9999; max=0; sum=0; count=0 }
                {
                    freq = $1
                    if (freq < min) min = freq
                    if (freq > max) max = freq
                    sum += freq
                    count++
                }
                END {
                    if (count > 0) {
                        avg = sum / count
                        printf "   Min: %d MHz | Max: %d MHz | Avg: %d MHz\n", min, max, avg
                        if (min < 2000 && max > 2200) {
                            print "   ⚠️  WARNING: Frequency variance detected - possible throttling"
                        }
                    }
                }
            '
        fi
    else
        echo "   No frequency data captured"
    fi

    # Extract power stats
    echo
    echo "🔋 GPU Power Consumption:"
    if grep -q "Power:" "$GPU_LOG"; then
        POWER=$(grep "Power:" "$GPU_LOG" | awk -F'Power: ' '{print $2}' | awk '{print $1}' | tr -d 'W')
        if [[ -n "$POWER" ]]; then
            echo "$POWER" | awk '
                BEGIN { min=999; max=0; sum=0; count=0 }
                {
                    pwr = $1
                    if (pwr < min) min = pwr
                    if (pwr > max) max = pwr
                    sum += pwr
                    count++
                }
                END {
                    if (count > 0) {
                        avg = sum / count
                        printf "   Min: %.1fW | Max: %.1fW | Avg: %.1fW\n", min, max, avg
                    }
                }
            '
        fi
    else
        echo "   No power data captured"
    fi

    # GPU active percentage
    echo
    echo "🎮 GPU Utilization:"
    GPU_ACTIVE=$(grep -c "GPU: ✅ ACTIVE" "$GPU_LOG" 2>/dev/null || true)
    GPU_IDLE=$(grep -c "GPU: ❌ IDLE" "$GPU_LOG" 2>/dev/null || true)
    GPU_ACTIVE=${GPU_ACTIVE:-0}
    GPU_IDLE=${GPU_IDLE:-0}
    TOTAL_SAMPLES=$((GPU_ACTIVE + GPU_IDLE))

    if [[ $TOTAL_SAMPLES -gt 0 ]]; then
        ACTIVE_PCT=$((GPU_ACTIVE * 100 / TOTAL_SAMPLES))
        echo "   Active samples: $GPU_ACTIVE / $TOTAL_SAMPLES (${ACTIVE_PCT}%)"
        if [[ $ACTIVE_PCT -lt 80 ]]; then
            echo "   ⚠️  WARNING: GPU active <80% - possible idle time or CPU bottleneck"
        fi
    else
        echo "   No utilization data captured"
    fi

    echo "========================================================================"
}

save_summary() {
    {
        echo "CardMint GPU-Monitored Baseline Test Summary"
        echo "=============================================="
        echo "Timestamp:    $TIMESTAMP"
        echo "Script:       $BASELINE_SCRIPT"
        echo "Test size:    $TEST_SIZE"
        echo "Status:       $TEST_STATUS"
        echo "Duration:     ${TEST_DURATION}s"
        echo "GPU log:      $GPU_LOG"
        echo
        analyze_gpu_log
    } > "$SUMMARY_LOG"

    echo
    echo "📝 Summary saved to: $SUMMARY_LOG"
}

main() {
    cd "$REPO_ROOT"

    print_header
    check_prerequisites

    if run_monitored_baseline; then
        analyze_gpu_log
        save_summary
        exit 0
    else
        echo "❌ Baseline test failed"
        analyze_gpu_log
        save_summary
        exit 1
    fi
}

# Help message
if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
    cat <<'EOF'
Usage: ./run_baseline_with_monitoring.sh [OPTIONS]

Run CardMint baseline tests with GPU monitoring to detect thermal throttling
and performance bottlenecks.

Environment Variables:
  BASELINE_SCRIPT    Path to baseline script (default: scripts/pcis_baseline_v2_kvopt.py)
  TEST_SIZE          Test size: mini, medium, full (default: mini)
  GPU_INTERVAL       GPU monitoring interval in seconds (default: 0.5)

Examples:
  # Run Phase 4E KV-optimized mini test with monitoring
  ./scripts/run_baseline_with_monitoring.sh

  # Run Phase 4D baseline for comparison
  BASELINE_SCRIPT=scripts/pcis_baseline_v2.py ./scripts/run_baseline_with_monitoring.sh

  # Run medium test with 1s monitoring interval
  TEST_SIZE=medium GPU_INTERVAL=1.0 ./scripts/run_baseline_with_monitoring.sh

Prerequisites:
  - Python virtual environment activated (source .venv/bin/activate)
  - KeepWarm daemon running (recommended)
  - LM Studio running with model loaded

Output:
  - GPU telemetry log: results/gpu_logs/*-gpu-*.log
  - Summary report: results/gpu_logs/*-summary-*.txt
  - Baseline results: results/*-results-*.json

EOF
    exit 0
fi

main "$@"
