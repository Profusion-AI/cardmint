// Dashboard Input Integration
// Connects input-bus to dashboard functions for keyboard/controller parity

class DashboardInputManager {
  constructor() {
    this.inputBus = null;
    this.keyboardAdapter = null;
    this.controllerAdapter = null;
    this.currentInputSource = 'keyboard';
    this.telemetryEnabled = true;
    this.captureDebounceMs = 150; // small guard to avoid accidental double triggers
    this._lastCaptureAt = 0;
    
    this.initializeInputBus();
    this.createStatusWidget();
  }

  async initializeInputBus() {
    try {
      // Use browser-compatible input bus (loaded via script tag)
      if (window.inputBus && window.KeyboardAdapter && window.ControllerAdapter) {
        this.inputBus = window.inputBus;
        this.keyboardAdapter = new window.KeyboardAdapter(this.inputBus);
        this.controllerAdapter = new window.ControllerAdapter(this.inputBus);
        
        console.log('[Dashboard] Input bus initialized');
        this.setupInputHandlers();
        this.updateStatusWidget();
      } else {
        throw new Error('Browser input bus not available');
      }
      
    } catch (error) {
      console.error('[Dashboard] Failed to initialize input bus:', error);
      // Fallback to basic keyboard handling
      this.setupFallbackKeyboardHandlers();
    }
  }

  setupInputHandlers() {
    if (!this.inputBus) return;
    
    // Listen for input events from the bus
    this.inputBus.onInput((event) => {
      this.handleInputEvent(event);
    });
    
    // Listen for specific actions
    this.inputBus.onAction('capture', (event) => {
      this.handleCaptureAction(event);
    });
    
    this.inputBus.onAction('approve', (event) => {
      this.handleApproveAction(event);
    });
    
    this.inputBus.onAction('reject', (event) => {
      this.handleRejectAction(event);
    });
  }

  handleInputEvent(event) {
    this.currentInputSource = event.source;
    this.updateStatusWidget();
    
    // Add visual feedback
    this.showInputFeedback(event.action, event.source);
    
    console.log(`[Dashboard] Input: ${event.action} from ${event.source}`);
  }

  async handleCaptureAction(event) {
    try {
      // Lightweight debounce to avoid double-triggers from device quirks
      const now = Date.now();
      if (now - this._lastCaptureAt < this.captureDebounceMs) {
        return;
      }
      this._lastCaptureAt = now;

      // Do not call emitInput here — this handler is invoked by emitInput.
      // Telemetry was already recorded by the originating input.
      
      // Trigger capture directly without re-emitting input or synthesizing DOM clicks
      if (typeof window.captureCard === 'function') {
        await window.captureCard();
      } else if (typeof window.triggerCapture === 'function') {
        await window.triggerCapture();
      } else {
        // Last resort: synthesize a click
        const captureBtn = document.getElementById('capture-btn');
        if (captureBtn) captureBtn.click();
      }
      
      this.showNotification('📸 Capture triggered', 'info');
      
    } catch (error) {
      console.error('Capture action failed:', error);
      this.showNotification('Capture failed', 'error');
    }
  }

  async handleApproveAction(event) {
    try {
      const currentCard = window.queueItems?.[window.currentQueueIndex];
      if (!currentCard) {
        this.showNotification('No card selected to approve', 'warning');
        return;
      }
      
      // Call existing dashboard approve function
      if (typeof window.approveCard === 'function') {
        await window.approveCard();
        this.showNotification(`✅ Card approved via ${event.source}`, 'success');
      }
      
    } catch (error) {
      console.error('Approve action failed:', error);
      this.showNotification('Approve failed', 'error');
    }
  }

  async handleRejectAction(event) {
    try {
      const currentCard = window.queueItems?.[window.currentQueueIndex];
      if (!currentCard) {
        this.showNotification('No card selected to reject', 'warning');
        return;
      }
      
      // Call existing dashboard reject function  
      if (typeof window.rejectCard === 'function') {
        await window.rejectCard();
        this.showNotification(`❌ Card rejected via ${event.source}`, 'warning');
      }
      
    } catch (error) {
      console.error('Reject action failed:', error);
      this.showNotification('Reject failed', 'error');
    }
  }

