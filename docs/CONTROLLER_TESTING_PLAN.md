# Controller Integration Testing Plan

## 🧪 Testing Phase Overview

The controller integration logic has been **scaffolded and implemented**, with all services running successfully. Now we need systematic testing to validate the complete workflow from button press to card processing.

## 📊 Current System Status
```
✅ Server: http://localhost:3000
✅ WebSocket: ws://localhost:3001  
✅ Dashboard: https://localhost:5175/
✅ Controller: 8BitDo Ultimate 2C connected and grabbed
✅ Architecture: Event-driven, passive scanning ready
```

## 🔬 Test Categories

### Category 1: Hardware Input Validation
**Objective:** Verify all controller buttons generate correct events

#### Test 1.1: Basic Button Detection
```bash
# Monitor for button events in server logs
npm run dev
# Press each button and verify log output:
# Expected: "Button X (X): PRESSED" for each button
```

**Buttons to Test:**
- [ ] A button → Should log "Button A (A): PRESSED"  
- [ ] B button → Should log "Button B (B): PRESSED"
- [ ] X button → Should log "Button X (X): PRESSED"
- [ ] Y button → Should log "Button Y (Y): PRESSED"
- [ ] D-pad Up → Should log "Button ↑ (UP): PRESSED"
- [ ] D-pad Down → Should log "Button ↓ (DOWN): PRESSED"  
- [ ] D-pad Left → Should log "Button ← (LEFT): PRESSED"
- [ ] D-pad Right → Should log "Button → (RIGHT): PRESSED"
- [ ] LB → Should log "Button LB (LB): PRESSED"
- [ ] RB → Should log "Button RB (RB): PRESSED"

#### Test 1.2: Button Combination Detection  
```bash
# Test modifier combinations
# Hold LB + press A → Should log "Controller action: lb_approve"
# Hold RB + press X → Should log "Controller action: rb_capture"
```

**Combinations to Test:**
- [ ] LB + A → "lb_approve" action
- [ ] LB + B → "lb_reject" action  
- [ ] LB + X → "lb_capture" action
- [ ] RB + X → "rb_capture" action

### Category 2: WebSocket Event Broadcasting
**Objective:** Confirm button presses reach dashboard via WebSocket

#### Test 2.1: Event Message Format
```bash
# Open browser dev tools on dashboard page
# Monitor WebSocket messages for button presses
# Expected format: {"type": "action_capture", "payload": {...}}
```

**Events to Verify:**
- [ ] X press → `action_capture` message
- [ ] A press → `action_approve` message  
- [ ] B press → `action_reject` message
- [ ] Y press → `action_edit` message
- [ ] D-pad → `navigation` message with direction

#### Test 2.2: Dashboard UI Updates
**Access:** https://localhost:5175/verification.html

**Visual Confirmations:**
- [ ] Controller status shows green "🎮 Controller: Press X to capture..."
- [ ] Button presses trigger toast notifications
- [ ] Timestamps update on capture events
- [ ] Queue navigation visually moves selection

### Category 3: Camera Integration Testing
**Objective:** Verify X button triggers actual camera capture

#### Test 3.1: Mock Camera Response
```bash
# With Sony camera in mock mode (current setup)
# Press X button → Should see:
# - "🎯 Controller capture triggered" in logs
# - "📸 Image captured in Xms: /path/to/image" 
# - Dashboard shows new image with timestamp
```

**Validation Steps:**
- [ ] X button press triggers capture attempt
- [ ] Mock camera returns simulated image path
- [ ] Capture time logged (should be < 500ms for mock)
- [ ] Dashboard updates with new "Last Capture" image
- [ ] Timestamp reflects actual capture time

#### Test 3.2: Real Sony Camera (Future Test)
```bash
# When Sony camera SDK is available:
# Same test but with real hardware capture
# Target: ~400ms capture time maintained
```

### Category 4: Queue Management Testing
**Objective:** Validate D-pad navigation and A/B approval workflow

#### Test 4.1: Queue Navigation
**Prerequisites:** Need test cards in verification queue

```bash
# Add test cards to queue first
# Then test D-pad navigation
```

