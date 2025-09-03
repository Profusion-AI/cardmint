// Browser-compatible Input Bus
// Simplified version of input-bus.ts for direct browser use

class BrowserInputBus extends EventTarget {
  constructor(csvPath = '/api/telemetry/input.csv') {
    super();
    this.sequenceCounter = 0;
    this.cycleId = `cycle_${Date.now()}`;
    this.csvPath = csvPath;
    this.startTime = Date.now();
    
    console.log(`[InputBus] Initialized, cycle: ${this.cycleId}`);
  }

  /**
   * Emit typed input event with validation
   */
  emitInput(event) {
    const seq = ++this.sequenceCounter;
    const validatedEvent = {
      ...event,
      seq,
      cycleId: event.cycleId || this.cycleId,
    };

    // Basic validation
    const validActions = ['capture', 'approve', 'reject'];
    const validSources = ['keyboard', 'controller'];
    
    if (!validActions.includes(validatedEvent.action)) {
      console.error('Invalid action:', validatedEvent.action);
      return;
    }
    
    if (!validSources.includes(validatedEvent.source)) {
      console.error('Invalid source:', validatedEvent.source);
      return;
    }

    // Record telemetry
    this.recordTelemetry(validatedEvent);
    
    // Emit events
    this.dispatchEvent(new CustomEvent('input', { detail: validatedEvent }));
    this.dispatchEvent(new CustomEvent(validatedEvent.action, { detail: validatedEvent }));
    
    console.log(`[InputBus] Input: ${validatedEvent.action} from ${validatedEvent.source} [${validatedEvent.seq}]`);
  }

  /**
   * Record telemetry via API
   */
  async recordTelemetry(event) {
    const telemetry = {
      ts: event.ts,
      source: event.source,
      action: event.action,
      cardId: event.cardId || '',
      cycleId: event.cycleId || this.cycleId,
      latencyMs: Date.now() - event.ts,
      error: ''
    };

    try {
      // Send to API for CSV logging
      await fetch('/api/telemetry/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetry)
      });
    } catch (error) {
      console.warn('Failed to record telemetry:', error);
      // Store locally as fallback
      this.storeLocalTelemetry(telemetry);
    }
  }

  storeLocalTelemetry(telemetry) {
    const key = `cardmint_telemetry_${this.cycleId}`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push(telemetry);
    localStorage.setItem(key, JSON.stringify(existing));
  }

  /**
   * Subscribe to specific action type
   */
  onAction(action, handler) {
    this.addEventListener(action, (e) => handler(e.detail));
  }

  /**
   * Subscribe to all input events
   */
  onInput(handler) {
    this.addEventListener('input', (e) => handler(e.detail));
  }

  /**
   * Get telemetry summary
   */
  async getTelemetrySummary() {
    try {
      const response = await fetch(`/api/telemetry/input/summary?cycle=${this.cycleId}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to get telemetry summary:', error);
      return this.getLocalTelemetrySummary();
    }
  }

  getLocalTelemetrySummary() {
    const key = `cardmint_telemetry_${this.cycleId}`;
    const data = JSON.parse(localStorage.getItem(key) || '[]');
    
    const keyboardInputs = data.filter(d => d.source === 'keyboard').length;
    const controllerInputs = data.filter(d => d.source === 'controller').length;
    const totalInputs = data.length;
    const avgLatencyMs = totalInputs > 0 
      ? data.reduce((sum, d) => sum + d.latencyMs, 0) / totalInputs 
      : 0;
    
    const sessionDurationMs = Date.now() - this.startTime;
    const throughputPerMinute = totalInputs > 0 
      ? (totalInputs / sessionDurationMs) * 60000 
      : 0;

    return {
      totalInputs,
      keyboardInputs,
      controllerInputs,
      avgLatencyMs,
      sessionDurationMs,
      throughputPerMinute,
    };
  }

  /**
   * Start new cycle for A/B testing
   */
  startNewCycle() {
    this.cycleId = `cycle_${Date.now()}`;
    this.startTime = Date.now();
    this.sequenceCounter = 0;
    console.log(`[InputBus] Started new test cycle: ${this.cycleId}`);
    return this.cycleId;
  }

  getCurrentCycle() {
    return this.cycleId;
  }
}

/**
 * Keyboard Adapter - Minimal mappings only
 */
class BrowserKeyboardAdapter {
  constructor(bus) {
    this.bus = bus;
    this.keyMappings = {
      'Space': 'capture',
      'KeyX': 'capture',
      'KeyA': 'approve',
      'KeyB': 'reject',
      'KeyR': 'reject',
    };
    
    this.setupEventListeners();
    console.log('[KeyboardAdapter] Initialized with minimal mappings');
  }

  setupEventListeners() {
    document.addEventListener('keydown', this.handleKeydown.bind(this));
  }

  handleKeydown(event) {
    // Skip if typing in form fields
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
      return;
    }
    // Skip if focused element is a control that might bind Space/Enter
    const active = document.activeElement;
    if (active && (active.tagName === 'BUTTON' || active.tagName === 'A' || active.getAttribute('role') === 'button')) {
      // We'll let our preventDefault below stop duplicate native clicks,
      // but also early-return to avoid emitting twice in odd browsers.
      // Return only for Space; allow A/B/R keys to pass.
      if (event.code === 'Space') {
        return;
      }
    }
    // Ignore auto-repeat to prevent floods on long press
    if (event.repeat) {
      return;
    }
    // Prevent other handlers from turning keydowns into synthetic clicks
    event.preventDefault();
    event.stopPropagation();
    
    const action = this.keyMappings[event.code];
    
    if (action) {
      this.bus.emitInput({
        action,
        source: 'keyboard',
        ts: Date.now(),
      });
    }
  }

  getMappings() {
    return {
      'Space/X': 'Capture Card',
      'A': 'Approve Card',
      'B/R': 'Reject Card',
    };
  }
}

/**
 * Controller Adapter - Shim for future integration
 */
class BrowserControllerAdapter {
  constructor(bus) {
    this.bus = bus;
    this.connected = false;
    console.log('[ControllerAdapter] Initialized (shim mode)');
  }

  simulateInput(action) {
    this.bus.emitInput({
      action,
      source: 'controller',
      ts: Date.now(),
    });
  }

  isConnected() {
    return this.connected;
  }

  getStatus() {
    return { connected: this.connected };
  }
}

// Global instances for dashboard use
window.inputBus = new BrowserInputBus();
window.KeyboardAdapter = BrowserKeyboardAdapter;
window.ControllerAdapter = BrowserControllerAdapter;

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { 
    BrowserInputBus, 
    BrowserKeyboardAdapter, 
    BrowserControllerAdapter 
  };
}
