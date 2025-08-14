#!/bin/bash

# Setup environment for Sony Camera SDK
export SONY_SDK_PATH="/home/profusionai/Sony/CrSDK_v2.00.00_20250805a_Linux64ARMv8"
export LD_LIBRARY_PATH="$SONY_SDK_PATH/external/crsdk:$LD_LIBRARY_PATH"

# Verify libraries are accessible
if [ ! -f "$SONY_SDK_PATH/external/crsdk/libCr_Core.so" ]; then
    echo "Error: Sony SDK libraries not found at $SONY_SDK_PATH"
    exit 1
fi

echo "Sony SDK environment configured:"
echo "  SDK Path: $SONY_SDK_PATH"
echo "  Libraries: $(ls $SONY_SDK_PATH/external/crsdk/*.so 2>/dev/null | wc -l) .so files found"

# Check USB connection
USB_DEVICE=$(lsusb | grep -i sony)
if [ -n "$USB_DEVICE" ]; then
    echo "  Camera: Connected via USB"
    echo "  Device: $USB_DEVICE"
else
    echo "  Camera: Not detected on USB"
fi

# Set performance governor for consistent capture timing
if command -v cpupower &> /dev/null; then
    echo "Setting CPU performance governor..."
    sudo cpupower frequency-set -g performance 2>/dev/null || echo "  Note: Could not set performance governor (requires sudo)"
fi

# Disable USB autosuspend for the session
echo "Configuring USB power management..."
for device in /sys/bus/usb/devices/*/power/control; do
    if [ -f "$device" ]; then
        echo 'on' | sudo tee "$device" > /dev/null 2>&1
    fi
done

echo ""
echo "Environment ready for camera operations!"