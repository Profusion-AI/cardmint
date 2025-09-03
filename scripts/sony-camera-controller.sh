#!/usr/bin/env bash

# Sony Camera Controller Script - Production Ready
# Handles the finnicky Sony SDK requirements for reliable camera operations
# (Codex-CTO) Staging + atomic rename, env-configurable paths, single-flight lock

set -Eeuo pipefail
IFS=$'\n\t'
export LC_ALL=C

# Sony SDK Paths - Critical for proper operation
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CARDMINT_ROOT="$(dirname "$SCRIPT_DIR")"

# Allow env overrides for portability
SDK_PATH="${CAMERA_SDK_PATH:-"${CARDMINT_ROOT}/CrSDK_v2.00.00_20250805a_Linux64PC"}"
BUILD_PATH="${CAMERA_BUILD_DIR:-"${SDK_PATH}/build"}"
SONY_CLI="${BUILD_PATH}/sony-cli"
SONY_CAPTURE="${BUILD_PATH}/sony-pc-capture-fast"

# Inventory (final) and staging (temp) dirs; allow env override
CAPTURES_DIR="${INVENTORY_IMAGES_DIR:-"${CARDMINT_ROOT}/data/inventory_images"}"
STAGING_DIR="${CAPTURE_STAGING_DIR:-"${CARDMINT_ROOT}/data/capture_staging"}"

# Optional tmpfs auto-enable for staging if not explicitly set
if [ -z "${CAPTURE_STAGING_DIR:-}" ] && [ -d "/dev/shm" ] && [ -w "/dev/shm" ]; then
    STAGING_DIR="/dev/shm/cardmint_staging"
fi

