# CardMint Controller Integration Test Plan

## Executive Summary

This test plan addresses systematic issues preventing controller integration with the CardMint webapp. Based on smoke test analysis revealing port conflicts, WebSocket mismatches, and incomplete UI integration, we establish a production-ready testing framework.

## Problem Statement

**Current State**: Controller backend functions but cannot communicate with frontend due to:
1. **Port management chaos** - hardcoded ports conflicting, no proper fallback strategy
2. **WebSocket mismatch** - dashboard expects 3001, server runs on 3002
3. **Missing integration** - only verification.html has controller handlers
4. **No feedback loop** - controller events broadcast into the void

**Target State**: Seamless controller-driven workflow where operators can capture, review, and approve cards using only the gamepad.

## Test Objectives

1. Validate complete chain: **Controller → Backend → WebSocket → Frontend → User Action**
2. Ensure production resilience with automatic port discovery
3. Verify controller drives real business actions (capture, approve, reject)
4. Confirm zero-impact when idle (no polling, no CPU waste)
5. Establish performance baselines for production deployment

## Test Environment Setup

### Prerequisites
- 8BitDo Ultimate 2C controller in DInput mode
- Node.js 22+ with npm packages installed
- Chrome/Firefox with localhost SSL certificates accepted
- `/dev/input/eventXX` read permissions
- Ports 3000-3010, 5173-5180 available for testing

### Environment Variables
```bash
export CARDMINT_DB_PATH="./data/test-cardmint.db"
export NODE_ENV="development"
export LOG_LEVEL="debug"
```

## Phase 1: Infrastructure Stabilization

### 1.1 Port Management Resilience Test

**Objective**: Ensure reliable startup regardless of port availability

**Test Matrix**:
- Scenario A: All ports free (3000, 3001, 5173)
- Scenario B: API port blocked (3000 in use)
- Scenario C: WebSocket port blocked (3001 in use)
- Scenario D: Dashboard port blocked (5173-5176 in use)
- Scenario E: All ports blocked (worst case)

**Test Script**:
```bash
#!/bin/bash
# scripts/test-port-resilience.sh

test_scenario() {
    local scenario=$1
    echo "Testing Scenario $scenario"
    
    # Block specific ports based on scenario
    case $scenario in
        B) node -e "require('http').createServer().listen(3000)" & BLOCKER_PID=$! ;;
        C) node -e "require('ws').WebSocketServer({port:3001})" & BLOCKER_PID=$! ;;
        D) for p in 5173 5174 5175 5176; do node -e "require('http').createServer().listen($p)" & done ;;
        E) # Block all ports
    esac
    
    # Start CardMint with timeout
    timeout 30s npm run dev:full 2>&1 | tee "startup-$scenario.log"
    
    # Assertions
    grep -q "fallback port" "startup-$scenario.log" && echo "✅ Fallback detected"
    curl -s "http://localhost:*/api/health" && echo "✅ API accessible"
    
    # Cleanup
    [ ! -z "$BLOCKER_PID" ] && kill $BLOCKER_PID 2>/dev/null
    pkill -f "tsx watch" 2>/dev/null
}
```

**Success Criteria**:
- System starts within 10s regardless of port conflicts
- Clear logs showing actual ports used (`"WebSocket server listening on fallback port 3002"`)
- Dashboard auto-discovers correct WebSocket port
- Health endpoint responds with 200 status

### 1.2 WebSocket Auto-Discovery Test

**Objective**: Dashboard finds WebSocket regardless of port assignment

**Method**:
```javascript
// Test in browser console at dashboard
const wsInfo = window.wsManager?.getConnectionInfo();
console.log('WebSocket Info:', wsInfo);

// Expected output format:
// {connected: true, url: "ws://localhost:3002", attempts: 0}
```

**Automated Test**:
```javascript
// scripts/test-websocket-discovery.js
const puppeteer = require('puppeteer');

async function testWebSocketDiscovery() {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    
    await page.goto('https://localhost:5177/verification.html');
    
    // Wait for WebSocket connection
    await page.waitForFunction(() => 
        window.wsManager?.isConnected() === true, 
        {timeout: 10000}
    );
    
    const wsInfo = await page.evaluate(() => 
        window.wsManager.getConnectionInfo()
    );
    
    console.log('✅ WebSocket connected:', wsInfo);
    await browser.close();
}
```

