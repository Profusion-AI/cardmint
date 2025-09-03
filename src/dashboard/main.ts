// src/dashboard/main.ts
// Dashboard entry point - auto-initializes reconnection toast

import { DashboardReloadToast, CMReconnectingWebSocket } from './lib/DashboardReloadToast.ts';

// Auto-initialize WebSocket connection for hot-reload notifications
function initializeReconnection() {
  // Only enable in development
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return;
  }

  try {
    // Try to connect to WebSocket for real-time updates
    // Read WebSocket URL from meta tag with fallback
    const wsUrl = document.querySelector('meta[name="ws-url"]')?.content || 'ws://localhost:3001';
    const ws = new CMReconnectingWebSocket(wsUrl);

    ws.addEventListener('open', () => {
      console.log('[Dashboard] WebSocket connected');
    });

    ws.addEventListener('close', () => {
      console.log('[Dashboard] WebSocket disconnected - toast will handle reconnection');
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        // Handle real-time updates here if needed
        if (data.type === 'server-reloading') {
          DashboardReloadToast.show('Server is reloading...');
        }
      } catch (e) {
        // Handle binary or non-JSON messages
      }
    });

  } catch (error) {
    console.warn('[Dashboard] WebSocket initialization failed:', error);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeReconnection);
} else {
  initializeReconnection();
}

// Export for manual usage if needed
export { DashboardReloadToast, CMReconnectingWebSocket };