  createStatusWidget() {
    const widget = document.createElement('div');
    widget.id = 'input-status-widget';
    widget.className = 'input-status-widget';
    widget.innerHTML = `
      <div class="input-source">
        <span class="input-icon">⌨️</span>
        <span class="input-label">Keyboard</span>
      </div>
      <div class="input-mappings">
        <span class="mapping">Space/X = Capture</span>
        <span class="mapping">A = Approve</span>
        <span class="mapping">B/R = Reject</span>
      </div>
    `;
    
    // Add CSS styles
    const style = document.createElement('style');
    style.textContent = `
      .input-status-widget {
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 12px 16px;
        border-radius: 8px;
        font-size: 0.85rem;
        z-index: 1500;
        border: 2px solid #4a5568;
        min-width: 200px;
      }
      
      .input-source {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 600;
      }
      
      .input-icon {
        font-size: 1rem;
      }
      
      .input-mappings {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .mapping {
        font-size: 0.75rem;
        color: #a0aec0;
      }
      
      .source-controller {
        border-color: #3182ce;
        background: rgba(49, 130, 206, 0.1);
      }
      
      .source-keyboard {
        border-color: #38a169;
        background: rgba(56, 161, 105, 0.1);
      }
      
      .input-feedback {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9);
        color: white;
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 0.9rem;
        z-index: 2000;
        animation: inputPulse 0.6s ease-out;
      }
      
      @keyframes inputPulse {
        0% { transform: translateX(-50%) scale(0.8); opacity: 0; }
        50% { transform: translateX(-50%) scale(1.1); opacity: 1; }
        100% { transform: translateX(-50%) scale(1); opacity: 0; }
      }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(widget);
    
    this.statusWidget = widget;
  }

  updateStatusWidget() {
    if (!this.statusWidget) return;
    
    const sourceDiv = this.statusWidget.querySelector('.input-source');
    const icon = sourceDiv.querySelector('.input-icon');
    const label = sourceDiv.querySelector('.input-label');
    
    if (this.currentInputSource === 'controller') {
      icon.textContent = '🎮';
      label.textContent = 'Controller';
      this.statusWidget.className = 'input-status-widget source-controller';
    } else {
      icon.textContent = '⌨️';
      label.textContent = 'Keyboard';
      this.statusWidget.className = 'input-status-widget source-keyboard';
    }
  }

  showInputFeedback(action, source) {
    const feedback = document.createElement('div');
    feedback.className = 'input-feedback';
    feedback.textContent = `${action.toUpperCase()} (${source})`;
    
    document.body.appendChild(feedback);
    
    setTimeout(() => {
      feedback.remove();
    }, 600);
  }

  showNotification(message, type = 'info') {
    // Use existing notification system if available
    if (typeof window.showNotification === 'function') {
      window.showNotification(message, type);
    } else {
      // Fallback notification
      console.log(`[${type.toUpperCase()}] ${message}`);
    }
  }

  setupFallbackKeyboardHandlers() {
    // Basic keyboard fallback if input-bus fails to load
    document.addEventListener('keydown', (event) => {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return; // Don't interfere with form inputs
      }
      
      switch (event.code) {
        case 'Space':
        case 'KeyX':
          event.preventDefault();
          this.handleCaptureAction({ source: 'keyboard' });
          break;
        case 'KeyA':
          event.preventDefault();
          this.handleApproveAction({ source: 'keyboard' });
          break;
        case 'KeyB':
        case 'KeyR':
          event.preventDefault();
          this.handleRejectAction({ source: 'keyboard' });
          break;
      }
    });
    
    console.log('[Dashboard] Using fallback keyboard handlers');
  }

  // Get telemetry data for A/B testing
  getTelemetryData() {
    if (this.inputBus) {
      return this.inputBus.getTelemetrySummary();
    }
    return null;
  }

  // Start new A/B test cycle
  startNewCycle() {
    if (this.inputBus) {
      const cycleId = this.inputBus.startNewCycle();
      this.showNotification(`Started new test cycle: ${cycleId}`, 'info');
      return cycleId;
    }
    return null;
  }
}

// Global instance
let dashboardInputManager = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    dashboardInputManager = new DashboardInputManager();
    window.dashboardInputManager = dashboardInputManager;
  });
} else {
  dashboardInputManager = new DashboardInputManager();
  window.dashboardInputManager = dashboardInputManager;
}

// Export for use in other modules
window.DashboardInputManager = DashboardInputManager;
