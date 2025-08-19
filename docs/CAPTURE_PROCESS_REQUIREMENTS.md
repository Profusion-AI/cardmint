# Single Capture Process Requirements

## Overview
The single-shot capture uses a stateless approach where each capture starts fresh, connects, captures, and cleanly exits.

## Process Flow for Single Capture

### 1. Initial State
- **No processes running** - Clean state before capture
- Camera connected via USB but no active SDK connections

### 2. Capture Execution
When `/home/profusionai/CardMint/capture-card` is executed:

```
sony-capture process (PID: dynamic)
├── Initializes Sony SDK (SDK::Init)
├── Enumerates cameras (SDK::EnumCameraObjects)
├── Connects to camera (SDK::Connect in Remote mode)
├── Configures PC save destination
├── Triggers shutter
├── Waits for image download callback
├── Outputs: "filename time"
└── Exits cleanly (SDK::Release)
```

### 3. Process Lifetime
- **Total lifetime**: ~400-450ms
- **Single process**: `sony-capture` 
- **No child processes**: Direct SDK calls
- **No daemons**: Completely stateless

### 4. Resource Usage During Capture
```
Process: sony-capture
Memory: ~23MB (SDK libraries + buffers)
CPU: Single thread, brief spike during transfer
File handles: 
  - USB device handle (via libusb)
  - Output file handle for image write
  - stdout for result output
```

### 5. Post-Capture State
- Process completely terminated
- All resources released
- No lingering connections
- Camera returns to idle state

## USB Disconnect/Reconnect Test Expectations

### Expected Behavior After USB Reconnect:
1. Camera should be re-enumerable by SDK
2. First capture after reconnect may take slightly longer (~500-600ms) due to:
   - USB device re-initialization
   - Camera handshake negotiation
3. Subsequent captures should return to normal ~400ms timing

### Potential Issues to Watch For:
- Camera might need a few seconds to fully initialize after USB reconnect
- USB device permissions might need to be re-established (unlikely on Linux)
- Camera might change its device ID/path (SDK should handle this)

## Test Command Sequence

```bash
# Before disconnect
/home/profusionai/CardMint/capture-card
# Expected: Success, ~400ms

# Disconnect USB cable
# Wait 5 seconds
# Reconnect USB cable
# Wait 5 seconds for camera to initialize

# After reconnect
/home/profusionai/CardMint/capture-card
# Expected: Success, possibly ~500-600ms for first capture

# Second capture after reconnect
/home/profusionai/CardMint/capture-card
# Expected: Success, back to ~400ms
```

## Files and Binaries

- **Executable**: `/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build/sony-capture`
- **Wrapper Script**: `/home/profusionai/CardMint/capture-card`
- **Source**: `/home/profusionai/CardMint/src/camera/sony-pc-capture-simple.cpp`
- **Output Directory**: `/home/profusionai/CardMint/captures/`

## Current Configuration
- Camera: Sony ZV-E10M2
- Connection: USB 3.0
- Mode: PC Remote
- Save Destination: PC Only
- File Format: DSC#####.JPG (sequential numbering)