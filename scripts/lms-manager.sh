#!/bin/bash
# LM Studio CLI Management Script for CardMint
# Manages both Mac M4 (vision) and Fedora (verification) LM Studio instances

set -euo pipefail

# Configuration
MAC_HOST="10.0.24.174"
MAC_PORT="1234"
FEDORA_HOST="localhost"
FEDORA_PORT="41343"
LMS_CLI="$HOME/.lmstudio/bin/lms"

# Model configurations
MAC_VISION_MODEL="qwen2.5-vl-7b-instruct"
FEDORA_VERIFIER_MODEL="openai/gpt-oss-20b"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_lms_cli() {
    if [[ ! -f "$LMS_CLI" ]]; then
        log_error "LM Studio CLI not found at $LMS_CLI"
        log_info "Please run LM Studio GUI first to install CLI components"
        exit 1
    fi
    
    if [[ ! -x "$LMS_CLI" ]]; then
        log_error "LM Studio CLI is not executable"
        exit 1
    fi
}

check_mac_connection() {
    if ! curl -s --connect-timeout 5 "http://${MAC_HOST}:${MAC_PORT}/v1/models" > /dev/null 2>&1; then
        log_warning "Mac M4 LM Studio instance not reachable at ${MAC_HOST}:${MAC_PORT}"
        return 1
    fi
    return 0
}

check_fedora_connection() {
    if ! curl -s --connect-timeout 5 "http://${FEDORA_HOST}:${FEDORA_PORT}/v1/models" > /dev/null 2>&1; then
        log_warning "Local Fedora LM Studio instance not running on port ${FEDORA_PORT}"
        return 1
    fi
    return 0
}

start_fedora_server() {
    log_info "Starting Fedora LM Studio server on port ${FEDORA_PORT}..."
    
    if check_fedora_connection; then
        log_success "Fedora LM Studio server already running"
        return 0
    fi
    
    # Start the server via CLI
    "$LMS_CLI" server start --port "$FEDORA_PORT" &
    
    # Wait for server to start
    local timeout=30
    local elapsed=0
    while [[ $elapsed -lt $timeout ]]; do
        if check_fedora_connection; then
            log_success "Fedora LM Studio server started successfully"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    
    log_error "Failed to start Fedora LM Studio server within ${timeout}s"
    return 1
}

stop_fedora_server() {
    log_info "Stopping Fedora LM Studio server..."
    "$LMS_CLI" server stop
    log_success "Fedora LM Studio server stopped"
}

load_fedora_verifier() {
    log_info "Loading GPT-OSS-20B model for verification on Fedora..."
    
    # Check if model is already loaded
    if "$LMS_CLI" ps | grep -q "$FEDORA_VERIFIER_MODEL"; then
        log_success "GPT-OSS-20B already loaded"
        return 0
    fi
    
    # Load the model with optimal settings
    "$LMS_CLI" load "$FEDORA_VERIFIER_MODEL" \
        --identifier="verifier" \
        --gpu=auto \
        --ttl=3600 \
        --context-length=4096 \
        --yes
    
    log_success "GPT-OSS-20B loaded for verification"
}

unload_fedora_verifier() {
    log_info "Unloading verification model from Fedora..."
    "$LMS_CLI" unload verifier
    log_success "Verification model unloaded"
}

check_mac_vision_model() {
    log_info "Checking Mac M4 vision model status..."
    
    if check_mac_connection; then
        local models_response
        models_response=$(curl -s "http://${MAC_HOST}:${MAC_PORT}/v1/models" | jq -r '.data[].id' 2>/dev/null || echo "")
        
        if echo "$models_response" | grep -q "$MAC_VISION_MODEL"; then
            log_success "Mac vision model ($MAC_VISION_MODEL) is loaded and ready"
            return 0
        else
            log_warning "Mac vision model not loaded or not accessible"
            return 1
        fi
    else
        log_error "Cannot connect to Mac M4 LM Studio instance"
        return 1
    fi
}