**Navigation Tests:**
- [ ] D-pad Up → Moves to previous queue item
- [ ] D-pad Down → Moves to next queue item  
- [ ] Selection highlights correct item
- [ ] Image display updates to selected card
- [ ] Navigation wraps at beginning/end

#### Test 4.2: Approval Workflow
**Test Steps:**
1. Navigate to queue item with D-pad
2. Press A button → Item should be approved and removed
3. Press B button → Item should be rejected and removed  
4. Queue should update automatically

**Validations:**
- [ ] A button removes item from queue
- [ ] B button removes item from queue
- [ ] Database updates correctly
- [ ] UI refreshes queue display
- [ ] Success notifications appear

### Category 5: Performance & Resource Testing
**Objective:** Confirm system remains passive and efficient

#### Test 5.1: Idle Resource Usage
```bash
# Monitor system resources when controller idle
top -p $(pgrep -f "tsx watch src/index.ts")
# Should show minimal CPU usage (~0.1%)
```

**Metrics to Verify:**
- [ ] CPU usage < 1% when idle
- [ ] Memory usage stable (no leaks)
- [ ] No continuous polling in logs  
- [ ] Zero WebSocket traffic when no input

#### Test 5.2: Response Time Testing
```bash
# Measure button-to-action latency
# Press X → Measure time to "capture triggered" log
# Target: < 100ms response time
```

**Performance Requirements:**
- [ ] Button response < 100ms
- [ ] WebSocket message delivery < 50ms
- [ ] Dashboard UI update < 200ms total
- [ ] Camera capture maintains ~400ms target

### Category 6: Error Handling & Recovery
**Objective:** Test system resilience and graceful degradation

#### Test 6.1: Controller Disconnect
**Test Steps:**
1. Unplug/disconnect controller during operation
2. Verify system detects disconnect
3. Reconnect controller
4. Verify automatic reconnection

**Expected Behaviors:**
- [ ] Disconnect logged and broadcast to dashboard
- [ ] Dashboard shows "Controller disconnected" warning  
- [ ] System continues operating without controller
- [ ] Reconnection automatically detected (within 5s)
- [ ] Full functionality restored on reconnect

#### Test 6.2: WebSocket Connection Issues
**Test Steps:**
1. Restart server while dashboard connected
2. Verify automatic reconnection
3. Test button functionality after reconnect

#### Test 6.3: Device Busy Scenarios
**Test Steps:**
1. Start another process using controller
2. Restart CardMint server
3. Verify it reclaims controller access

## 🎯 Testing Priority Order

### Phase A: Critical Path (Do First)
1. **Hardware Input Validation** → Confirm all buttons detected
2. **WebSocket Broadcasting** → Verify events reach dashboard  
3. **Basic UI Integration** → Check notifications and status updates

### Phase B: Core Workflow (Do Second)
1. **Mock Camera Integration** → Test X button capture flow
2. **Queue Navigation** → Test D-pad movement
3. **Approval Actions** → Test A/B button workflow

### Phase C: Production Readiness (Do Third)  
1. **Performance Testing** → Validate resource efficiency
2. **Error Recovery** → Test disconnect scenarios
3. **Real Camera Integration** → When hardware available

## 📝 Test Execution Notes

### Current Test Environment
- **Development Mode:** All services running via `npm run dev`
- **Controller:** 8BitDo Ultimate 2C in DInput mode
- **Device Path:** `/dev/input/event29`
- **Camera Mode:** Mock implementation (Sony SDK not available)

### Test Data Requirements
- **Queue Items:** Need sample cards in verification queue for navigation tests
- **Image Assets:** Test images for capture display validation
- **Network Scenarios:** Local testing sufficient initially

### Success Criteria
- All button inputs generate appropriate system responses
- Dashboard updates in real-time with controller actions
- System maintains passive architecture (no resource waste)
- Error scenarios handled gracefully without crashes
- Performance targets met (response < 100ms, capture < 400ms)

## 🚀 Next Steps After Testing

1. **Document Test Results** → Update status with findings
2. **Fix Any Issues** → Address discovered bugs or performance problems  
3. **Real Hardware Testing** → Test with actual Sony camera when available
4. **User Acceptance** → Validate with actual card scanning workflow
5. **Production Deployment** → Move from development to production config

The scaffolding is complete and ready for systematic validation!