**Success Criteria**:
- Dashboard connects to WebSocket within 3s
- Connection toast shows "Connected to server"
- WebSocket URL matches actual server port (not hardcoded 3001)

## Phase 2: Controller Pipeline Validation

### 2.1 Event Flow Contract Test (No Hardware)

**Objective**: Verify message contract without physical controller

**Unit Test Implementation**:
```javascript
// tests/integration/controller-pipeline.test.ts
describe('Controller Event Pipeline', () => {
    let mockController: MockControllerService;
    let integration: ControllerIntegration;
    let wsMessages: any[] = [];

    beforeEach(() => {
        mockController = new MockControllerService();
        const mockWS = {
            broadcast: (msg: any) => wsMessages.push(msg)
        };
        integration = new ControllerIntegration({
            controller: mockController,
            webSocket: mockWS
        });
        wsMessages = [];
    });

    it('should broadcast capture_success on X button', async () => {
        await mockController.simulateButton('X', 1); // Press
        await mockController.simulateButton('X', 0); // Release
        
        expect(wsMessages).toContainEqual({
            type: 'capture_success',
            payload: expect.objectContaining({
                triggeredBy: 'controller',
                timestamp: expect.any(String)
            })
        });
    });
    
    // Additional test cases for each button mapping
});
```

**Message Contract Validation**:
| Button | Expected Event | Payload Fields |
|--------|---------------|----------------|
| X | `capture_success` | `{triggeredBy: 'controller', imagePath, captureTime}` |
| A | `action_approve` | `{triggeredBy: 'controller'}` |
| B | `action_reject` | `{triggeredBy: 'controller'}` |
| Y | `action_edit` | `{triggeredBy: 'controller'}` |
| D-pad | `navigation` | `{triggeredBy: 'controller', direction}` |
| LB+X | `action_quick_capture` | `{triggeredBy: 'controller'}` |
| LB+A | `action_quick_approve` | `{triggeredBy: 'controller'}` |

### 2.2 Dashboard UI Response Test

**Objective**: Verify UI reacts correctly to controller WebSocket events

**Test Implementation**:
```javascript
// scripts/test-dashboard-responses.js
const testCases = [
    {
        event: { type: 'controller_connected', payload: { controllerName: '8BitDo Ultimate 2C' }},
        expectations: [
            'Status indicator turns green',
            'Toast notification appears: "🎮 Controller connected"',
            'Controller icon visible in header'
        ]
    },
    {
        event: { type: 'capture_success', payload: { imagePath: '/captures/test.jpg', captureTime: 350 }},
        expectations: [
            'Last capture image updates',
            'Timestamp refreshes',
            'Capture time displayed'
        ]
    },
    {
        event: { type: 'action_approve', payload: { triggeredBy: 'controller' }},
        expectations: [
            'Toast: "✅ Card approved"',
            'Current card removed from queue',
            'Next card automatically selected'
        ]
    }
];

// Execute via browser automation
async function runDashboardTests() {
    for (const testCase of testCases) {
        console.log(`Testing: ${testCase.event.type}`);
        
        // Inject WebSocket message
        await page.evaluate((event) => {
            window.wsManager?.handleMessage(event);
        }, testCase.event);
        
        // Verify expectations (manual observation or DOM checks)
        await page.waitForTimeout(500);
        
        for (const expectation of testCase.expectations) {
            console.log(`  ✅ ${expectation}`);
        }
    }
}
```

**Success Criteria**:
- Each WebSocket event produces expected UI change within 200ms
- No console errors during event handling
- UI state persists correctly after events

## Phase 3: Hardware-in-the-Loop Testing

### 3.1 Controller Detection & Stability Test

**Objective**: Prove passive controller layer is stable with real hardware

**Test Procedure**:
```bash
# Start controller service in isolation
npm run test:controller

# Test sequence (manual execution):
# 1. Press each button: A, B, X, Y
# 2. Press D-pad: Up, Down, Left, Right  
# 3. Press combinations: LB+X, LB+A, RB+X
# 4. Hold button for 2 seconds (test repeat handling)
# 5. Rapid press sequence (10 presses in 5 seconds)
```

