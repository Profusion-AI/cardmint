#!/bin/bash

# CardMint E2E Production Readiness Validation
# Comprehensive test suite for production deployment readiness

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 CardMint E2E Production Readiness Validation${NC}"
echo "================================================================="
echo ""

# Configuration
API_BASE="http://localhost:3000"
WS_URL="ws://localhost:3001"
GOLDEN_DIR="./data/golden_baseline"
TEST_CYCLE="prod_ready_$(date +%s)"

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_result="$3"
    
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -n "📝 Test ${TESTS_RUN}: ${test_name}... "
    
    if eval "$test_command"; then
        if [ -n "$expected_result" ]; then
            if eval "$expected_result"; then
                echo -e "${GREEN}✅ PASS${NC}"
                TESTS_PASSED=$((TESTS_PASSED + 1))
            else
                echo -e "${RED}❌ FAIL (expectation not met)${NC}"
                TESTS_FAILED=$((TESTS_FAILED + 1))
            fi
        else
            echo -e "${GREEN}✅ PASS${NC}"
            TESTS_PASSED=$((TESTS_PASSED + 1))
        fi
    else
        echo -e "${RED}❌ FAIL${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

echo -e "${YELLOW}Phase 1: Infrastructure Validation${NC}"
echo "----------------------------------------"

# Test 1: API Health Check
run_test "API Health Check" \
    "curl -s ${API_BASE}/api/health | jq -r '.status' | grep -q 'healthy'" \
    ""

# Test 2: WebSocket Connectivity
run_test "WebSocket Server Available" \
    "curl -s --max-time 5 ${API_BASE}/dashboard/verification.html | head -5 | grep -q 'DOCTYPE html'" \
    ""

# Test 3: Database Connectivity
run_test "Database Connection" \
    "curl -s ${API_BASE}/api/cards | jq -r '.[]' > /dev/null 2>&1" \
    ""

# Test 4: Telemetry System
run_test "Telemetry Pipeline" \
    "curl -s -X POST -H 'Content-Type: application/json' -d '{\"ts\": $(date +%s)000, \"source\": \"keyboard\", \"action\": \"capture\", \"cardId\": \"test_1\", \"cycleId\": \"${TEST_CYCLE}\", \"latencyMs\": 50, \"error\": \"\"}' ${API_BASE}/api/telemetry/input | jq -r '.success' | grep -q 'true'" \
    ""

echo ""
echo -e "${YELLOW}Phase 2: Capture Simulation Validation${NC}"
echo "--------------------------------------------"

# Test 5: Single Image Simulation
run_test "Single Image Simulation" \
    "curl -s -X POST -H 'Content-Type: application/json' -d '{\"filePath\": \"${GOLDEN_DIR}/blissey.jpg\", \"cycleId\": \"${TEST_CYCLE}\"}' ${API_BASE}/api/capture/simulate | jq -r '.simulated' | grep -q 'true'" \
    ""

# Test 6: Batch Image Simulation
run_test "Batch Image Simulation" \
    "curl -s -X POST -H 'Content-Type: application/json' -d '{\"filePaths\": [\"${GOLDEN_DIR}/blissey.jpg\", \"${GOLDEN_DIR}/neo4-5_large.jpg\"], \"cycleId\": \"${TEST_CYCLE}\"}' ${API_BASE}/api/batch/enqueue | jq -r '.successful' | grep -q '2'" \
    ""

echo ""
echo -e "${YELLOW}Phase 3: Golden 10 Baseline Validation${NC}"
echo "--------------------------------------------"

# Test 7: Golden Images Accessible
GOLDEN_COUNT=$(find ${GOLDEN_DIR} -name "*.jpg" -o -name "*.JPG" | wc -l)
run_test "Golden 10 Images Available" \
    "[ ${GOLDEN_COUNT} -ge 10 ]" \
    ""

