#!/bin/bash
# Verify Path A retry and fallback metrics
# Usage: ./scripts/verify-retry-metrics.sh

set -e

echo "=== Path A Retry/Fallback Metrics Verification ==="
echo ""

# Check if server is running
if ! curl -s http://localhost:4000/health >/dev/null 2>&1; then
  echo "❌ Server not running at http://localhost:4000"
  echo "   Start with: npm run dev"
  exit 1
fi

echo "✅ Server is running"
echo ""

# Fetch metrics
echo "📊 Current metrics:"
echo ""

METRICS=$(curl -s http://localhost:4000/metrics)

# Extract key metrics
echo "Path A Retry Metrics:"
echo "$METRICS" | jq '.counters | {
  a_lane_retries: .a_lane_retries_total,
  retry_successes: .a_lane_retry_success_total,
  fallbacks_to_lmstudio: .fallbacks_to_lmstudio_total,
  pathA_failures: .pathA_failures_total
}'

echo ""
echo "Queue Metrics:"
echo "$METRICS" | jq '.gauges | {
  queue_depth: .queue_depth_current
}'

echo ""
echo "General Metrics:"
echo "$METRICS" | jq '.counters | {
  jobs_processed: .jobs_processed_total,
  jobs_failed: .jobs_failed_total
}'

echo ""
echo "Inference Latency:"
echo "$METRICS" | jq '.histograms.inference_latency_ms | {
  count: .count,
  p50: .p50,
  p95: .p95,
  min: .min,
  max: .max
}'

echo ""
echo "=== Verification Complete ==="
echo ""
echo "To test forced timeout:"
echo "  1. Set OPENAI_TIMEOUT_MS=1 in .env"
echo "  2. Trigger a capture"
echo "  3. Run this script again to see a_lane_retries_total and fallbacks_to_lmstudio_total increment"