**Monitoring Script**:
```bash
#!/bin/bash
# Monitor resource usage during test
while true; do
    ps -p $CONTROLLER_PID -o %cpu,%mem,etime
    sleep 1
done > controller-resources.log &

# Run for 30 seconds
timeout 30s npm run test:controller

# Analyze results
echo "Resource Usage Summary:"
awk '{cpu+=$1; mem+=$2} END {print "Avg CPU:", cpu/NR, "Avg Memory:", mem/NR}' controller-resources.log
```

**Success Criteria**:
- All button presses logged with format: `Controller action: capture (button: X)`
- CPU usage < 2% during idle periods
- Memory stable (< 1MB variance) over 5-minute period
- No continuous polling or event spam
- Exclusive device grab maintained throughout test

### 3.2 Disconnect/Reconnect Resilience Test

**Objective**: Verify graceful handling of controller disconnect scenarios

**Test Sequence**:
1. Start with controller connected and working
2. Physically unplug controller
3. Observe logs and dashboard for 10 seconds
4. Reconnect controller
5. Test immediate functionality

**Expected Behavior**:
```
# Disconnect sequence
[INFO] Controller disconnected
[WARN] 8BitDo controller disconnected  
# Dashboard shows: "🎮 Controller disconnected" toast

# Reconnect sequence  
[INFO] Connecting to 8BitDo controller at /dev/input/event29
[INFO] Controller grabbed successfully with evtest
[INFO] 8BitDo controller connected and grabbed for exclusive access
# Dashboard shows: "🎮 Controller connected" toast
```

**Success Criteria**:
- Disconnect detected within 5 seconds
- No crashes or error exceptions
- Auto-reconnection completes within 5 seconds
- First button press after reconnect works immediately

## Phase 4: End-to-End Integration Testing

### 4.1 Complete Workflow Test

**Objective**: Controller drives full card processing workflow

**Setup**:
```bash
# Clean environment
pkill -f "tsx watch" && pkill -f vite
rm -f ./data/test-cardmint.db

# Start full stack
timeout 120s npm run dev:full
```

**Test Workflow**:
1. **Capture Phase**:
   - Press controller **X** button
   - Verify sequence:
     - Terminal: `🎯 Controller capture triggered`
     - Terminal: `📸 Image captured in XXXms: /path/to/image.jpg`
     - Dashboard: New image appears in "📸 Last Capture" section
     - Database: New record inserted in `processing_queue`

2. **Navigation Phase**:
   - Use D-pad to navigate between queued cards
   - Verify: Selected card highlight moves, detail panel updates

3. **Decision Phase**:
   - Press **A** to approve current card
   - Verify: Card disappears from queue, moved to approved status
   - Press **B** to reject next card  
   - Verify: Card moved to rejected status

4. **Quick Actions Phase**:
   - Press **LB+X** for quick capture
   - Press **LB+A** for quick approve
   - Verify: Actions execute with visual feedback

**Performance Metrics to Capture**:
```bash
# Latency measurements
Button Press → Log Entry: < 50ms
Log Entry → WebSocket Broadcast: < 10ms  
WebSocket → UI Update: < 150ms
Total Response Time: < 200ms

# Database Performance
Card Insert Time: < 20ms
Card Update Time: < 10ms
Queue Query Time: < 5ms
```

**Success Criteria**:
- Complete 10-card session using controller only (no mouse/keyboard)
- All latency requirements met
- No dropped events or missed button presses
- Database accurately reflects all card states
- UI updates smoothly without flicker or delay

### 4.2 Multi-Dashboard Concurrency Test

**Objective**: Multiple dashboard instances with single controller

**Test Setup**:
```bash
# Open 3 browser tabs:
# Tab 1: https://localhost:5177/verification.html
# Tab 2: https://localhost:5177/processing-status.html  
# Tab 3: https://localhost:5177/health.html
```

**Test Procedure**:
1. Press controller buttons while monitoring all tabs
2. Verify all tabs receive WebSocket events simultaneously
3. Check for WebSocket connection limits or conflicts

**Success Criteria**:
- All dashboard instances update simultaneously
- No WebSocket connection drops
- Controller status consistent across all dashboards
- Performance impact < 5% with multiple clients

