#!/usr/bin/env bash
# Healthcheck for OpenAI Files API + Responses API integration
# Exit codes:
#   0 - Success
#  10 - File upload failed (purpose: vision not supported)
#  11 - Responses API rejected file_id
#  12 - Response invalid/empty

set -euo pipefail

# Check for OPENAI_API_KEY
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "❌ OPENAI_API_KEY not set in environment"
  exit 1
fi

# Check for test image
TEST_IMAGE="${1:-}"
if [[ -z "$TEST_IMAGE" || ! -f "$TEST_IMAGE" ]]; then
  echo "Usage: $0 <path-to-test-image.jpg>"
  echo "Example: $0 /path/to/test-card-1024.jpg"
  exit 1
fi

# Verify image size
IMAGE_SIZE=$(stat -c%s "$TEST_IMAGE" 2>/dev/null || stat -f%z "$TEST_IMAGE" 2>/dev/null)
if [[ $IMAGE_SIZE -gt $((400 * 1024)) ]]; then
  echo "⚠️  Warning: Test image is ${IMAGE_SIZE}B (>400KB). Consider using a smaller test image."
fi

echo "🔍 OpenAI Files API + Responses API Healthcheck"
echo "================================================"
echo "Test image: $TEST_IMAGE (${IMAGE_SIZE}B)"
echo ""

# Step 1: Upload with purpose: vision
echo "Step 1: Uploading test image with purpose: vision..."
UPLOAD_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  https://api.openai.com/v1/files \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F purpose=vision \
  -F file=@"$TEST_IMAGE")

# Extract HTTP status
HTTP_STATUS=$(echo "$UPLOAD_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
UPLOAD_BODY=$(echo "$UPLOAD_RESPONSE" | sed '/HTTP_STATUS:/d')

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "❌ File upload failed with HTTP $HTTP_STATUS"
  echo "Response: $UPLOAD_BODY"
  echo ""
  echo "This suggests purpose: vision may not be supported on your account."
  echo "Fallback to HTTPS URLs instead of file_id may be required."
  exit 10
fi

# Extract file_id
FILE_ID=$(echo "$UPLOAD_BODY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -z "$FILE_ID" ]]; then
  echo "❌ File upload response missing file_id"
  echo "Response: $UPLOAD_BODY"
  exit 10
fi

echo "✅ Upload successful: file_id=$FILE_ID"
echo ""

# Step 2: Call Responses API with file_id
echo "Step 2: Testing Responses API with file_id..."
RESPONSES_PAYLOAD=$(cat <<EOF
{
  "model": "gpt-4o-mini",
  "max_output_tokens": 64,
  "input": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "What object is on this card?" },
      { "type": "input_image", "image": { "file_id": "$FILE_ID" } }
    ]
  }]
}
EOF
)

RESPONSES_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$RESPONSES_PAYLOAD")

# Extract HTTP status
HTTP_STATUS=$(echo "$RESPONSES_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
RESPONSES_BODY=$(echo "$RESPONSES_RESPONSE" | sed '/HTTP_STATUS:/d')

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "❌ Responses API failed with HTTP $HTTP_STATUS"
  echo "Response: $RESPONSES_BODY"
  echo ""
  echo "This suggests Responses API doesn't accept file_id for images."
  echo "Fallback to HTTPS URLs instead of file_id may be required."

  # Cleanup
  curl -s -X DELETE \
    "https://api.openai.com/v1/files/$FILE_ID" \
    -H "Authorization: Bearer $OPENAI_API_KEY" > /dev/null

  exit 11
fi

# Check for valid response content
CONTENT=$(echo "$RESPONSES_BODY" | grep -o '"content":\s*"[^"]*"' | head -1)
if [[ -z "$CONTENT" ]]; then
  echo "❌ Responses API returned empty/invalid content"
  echo "Response: $RESPONSES_BODY"

  # Cleanup
  curl -s -X DELETE \
    "https://api.openai.com/v1/files/$FILE_ID" \
    -H "Authorization: Bearer $OPENAI_API_KEY" > /dev/null

  exit 12
fi

echo "✅ Responses API successful"
echo "Content preview: $(echo "$CONTENT" | cut -c1-80)..."
echo ""

# Step 3: Cleanup
echo "Step 3: Cleaning up test file..."
DELETE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X DELETE \
  "https://api.openai.com/v1/files/$FILE_ID" \
  -H "Authorization: Bearer $OPENAI_API_KEY")

HTTP_STATUS=$(echo "$DELETE_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "✅ File deleted successfully"
else
  echo "⚠️  File deletion returned HTTP $HTTP_STATUS (non-critical)"
fi

echo ""
echo "================================================"
echo "✅ All checks passed!"
echo ""
echo "Your OpenAI account supports:"
echo "  ✓ File uploads with purpose: vision"
echo "  ✓ Responses API with file_id images"
echo "  ✓ File cleanup"
echo ""
echo "The current implementation should work without fallback."
exit 0