# Ensure absolute paths (convert relative to absolute based on CARDMINT_ROOT)
if [[ "$CAPTURES_DIR" != /* ]]; then
    CAPTURES_DIR="${CARDMINT_ROOT}/${CAPTURES_DIR#./}"
fi
if [[ "$STAGING_DIR" != /* ]]; then
    STAGING_DIR="${CARDMINT_ROOT}/${STAGING_DIR#./}"
fi

# Production configuration - CRITICAL: Real-world timing is ~5000ms, need safety margin
CAPTURE_TIMEOUT=${CAMERA_TIMEOUT_MS:-10000}  # Increased from 5000ms based on physical testing
# Normalize to seconds for timeout(1)
CAPTURE_TIMEOUT_SEC=$(( (CAPTURE_TIMEOUT + 999) / 1000 ))
MAX_RETRIES=3
RETRY_DELAY=1

# Logging setup
LOG_FILE="${CARDMINT_ROOT}/logs/sony-camera.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    local line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    # Write to log file and stderr (do not pollute stdout used for protocol lines)
    echo "$line" >> "$LOG_FILE"
    echo "$line" >&2
}

error_exit() {
    log "ERROR: $1"
    exit 1
}

# Validate environment
check_environment() {
    log "Checking Sony SDK environment..."
    
    [ -d "$SDK_PATH" ] || error_exit "Sony SDK not found at $SDK_PATH"
    [ -d "$BUILD_PATH" ] || error_exit "Build directory not found at $BUILD_PATH"
    [ -x "$SONY_CLI" ] || error_exit "Sony CLI binary not executable at $SONY_CLI"
    [ -x "$SONY_CAPTURE" ] || error_exit "Sony capture binary not executable at $SONY_CAPTURE"
    
    # Ensure directories exist
    mkdir -p "$CAPTURES_DIR" "$STAGING_DIR"
    
    log "Environment validation complete"
}

# Setup LD_LIBRARY_PATH for Sony SDK
setup_library_path() {
    export LD_LIBRARY_PATH="${BUILD_PATH}:${BUILD_PATH}/CrAdapter:${SDK_PATH}/external/crsdk:${SDK_PATH}/external/crsdk/CrAdapter:${LD_LIBRARY_PATH:-}"
    log "Library path configured: $LD_LIBRARY_PATH"
}

# Run command in Sony SDK build directory (CRITICAL requirement)
run_in_sdk_directory() {
    local cmd="$1"
    local timeout_duration_sec="${2:-$CAPTURE_TIMEOUT_SEC}"
    
    cd "$BUILD_PATH" || error_exit "Cannot change to build directory"
    
    log "Executing: $cmd (timeout: ${timeout_duration_sec}s)"
    
    # Run with timeout and capture both stdout and stderr
    if timeout "$timeout_duration_sec" bash -c "$cmd" 2>&1; then
        local exit_code=$?
        log "Command completed successfully (exit code: $exit_code)"
        return $exit_code
    else
        local exit_code=$?
        if [ $exit_code -eq 124 ]; then
            log "Command timed out after ${timeout_duration} seconds"
        else
            log "Command failed with exit code: $exit_code"
        fi
        return $exit_code
    fi
}

# List available cameras
list_cameras() {
    log "Listing Sony cameras..."
    
    if run_in_sdk_directory "./sony-cli list" 10; then
        log "Camera list retrieved successfully"
        return 0
    else
        log "Failed to list cameras"
        return 1
    fi
}

# Connect to camera
connect_camera() {
    log "Connecting to Sony camera..."
    
    local retry_count=0
    while [ $retry_count -lt $MAX_RETRIES ]; do
        if run_in_sdk_directory "./sony-cli connect" 10; then
            log "Camera connected successfully"
            return 0
        else
            retry_count=$((retry_count + 1))
            log "Connection attempt $retry_count failed, retrying in $RETRY_DELAY seconds..."
            sleep $RETRY_DELAY
        fi
    done
    
    log "Failed to connect to camera after $MAX_RETRIES attempts"
    return 1
}

# Check camera status by testing connection
camera_status() {
    log "Checking camera status via connection test..."
    
    # Since there's no status command, test with a quick connect/disconnect
    if run_in_sdk_directory "./sony-cli connect" 8; then
        log "Camera connection test successful"
        # Quick disconnect to clean up
        run_in_sdk_directory "./sony-cli disconnect" 3
        return 0
    else
        log "Camera connection test failed"
        return 1
    fi
}

# Capture single image
capture_image() {
    log "Starting image capture..."
    local capture_start=$(date +%s.%3N)
    
    # Single-flight lock to avoid concurrent captures corrupting SDK state
    exec 9>"$CAPTURES_DIR/.capture.lock" || true
    if ! flock -n 9; then
        log "CAPTURE_SKIPPED: Another capture in progress"
        echo "FAILED:BUSY:0"
        return 95
    fi
    
    # Use the fast capture binary for <400ms performance
    # Run directly without logging wrapper to get clean output
    cd "$BUILD_PATH" || error_exit "Cannot change to build directory"

    # Dev/Test mode: simulate capture quickly
    if [ "${FAKE_CAMERA:-0}" = "1" ]; then
        local timestamp=$(date '+%Y%m%d_%H%M%S')
        local millis=$(date +%3N)
        local rand=$(printf '%04x' $RANDOM)
        local filename="card_${timestamp}_${millis}-${rand}.jpg"
        local tmp_path="${STAGING_DIR}/${filename}.tmp"
        local final_path="${CAPTURES_DIR}/${filename}"
        cp "$CARDMINT_ROOT/test-card.jpg" "$tmp_path" 2>/dev/null || cp "$CARDMINT_ROOT/test_highres.jpg" "$tmp_path"
        mv "$tmp_path" "$final_path"
        local capture_end=$(date +%s.%3N)
        local total_duration=$(awk "BEGIN {printf \"%.0f\", ($capture_end - $capture_start) * 1000}")
        log "CAPTURE_SUCCESS_FAKE: $filename (${total_duration}ms total)"
        echo "SUCCESS:$final_path:$total_duration"
        return 0
    fi
    
    local capture_output
    if capture_output=$(ionice -c2 -n0 nice -n -5 timeout $CAPTURE_TIMEOUT_SEC ./sony-pc-capture-fast --quick --no-delay --quiet 2>/dev/null); then
        local capture_end=$(date +%s.%3N)
        local total_duration=$(awk "BEGIN {printf \"%.0f\", ($capture_end - $capture_start) * 1000}")
        
        # Parse output: "/path/to/file.jpg NNNms"
        local captured_file=$(echo "$capture_output" | tail -1 | awk '{print $1}')
        local binary_time=$(echo "$capture_output" | tail -1 | awk '{print $2}' | sed 's/ms//')
        
        # Verify file was created
        if [ -f "$captured_file" ]; then
            # Move file via staging with atomic rename
            local timestamp=$(date '+%Y%m%d_%H%M%S')
            local millis=$(date +%3N)
            local rand=$(printf '%04x' $RANDOM)
            local filename="card_${timestamp}_${millis}-${rand}.jpg"
            local tmp_path="${STAGING_DIR}/${filename}.tmp"
            local target_path="${CAPTURES_DIR}/${filename}"
            
            mv "$captured_file" "$tmp_path"
            mv "$tmp_path" "$target_path"
            
            local file_size=$(stat -c%s "$target_path" 2>/dev/null || echo "0")
            if [ "$file_size" -le 1024 ]; then
                log "CAPTURE_FAILED: File too small ($file_size bytes)"
                echo "FAILED:FILE_INCOMPLETE:$file_size"
                return 1
            fi
            log "CAPTURE_SUCCESS: $filename (${binary_time}ms binary, ${total_duration}ms total, $file_size bytes)"
            echo "SUCCESS:$target_path:$binary_time"
            return 0
        else
            log "CAPTURE_FAILED: File not created: $captured_file"
            echo "FAILED:FILE_NOT_CREATED:$captured_file"
            return 1
        fi
    else
        local capture_end=$(date +%s.%3N)
        local total_duration=$(awk "BEGIN {printf \"%.0f\", ($capture_end - $capture_start) * 1000}")
        
        log "CAPTURE_FAILED: Command failed (${total_duration}ms total)"
        echo "FAILED:COMMAND_FAILED:$total_duration"
        return 1
    fi
}

# Disconnect camera
disconnect_camera() {
    log "Disconnecting camera..."
    
    if run_in_sdk_directory "./sony-cli disconnect" 5; then
        log "Camera disconnected successfully"
        return 0
    else
        log "Failed to disconnect camera cleanly"
        return 1
    fi
}

# Health check - validate entire camera pipeline
health_check() {
    log "Performing comprehensive health check..."
    
    local checks_passed=0
    local total_checks=5
    
    # Check 1: Environment
    if check_environment >/dev/null 2>&1; then
        log "✅ Environment check passed"
        checks_passed=$((checks_passed + 1))
    else
        log "❌ Environment check failed"
    fi
    
    # Check 2: Camera listing
    if list_cameras >/dev/null 2>&1; then
        log "✅ Camera listing passed"
        checks_passed=$((checks_passed + 1))
    else
        log "❌ Camera listing failed"
    fi
    
    # Check 3: Connection
    if connect_camera >/dev/null 2>&1; then
        log "✅ Camera connection passed"
        checks_passed=$((checks_passed + 1))
        
        # Check 4: Status (only if connected)
        if camera_status >/dev/null 2>&1; then
            log "✅ Camera status check passed"
            checks_passed=$((checks_passed + 1))
        else
            log "❌ Camera status check failed"
        fi
        
        # Check 5: Capture directory (test from original working directory)
        # Save current dir and return to cardmint root for directory check
        local current_dir=$(pwd)
        cd "$CARDMINT_ROOT" || true
        if [ -w "$CAPTURES_DIR" ]; then
            log "✅ Captures directory writable"
            checks_passed=$((checks_passed + 1))
        else
            log "❌ Captures directory not writable ($CAPTURES_DIR from $(pwd))"
        fi
        cd "$current_dir" || true
        
        # Clean disconnect
        disconnect_camera >/dev/null 2>&1
    else
        log "❌ Camera connection failed"
        log "❌ Skipping status and directory checks due to connection failure"
    fi
    
    log "Health check complete: $checks_passed/$total_checks checks passed"
    echo "HEALTH_CHECK:$checks_passed:$total_checks"
    
    [ $checks_passed -eq $total_checks ]
}

# Main command dispatcher
main() {
    local command="${1:-help}"
    
    log "Sony Camera Controller started: $command"
    
    # Always check environment and setup library path
    check_environment
    setup_library_path
    
    case "$command" in
        "list")
            list_cameras
            ;;
        "connect")
            connect_camera
            ;;
        "status")
            camera_status
            ;;
        "capture")
            capture_image
            ;;
        "disconnect")
            disconnect_camera
            ;;
        "health")
            health_check
            ;;
        "help"|*)
            echo "Sony Camera Controller - Production Ready"
            echo "Usage: $0 {list|connect|status|capture|disconnect|health}"
            echo ""
            echo "Commands:"
            echo "  list       - List available Sony cameras"
            echo "  connect    - Connect to Sony camera"
            echo "  status     - Check camera connection status"
            echo "  capture    - Capture single image (<400ms target)"
            echo "  disconnect - Disconnect from camera"
            echo "  health     - Comprehensive health check"
            echo ""
            echo "Environment:"
            echo "  SDK Path: $SDK_PATH"
            echo "  Build Path: $BUILD_PATH"
            echo "  Output Dir: $CAPTURES_DIR"
            echo "  Log File: $LOG_FILE"
            ;;
    esac
}

# Execute main function with all arguments
main "$@"
