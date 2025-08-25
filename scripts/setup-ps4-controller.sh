#!/bin/bash

# Setup PS4 Controller for CardMint
# Configures DualShock 4 controller for optimal scanning workflow

set -euo pipefail

echo "🎮 CardMint PS4 Controller Setup"
echo "================================"

# Check if running with sudo for device access
if [[ $EUID -ne 0 ]]; then
    echo "⚠️  This script needs root access for device configuration"
    echo "Please run: sudo $0"
    exit 1
fi

# Install required packages
echo "📦 Installing PS4 controller support packages..."
dnf install -y evdev bluez bluez-tools python3-evdev python3-pip

# Enable Bluetooth service
echo "📡 Enabling Bluetooth service..."
systemctl enable bluetooth
systemctl start bluetooth

# Add user to input group
echo "👤 Adding profusionai to input group..."
usermod -a -G input profusionai

# Create udev rule for PS4 controller
echo "📋 Creating udev rule for PS4 controller..."
cat > /etc/udev/rules.d/99-ps4-controller.rules << 'EOF'
# Sony DualShock 4 Controller (USB)
SUBSYSTEM=="input", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="05c4", MODE="0664", GROUP="input"
SUBSYSTEM=="input", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="09cc", MODE="0664", GROUP="input"

# Sony DualShock 4 Controller (Bluetooth)  
SUBSYSTEM=="input", ATTRS{name}=="Wireless Controller", MODE="0664", GROUP="input"
SUBSYSTEM=="input", ATTRS{name}=="Sony Interactive Entertainment Wireless Controller", MODE="0664", GROUP="input"

# HID device access
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="05c4", MODE="0664", GROUP="input"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="09cc", MODE="0664", GROUP="input"
EOF

# Reload udev rules
echo "🔄 Reloading udev rules..."
udevadm control --reload-rules
udevadm trigger

# Create systemd user service for PS4 controller daemon
echo "🛠️  Creating systemd user service..."
mkdir -p /home/profusionai/.config/systemd/user

cat > /home/profusionai/.config/systemd/user/ps4-controller.service << 'EOF'
[Unit]
Description=CardMint PS4 Controller Handler
After=graphical-session.target

[Service]
Type=exec
User=profusionai
Group=input
WorkingDirectory=/home/profusionai/CardMint
ExecStart=/usr/bin/python3 /home/profusionai/CardMint/scripts/ps4-scanner-controller.py
Restart=on-failure
RestartSec=5

# Environment
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/1000

# Allow access to input devices
SupplementaryGroups=input

[Install]
WantedBy=default.target
EOF

# Set correct ownership
chown -R profusionai:profusionai /home/profusionai/.config/systemd

# Install Python dependencies for controller support
echo "🐍 Installing Python dependencies..."
pip3 install evdev

echo "✅ PS4 Controller setup completed!"
echo ""
echo "📋 Next steps:"
echo "  1. Connect PS4 controller via USB cable"
echo "  2. Or pair via Bluetooth:"
echo "     - Hold Share + PS buttons until light bar flashes"
echo "     - Run: sudo bluetoothctl"
echo "     - scan on"
echo "     - pair [MAC_ADDRESS]"
echo "     - connect [MAC_ADDRESS]"
echo ""
echo "🎮 Test controller:"
echo "  • Check connection: ls /dev/input/event*"
echo "  • Test in CardMint: python3 scripts/ps4-scanner-controller.py"
echo "  • Enable service: systemctl --user enable ps4-controller.service"
echo ""
echo "🔧 Troubleshooting:"
echo "  • Check permissions: ls -l /dev/input/"
echo "  • View logs: journalctl --user -u ps4-controller.service"
echo "  • Reconnect controller if issues persist"
echo ""
echo "🚀 Ready for controller-enhanced scanning workflow!"