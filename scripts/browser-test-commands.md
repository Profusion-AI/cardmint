# Browser E2E Testing Commands

## Setup
1. Open http://localhost:3000/dashboard/verification.html in browser
2. Open browser console (F12)

## Phase 1: Initialize Input Bus
```javascript
// Check if input bus loaded correctly
console.log('Input Bus Status:', {
  inputBus: typeof window.inputBus,
  KeyboardAdapter: typeof window.KeyboardAdapter,
  ControllerAdapter: typeof window.ControllerAdapter,
  dashboardInputManager: typeof window.dashboardInputManager
});

// Check dashboard input manager state
if (window.dashboardInputManager) {
  console.log('Dashboard Input Manager:', {
    inputBus: !!window.dashboardInputManager.inputBus,
    currentSource: window.dashboardInputManager.currentInputSource,
    telemetryEnabled: window.dashboardInputManager.telemetryEnabled
  });
}
```

## Phase 2: Manual Keyboard Testing
```javascript
// Test keyboard inputs manually by pressing:
// - Space or X key -> should show "CAPTURE" feedback
// - A key -> should show "APPROVE" feedback  
// - B or R key -> should show "REJECT" feedback

// Check console for input events
// Status widget should show ⌨️ Keyboard
```

## Phase 3: Programmatic Input Testing
```javascript
// Start new test cycle
const cycleId = window.dashboardInputManager.startNewCycle();
console.log('Started cycle:', cycleId);

// Simulate 5 keyboard inputs
for (let i = 0; i < 5; i++) {
  setTimeout(() => {
    window.inputBus.emitInput({
      action: i % 3 === 0 ? 'capture' : (i % 3 === 1 ? 'approve' : 'reject'),
      source: 'keyboard',
      ts: Date.now(),
      cardId: `test_card_${i}`,
      cycleId: cycleId
    });
  }, i * 500);
}
```

## Phase 4: WebSocket Testing
```javascript
// Test WebSocket connection (if configured)
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onopen = () => console.log('✅ WebSocket connected');
ws.onmessage = (e) => console.log('📨 WebSocket message:', JSON.parse(e.data));
ws.onerror = (e) => console.log('❌ WebSocket error:', e);

// Send test message
ws.send(JSON.stringify({ type: 'test', data: 'Hello from browser' }));
```

## Phase 5: Telemetry Validation
```javascript
// Get telemetry summary for current cycle
fetch(`/api/telemetry/input/summary?cycle=${cycleId}`)
  .then(r => r.json())
  .then(data => {
    console.log('📊 Telemetry Summary:', data);
    console.log('Expected: 5 inputs, Got:', data.totalInputs);
    console.log('Keyboard ratio:', data.keyboardInputs / data.totalInputs);
  });
```

## Phase 6: Performance Testing
```javascript
// Measure input latency
const latencies = [];
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  
  window.inputBus.emitInput({
    action: 'capture',
    source: 'keyboard', 
    ts: Date.now()
  });
  
  const end = performance.now();
  latencies.push(end - start);
}

console.log('Input latencies (ms):', latencies);
console.log('Average latency:', latencies.reduce((a,b) => a+b) / latencies.length);
console.log('Max latency:', Math.max(...latencies));
```

## Phase 7: Controller Simulation
```javascript
// Simulate controller inputs
window.inputBus.emitInput({
  action: 'capture',
  source: 'controller',
  ts: Date.now()
});

// Check status widget changes to 🎮 Controller
console.log('Status should show 🎮 Controller');
```

## Expected Results
- ✅ All input-bus libraries load correctly
- ✅ Status widget appears in top-right corner  
- ✅ Keyboard inputs show visual feedback
- ✅ WebSocket connects (if enabled)
- ✅ Telemetry data records correctly
- ✅ Input latency <100ms average
- ✅ Controller simulation works

## Success Criteria for E2E
1. Zero 404 errors for /lib/ assets
2. Input-bus initializes without errors
3. Keyboard inputs trigger visual feedback
4. Telemetry POST requests succeed
5. CSV data matches input counts
6. Performance targets met (sub-100ms)