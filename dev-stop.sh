#!/bin/bash
# CardMint Development - Graceful Shutdown
# Stops all frontend and backend dev servers

echo "🛑 Stopping CardMint dev servers..."

# Kill frontend Vite processes
VITE_PIDS=$(ps aux | grep "[v]ite" | grep "CardMint-workspace" | awk '{print $2}')
if [ -n "$VITE_PIDS" ]; then
  echo "  Stopping frontend (Vite)..."
  echo "$VITE_PIDS" | xargs kill 2>/dev/null
  sleep 1
fi

# Kill backend tsx processes
BACKEND_PIDS=$(ps aux | grep "[t]sx watch src/server.ts" | grep "CardMint-workspace" | awk '{print $2}')
if [ -n "$BACKEND_PIDS" ]; then
  echo "  Stopping backend (tsx)..."
  echo "$BACKEND_PIDS" | xargs kill 2>/dev/null
  sleep 1
fi

# Kill Node.js server processes
NODE_SERVER_PIDS=$(ps aux | grep "[n]ode.*src/server.ts" | grep "CardMint-workspace" | awk '{print $2}')
if [ -n "$NODE_SERVER_PIDS" ]; then
  echo "  Stopping Node server processes..."
  echo "$NODE_SERVER_PIDS" | xargs kill 2>/dev/null
  sleep 1
fi

# Force kill anything still listening on dev ports
for PORT in 4000 5173; do
  PORT_PIDS=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PORT_PIDS" ]; then
    echo "  Forcing release of port $PORT ($PORT_PIDS)..."
    echo "$PORT_PIDS" | xargs kill 2>/dev/null
    sleep 1
    PORT_PIDS=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$PORT_PIDS" ]; then
      echo "  Port $PORT still busy, sending SIGKILL"
      echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
    fi
  fi
done

echo "✅ All dev servers stopped"
