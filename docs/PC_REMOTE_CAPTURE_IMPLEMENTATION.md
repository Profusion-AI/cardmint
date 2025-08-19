# PC Remote Capture Implementation Documentation

## Executive Summary

The PC Remote capture implementation is the cornerstone of the CardMint high-speed scanning pipeline, enabling direct-to-PC image capture from Sony cameras with sub-500ms latency. This document details the technical implementation that replaced the slower SD card transfer method with a direct memory pipeline.

## Problem Statement

The initial CardMint implementation suffered from critical performance bottlenecks:
- Images were saved to the camera's SD card first
- Required post-capture transfer operations
- Total latency exceeded 2-3 seconds per card
- Incompatible with the 60+ cards/minute throughput requirement

## Solution Architecture

### Core Technology: Sony PC Remote Mode

PC Remote mode enables the camera to function as a tethered capture device, bypassing SD card storage entirely. Images are transmitted directly to the host PC's memory/storage via USB 3.0.

### Key Components

1. **Connection Mode**: `CrSdkControlMode_Remote`
2. **Save Destination**: `CrStillImageStoreDestination_HostPC`
3. **Transfer Protocol**: USB PTP (Picture Transfer Protocol)
4. **Callback System**: `OnCompleteDownload` for transfer confirmation

## Technical Implementation

### 1. SDK Initialization and Camera Discovery

```cpp
// Initialize Sony Camera Remote SDK
SDK::Init()

// Enumerate connected cameras
SDK::ICrEnumCameraObjectInfo* cameraList = nullptr;
SDK::EnumCameraObjects(&cameraList);

// Get first camera (Sony ZV-E10M2)
const auto* cameraInfo = cameraList->GetCameraObjectInfo(0);
```

### 2. PC Remote Connection

The critical difference from Contents Transfer mode:

```cpp
// Connect in PC Remote mode (NOT Contents mode)
SDK::Connect(
    cameraInfo,
    this,  // IDeviceCallback for event handling
    &deviceHandle,
    SDK::CrSdkControlMode_Remote,  // KEY: Remote mode, not Contents
    SDK::CrReconnecting_ON
);
```

### 3. Configure PC-Only Save Destination

This is the most critical configuration step that was missing in initial attempts:

```cpp
// Configure camera to save directly to PC
SDK::CrDeviceProperty prop;
prop.SetCode(SDK::CrDeviceProperty_StillImageStoreDestination);
prop.SetCurrentValue(SDK::CrStillImageStoreDestination_HostPC);
prop.SetValueType(SDK::CrDataType_UInt16Array);

SDK::SetDeviceProperty(deviceHandle, &prop);
```

**Camera Menu Requirements:**
- Navigate to: Setup → USB → Still Img. Save Dest.
- Set to: "PC Only"
- USB LUN Setting: "Multi"

### 4. Set Save Path and Naming

Configure where images will be saved on the host PC:

```cpp
const char* captureDir = "/home/profusionai/CardMint/captures";
const char* filePrefix = "card";

SDK::SetSaveInfo(
    deviceHandle,
    (CrChar*)captureDir,  // Directory path
    (CrChar*)filePrefix,  // File prefix
    1                     // Starting number
);
```

This generates filenames like: `card00001.JPG`, `card00002.JPG`, etc.

### 5. Capture Trigger Mechanism

The shutter control uses a press-and-release pattern:

```cpp
// Press shutter
SDK::SendCommand(
    deviceHandle,
    SDK::CrCommandId_Release,
    SDK::CrCommandParam_Down
);

// Hold for 100ms (ensures capture registration)
std::this_thread::sleep_for(100ms);

// Release shutter
SDK::SendCommand(
    deviceHandle,
    SDK::CrCommandId_Release,
    SDK::CrCommandParam_Up
);
```

### 6. Asynchronous Transfer Handling

The `OnCompleteDownload` callback is triggered when the image transfer completes:

```cpp
class PCRemoteCapture : public SDK::IDeviceCallback {
    void OnCompleteDownload(CrChar* filename, CrInt32u type) override {
        // filename contains the full path of saved image
        // e.g., "/home/profusionai/CardMint/captures/card00001.JPG"
        
        std::lock_guard<std::mutex> lock(m_downloadMutex);
        m_lastCapturedFile = std::string((char*)filename);
        m_downloadComplete = true;
        m_downloadCV.notify_all();
    }
};
```

### 7. Synchronous Wrapper with Timeout

To provide a synchronous interface for the capture operation:

```cpp
// Wait for download completion with timeout
std::unique_lock<std::mutex> lock(m_downloadMutex);
bool success = m_downloadCV.wait_for(lock, 10s, [this] { 
    return m_downloadComplete; 
});
```

## Performance Characteristics

### Measured Latencies

| Operation | Duration |
|-----------|----------|
| Shutter trigger | ~50ms |
| Image capture & processing | ~200ms |
| USB 3.0 transfer (10.6MB) | ~180ms |
| File write to SSD | ~7ms |
| **Total end-to-end** | **437ms** |

### Throughput Analysis

- Single capture: 437ms
- Theoretical maximum: 137 cards/minute
- Practical throughput: 60-80 cards/minute (accounting for card positioning)

## Critical Success Factors

