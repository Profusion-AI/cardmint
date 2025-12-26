#!/bin/bash
# CardMint Development - Clean Startup
# Starts frontend and backend dev servers with hot reloading

set -euo pipefail

BACKEND_PORT=4000
BACKEND_HEALTH_PATH="/metrics"

echo "🚀 Starting CardMint dev servers..."

mkdir -p logs

# Stop any existing processes first
./dev-stop.sh
sleep 1

# Start backend in background
echo ""
echo "📦 Starting backend (port ${BACKEND_PORT})..."
cd apps/backend
npm run dev > ../../logs/backend.log 2>&1 &
BACKEND_PID=$!
echo "  ✓ Backend started (PID: $BACKEND_PID)"
cd ../..

# Wait for backend to be ready
echo "  ⏳ Waiting for backend..."
for _ in {1..15}; do
  if curl -sf "http://127.0.0.1:${BACKEND_PORT}${BACKEND_HEALTH_PATH}" > /dev/null 2>&1; then
    echo "  ✓ Backend is ready"
    break
  fi
  sleep 1
done

# Start frontend in background
echo ""
echo "🎨 Starting frontend (strict port 5173)..."
cd apps/frontend
npm run dev > ../../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "  ✓ Frontend started (PID: $FRONTEND_PID)"
cd ../..

# Wait for frontend log to report the port or fail fast if busy
echo "  ⏳ Waiting for Vite..."
for _ in {1..15}; do
  if grep -q "Local:" logs/frontend.log 2>/dev/null; then
    break
  fi
  if grep -qi "EADDRINUSE" logs/frontend.log 2>/dev/null; then
    echo "  ❌ Vite reported port 5173 already in use. Run ./dev-stop.sh and retry." >&2
    exit 1
  fi
  sleep 1
done

# Detect which port Vite chose (strictPort keeps it at 5173, but log parsing is defensive)
VITE_PORT=$(grep -oP "Local:.*http://localhost:\K\d+" logs/frontend.log | head -1)
if [ -z "$VITE_PORT" ]; then
  VITE_PORT="5173"
fi

echo ""
echo "✅ CardMint is running!"
echo ""
echo "  🌐 Frontend:  http://localhost:${VITE_PORT}"
echo "  🔧 Backend:   http://localhost:${BACKEND_PORT}"
echo ""
echo "📝 Logs:"
echo "  Frontend: tail -f logs/frontend.log"
echo "  Backend:  tail -f logs/backend.log"
echo ""
echo "🛑 To stop: ./dev-stop.sh"
echo ""
