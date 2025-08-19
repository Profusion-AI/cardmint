#!/bin/bash

# Sony Camera Remote SDK Setup Script for CardMint
# This script downloads and sets up the Sony SDK if it's not already present

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SDK_DIR="$PROJECT_ROOT/CrSDK_v2.00.00_20250805a_Linux64PC"
SDK_LINK="$PROJECT_ROOT/sony-sdk"
ARCHITECTURE=$(uname -m)

echo "🎥 CardMint Sony SDK Setup"
echo "=========================="
echo

# Check system architecture
if [ "$ARCHITECTURE" != "x86_64" ]; then
    echo "❌ Error: This SDK requires x86_64 architecture"
    echo "   Your system: $ARCHITECTURE"
    exit 1
fi

# Check if SDK already exists
if [ -d "$SDK_DIR" ]; then
    echo "✅ SDK already exists at: $SDK_DIR"
else
    echo "⚠️  Sony Camera Remote SDK not found!"
    echo
    echo "The Sony SDK is proprietary and must be obtained from Sony."
    echo
    echo "To set up the SDK:"
    echo "1. Download the SDK from Sony's developer portal"
    echo "2. Extract to: $SDK_DIR"
    echo "3. Re-run this script"
    echo
    echo "Expected SDK structure:"
    echo "  $SDK_DIR/"
    echo "  ├── app/           (Sample application code)"
    echo "  ├── external/      (SDK libraries)"
    echo "  ├── CMakeLists.txt (Build configuration)"
    echo "  └── README.md      (Documentation)"
    exit 1
fi

# Create symlink if it doesn't exist
if [ ! -L "$SDK_LINK" ]; then
    echo "📎 Creating symlink: sony-sdk -> $(basename "$SDK_DIR")"
    ln -sfn "$(basename "$SDK_DIR")" "$SDK_LINK"
else
    echo "✅ Symlink already exists: sony-sdk"
fi

# Check for required dependencies
echo
echo "🔍 Checking dependencies..."

check_command() {
    if command -v $1 &> /dev/null; then
        echo "  ✅ $1: $(command -v $1)"
    else
        echo "  ❌ $1: NOT FOUND"
        return 1
    fi
}

MISSING_DEPS=0
check_command cmake || MISSING_DEPS=1
check_command g++ || MISSING_DEPS=1
check_command make || MISSING_DEPS=1

if [ $MISSING_DEPS -eq 1 ]; then
    echo
    echo "⚠️  Missing dependencies. Install with:"
    echo "  sudo dnf install cmake gcc-c++ make"
    exit 1
fi

# Check if wrapper is already built
if [ -f "$SDK_DIR/build/sony-cli" ]; then
    echo
    echo "✅ Sony CLI wrapper already built"
    echo "   Binary: $SDK_DIR/build/sony-cli"
else
    echo
    echo "🔨 Building Sony CLI wrapper..."
    
    # Apply our custom wrapper if it exists
    if [ -f "$PROJECT_ROOT/src/camera/sony-cli-wrapper.cpp" ]; then
        echo "  📋 Copying custom wrapper..."
        cp "$PROJECT_ROOT/src/camera/sony-cli-wrapper.cpp" "$SDK_DIR/app/sony-cli.cpp"
    fi
    
    # Build the SDK
    cd "$SDK_DIR"
    rm -rf build
    mkdir build
    cd build
    
    echo "  🔧 Running CMake..."
    cmake -DCMAKE_BUILD_TYPE=Release .. > /dev/null 2>&1
    
    echo "  🏗️  Building..."
    cmake --build . > /dev/null 2>&1
    
    if [ -f "sony-cli" ]; then
        echo "  ✅ Build successful!"
    elif [ -f "RemoteCli" ]; then
        # Rename if it built with default name
        mv RemoteCli sony-cli
        echo "  ✅ Build successful (renamed RemoteCli to sony-cli)!"
    else
        echo "  ❌ Build failed!"
        exit 1
    fi
fi

# Test the binary
echo
echo "🧪 Testing Sony CLI..."
cd "$SDK_DIR/build"

# Set library path
export LD_LIBRARY_PATH="$SDK_DIR/external/crsdk:$SDK_DIR/external/crsdk/CrAdapter:$LD_LIBRARY_PATH"

# Test list command
if ./sony-cli list > /dev/null 2>&1; then
    DEVICES=$(./sony-cli list | grep "DEVICES:" | cut -d: -f2)
    if [ "$DEVICES" != "" ] && [ "$DEVICES" != "0" ]; then
        echo "  ✅ Camera detected! ($DEVICES device(s) found)"
        ./sony-cli list | grep "DEVICE:" | sed 's/^/     /'
    else
        echo "  ⚠️  No cameras detected (connect camera via USB and enable PC Remote)"
    fi
else
    echo "  ❌ Sony CLI test failed"
    echo "     Make sure all SDK libraries are present in: $SDK_DIR/external/"
    exit 1
fi

# Final instructions
echo
echo "✨ SDK setup complete!"
echo
echo "Next steps:"
echo "1. Configure your camera (see docs/CAMERA_SETUP.md)"
echo "2. Run validation: npm run camera-validate"
echo "3. Test scanning: ./scan-card.ts"
echo
echo "SDK location: $SDK_DIR"
echo "Symlink: $SDK_LINK"
echo "Binary: $SDK_DIR/build/sony-cli"