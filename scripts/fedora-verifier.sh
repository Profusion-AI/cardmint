#!/bin/bash
# Fedora LM Studio Verification Service
# Dedicated script for managing GPT-OSS-20B verification service on Fedora
# Part of CardMint E2E Pipeline (August 29, 2025)

set -euo pipefail

# Configuration
FEDORA_PORT="41343"
VERIFIER_MODEL="openai/gpt-oss-20b"
VERIFIER_IDENTIFIER="cardmint-verifier"
LMS_CLI="$HOME/.lmstudio/bin/lms"
LOG_FILE="$HOME/CardMint/logs/fedora-verifier.log"
PID_FILE="/tmp/cardmint-verifier.pid"

# Verification service configuration
GPU_OFFLOAD="auto"  # Let LM Studio decide optimal GPU usage
CONTEXT_LENGTH="4096"  # Sufficient for card verification tasks
TTL_SECONDS="3600"  # 1 hour - reload model if idle
MAX_TOKENS="150"  # Short verification responses
TEMPERATURE="0.1"  # Low temperature for consistent verification

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[VERIFIER]${NC} $1" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[VERIFIER]${NC} $1" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[VERIFIER]${NC} $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[VERIFIER]${NC} $1" | tee -a "$LOG_FILE"
}

ensure_log_dir() {
    mkdir -p "$(dirname "$LOG_FILE")"
}

check_prerequisites() {
    if [[ ! -f "$LMS_CLI" ]]; then
        log_error "LM Studio CLI not found at $LMS_CLI"
        log_info "Run: ~/.lmstudio/bin/lms bootstrap"
        exit 1
    fi
    
    if ! command -v jq &> /dev/null; then
        log_warning "jq not installed - JSON parsing may be limited"
    fi
    
    # Check if GPT-OSS-20B is downloaded
    if ! "$LMS_CLI" ls | grep -q "$VERIFIER_MODEL"; then
        log_warning "GPT-OSS-20B model not found locally"
        log_info "Model will be downloaded on first load (this may take time)"
    fi
}

is_server_running() {
    curl -s --connect-timeout 2 "http://localhost:${FEDORA_PORT}/v1/models" > /dev/null 2>&1
}

is_model_loaded() {
    "$LMS_CLI" ps 2>/dev/null | grep -q "$VERIFIER_IDENTIFIER"
}

start_server() {
    log_info "Starting Fedora LM Studio server on port $FEDORA_PORT..."
    
    if is_server_running; then
        log_success "Server already running on port $FEDORA_PORT"
        return 0
    fi
    
    # Start server in background
    nohup "$LMS_CLI" server start --port "$FEDORA_PORT" > "$LOG_FILE.server" 2>&1 &
    echo $! > "$PID_FILE"
    
    # Wait for server startup
    local timeout=30
    local elapsed=0
    while [[ $elapsed -lt $timeout ]]; do
        if is_server_running; then
            log_success "Server started successfully on port $FEDORA_PORT"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    
    log_error "Server failed to start within ${timeout}s"
    return 1
}

load_verifier_model() {
    log_info "Loading GPT-OSS-20B verification model..."
    
    if is_model_loaded; then
        log_success "Verification model already loaded"
        return 0
    fi
    
    # Load model with optimized settings for verification
    log_info "Loading model with GPU offload: $GPU_OFFLOAD, Context: $CONTEXT_LENGTH, TTL: ${TTL_SECONDS}s"
    
    "$LMS_CLI" load "$VERIFIER_MODEL" \
        --identifier="$VERIFIER_IDENTIFIER" \
        --gpu="$GPU_OFFLOAD" \
        --context-length="$CONTEXT_LENGTH" \
        --ttl="$TTL_SECONDS" \
        --yes
    
    log_success "GPT-OSS-20B loaded as '$VERIFIER_IDENTIFIER'"
}