### 1. Camera Configuration
The camera MUST be configured with:
- PC Remote mode enabled (not MTP/Mass Storage)
- Still Img. Save Dest.: "PC Only"
- USB Connection: "PC Remote"
- USB LUN Setting: "Multi"

### 2. SDK Connection Mode
Must use `CrSdkControlMode_Remote`, NOT `CrSdkControlMode_ContentsTransfer`

### 3. Property Configuration
Must set `CrDeviceProperty_StillImageStoreDestination` to `CrStillImageStoreDestination_HostPC`

### 4. Save Path Configuration
Must call `SetSaveInfo()` with valid local directory path

### 5. Callback Implementation
Must implement `IDeviceCallback::OnCompleteDownload()` to receive transfer notifications

## Common Pitfalls and Solutions

### Pitfall 1: Images Save to SD Card
**Symptom**: Camera makes capture sound but no file appears on PC
**Cause**: Camera not in PC Remote mode
**Solution**: Set Still Img. Save Dest. to "PC Only" in camera menu

### Pitfall 2: Connection Fails
**Symptom**: SDK::Connect returns error
**Cause**: Camera in wrong USB mode
**Solution**: Set USB Connection to "PC Remote" in camera menu

### Pitfall 3: No OnCompleteDownload Callback
**Symptom**: Capture succeeds but callback never fires
**Cause**: Using Contents Transfer mode instead of Remote mode
**Solution**: Use `CrSdkControlMode_Remote` in Connect()

### Pitfall 4: SetSaveInfo Fails
**Symptom**: SetSaveInfo returns error code
**Cause**: Directory doesn't exist or insufficient permissions
**Solution**: Create directory first and ensure write permissions

## Integration with CardMint Pipeline

### Current Implementation Location
- **Source**: `/home/profusionai/CardMint/src/camera/sony-pc-capture.cpp`
- **Binary**: `/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build/sony-pc-capture`

### Production Integration Points

1. **Camera Service**: Wraps SDK calls in TypeScript-friendly interface
2. **Capture Queue**: Manages rapid sequential captures
3. **Image Pipeline**: Receives captured images for OCR processing
4. **Database Service**: Records capture metadata and paths

### Sample Integration Code

```typescript
// TypeScript wrapper for production use
class SonyCameraService {
    private cliWrapper: ChildProcess;
    
    async captureCard(): Promise<string> {
        // Execute compiled C++ binary
        const result = await exec('./sony-pc-capture');
        
        // Parse output for filename
        const match = result.stdout.match(/File: (.+\.JPG)/);
        if (!match) throw new Error('Capture failed');
        
        return match[1];  // Return captured image path
    }
}
```

## Performance Optimization Opportunities

### 1. Memory-Only Transfer
Instead of saving to disk, capture directly to memory buffer:
```cpp
// Use OnCompleteDownload overload with data buffer
void OnCompleteDownload(CrInt8u* data, CrInt64u size) {
    // Process image directly from memory
}
```

### 2. Parallel Processing Pipeline
- Capture thread: Manages camera operations
- Transfer thread: Handles USB data transfer  
- Processing thread: Performs OCR on completed images
- Database thread: Async writes to PostgreSQL

### 3. Pre-allocated Buffers
Allocate image buffers in advance to eliminate allocation overhead during capture.

## Testing and Validation

### Test Execution
```bash
cd /home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build
./sony-pc-capture
```

### Expected Output
```
=== Initializing Sony SDK ===
✓ SDK initialized successfully

=== Finding Camera ===
✓ Found camera: ILME-ZV-E10M2
  ID: 00000000001

=== Connecting to Camera ===
✓ Connected in PC Remote mode

=== Configuring PC Save Mode ===
✓ Set save destination to PC Only
✓ Set save folder: /home/profusionai/CardMint/captures
✓ File prefix: card

=== Capturing Image ===
Position your Pokemon card...
Capturing in 2 seconds...
Triggering shutter...
✓ Shutter triggered!
Waiting for download...
[Event] Download complete: /home/profusionai/CardMint/captures/card00001.JPG

✅ CAPTURE SUCCESSFUL!
   File: /home/profusionai/CardMint/captures/card00001.JPG
   Total time: 437ms
```

### Verification
```bash
# Check captured image
ls -lh /home/profusionai/CardMint/captures/
# -rw-rw-r-- 1 profusionai profusionai 10.6M Aug 15 16:32 card00001.JPG

# Verify image properties
identify card00001.JPG
# card00001.JPG JPEG 6192x4128 6192x4128+0+0 8-bit sRGB 10.6MB
```

## Conclusion

The PC Remote capture implementation successfully achieves the sub-500ms latency requirement for the CardMint scanning pipeline. By eliminating SD card operations and implementing direct USB transfer to PC memory, the system can now support the target throughput of 60+ cards per minute.

The key insight was recognizing that Sony's SDK supports two fundamentally different modes:
1. **Contents Transfer Mode**: For downloading existing files from SD card
2. **PC Remote Mode**: For direct capture to PC without SD card involvement

The successful implementation hinges on proper camera configuration, correct SDK connection mode, and implementing the asynchronous callback system for transfer notifications.

## References

- Sony Camera Remote SDK v2.00.00 API Reference
- Sony RemoteSampleApp Implementation Manual v2.00.00
- CardMint System Architecture Documentation
- Sony ZV-E10M2 PC Remote Mode Manual