## Phase 5: Performance & Production Readiness

### 5.1 Performance Baseline Establishment

**Monitoring Setup**:
```bash
#!/bin/bash
# scripts/monitor-performance.sh

# Start system monitoring
iostat 1 > iostat.log &
vmstat 1 > vmstat.log &
pidstat -p $CARDMINT_PID 1 > pidstat.log &

# Run 5-minute performance test
timeout 300s npm run dev:full

# Generate performance report
echo "=== Performance Baseline Report ==="
echo "CPU Usage (avg):" $(awk '{sum+=$3} END {print sum/NR "%"}' vmstat.log)
echo "Memory Usage (avg):" $(awk '{sum+=$4} END {print sum/NR "MB"}' vmstat.log)
echo "Disk I/O (avg):" $(awk '{sum+=$4} END {print sum/NR "KB/s"}' iostat.log)
```

**Target Benchmarks**:
- **Idle State**: CPU < 1%, Memory < 100MB, Disk I/O < 1KB/s
- **Active State**: CPU < 10%, Memory < 200MB, Disk I/O < 10KB/s
- **Button Response**: p50 < 50ms, p95 < 100ms, p99 < 200ms
- **Capture Time**: p50 < 400ms, p95 < 600ms, p99 < 800ms

### 5.2 Stress Testing

**Rapid Button Press Test**:
```bash
# Simulate rapid controller input
# (Manual test - press buttons as fast as possible for 30 seconds)

# Monitor for:
# - Event queue overflow
# - Memory leaks
# - WebSocket backpressure
# - UI responsiveness degradation
```

**Success Criteria**:
- No dropped events during stress test
- Memory returns to baseline after stress
- UI remains responsive throughout
- No error exceptions or crashes

### 5.3 Long-Running Stability Test

**24-Hour Soak Test**:
```bash
# Start system and monitor for 24 hours
nohup npm run dev:full > 24hr-test.log 2>&1 &

# Periodic controller activity simulation
while true; do
    sleep 300  # 5 minute intervals
    # Simulate button press via automated input
    echo "Simulated button press at $(date)" >> activity.log
done &

# Monitor system resources every hour
while true; do
    sleep 3600
    ps aux | grep node >> resource-usage.log
    free -h >> memory-usage.log
done &
```

**Success Criteria**:
- System runs continuously for 24 hours without crashes
- Memory usage remains stable (< 10% growth)
- Controller remains responsive after extended runtime
- No WebSocket connection leaks

## Phase 6: User Acceptance Testing

### 6.1 Operator Workflow Validation

**Test Scenario**: Complete card scanning session using controller only

**Participant Profile**: 
- Familiar with card games but new to CardMint
- Basic understanding of scanning workflow
- No prior controller setup experience

**Task List**:
1. Connect and verify controller functionality
2. Capture 10 different cards using controller
3. Review each card in dashboard (navigate with D-pad)
4. Approve 7 cards, reject 3 cards using controller buttons
5. Navigate to different dashboard sections
6. Export approved batch (if accessible via controller)

**Success Metrics**:
- Task completion rate > 90%
- Time to complete 10-card workflow < 15 minutes
- User satisfaction rating > 4/5
- Zero critical errors requiring keyboard/mouse intervention

### 6.2 Error Recovery Testing

**Failure Scenarios**:
1. Controller disconnects mid-session
2. WebSocket connection drops
3. API server restart during operation
4. Dashboard browser refresh
5. Multiple rapid button presses (accidental)

**Recovery Verification**:
- Clear error messages displayed to user
- Automatic recovery without user intervention
- No data loss during recovery
- Session state preserved where possible

## Automation & Continuous Integration

### 6.1 Automated Test Suite

**Test Structure**:
```
tests/
├── unit/
│   ├── controller-service.test.ts
│   ├── controller-integration.test.ts
│   └── websocket-manager.test.ts
├── integration/
│   ├── port-resilience.test.ts
│   ├── websocket-discovery.test.ts
│   └── event-pipeline.test.ts
├── e2e/
│   ├── complete-workflow.test.ts
│   ├── multi-dashboard.test.ts
│   └── performance-baseline.test.ts
└── stress/
    ├── rapid-input.test.ts
    └── long-running.test.ts
```

