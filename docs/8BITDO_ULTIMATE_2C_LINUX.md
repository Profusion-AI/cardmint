8BitDo Ultimate 2C on Linux — Capability Notes and Setup Plan
=============================================================

Overview
--------
- Goal: Use an 8BitDo Ultimate 2C as a persistent, wired controller for CardMint on Fedora.
- Without the 2.4G dongle, we will rely on USB‑C wired mode. Many 8BitDo models support XInput over USB and enumerate like an Xbox 360‑class controller; some variants present as 8BitDo vendor HID (DInput) instead.

What To Expect (Enumeration)
----------------------------
- XInput (preferred): Enumerates as Xbox 360‑class device (VID 045e PID 028e). Linux driver: `xpad` (in‑kernel). Result: stable mapping, rumble, persistent wired.
- 8BitDo HID/DInput: Enumerates under 8BitDo vendor (VID 2dc8:xxxx). Linux driver: `hid-generic`. Result: works via evdev, but mapping/rumble may vary. Still fine for persistent input if mapping is acceptable.

Mode Selection (Typical 8BitDo Patterns)
----------------------------------------
- XInput mode: Hold X + Start, then connect USB‑C.
- DInput mode: Hold B + Start, then connect USB‑C.
- Switch mode: Hold Y + Start, then connect USB‑C.

Note: Exact combos can vary by model/firmware. We will verify using the manual once the device is on hand.

Fedora Setup & Verification
---------------------------
1) Connect controller via a known data‑capable USB‑C cable (avoid charge‑only cables).
2) Select mode (start with XInput: X + Start). Then:
   - `lsusb | grep -iE '045e:028e|2dc8:'`
     - 045e:028e → Xbox 360 class (XInput). Good.
     - 2dc8:xxxx → 8BitDo vendor HID (DInput).
   - `dmesg -w | rg -i 'xpad|xbox|8bitdo|hid'`
     - Look for `xpad` claiming the device vs `hid-generic`.
   - `ls -l /dev/input/by-id`
     - Names containing "Xbox 360" indicate XInput; names containing "8BitDo" indicate vendor HID.
3) Sanity test mapping (optional):
   - `sudo dnf install -y evtest`
   - `sudo evtest /dev/input/eventX`

Driver Notes
------------
- XInput path uses `xpad` (part of mainline kernel) and is typically robust for wired use (standard mapping, rumble supported).
- DInput/HID path uses `hid-generic`; mapping may differ but is still usable for CardMint if persistence is the main goal.

Autosuspend & Persistence
-------------------------
- XInput controllers (wired) generally do not exhibit aggressive sleep. A udev rule to disable autosuspend is usually unnecessary, but if needed you can set:

```
# Template (adjust idVendor/idProduct once known via lsusb)
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="028e", \
  TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="045e", ATTRS{idProduct}=="028e", \
  TEST=="power/autosuspend", ATTR{power/autosuspend}="-1"
```

- For 8BitDo vendor HID (2dc8:xxxx), substitute the detected product ID:

```
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="XXXX", \
  TEST=="power/control", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEMS=="usb", ATTRS{idVendor}=="2dc8", ATTRS{idProduct}=="XXXX", \
  TEST=="power/autosuspend", ATTR{power/autosuspend}="-1"
```

CardMint Integration Plan
-------------------------
- Preferred: XInput (VID 045e:028e) via wired USB‑C and `xpad` driver → stable mapping, minimal configuration.
- If DInput/HID (VID 2dc8:xxxx): still acceptable if mapping is consistent for our needs; we can document a small mapping table if needed.
- Our current watcher system can be extended to detect 045e:028e (XInput mode) and optionally 2dc8:xxxx (8BitDo vendor mode) once the device is connected.

Testing Checklist (When Controller Arrives)
------------------------------------------
1) Try XInput mode (X + Start → USB‑C), verify `lsusb` shows 045e:028e and `xpad` in `dmesg`.
2) Confirm `/dev/input/by-id` shows an Xbox 360 class device; run `evtest` to validate buttons/axes.
3) If XInput fails, try DInput (B + Start) and confirm 2dc8:xxxx in `lsusb`; verify evdev events.
4) If only charging occurs (no `lsusb` entry), switch cable/port; avoid hubs initially.

Operational Guidance
--------------------
- For production stations that require always‑on behavior, XInput (wired) is recommended (Xbox class or 8BitDo in XInput mode).
- If we later add a 2.4G dongle for this model, we can also test the dongle path (often XInput over 2.4G) for enhanced stability.

Next Steps (Post‑Arrival)
-------------------------
- Capture actual VID:PID and by‑id names.
- Decide whether to extend our watcher to include XInput (045e:028e) and/or 8BitDo HID (2dc8:xxxx).
- If desired, add minimal udev/systemd glue to run diagnostics or keepalive actions on connect (likely not necessary for XInput wired, but feasible).

