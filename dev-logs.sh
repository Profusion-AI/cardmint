#!/bin/bash
# CardMint Development - Log Viewer
# Tails both frontend and backend logs in split view

if [ ! -f "logs/frontend.log" ] || [ ! -f "logs/backend.log" ]; then
  echo "⚠️  Log files not found. Make sure dev servers are running."
  echo "   Run: ./dev-start.sh"
  exit 1
fi

# Check if tmux is available for split view
if command -v tmux &> /dev/null; then
  echo "📋 Opening logs in tmux split view..."
  echo "   Press Ctrl+B then D to detach"
  sleep 2
  tmux new-session \; \
    send-keys 'tail -f logs/backend.log' C-m \; \
    split-window -h \; \
    send-keys 'tail -f logs/frontend.log' C-m \; \
    select-pane -t 0
else
  # Fallback to multitail or simple tail
  if command -v multitail &> /dev/null; then
    multitail logs/backend.log logs/frontend.log
  else
    echo "📋 Tailing both logs (Ctrl+C to exit)..."
    tail -f logs/backend.log logs/frontend.log
  fi
fi
