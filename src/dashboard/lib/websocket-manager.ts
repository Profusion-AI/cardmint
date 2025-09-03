// src/dashboard/lib/websocket-manager.ts
// Enhanced WebSocket manager with reconnection logic and event handling

export interface WebSocketConfig {
  maxReconnectAttempts: number;
  reconnectInterval: number;
  heartbeatInterval: number;
  timeout: number;
}

export interface WebSocketMessage {
  type: string;
  data?: any;
  message?: string;
  timestamp?: string;
  [key: string]: any;
}

export type WebSocketEventHandler = (data: WebSocketMessage) => void;

export class CardMintWebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private config: WebSocketConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private eventHandlers: Map<string, WebSocketEventHandler[]> = new Map();
  private connected = false;

  constructor(config: Partial<WebSocketConfig> = {}) {
    this.config = {
      maxReconnectAttempts: 10,
      reconnectInterval: 1000, // Start at 1 second
      heartbeatInterval: 30000, // 30 seconds
      timeout: 5000,
      ...config
    };

    // Read WebSocket URL from meta tag with fallback
    this.url = document.querySelector('meta[name="ws-url"]')?.content || this.getDefaultWebSocketUrl();
    
    this.connect();
  }
  
  private getDefaultWebSocketUrl(): string {
    // Auto-detect WebSocket URL as fallback
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = this.getWebSocketPort();
    return `${protocol}//${location.hostname}:${port}`;
  }

  private getWebSocketPort(): string {
    // Try to determine WebSocket port from current location
    const currentPort = parseInt(location.port || '80');
    
    // Common patterns for WebSocket ports
    if (currentPort === 3000) return '3001'; // Development
    if (currentPort === 5173) return '3001'; // Vite dev server
    if (currentPort === 80) return '3001';   // Production HTTP
    if (currentPort === 443) return '3001';  // Production HTTPS
    
    return '3001'; // Default fallback
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('[WebSocket] Connected to CardMint server');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit('connection', { connected: true });
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WebSocketMessage;
          this.handleMessage(data);
        } catch (error) {
          console.warn('[WebSocket] Failed to parse message:', event.data);
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.stopHeartbeat();
        this.emit('connection', { connected: false });
        
        if (!event.wasClean && this.reconnectAttempts < this.config.maxReconnectAttempts) {
          // exponential backoff up to ~30s
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        // optional; fall back to REST
        this.emit('error', { error: 'WebSocket connection failed' });
      };

    } catch (error) {
      // optional; REST only
      this.emit('connection', { connected: false });
      this.scheduleReconnect();
    }
  }

  private handleMessage(data: WebSocketMessage): void {
    // Add timestamp if not present
    if (!data.timestamp) {
      data.timestamp = new Date().toISOString();
    }

    // Emit to all listeners for this message type
    const handlers = this.eventHandlers.get(data.type) || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`[WebSocket] Handler error for ${data.type}:`, error);
      }
    });

    // Also emit to generic 'message' listeners
    this.emit('message', data);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempts++;
      // Rotate common fallback ports when using default host
      try {
        const u = new URL(this.url);
        const host = u.hostname;
        const port = Number(u.port || '3001');
        const candidates = [3001, 3002, 3003, 3004];
        const idx = candidates.indexOf(port);
        const nextPort = candidates[(idx + 1) % candidates.length];
        this.url = `${u.protocol}//${host}:${nextPort}`;
      } catch {}
      this.connect();
    }, delay);

    this.emit('reconnecting', { 
      attempt: this.reconnectAttempts + 1, 
      maxAttempts: this.config.maxReconnectAttempts,
      delay 
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public on(eventType: string, handler: WebSocketEventHandler): void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType)!.push(handler);
  }

  public off(eventType: string, handler?: WebSocketEventHandler): void {
    if (!handler) {
      this.eventHandlers.delete(eventType);
      return;
    }

    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private emit(eventType: string, data: any): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.forEach(handler => {
      try {
        handler({ type: eventType, ...data });
      } catch (error) {
        console.error(`[WebSocket] Event handler error for ${eventType}:`, error);
      }
    });
  }

  public send(data: any): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
        return true;
      } catch (error) {
        console.error('[WebSocket] Failed to send message:', error);
      }
    } else {
      console.warn('[WebSocket] Cannot send message - not connected');
    }
    return false;
  }

  public isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.connected = false;
    this.eventHandlers.clear();
  }

  public getConnectionInfo(): {connected: boolean, attempts: number, url: string} {
    return {
      connected: this.connected,
      attempts: this.reconnectAttempts,
      url: this.url
    };
  }
}