test_verification() {
    log_info "Testing verification model with sample card data..."
    
    local test_payload=$(cat << 'EOF'
{
    "model": "cardmint-verifier",
    "messages": [
        {
            "role": "system",
            "content": "You are a Pokemon card verification expert. Validate the extracted card data and respond with a confidence score (0-1) and any concerns."
        },
        {
            "role": "user", 
            "content": "Verify this card data: Card: 'Pikachu', Set: 'Base Set', Number: '25/102', First Edition: true. Is this data consistent and valid?"
        }
    ],
    "max_tokens": 100,
    "temperature": 0.1
}
EOF
    )
    
    local response
    response=$(curl -s -X POST "http://localhost:${FEDORA_PORT}/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -d "$test_payload" 2>/dev/null)
    
    if echo "$response" | grep -q "choices"; then
        log_success "Verification test passed - model responding correctly"
        
        # Extract and log the response
        local content
        content=$(echo "$response" | jq -r '.choices[0].message.content' 2>/dev/null || echo "Could not parse response")
        log_info "Test response: $content"
        return 0
    else
        log_error "Verification test failed - model not responding correctly"
        log_error "Response: $response"
        return 1
    fi
}

start_verification_service() {
    ensure_log_dir
    log_info "=== Starting CardMint Verification Service ==="
    log_info "Date: $(date)"
    log_info "Model: $VERIFIER_MODEL"
    log_info "Port: $FEDORA_PORT"
    
    check_prerequisites
    
    if ! start_server; then
        log_error "Failed to start LM Studio server"
        return 1
    fi
    
    if ! load_verifier_model; then
        log_error "Failed to load verification model"
        return 1
    fi
    
    if ! test_verification; then
        log_error "Verification service test failed"
        return 1
    fi
    
    log_success "=== CardMint Verification Service READY ==="
    log_info "Endpoint: http://localhost:$FEDORA_PORT"
    log_info "Model ID: $VERIFIER_IDENTIFIER"
    log_info "Log file: $LOG_FILE"
    
    return 0
}

stop_verification_service() {
    log_info "=== Stopping CardMint Verification Service ==="
    
    # Unload model first
    if is_model_loaded; then
        log_info "Unloading verification model..."
        "$LMS_CLI" unload "$VERIFIER_IDENTIFIER" 2>/dev/null || true
    fi
    
    # Stop server
    log_info "Stopping LM Studio server..."
    "$LMS_CLI" server stop 2>/dev/null || true
    
    # Clean up PID file
    if [[ -f "$PID_FILE" ]]; then
        rm -f "$PID_FILE"
    fi
    
    log_success "Verification service stopped"
}

service_status() {
    echo "=== CardMint Verification Service Status ==="
    echo "Date: $(date)"
    echo "Model: $VERIFIER_MODEL"
    echo "Port: $FEDORA_PORT"
    echo "Log: $LOG_FILE"
    echo
    
    if is_server_running; then
        echo -e "Server: ${GREEN}RUNNING${NC}"
        
        if is_model_loaded; then
            echo -e "Model: ${GREEN}LOADED${NC} ($VERIFIER_IDENTIFIER)"
            
            # Show model details
            local model_info
            model_info=$("$LMS_CLI" ps 2>/dev/null | grep "$VERIFIER_IDENTIFIER" || echo "Details unavailable")
            echo "Details: $model_info"
            
            # Quick health check
            if curl -s --connect-timeout 2 "http://localhost:${FEDORA_PORT}/v1/models" | grep -q "$VERIFIER_IDENTIFIER"; then
                echo -e "Health: ${GREEN}HEALTHY${NC}"
            else
                echo -e "Health: ${YELLOW}DEGRADED${NC}"
            fi
        else
            echo -e "Model: ${RED}NOT LOADED${NC}"
        fi
    else
        echo -e "Server: ${RED}NOT RUNNING${NC}"
        echo -e "Model: ${RED}UNAVAILABLE${NC}"
    fi
    
    # Show recent log entries
    if [[ -f "$LOG_FILE" ]]; then
        echo
        echo "Recent log entries:"
        tail -n 5 "$LOG_FILE" 2>/dev/null || echo "No recent log entries"
    fi
}

monitor_service() {
    log_info "Monitoring verification service (Ctrl+C to stop)..."
    
    while true; do
        if ! is_server_running || ! is_model_loaded; then
            log_warning "Service degraded - attempting restart..."
            start_verification_service
        else
            log_info "Service healthy - $(date)"
        fi
        
        sleep 30
    done
}

benchmark_verification() {
    log_info "Running verification benchmark..."
    
    if ! is_server_running || ! is_model_loaded; then
        log_error "Service not ready for benchmarking"
        return 1
    fi
    
    local test_cases=(
        "Card: 'Charizard', Set: 'Base Set', Number: '4/102', First Edition: false"
        "Card: 'Blastoise', Set: 'Base Set 2', Number: '2/130', Holo: true"
        "Card: 'Venusaur', Set: 'Base Set', Number: '15/102', Shadowless: true"
    )
    
    local total_time=0
    local successful_tests=0
    
    for test_case in "${test_cases[@]}"; do
        local start_time
        start_time=$(date +%s%3N)
        
        local payload=$(cat << EOF
{
    "model": "$VERIFIER_IDENTIFIER",
    "messages": [
        {"role": "system", "content": "Verify this Pokemon card data and provide confidence score."},
        {"role": "user", "content": "$test_case"}
    ],
    "max_tokens": 50,
    "temperature": 0.1
}
EOF
        )
        
        local response
        response=$(curl -s -X POST "http://localhost:${FEDORA_PORT}/v1/chat/completions" \
            -H "Content-Type: application/json" \
            -d "$payload" 2>/dev/null)
        
        local end_time
        end_time=$(date +%s%3N)
        local response_time=$((end_time - start_time))
        
        if echo "$response" | grep -q "choices"; then
            log_success "Test case verified in ${response_time}ms"
            total_time=$((total_time + response_time))
            successful_tests=$((successful_tests + 1))
        else
            log_error "Test case failed: $test_case"
        fi
    done
    
    if [[ $successful_tests -gt 0 ]]; then
        local avg_time=$((total_time / successful_tests))
        log_success "Benchmark complete: ${successful_tests}/${#test_cases[@]} tests passed"
        log_info "Average response time: ${avg_time}ms"
        
        if [[ $avg_time -lt 200 ]]; then
            log_success "Performance: EXCELLENT (<200ms)"
        elif [[ $avg_time -lt 500 ]]; then
            log_success "Performance: GOOD (<500ms)"
        else
            log_warning "Performance: SLOW (>${avg_time}ms)"
        fi
    else
        log_error "Benchmark failed - no successful tests"
        return 1
    fi
}

usage() {
    echo "CardMint Fedora Verification Service Manager"
    echo "Usage: $0 {start|stop|status|monitor|test|benchmark}"
    echo
    echo "Commands:"
    echo "  start     - Start verification service (server + model loading)"
    echo "  stop      - Stop verification service completely"  
    echo "  status    - Show current service status"
    echo "  monitor   - Continuously monitor and restart if needed"
    echo "  test      - Run verification test with sample data"
    echo "  benchmark - Run performance benchmark"
    echo
    echo "Configuration:"
    echo "  Model: $VERIFIER_MODEL"
    echo "  Port: $FEDORA_PORT"
    echo "  Logs: $LOG_FILE"
}

main() {
    case "${1:-}" in
        start)
            start_verification_service
            ;;
        stop)
            stop_verification_service
            ;;
        status)
            service_status
            ;;
        monitor)
            monitor_service
            ;;
        test)
            test_verification
            ;;
        benchmark)
            benchmark_verification
            ;;
        *)
            usage
            exit 1
            ;;
    esac
}

main "$@"