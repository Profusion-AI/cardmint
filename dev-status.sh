#!/bin/bash
# CardMint Development - Status Check
# Shows running dev servers and their ports

echo "🔍 CardMint Dev Status"
echo ""

# Check backend
BACKEND_PIDS=$(ps aux | grep "[t]sx watch src/server.ts\|[n]ode.*src/server.ts" | grep "CardMint-workspace" | awk '{print $2}')
if [ -n "$BACKEND_PIDS" ]; then
  echo "✓ Backend running (PID: $BACKEND_PIDS)"
  if curl -s http://localhost:4000/metrics > /dev/null 2>&1; then
    echo "  └─ http://localhost:4000 (responding)"
  else
    echo "  └─ Port 4000 not responding"
  fi
else
  echo "✗ Backend not running"
fi

# Check frontend
VITE_PIDS=$(ps aux | grep "[v]ite" | grep "CardMint-workspace" | awk '{print $2}')
if [ -n "$VITE_PIDS" ]; then
  echo "✓ Frontend running (PIDs: $VITE_PIDS)"

  # Try to detect port
  if curl -s http://localhost:5173 > /dev/null 2>&1; then
    echo "  └─ http://localhost:5173 (responding)"
  else
    echo "  └─ Port 5173 not responding"
  fi
else
  echo "✗ Frontend not running"
fi

echo ""
echo "💡 Commands:"
echo "  Start:  ./dev-start.sh"
echo "  Stop:   ./dev-stop.sh"
echo "  Logs:   ./dev-logs.sh"
