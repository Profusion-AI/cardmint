#!/usr/bin/env python3
"""
Exclusive grab for a gamepad event device using python-evdev.

Usage:
  python3 scripts/linux/gamepad-grab.py --by-id <substring>
  python3 scripts/linux/gamepad-grab.py --event /dev/input/eventX

Keeps the process running while holding the EVIOCGRAB. Press Ctrl+C to release.
Requires python3-evdev (dnf install python3-evdev).
"""
import argparse
import os
import sys
import time
from evdev import InputDevice, list_devices


def find_by_id(substr: str):
    by_id_dir = '/dev/input/by-id'
    try:
        for name in os.listdir(by_id_dir):
            if 'event' in name and substr.lower() in name.lower():
                return os.path.join(by_id_dir, name)
    except FileNotFoundError:
        pass
    return None


def resolve_real(path_in: str) -> str:
    try:
        return os.path.realpath(path_in)
    except Exception:
        return path_in


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--by-id', help='Substring to match under /dev/input/by-id')
    ap.add_argument('--event', help='Direct event device path (e.g., /dev/input/eventX)')
    args = ap.parse_args()

    if not args.by_id and not args.event:
        print('ERROR: specify --by-id or --event', file=sys.stderr)
        sys.exit(2)

    event_path = args.event
    if args.by_id:
        event_path = find_by_id(args.by_id)
        if not event_path:
            print('WAITING: no matching by-id found, will retry...', flush=True)
            # Poll briefly to allow udev to settle
            for _ in range(20):
                time.sleep(0.25)
                event_path = find_by_id(args.by_id)
                if event_path:
                    break

    if not event_path:
        print('ERROR: could not resolve an event device', file=sys.stderr)
        sys.exit(1)

    real_event = resolve_real(event_path)
    dev = InputDevice(real_event)
    dev.grab()  # EVIOCGRAB
    print(f'GRABBED: byId={event_path} realEvent={real_event} name={dev.name}', flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            dev.ungrab()
            print('RELEASED')
        except Exception:
            pass


if __name__ == '__main__':
    main()

