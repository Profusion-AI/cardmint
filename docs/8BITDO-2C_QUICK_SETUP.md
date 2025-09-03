# 8BitDo-2C Quick Setup Guide

**5-Minute Production Setup for CardMint**

## Hardware Connection
1. Connect 8BitDo-2C via USB-C data cable
2. Power on holding **B+Start** (DInput mode)
3. Verify: `lsusb | grep 2dc8:310a`

## Software Configuration
```bash
# 1. Create udev rules
sudo tee /etc/udev/rules.d/99-8bitdo-2c.rules << 'EOF'
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="310a", \
  TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="310a", \
  TEST=="power/autosuspend", ATTR{power/autosuspend}="-1"
SUBSYSTEM=="input",  ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="310a", MODE="0664", GROUP="input"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="310a", MODE="0664", GROUP="input"
EOF

# 2. Apply rules
sudo udevadm control --reload-rules && sudo udevadm trigger

# 3. Test detection
npm run gamepad:detect
# Expected: READY {"mode":"dinput",...}

# 4. Start exclusive access for CardMint
npm run gamepad:grab -- --by-id '8bitdo'
# Keep this running during CardMint operation
```

## Verification Checklist
- [ ] `lsusb` shows device `2dc8:310a`
- [ ] `npm run gamepad:detect` returns `READY`
- [ ] `npm run gamepad:grab` shows `GRABBED`
- [ ] Controller isolated from desktop apps

## Production Integration
- Run grabber as systemd service or CardMint subprocess
- Controller events available at detected `/dev/input/eventXX`
- Use evdev library for button/analog input processing

**Status**: ✅ Ready for CardMint v2.0+ Integration