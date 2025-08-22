/**
 * PS4 Controller Web Integration for CardMint Dashboard
 * Handles controller input via Gamepad API in the browser
 */

class PS4ControllerWeb {
  constructor() {
    this.gamepad = null;
    this.connected = false;
    this.lastButtons = {};
    this.queueIndex = 0;
    this.captureEnabled = true;
    this.editMode = false;
    this.vibrationEnabled = true;
    
    // Button mappings for PS4 controller
    this.buttonMap = {
      0: 'cross',      // X - Capture
      1: 'circle',     // O - Reject
      2: 'square',     // Square - Edit
      3: 'triangle',   // Triangle - Approve
      4: 'l1',         // L1 - Previous
      5: 'r1',         // R1 - Next
      6: 'l2',         // L2 - Prev batch
      7: 'r2',         // R2 - Next batch
      8: 'share',      // Share - Save
      9: 'options',    // Options - Menu
      10: 'l3',        // L3 - Zoom
      11: 'r3',        // R3 - Toggle
      12: 'up',        // D-pad up
      13: 'down',      // D-pad down
      14: 'left',      // D-pad left
      15: 'right',     // D-pad right
      16: 'ps',        // PlayStation button
      17: 'touchpad'   // Touchpad click
    };
    
    // Axis mappings
    this.axisMap = {
      0: 'leftX',      // Left stick X
      1: 'leftY',      // Left stick Y
      2: 'rightX',     // Right stick X - Queue navigation
      3: 'rightY'      // Right stick Y - Scroll
    };
    
    this.init();
  }
  
