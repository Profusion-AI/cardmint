# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains multiple projects with specialized Claude Code subagents operating within each main directory:

### Sony Camera Remote SDK (`Sony/`)
Sony Camera Remote SDK v2.00.00 for Linux64ARMv8, providing a C++ CLI application for remote control of Sony cameras via USB and Ethernet connections. The SDK enables comprehensive camera control including capture operations, settings adjustment, live view, and contents transfer.

### CardMint System (`CardMint/`)
High-performance card scanning and processing system designed to achieve sub-500ms response times and 60+ cards/minute throughput. Integrates camera hardware, real-time processing, and database operations for automated card digitization.

## Orchestrator Role

**Claude Code acts as the primary orchestrator**, coordinating subagents that operate within each project directory. Each subagent has specialized knowledge of its domain (Sony SDK, CardMint system) while the orchestrator manages cross-project dependencies, resource allocation, and high-level task coordination.

## Build System

### Prerequisites
```bash
sudo apt install autoconf libtool libudev-dev gcc g++ make cmake unzip libxml2-dev
```

### Build Commands
```bash
# Standard build process
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build .

# Clean rebuild
rm -rf build && mkdir build && cd build && cmake -DCMAKE_BUILD_TYPE=Release .. && cmake --build .
```

### Key Build Notes
- CMake generates absolute paths - build files cannot be moved from their generation directory
- The build result executable can be moved without issue
- C++17 standard is required
- Stack protection and signed-char compilation are enabled on Linux

## Architecture

### Core Components

**RemoteCli.cpp**: Main application entry point with menu-driven interface supporting:
- Camera discovery and connection (USB/Ethernet/SSH)
- Remote Control Mode: Full camera operation with live settings adjustment
- Contents Transfer Mode: File download and management
- Remote Transfer Mode: Combined remote control and content operations

**CameraDevice.h/.cpp**: Primary camera abstraction layer providing:
- Connection management with auto-reconnection support
- Property getters/setters for all camera parameters (aperture, ISO, shutter, focus, etc.)
- Shooting operations (single, continuous, bracket, movie recording)
- Live view streaming and OSD overlay
- Contents listing and transfer
- Callback-based event handling

**Connection Management**:
- `ConnectionInfo`: Network and USB connection details
- `PropertyValueTable`: Camera property state management
- `IDeviceCallback`: Asynchronous event handling interface

### External Dependencies

**Sony CRSDK Libraries** (`external/crsdk/`):
- `libCr_Core.so`: Core SDK functionality
- `libCr_PTP_IP.so` / `libCr_PTP_USB.so`: Protocol adapters
- `libmonitor_protocol*.so`: Monitoring capabilities
- `libssh2.so`, `libusb-1.0.so`: Communication libraries

**OpenCV 4.08** (`external/opencv/`):
- Image processing and display capabilities
- Headers in `external/opencv/include/opencv2/`
- Linux shared libraries: `libopencv_core.so.408`, `libopencv_highgui.so.408`, etc.

## Development Workflow

### Camera Connection Modes
1. **MSEARCH_ENB**: Auto-discovery of network cameras (default)
2. **Manual IP**: Direct IP address entry for Ethernet connection
3. **USB**: Direct USB serial connection (disabled by default)

### Key Features Implementation
- **Live View**: Real-time camera preview with quality settings
- **Property Control**: Bidirectional camera settings (get/set pattern)
- **Shooting Operations**: Single capture, continuous, focus bracketing, movie recording
- **Remote Key Control**: Camera button/dial/lever simulation
- **Firmware Update**: Remote firmware management capabilities
- **SSH Support**: Secure camera communication option

### Code Conventions
- Extensive use of Sony's SCRSDK namespace
- Menu-driven CLI with nested operation modes
- Shared pointer management for camera device instances
- Thread-safe operations using std::atomic and condition variables
- Text abstraction layer (`cli::text`, `cli::tout`) for cross-platform string handling

## Testing

No automated test framework is included. Testing is performed through:
- Manual camera connection verification
- Interactive menu system validation
- Live camera operation testing with physical Sony cameras
- Network connectivity testing (IP/SSH modes)

## Platform Support

- **Linux**: Primary target (tested on Ubuntu 20.04 LTS+)
- **Windows**: Supported via Visual Studio 2019+ with v142 toolset
- **macOS**: Supported on macOS 12.1+ (Monterey) with Xcode 14.1+

## Hardware Requirements

- Compatible Sony camera models (see Camera_Remote_SDK_API_Reference_xxx.pdf)
- USB 3.0+ connection for USB mode
- Network connectivity for IP/Ethernet mode
- SSH support for secure connections (optional)