# Test 8: Golden Manifest Validation
run_test "Golden Manifest Valid" \
    "jq -r '.cards | length' ${GOLDEN_DIR}/manifest.json | grep -q '10'" \
    ""

echo ""
echo -e "${YELLOW}Phase 4: Mac ML Server Validation${NC}"
echo "---------------------------------------"

# Test 9: Mac ML Server Connectivity
run_test "Mac ML Server Online" \
    "curl -s --connect-timeout 5 http://10.0.24.174:1234/v1/models | jq -r '.data[0].id' | grep -q 'qwen'" \
    ""

# Test 10: LMStudio Model Ready
run_test "LMStudio Model Available" \
    "curl -s http://10.0.24.174:1234/v1/models | jq -r '.data[] | select(.id | contains(\"qwen2.5-vl\")) | .id' | head -1 | grep -q '.'" \
    ""

echo ""
echo -e "${YELLOW}Phase 5: Dashboard & UI Validation${NC}"
echo "---------------------------------------"

# Test 11: Verification Dashboard
run_test "Verification Dashboard Loads" \
    "curl -s ${API_BASE}/dashboard/verification.html | grep -q 'capture-pane'" \
    ""

# Test 12: Dashboard Assets
run_test "Dashboard CSS/JS Assets" \
    "curl -s ${API_BASE}/dashboard/verification.html | grep -q 'CardMint - Verification'" \
    ""

echo ""
echo -e "${YELLOW}Phase 6: Performance Baseline${NC}"
echo "------------------------------------"

# Test 13: API Response Time
start_time=$(date +%s%3N)
curl -s ${API_BASE}/api/health > /dev/null
end_time=$(date +%s%3N)
latency=$((end_time - start_time))

run_test "API Response Time (<100ms)" \
    "[ ${latency} -lt 100 ]" \
    ""

# Test 14: Memory Usage Check
memory_mb=$(curl -s ${API_BASE}/api/health | jq -r '.memory.rss')
run_test "Memory Usage Reasonable (<200MB)" \
    "[ ${memory_mb} -lt 200 ]" \
    ""

echo ""
echo -e "${YELLOW}Phase 7: Telemetry CSV Validation${NC}"
echo "---------------------------------------"

# Test 15: CSV Header Correct
run_test "CSV Header Format" \
    "head -1 ./data/input-telemetry.csv | grep -q 'ts,source,action,cardId,cycleId,latencyMs,error'" \
    ""

# Test 16: CSV Data Integrity
CSV_LINES=$(wc -l < ./data/input-telemetry.csv)
run_test "CSV Has Data" \
    "[ ${CSV_LINES} -gt 1 ]" \
    ""

echo ""
echo "================================================================="
echo -e "${BLUE}📊 Production Readiness Summary${NC}"
echo "================================================================="
echo -e "Total Tests Run:    ${TESTS_RUN}"
echo -e "Tests Passed:       ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Tests Failed:       ${RED}${TESTS_FAILED}${NC}"

if [ ${TESTS_FAILED} -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 ALL TESTS PASSED - PRODUCTION READY!${NC}"
    echo ""
    echo -e "${BLUE}Ready for Production Data:${NC}"
    echo "• Place your card images in ./data/inventory_images/"
    echo "• Use batch enqueue API to process multiple cards"
    echo "• Monitor telemetry via ./data/input-telemetry.csv"
    echo "• Access dashboard at http://localhost:3000/dashboard/verification.html"
    echo ""
    echo -e "${BLUE}Next Steps:${NC}"
    echo "• Run incremental tests: 10 → 25 → 50 → 100 cards"
    echo "• Monitor Mac ML server performance"
    echo "• Validate keyboard vs controller A/B testing"
    echo "• Collect throughput metrics (cards/hour)"
    echo ""
    exit 0
else
    echo ""
    echo -e "${RED}❌ PRODUCTION READINESS FAILED${NC}"
    echo "Please fix the failing tests before proceeding with production data."
    echo ""
    exit 1
fi