// Global WebSocket manager instance
let globalWSManager: CardMintWebSocketManager | null = null;

export function getWebSocketManager(): CardMintWebSocketManager {
  if (!globalWSManager) {
    globalWSManager = new CardMintWebSocketManager();
  }
  return globalWSManager;
}

// Utility functions for common use cases
export function subscribeToQueueUpdates(handler: (data: any) => void): () => void {
  const ws = getWebSocketManager();
  ws.on('queueStatus', handler);
  ws.on('cardProcessed', handler);
  ws.on('cardFailed', handler);
  ws.on('batchProgress', handler);
  
  // Return unsubscribe function
  return () => {
    ws.off('queueStatus', handler);
    ws.off('cardProcessed', handler);
    ws.off('cardFailed', handler);
    ws.off('batchProgress', handler);
  };
}

export function subscribeToConnectionStatus(handler: (connected: boolean) => void): () => void {
  const ws = getWebSocketManager();
  
  const connectionHandler = (data: WebSocketMessage) => {
    handler(data.connected === true);
  };
  
  ws.on('connection', connectionHandler);
  
  // Send initial status
  handler(ws.isConnected());
  
  return () => ws.off('connection', connectionHandler);
}

export function requestStatus(): void {
  const ws = getWebSocketManager();
  ws.send({ action: 'getQueueStatus' });
  ws.send({ action: 'getMetrics' });
  ws.send({ action: 'getCardStatusDistribution' });
}

// Enhanced toast notifications for connection status
export class ConnectionToast {
  private static toastElement: HTMLElement | null = null;
  private static hideTimer: number | null = null;

  static show(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    this.hide();

    const toast = document.createElement('div');
    toast.className = `connection-toast connection-toast-${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-icon">${this.getIcon(type)}</span>
        <span class="toast-message">${message}</span>
      </div>
    `;

    // Add styles
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${this.getBackgroundColor(type)};
      color: white;
      padding: 12px 18px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideInRight 0.3s ease-out;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1);
    `;

    // Add keyframe animation
    if (!document.getElementById('toast-styles')) {
      const styles = document.createElement('style');
      styles.id = 'toast-styles';
      styles.textContent = `
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOutRight {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
      `;
      document.head.appendChild(styles);
    }

    document.body.appendChild(toast);
    this.toastElement = toast;

    // Auto-hide after delay (except for error messages)
    if (type !== 'error') {
      this.hideTimer = window.setTimeout(() => this.hide(), 4000);
    }
  }

  static hide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    if (this.toastElement) {
      this.toastElement.style.animation = 'slideOutRight 0.3s ease-out forwards';
      setTimeout(() => {
        if (this.toastElement && this.toastElement.parentNode) {
          this.toastElement.parentNode.removeChild(this.toastElement);
        }
        this.toastElement = null;
      }, 300);
    }
  }

  private static getIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'warning': return '⚠';
      case 'error': return '✗';
      default: return 'ℹ';
    }
  }

  private static getBackgroundColor(type: string): string {
    switch (type) {
      case 'success': return 'rgba(16, 185, 129, 0.9)';
      case 'warning': return 'rgba(245, 158, 11, 0.9)';
      case 'error': return 'rgba(239, 68, 68, 0.9)';
      default: return 'rgba(59, 130, 246, 0.9)';
    }
  }
}

// Auto-initialize connection status toasts
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const ws = getWebSocketManager();
    
    ws.on('connection', (data) => {
      if (data.connected) {
        ConnectionToast.show('Connected to server', 'success');
      } else {
        ConnectionToast.show('Connection lost', 'warning');
      }
    });

    ws.on('reconnecting', (data) => {
      ConnectionToast.show(
        `Reconnecting... (${data.attempt}/${data.maxAttempts})`,
        'info'
      );
    });

    ws.on('error', (data) => {
      ConnectionToast.show('Connection error', 'error');
    });
  });
}
