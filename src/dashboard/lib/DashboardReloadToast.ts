// src/dashboard/lib/DashboardReloadToast.ts

type Backoff = { baseMs?: number; maxMs?: number };
type WSLike = WebSocket;

class Toast {
  private el: HTMLDivElement | null = null;
  private hideTimer: number | null = null;

  ensureStyles() {
    if (document.getElementById('cm-reload-toast-style')) return;
    const style = document.createElement('style');
    style.id = 'cm-reload-toast-style';
    style.textContent = `
      .cm-reload-toast {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(20,20,20,0.92);
        color: #fff;
        padding: 10px 14px;
        border-radius: 12px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
        font: 500 14px/1.1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 140ms ease;
      }
      .cm-reload-toast.show { opacity: 1; }
      .cm-reload-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #ffcc00;
        box-shadow: 0 0 0 0 rgba(255,204,0,0.7);
        animation: cm-pulse 1.2s infinite;
      }
      @keyframes cm-pulse {
        0% { box-shadow: 0 0 0 0 rgba(255,204,0,0.7); }
        70% { box-shadow: 0 0 0 8px rgba(255,204,0,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,204,0,0); }
      }
    `;
    document.head.appendChild(style);
  }

  show(text = 'Server reloaded… reconnecting') {
    this.ensureStyles();
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'cm-reload-toast';
      this.el.innerHTML = `<span class="cm-reload-dot"></span><span class="cm-reload-text"></span>`;
      document.body.appendChild(this.el);
    }
    const textEl = this.el.querySelector('.cm-reload-text')!;
    textEl.textContent = text;
    this.el.classList.add('show');
  }

  hide(delayMs = 600) {
    if (!this.el) return;
    if (this.hideTimer) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.hideTimer = window.setTimeout(() => {
      this.el?.classList.remove('show');
    }, delayMs) as unknown as number;
  }
}

class ReconnectingWebSocket {
  private url: string;
  private protocols?: string | string[];
  private backoff: Backoff;
  private ws: WSLike | null = null;
  private manualClose = false;
  private attempts = 0;
  private toast: Toast;

  // event handlers
  onopen: ((ev: Event) => any) | null = null;
  onmessage: ((ev: MessageEvent) => any) | null = null;
  onclose: ((ev: CloseEvent) => any) | null = null;
  onerror: ((ev: Event) => any) | null = null;

  constructor(url: string, protocols?: string | string[], backoff?: Backoff) {
    this.url = url;
    this.protocols = protocols;
    this.backoff = { baseMs: 200, maxMs: 2500, ...(backoff ?? {}) };
    this.toast = new Toast();
    this.connect();
  }

  private connect() {
    this.ws = this.protocols ? new WebSocket(this.url, this.protocols) : new WebSocket(this.url);

    this.ws.onopen = (ev) => {
      this.attempts = 0;
      this.toast.hide();
      this.onopen?.(ev);
    };
    this.ws.onmessage = (ev) => this.onmessage?.(ev);
    this.ws.onerror = (ev) => this.onerror?.(ev);
    this.ws.onclose = (ev) => {
      this.onclose?.(ev);
      if (this.manualClose) return;
      this.toast.show();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    this.attempts++;
    const jitter = Math.random() * 50;
    const wait = Math.min(this.backoff.baseMs! * Math.pow(2, this.attempts - 1) + jitter, this.backoff.maxMs!);
    setTimeout(() => this.connect(), wait);
  }

  send(data: Parameters<WSLike['send']>[0]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('socket not open');
    this.ws.send(data);
  }

  close(code?: number, reason?: string) {
    this.manualClose = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(code, reason);
    }
  }

  get readyState() {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  // EventTarget compatibility sugar
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any) {
    // route to our handlers
    if (type === 'open') this.onopen = listener as any;
    if (type === 'message') this.onmessage = listener as any;
    if (type === 'close') this.onclose = listener as any;
    if (type === 'error') this.onerror = listener as any;
  }
}

/** Singleton install — HMR-safe. */
let singleton: { Toast: Toast; ReconnectingWebSocket: typeof ReconnectingWebSocket } | null =
  // @ts-ignore
  (import.meta as any).hot?.data?.__cmReloadSingleton ?? null;

if (!singleton) {
  singleton = { Toast: new Toast(), ReconnectingWebSocket };
  // @ts-ignore
  if ((import.meta as any).hot) {
    // persist across HMR and prevent duplicate toasts
    (import.meta as any).hot.data.__cmReloadSingleton = singleton;
    (import.meta as any).hot.dispose(() => {
      // allow Vite to swap modules without leaving UI artifacts
      // We keep the singleton, but hide any visible toast on dispose.
      singleton?.Toast.hide(0);
    });
  }
}

export const DashboardReloadToast = singleton.Toast;
export const CMReconnectingWebSocket = singleton.ReconnectingWebSocket;