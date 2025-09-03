# Controller Debugging Session - August 28, 2025

## Issue Summary
8BitDo Ultimate 2C controller X button not triggering camera captures despite system showing "controller connected and grabbed for exclusive access."

## Hardware Configuration
- **Controller**: 8BitDo Ultimate 2C Wireless Controller (EEC06B77E3)
- **Connection**: USB, DInput mode
- **System**: Fedora Linux after restart

## Device Path Investigation

### Device Discovery
```bash
$ ls -la /dev/input/by-id/ | grep -i 8bitdo
usb-8BitDo_8BitDo_Ultimate_2C_Wireless_Controller_EEC06B77E3-event-joystick -> ../event24
usb-8BitDo_8BitDo_Ultimate_2C_Wireless_Controller_EEC06B77E3-if01-event-kbd -> ../event16
usb-8BitDo_8BitDo_Ultimate_2C_Wireless_Controller_EEC06B77E3-if01-event-mouse -> ../event17
```

### Key Finding
Controller creates multiple device nodes:
- `/dev/input/event24` - Joystick events (analog sticks, triggers)
- `/dev/input/event16` - Keyboard events (face buttons including X)
- `/dev/input/event17` - Mouse events

## Debugging Steps Taken

### 1. Initial Problem
System was connecting to `/dev/input/event24` (joystick device) but X button events come through `/dev/input/event16` (keyboard device).

### 2. Device Path Fix
**File**: `src/services/ControllerService.ts`

**Before** (line 168):
```typescript
const devicePath = '/dev/input/event29'; // Hardcoded wrong path
```

**After**:
```typescript
const keyboardDevice = '/dev/input/event16'; // 8BitDo keyboard events for X button
```

### 3. Connection Logic Fix
**Before**:
```typescript
logger.info(`Connecting to 8BitDo controller at ${devicePath}`);
```

**After**:
```typescript
const keyboardDevice = '/dev/input/event16';
logger.info(`Connecting to 8BitDo controller at ${keyboardDevice} (keyboard events for X button)`);
```

### 4. Button Code Mapping Investigation

**evtest Analysis of `/dev/input/event16`**:
```
Input device name: "8BitDo 8BitDo Ultimate 2C Wireless Controller Keyboard"
Event type 1 (EV_KEY)
  ...
  Event code 30 (KEY_A)
  Event code 45 (KEY_X)    <-- X button maps to this
  Event code 48 (KEY_B)
  Event code 21 (KEY_Y)
  ...
```

### 5. Button Mapping Fix
**Before** (joystick button codes):
```typescript
private readonly BUTTON_MAP: Record<number, {...}> = {
  304: { name: 'A', symbol: 'A', action: 'approve' },    // BTN_SOUTH
  307: { name: 'X', symbol: 'X', action: 'capture' },    // BTN_NORTH (wrong!)
  // ...
};
```

**After** (keyboard key codes):
```typescript
private readonly BUTTON_MAP: Record<number, {...}> = {
  30: { name: 'A', symbol: 'A', action: 'approve' },     // KEY_A
  45: { name: 'X', symbol: 'X', action: 'capture' },     // KEY_X (correct!)
  48: { name: 'B', symbol: 'B', action: 'reject' },      // KEY_B  
  21: { name: 'Y', symbol: 'Y', action: 'edit' },        // KEY_Y
  // ...
};
```

## Current System Status

### Log Output
```
[INFO] Connecting to 8BitDo controller at /dev/input/event16 (keyboard events for X button)
[DEBUG] Controller output:
[INFO] Controller grabbed successfully with evtest
[INFO] 8BitDo controller connected and grabbed for exclusive access
[INFO] CardMint System is running successfully
```

### Systems Operational
- ✅ Sony Camera: Connected (script mode, 5/5 health checks)
- ✅ Controller: Connected to correct device (/dev/input/event16)
- ✅ E2E Pipeline: Active with FileQueueManager and IntegratedScannerService
- ✅ LM Studio: Available on Mac (qwen2.5-vl-7b-instruct)
- ✅ Button Mapping: Updated to use keyboard key codes

## Test Results
**Status**: X button press still not triggering camera capture

## Potential Root Causes

### 1. Event Grabbing Issue
```bash
$ timeout 10s evtest /dev/input/event16
***********************************************
  This device is grabbed by another process.
  No events are available to evtest while the
  other grab is active.
***********************************************
```
The device is exclusively grabbed, but events may not be reaching the button processing logic.

### 2. Event Processing Pipeline
Even with correct device and button codes, the event flow might be broken:
1. `evtest` grabs device → reads raw events
2. Raw events → button mapping lookup
3. Button mapping → camera trigger logic
4. Camera trigger → Sony SDK execution

### 3. Input Reading Logic
The `startInputReading()` method may have parsing issues for keyboard events vs joystick events.

### 4. Multiple Grab Processes
Logs show duplicate "Controller grabbed successfully" messages, suggesting multiple processes might be competing for the device.

## Recommended Next Steps for CTO

1. **Verify Event Flow**: Add debug logging to `startInputReading()` to confirm raw events are being received
2. **Check Process Conflicts**: Investigate multiple grab process instances
3. **Test Event Parsing**: Validate keyboard event parsing vs joystick event parsing
4. **Alternative Device Strategy**: Consider monitoring both event16 (buttons) and event24 (joystick) simultaneously
5. **Direct evtest Validation**: Test X button with manual evtest to confirm hardware functionality

## Files Modified
- `src/services/ControllerService.ts` (lines 37-49, 136-137, 145, 152, 168)

## System Environment
- **CardMint**: E2E mode active (E2E_NO_REDIS=true)
- **Architecture**: Fedora capture → Mac ML processing  
- **Database**: SQLite WAL mode
- **Network**: All services listening (API:3000, WS:3001, Dashboard:5173)

---
*Session conducted by Claude Code on August 28, 2025*
*All diagnostic steps and code changes documented for CTO review*