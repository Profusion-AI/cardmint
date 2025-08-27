#!/bin/bash

# CardMint A/B Testing Smoke Script
# Tests the complete input telemetry pipeline without external dependencies
# Usage: ./scripts/smoke-ab.sh [API_PORT]

set -e

# Configuration
API_PORT=${1:-${API_PORT:-3000}}
API_BASE="http://localhost:${API_PORT}"
CYCLE_ID="smoke_test_$(date +%s)"

echo "🧪 CardMint A/B Testing Smoke Script"
echo "======================================"
echo "API Base: ${API_BASE}"
echo "Cycle ID: ${CYCLE_ID}"
echo ""

# Check if jq is available for JSON parsing
if command -v jq >/dev/null 2>&1; then
    PARSE_JSON="jq"
    echo "✅ jq available for JSON parsing"
else
    PARSE_JSON="sed"
    echo "⚠️  jq not available, using sed fallback"
fi

# Function to extract JSON values with fallback
extract_json() {
    local json="$1"
    local key="$2"
    
    if [ "$PARSE_JSON" = "jq" ]; then
        echo "$json" | jq -r ".$key"
    else
        echo "$json" | sed -n "s/.*\"$key\":\s*\([0-9]*\).*/\1/p"
    fi
}

# Test 1: POST keyboard input telemetry
echo "📝 Test 1: Posting keyboard input telemetry..."
keyboard_response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"ts\": $(date +%s)000,
        \"source\": \"keyboard\",
        \"action\": \"capture\",
        \"cardId\": \"smoke_card_1\",
        \"cycleId\": \"${CYCLE_ID}\",
        \"latencyMs\": 25.5,
        \"error\": \"\"
    }" \
    "${API_BASE}/api/telemetry/input")

keyboard_body=$(echo "$keyboard_response" | head -n -1)
keyboard_status=$(echo "$keyboard_response" | tail -n 1)

if [ "$keyboard_status" != "200" ]; then
    echo "❌ Keyboard telemetry POST failed with status $keyboard_status"
    echo "Response: $keyboard_body"
    exit 1
fi

echo "✅ Keyboard telemetry posted successfully"

# Test 2: POST controller input telemetry
echo "📝 Test 2: Posting controller input telemetry..."
controller_response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"ts\": $(date +%s)000,
        \"source\": \"controller\",
        \"action\": \"approve\",
        \"cardId\": \"smoke_card_2\",
        \"cycleId\": \"${CYCLE_ID}\",
        \"latencyMs\": 18.2,
        \"error\": \"\"
    }" \
    "${API_BASE}/api/telemetry/input")

controller_body=$(echo "$controller_response" | head -n -1)
controller_status=$(echo "$controller_response" | tail -n 1)

if [ "$controller_status" != "200" ]; then
    echo "❌ Controller telemetry POST failed with status $controller_status"
    echo "Response: $controller_body"
    exit 1
fi

echo "✅ Controller telemetry posted successfully"

# Test 3: POST another keyboard input for better test data
echo "📝 Test 3: Posting additional keyboard input..."
keyboard2_response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"ts\": $(date +%s)000,
        \"source\": \"keyboard\",
        \"action\": \"reject\",
        \"cardId\": \"smoke_card_3\",
        \"cycleId\": \"${CYCLE_ID}\",
        \"latencyMs\": 32.1,
        \"error\": \"\"
    }" \
    "${API_BASE}/api/telemetry/input")

keyboard2_status=$(echo "$keyboard2_response" | tail -n 1)

if [ "$keyboard2_status" != "200" ]; then
    echo "❌ Additional keyboard telemetry POST failed"
    exit 1
fi

echo "✅ Additional keyboard telemetry posted"

# Small delay to ensure all data is written
sleep 1

# Test 4: GET telemetry summary for our cycle
echo "📝 Test 4: Fetching telemetry summary for cycle ${CYCLE_ID}..."
summary_response=$(curl -s -w "\n%{http_code}" \
    "${API_BASE}/api/telemetry/input/summary?cycle=${CYCLE_ID}")

summary_body=$(echo "$summary_response" | head -n -1)
summary_status=$(echo "$summary_response" | tail -n 1)

if [ "$summary_status" != "200" ]; then
    echo "❌ Telemetry summary GET failed with status $summary_status"
    echo "Response: $summary_body"
    exit 1
fi

echo "✅ Telemetry summary retrieved successfully"

# Parse summary data
total_inputs=$(extract_json "$summary_body" "totalInputs")
keyboard_inputs=$(extract_json "$summary_body" "keyboardInputs")
controller_inputs=$(extract_json "$summary_body" "controllerInputs")

echo ""
echo "📊 Telemetry Summary Results:"
echo "----------------------------"
echo "Total Inputs: $total_inputs"
echo "Keyboard Inputs: $keyboard_inputs"
echo "Controller Inputs: $controller_inputs"

# Test 5: Validate expected counts
echo ""
echo "📝 Test 5: Validating A/B test data integrity..."

# We posted 2 keyboard + 1 controller = 3 total
if [ "$total_inputs" != "3" ]; then
    echo "❌ Expected 3 total inputs, got $total_inputs"
    exit 1
fi

if [ "$keyboard_inputs" != "2" ]; then
    echo "❌ Expected 2 keyboard inputs, got $keyboard_inputs"
    exit 1
fi

if [ "$controller_inputs" != "1" ]; then
    echo "❌ Expected 1 controller input, got $controller_inputs"
    exit 1
fi

echo "✅ A/B test data integrity verified"

# Test 6: Test invalid telemetry rejection
echo ""
echo "📝 Test 6: Testing invalid telemetry rejection..."
invalid_response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"source\": \"keyboard\",
        \"action\": \"capture\"
    }" \
    "${API_BASE}/api/telemetry/input")

invalid_status=$(echo "$invalid_response" | tail -n 1)

if [ "$invalid_status" != "400" ]; then
    echo "❌ Expected 400 status for invalid telemetry, got $invalid_status"
    exit 1
fi

echo "✅ Invalid telemetry correctly rejected with 400 status"

# All tests passed!
echo ""
echo "🎉 All smoke tests passed! A/B testing harness is ready."
echo ""
echo "Summary:"
echo "✅ Keyboard input telemetry recording"
echo "✅ Controller input telemetry recording"
echo "✅ Telemetry summary generation"
echo "✅ Cycle-based filtering"  
echo "✅ Data integrity validation"
echo "✅ Invalid input rejection"
echo ""
echo "The CardMint A/B testing pipeline is production-ready."

exit 0