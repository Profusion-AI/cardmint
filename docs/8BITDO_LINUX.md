# 8BitDo-2C Controller - Legacy Documentation

**⚠️ DEPRECATED**: This file contains legacy setup information. 

**For CardMint Production Use**, see the updated documentation:
- **[8BitDo-2C CardMint Integration Guide](./8BITDO-2C_CARDMINT_INTEGRATION.md)** - Complete production setup
- **[8BitDo-2C Quick Setup](./8BITDO-2C_QUICK_SETUP.md)** - 5-minute configuration guide

---

## Legacy Overview (Reference Only)
- Goal: Reliable wired USB use of the 8BitDo Ultimate 2C on Fedora 42, with optional exclusive access for CardMint.
- Modes: 8BitDo pads can present as XInput (Xbox), DInput (generic HID), or Switch. **DInput is verified optimal for CardMint**.
- Drivers you may see depending on mode: `xpad` (Xbox/XInput), `hid-generic` (DInput), `hid-nintendo` (Switch), plus `joydev` for `/dev/input/js*`.

**Verified Production Specs**: USB IDs `2dc8:310a`, DInput mode, `/dev/input/event29`

Quick Start
-----------
1) Connect the controller via USB using a data‑capable cable.
2) Choose mode on power‑on (hold combo while powering):
   - XInput: X+Start (best general compatibility; appears as Microsoft Xbox 360/One controller)
   - DInput: B+Start (generic HID gamepad)
   - Switch: Y+Start (Nintendo mode)
3) Verify kernel sees it:
   - `lsusb | rg -i '8bit|xbox|microsoft|nintendo|gamepad'`
   - `journalctl -k -f` and plug/unplug to observe logs
4) Find the event device:
   - `ls -l /dev/input/by-id/` → look for an `event-joystick` symlink (8BitDo/Microsoft/Nintendo name)

Udev Rules (disable autosuspend + permissions)
----------------------------------------------
1) Identify USB IDs after plugging in: `lsusb` → note `idVendor` and `idProduct`.
2) Create `/etc/udev/rules.d/99-8bitdo-ultimate-2c.rules` (replace VVVV/PPPP with your IDs):

```
# Keep power and grant permissions for 8BitDo Ultimate 2C (USB)
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="VVVV", ATTRS{idProduct}=="PPPP", \
  TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="VVVV", ATTRS{idProduct}=="PPPP", \
  TEST=="power/autosuspend", ATTR{power/autosuspend}="-1"

# Input/hidraw access (adjust group as needed)
SUBSYSTEM=="input",  ATTRS{idVendor}=="VVVV", ATTRS{idProduct}=="PPPP", MODE="0664", GROUP="input"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="VVVV", ATTRS{idProduct}=="PPPP", MODE="0664", GROUP="input"

# Optional: ignore non-joystick subfunctions exposed as keyboards/mice
# SUBSYSTEM=="input", ATTRS{idVendor}=="VVVV", ATTRS{idProduct}=="PPPP", ENV{LIBINPUT_IGNORE_DEVICE}="1"
```

3) Reload rules: `sudo udevadm control --reload-rules && sudo udevadm trigger`

Repo Tools
----------
- `scripts/linux/gamepad-detect.ts`: Detects a gamepad’s by-id symlink and resolves the event device; can watch for connect/disconnect.
- `scripts/linux/gamepad-grab.py`: Grabs the event device exclusively (EVIOCGRAB) to prevent other apps from reading it.

NPM Scripts
-----------
- `npm run gamepad:detect` → one-shot detection with details.
- `npm run gamepad:watch` → watch for connect/disconnect and print READY/WAITING.
- `npm run gamepad:grab -- --by-id <substring>` → exclusive grab; keep process running to hold the grab.

Hardware Handshake – What to Check
----------------------------------
- Modules: `lsmod | rg -E 'xpad|hid_nintendo|hid_generic|joydev'`
- USB IDs: `lsusb | rg -i '8bit|xbox|microsoft|nintendo'`
- Devices: `ls -l /dev/input/by-id/` → find `*-event-joystick` symlink
- Kernel logs on plug: `journalctl -k -f`

Software Handshake – Verify Input
---------------------------------
- Event stream: `sudo evtest /dev/input/eventX` (press buttons and observe events)
- js device: `jstest /dev/input/js0` (if `joydev` is present)
- Browser: `chrome://gamepad` shows the controller and live input
- Repo detector: `npm run gamepad:detect` prints READY with resolved event device

Exclusivity (Prevent Other Apps from Consuming Input)
-----------------------------------------------------
- Use the Python grabber to EVIOCGRAB the event device:
  - Find the by-id symlink: `/dev/input/by-id/...-event-joystick`
  - `npm run gamepad:grab -- --by-id '<substring from by-id name>'`
  - Keep the grabber running while CardMint is using the controller
- Integration note: Production services can open the event device and perform EVIOCGRAB directly; until then, run the grabber as a sidecar.

Troubleshooting
---------------
- Device enumerates as Microsoft (`045e:028e`): This is expected in XInput mode; target Microsoft IDs in udev rules.
- No `event-joystick` symlink: Some modes expose only evdev `event*`; use `ls -l /dev/input/by-id/` and match `event-*` entries by name.
- Steam/desktop captures inputs: Use the grabber, disable Steam Input, or stop Steam on the capture station.
- Intermittent disconnects: Ensure good cable/port, disable autosuspend (udev), prefer XInput mode.

Appendix: Mode Heuristics
-------------------------
- XInput: by-id name tends to include `Xbox`/`Microsoft`; driver `xpad`.
- DInput: by-id name includes `8BitDo`; driver `hid-generic` + `joydev`.
- Switch: by-id includes `Nintendo`; driver `hid-nintendo`.