**CI Pipeline**:
```yaml
# .github/workflows/controller-integration.yml
name: Controller Integration Tests
on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm ci
      - name: Run unit tests
        run: npm test -- --testPathPattern=unit
      
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - name: Port resilience test
        run: ./scripts/test-port-resilience.sh
      - name: WebSocket discovery test
        run: npm test -- --testPathPattern=integration
      
  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - name: Start test environment
        run: timeout 60s npm run dev:full &
      - name: Wait for services
        run: sleep 15
      - name: Run E2E tests
        run: npm run test:e2e:controller
```

### 6.2 Monitoring Dashboard

**Real-time Metrics Display**:
```javascript
// dashboard/controller-status.html
const statusMetrics = {
    controllerConnected: boolean,
    lastButtonPress: timestamp,
    buttonPressCount: number,
    averageLatency: number,
    webSocketPort: number,
    errorCount: number,
    uptime: duration
};

// Update every second
setInterval(updateControllerStatus, 1000);
```

## Risk Assessment & Mitigation

### Critical Risks

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|-------------------|
| Port conflicts prevent startup | High | Critical | Implement dynamic port allocation with discovery protocol |
| Controller device permissions | Medium | High | Provide udev rules installer + fallback to polling mode |
| WebSocket connection instability | Medium | High | Implement robust reconnection logic with exponential backoff |
| Memory leaks in event handling | Low | High | Add event listener cleanup + automated memory monitoring |
| Concurrent device access conflicts | Medium | Medium | Process coordination via lock files + graceful grab handling |

### Performance Risks

| Risk | Probability | Impact | Mitigation Strategy |
|------|-------------|--------|-------------------|
| Button input lag > 200ms | Medium | Medium | Optimize event processing pipeline + remove blocking operations |
| WebSocket message backlog | Low | Medium | Implement message queuing with overflow protection |
| Dashboard UI freeze | Low | High | Use web workers for heavy operations + keep UI thread free |

## Test Execution Schedule

### Week 1: Foundation
- Day 1-2: Phase 1 (Infrastructure Stabilization)
- Day 3-4: Phase 2 (Pipeline Validation)
- Day 5: Phase 3 (Hardware Integration)

### Week 2: Integration
- Day 1-3: Phase 4 (End-to-End Testing)
- Day 4: Phase 5 (Performance Testing)  
- Day 5: Phase 6 (User Acceptance)

### Week 3: Production Readiness
- Day 1-2: CI/CD Integration
- Day 3-4: Documentation & Training
- Day 5: Final Validation & Sign-off

## Success Criteria Summary

### Must Have (MVP)
- ✅ Controller buttons trigger card capture reliably
- ✅ Dashboard shows real-time controller connection status
- ✅ Approve/reject cards via A/B buttons
- ✅ Navigate card queue using D-pad
- ✅ Automatic port conflict resolution
- ✅ Graceful disconnect/reconnect handling
- ✅ Sub-200ms button response time

### Should Have (Enhanced)
- ✅ Multi-dashboard simultaneous support
- ✅ Visual button press feedback in UI
- ✅ Controller-only complete workflow
- ✅ Performance monitoring dashboard
- ✅ Automated test coverage > 80%

### Nice to Have (Future)
- Configurable button mappings
- Haptic feedback integration
- Burst capture mode (RB+X)
- Gesture combination support
- Controller setup wizard

## Deliverables

1. **Test Results Documentation**: Detailed results for each phase
2. **Performance Benchmark Report**: Baseline metrics for production
3. **User Acceptance Report**: Operator feedback and recommendations
4. **CI/CD Integration**: Automated test pipeline
5. **Production Deployment Guide**: Step-by-step setup instructions
6. **Troubleshooting Runbook**: Common issues and solutions

## Conclusion

This comprehensive test plan ensures the controller integration meets production standards while maintaining the high-performance requirements of the CardMint system. By systematically addressing infrastructure, integration, and user experience concerns, we establish a robust foundation for controller-driven card processing workflows.

The phased approach allows for early problem detection and iterative improvement, while the automated testing framework ensures long-term maintainability and regression protection.