status() {
    echo "=== CardMint LM Studio Status ==="
    echo
    
    # Check Mac M4 instance
    echo -e "${BLUE}Mac M4 Instance (Vision Processing):${NC}"
    echo "  Endpoint: http://${MAC_HOST}:${MAC_PORT}"
    if check_mac_connection; then
        echo -e "  Status: ${GREEN}ONLINE${NC}"
        if check_mac_vision_model; then
            echo -e "  Vision Model: ${GREEN}LOADED${NC} (${MAC_VISION_MODEL})"
        else
            echo -e "  Vision Model: ${YELLOW}NOT LOADED${NC}"
        fi
    else
        echo -e "  Status: ${RED}OFFLINE${NC}"
        echo -e "  Vision Model: ${RED}UNAVAILABLE${NC}"
    fi
    echo
    
    # Check Fedora instance
    echo -e "${BLUE}Fedora Instance (Verification):${NC}"
    echo "  Endpoint: http://${FEDORA_HOST}:${FEDORA_PORT}"
    if check_fedora_connection; then
        echo -e "  Status: ${GREEN}ONLINE${NC}"
        
        # Check loaded models
        local loaded_models
        loaded_models=$("$LMS_CLI" ps 2>/dev/null | grep -v "No models" | tail -n +2 || echo "")
        
        if echo "$loaded_models" | grep -q "verifier"; then
            echo -e "  Verifier Model: ${GREEN}LOADED${NC} (${FEDORA_VERIFIER_MODEL})"
        else
            echo -e "  Verifier Model: ${YELLOW}NOT LOADED${NC}"
        fi
    else
        echo -e "  Status: ${RED}OFFLINE${NC}"
        echo -e "  Verifier Model: ${RED}UNAVAILABLE${NC}"
    fi
    echo
}

health_check() {
    log_info "Performing health check for CardMint LM Studio instances..."
    
    local mac_ok=0
    local fedora_ok=0
    
    # Test Mac instance
    if check_mac_connection && check_mac_vision_model; then
        log_success "Mac M4 instance: HEALTHY"
        mac_ok=1
    else
        log_error "Mac M4 instance: UNHEALTHY"
    fi
    
    # Test Fedora instance
    if check_fedora_connection; then
        # Test actual inference
        local test_response
        test_response=$(curl -s -X POST "http://${FEDORA_HOST}:${FEDORA_PORT}/v1/chat/completions" \
            -H "Content-Type: application/json" \
            -d '{
                "model": "verifier",
                "messages": [{"role": "user", "content": "Test message"}],
                "max_tokens": 10
            }' 2>/dev/null || echo "")
        
        if echo "$test_response" | grep -q "choices"; then
            log_success "Fedora instance: HEALTHY"
            fedora_ok=1
        else
            log_warning "Fedora instance: ONLINE but inference test failed"
        fi
    else
        log_error "Fedora instance: UNHEALTHY"
    fi
    
    # Overall status
    if [[ $mac_ok -eq 1 && $fedora_ok -eq 1 ]]; then
        log_success "Overall CardMint pipeline: HEALTHY"
        return 0
    else
        log_error "Overall CardMint pipeline: DEGRADED"
        return 1
    fi
}

start_pipeline() {
    log_info "Starting CardMint LM Studio pipeline..."
    
    check_lms_cli
    
    # Start Fedora server and load verifier
    if start_fedora_server; then
        load_fedora_verifier
    else
        log_error "Failed to start Fedora verification service"
        return 1
    fi
    
    # Check Mac instance
    if ! check_mac_vision_model; then
        log_warning "Mac vision model not ready - ensure Mac LM Studio is running with vision model loaded"
    fi
    
    log_success "CardMint LM Studio pipeline startup complete"
    status
}

stop_pipeline() {
    log_info "Stopping CardMint LM Studio pipeline..."
    
    # Unload models and stop Fedora server
    unload_fedora_verifier 2>/dev/null || true
    stop_fedora_server 2>/dev/null || true
    
    log_success "CardMint LM Studio pipeline stopped"
}

usage() {
    echo "Usage: $0 {start|stop|status|health|start-fedora|stop-fedora|load-verifier|unload-verifier}"
    echo
    echo "Commands:"
    echo "  start           - Start complete CardMint LM Studio pipeline"
    echo "  stop            - Stop complete CardMint LM Studio pipeline"
    echo "  status          - Show status of both Mac and Fedora instances"
    echo "  health          - Perform health check with inference tests"
    echo "  start-fedora    - Start only Fedora LM Studio server"
    echo "  stop-fedora     - Stop only Fedora LM Studio server"
    echo "  load-verifier   - Load GPT-OSS-20B on Fedora for verification"
    echo "  unload-verifier - Unload verification model from Fedora"
    echo
    echo "Environment variables:"
    echo "  MAC_HOST        - Mac M4 IP address (default: $MAC_HOST)"
    echo "  MAC_PORT        - Mac M4 port (default: $MAC_PORT)"
    echo "  FEDORA_PORT     - Local Fedora port (default: $FEDORA_PORT)"
}

main() {
    case "${1:-}" in
        start)
            start_pipeline
            ;;
        stop)
            stop_pipeline
            ;;
        status)
            status
            ;;
        health)
            health_check
            ;;
        start-fedora)
            check_lms_cli
            start_fedora_server
            ;;
        stop-fedora)
            check_lms_cli
            stop_fedora_server
            ;;
        load-verifier)
            check_lms_cli
            load_fedora_verifier
            ;;
        unload-verifier)
            check_lms_cli
            unload_fedora_verifier
            ;;
        *)
            usage
            exit 1
            ;;
    esac
}

main "$@"