  init() {
    // Check for Gamepad API support
    if (!('getGamepads' in navigator)) {
      console.error('Gamepad API not supported');
      return;
    }
    
    // Listen for controller connection
    window.addEventListener('gamepadconnected', (e) => {
      console.log('🎮 Controller connected:', e.gamepad.id);
      this.onConnect(e.gamepad);
    });
    
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log('🎮 Controller disconnected');
      this.onDisconnect();
    });
    
    // Start polling for input
    this.startPolling();
  }
  
  onConnect(gamepad) {
    this.gamepad = gamepad;
    this.connected = true;
    
    // Show connection status
    this.showNotification('PS4 Controller Connected', 'success');
    this.updateUI();
    
    // Vibrate to confirm
    this.vibrate(200);
  }
  
  onDisconnect() {
    this.connected = false;
    this.gamepad = null;
    this.showNotification('Controller Disconnected', 'warning');
    this.updateUI();
  }
  
  startPolling() {
    const poll = () => {
      if (this.connected) {
        this.checkInput();
      }
      requestAnimationFrame(poll);
    };
    poll();
  }
  
  checkInput() {
    // Get latest gamepad state
    const gamepads = navigator.getGamepads();
    this.gamepad = gamepads[0]; // PS4 is usually first
    
    if (!this.gamepad) return;
    
    // Check buttons
    this.gamepad.buttons.forEach((button, index) => {
      const buttonName = this.buttonMap[index];
      
      // Check if button state changed
      if (button.pressed && !this.lastButtons[buttonName]) {
        this.onButtonPress(buttonName);
      } else if (!button.pressed && this.lastButtons[buttonName]) {
        this.onButtonRelease(buttonName);
      }
      
      this.lastButtons[buttonName] = button.pressed;
    });
    
    // Check axes (analog sticks)
    this.checkAxes();
  }
  
  checkAxes() {
    const deadzone = 0.2;
    
    // Right stick for queue navigation
    const rightX = this.gamepad.axes[2];
    const rightY = this.gamepad.axes[3];
    
    if (Math.abs(rightY) > deadzone) {
      if (rightY < -deadzone && !this.rightStickActive) {
        this.navigateQueue('up');
        this.rightStickActive = true;
      } else if (rightY > deadzone && !this.rightStickActive) {
        this.navigateQueue('down');
        this.rightStickActive = true;
      }
    } else {
      this.rightStickActive = false;
    }
    
    // Left stick for panning
    const leftX = this.gamepad.axes[0];
    const leftY = this.gamepad.axes[1];
    
    if (Math.abs(leftX) > deadzone || Math.abs(leftY) > deadzone) {
      this.panView(leftX, leftY);
    }
  }
  
  onButtonPress(button) {
    console.log(`Button pressed: ${button}`);
    
    switch(button) {
      case 'cross': // X - Capture
        this.captureCard();
        break;
        
      case 'triangle': // Triangle - Approve
        this.approveCard();
        break;
        
      case 'circle': // Circle - Reject
        this.rejectCard();
        break;
        
      case 'square': // Square - Edit
        this.toggleEditMode();
        break;
        
      case 'l1': // L1 - Previous
        this.previousCard();
        break;
        
      case 'r1': // R1 - Next
        this.nextCard();
        break;
        
      case 'l2': // L2 - Previous batch
        this.previousBatch();
        break;
        
      case 'r2': // R2 - Next batch
        this.nextBatch();
        break;
        
      case 'share': // Share - Save session
        this.saveSession();
        break;
        
      case 'options': // Options - Menu
        this.toggleMenu();
        break;
        
      case 'ps': // PS button - Home
        this.goHome();
        break;
        
      case 'touchpad': // Touchpad - Quick approve all
        this.quickApproveAll();
        break;
        
      // D-pad for fine navigation
      case 'up':
        this.navigateQueue('up');
        break;
      case 'down':
        this.navigateQueue('down');
        break;
      case 'left':
        this.navigateQueue('left');
        break;
      case 'right':
        this.navigateQueue('right');
        break;
    }
    
    // Haptic feedback
    this.vibrate(50);
  }
  
  onButtonRelease(button) {
    // Handle button releases if needed
  }
  
  // Action methods
  async captureCard() {
    if (!this.captureEnabled) return;
    
    console.log('📸 Capturing card...');
    this.captureEnabled = false;
    
    try {
      const response = await fetch('/api/capture', {
        method: 'POST'
      });
      
      if (response.ok) {
        const result = await response.json();
        this.showNotification('Card captured!', 'success');
        this.vibrate(100);
        
        // Update capture pane
        document.querySelector('#capture-pane').src = result.imagePath;
      }
    } catch (error) {
      console.error('Capture error:', error);
      this.showNotification('Capture failed', 'error');
    }
    
    // Re-enable after cooldown
    setTimeout(() => {
      this.captureEnabled = true;
    }, 1000);
  }
  
  async approveCard() {
    const currentCard = this.getCurrentCard();
    if (!currentCard) return;
    
    console.log('✅ Approving card:', currentCard.id);
    
    try {
      await fetch(`/api/verify/${currentCard.id}/approve`, {
        method: 'POST'
      });
      
      this.showNotification('Card approved!', 'success');
      this.vibrate(100);
      this.nextCard();
    } catch (error) {
      console.error('Approve error:', error);
    }
  }
  
  async rejectCard() {
    const currentCard = this.getCurrentCard();
    if (!currentCard) return;
    
    console.log('❌ Rejecting card:', currentCard.id);
    
    try {
      await fetch(`/api/verify/${currentCard.id}/reject`, {
        method: 'POST'
      });
      
      this.showNotification('Card rejected', 'warning');
      this.vibrate(200);
      this.nextCard();
    } catch (error) {
      console.error('Reject error:', error);
    }
  }
  
  toggleEditMode() {
    this.editMode = !this.editMode;
    document.body.classList.toggle('edit-mode', this.editMode);
    this.showNotification(`Edit mode ${this.editMode ? 'ON' : 'OFF'}`, 'info');
  }
  
  navigateQueue(direction) {
    const queue = document.querySelectorAll('.queue-item');
    
    switch(direction) {
      case 'up':
        if (this.queueIndex > 0) this.queueIndex--;
        break;
      case 'down':
        if (this.queueIndex < queue.length - 1) this.queueIndex++;
        break;
    }
    
    this.highlightQueueItem();
  }
  
  nextCard() {
    this.navigateQueue('down');
  }
  
  previousCard() {
    this.navigateQueue('up');
  }
  
  nextBatch() {
    console.log('Next batch');
    // Move to next 15 cards
    this.queueIndex = Math.min(this.queueIndex + 15, document.querySelectorAll('.queue-item').length - 1);
    this.highlightQueueItem();
  }
  
  previousBatch() {
    console.log('Previous batch');
    // Move to previous 15 cards
    this.queueIndex = Math.max(this.queueIndex - 15, 0);
    this.highlightQueueItem();
  }
  
  async saveSession() {
    console.log('💾 Saving session...');
    
    try {
      await fetch('/api/session/save', {
        method: 'POST'
      });
      
      this.showNotification('Session saved!', 'success');
      this.vibrate(200);
    } catch (error) {
      console.error('Save error:', error);
    }
  }
  
  toggleMenu() {
    document.querySelector('#menu').classList.toggle('show');
  }
  
  goHome() {
    window.location.href = '/dashboard';
  }
  
  async quickApproveAll() {
    if (!confirm('Approve all high-confidence cards?')) return;
    
    console.log('⚡ Quick approving all...');
    // Approve all cards with >90% confidence
    const highConfidence = document.querySelectorAll('.queue-item[data-confidence="high"]');
    
    for (const item of highConfidence) {
      await fetch(`/api/verify/${item.dataset.id}/approve`, {
        method: 'POST'
      });
    }
    
    this.showNotification(`Approved ${highConfidence.length} cards`, 'success');
    this.vibrate(500);
  }
  
  // Helper methods
  getCurrentCard() {
    const queue = document.querySelectorAll('.queue-item');
    return queue[this.queueIndex];
  }
  
  highlightQueueItem() {
    document.querySelectorAll('.queue-item').forEach((item, index) => {
      item.classList.toggle('active', index === this.queueIndex);
    });
    
    // Scroll into view
    const currentItem = this.getCurrentCard();
    if (currentItem) {
      currentItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  
  panView(x, y) {
    // Pan the image view with left stick
    const imagePane = document.querySelector('#capture-pane');
    if (imagePane && this.editMode) {
      imagePane.style.transform = `translate(${x * 100}px, ${y * 100}px)`;
    }
  }
  
  vibrate(duration = 100) {
    if (!this.vibrationEnabled || !this.gamepad) return;
    
    // Use Vibration API if available
    if (this.gamepad.vibrationActuator) {
      this.gamepad.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: duration,
        weakMagnitude: 0.5,
        strongMagnitude: 1.0
      });
    }
  }
  
  showNotification(message, type = 'info') {
    // Create toast notification
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
  }
  
  updateUI() {
    const statusEl = document.querySelector('#controller-status');
    if (statusEl) {
      statusEl.className = this.connected ? 'connected' : 'disconnected';
      statusEl.textContent = this.connected ? '🎮 PS4 Connected' : '🎮 No Controller';
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.ps4Controller = new PS4ControllerWeb();
  
  // Add CSS for controller UI
  const style = document.createElement('style');
  style.textContent = `
    #controller-status {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 20px;
      border-radius: 20px;
      font-weight: bold;
      z-index: 1000;
    }
    
    #controller-status.connected {
      background: #4CAF50;
      color: white;
    }
    
    #controller-status.disconnected {
      background: #f44336;
      color: white;
    }
    
    .toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      padding: 15px 30px;
      border-radius: 5px;
      color: white;
      font-weight: bold;
      animation: slideUp 0.3s;
      z-index: 2000;
    }
    
    .toast-success { background: #4CAF50; }
    .toast-error { background: #f44336; }
    .toast-warning { background: #ff9800; }
    .toast-info { background: #2196F3; }
    
    @keyframes slideUp {
      from { transform: translate(-50%, 100px); }
      to { transform: translate(-50%, 0); }
    }
    
    .queue-item.active {
      border: 3px solid #2196F3;
      box-shadow: 0 0 20px rgba(33, 150, 243, 0.5);
    }
    
    body.edit-mode {
      border: 5px solid #ff9800;
    }
    
    /* Controller button hints */
    .controller-hints {
      position: fixed;
      bottom: 10px;
      left: 10px;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 10px;
      border-radius: 10px;
      font-size: 12px;
    }
    
    .controller-hints span {
      margin: 0 10px;
    }
  `;
  document.head.appendChild(style);
  
  // Add controller status indicator
  const statusDiv = document.createElement('div');
  statusDiv.id = 'controller-status';
  statusDiv.textContent = '🎮 Waiting for controller...';
  document.body.appendChild(statusDiv);
  
  // Add button hints
  const hints = document.createElement('div');
  hints.className = 'controller-hints';
  hints.innerHTML = `
    <span>❌ Capture</span>
    <span>△ Approve</span>
    <span>○ Reject</span>
    <span>□ Edit</span>
    <span>R3 Navigate</span>
  `;
  document.body.appendChild(hints);
  
  console.log('🎮 PS4 Controller Web Integration Ready');
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PS4ControllerWeb;
}