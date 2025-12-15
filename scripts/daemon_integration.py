#!/usr/bin/env python3
"""Daemon Integration Module - KeepWarm State Detection for Test Scripts.

This module provides integration functions for CardMint test scripts to detect
and interact with the cardmint-keepwarm daemon. Ensures graceful handling
when daemon is not available and provides clear user guidance.

Usage in test scripts:
  from daemon_integration import check_keepwarm_daemon, require_keepwarm_daemon

  # Optional daemon check (warns but continues)
  daemon_status = check_keepwarm_daemon()

  # Required daemon check (fails fast with guidance)
  require_keepwarm_daemon()
"""
import json
import socket
import sys
import time
from pathlib import Path
from typing import Dict, Any, Optional, Tuple

# KeepWarm daemon configuration (Phase 4C: Enhanced daemon as default)
HEALTH_CHECK_PORT = 12346
STATE_FILE = Path("/tmp/cardmint-keepwarm-enhanced.state")
PID_FILE = Path("/tmp/cardmint-keepwarm-enhanced.pid")

def check_keepwarm_daemon() -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Check if keepwarm daemon is running and healthy.

    Returns:
        (is_running, health_data): Tuple with daemon status and health info
    """
    try:
        # Quick TCP health check
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(2.0)
            s.connect(('localhost', HEALTH_CHECK_PORT))
            health_response = s.recv(1024).decode()
            health_data = json.loads(health_response)

            return True, health_data

    except (ConnectionRefusedError, socket.timeout, json.JSONDecodeError):
        return False, None
    except Exception as e:
        print(f"⚠️  Daemon health check error: {e}", file=sys.stderr)
        return False, None


def get_daemon_state_file() -> Optional[Dict[str, Any]]:
    """Read daemon state file if available.

    Returns:
        State data dict or None if unavailable
    """
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return None


def require_keepwarm_daemon() -> Dict[str, Any]:
    """Require keepwarm daemon to be running. Exit with guidance if not available.

    Returns:
        health_data: Daemon health information
    """
    print("🔍 Checking for CardMint KeepWarm daemon...", end="")

    is_running, health_data = check_keepwarm_daemon()

    if not is_running:
        print(" ❌ NOT FOUND")
        print()
        print("🚨 KEEPWARM DAEMON REQUIRED")
        print("=" * 50)
        print("This test requires the CardMint KeepWarm daemon to be running to avoid")
        print("3.5s warmup delays and 36.5% cold-start performance variance.")
        print()
        print("Quick Start:")
        print("  # Start enhanced daemon (Phase 4C default)")
        print("  python scripts/cardmint-keepwarm-enhanced.py --daemon")
        print()
        print("  # Check status")
        print("  python scripts/cardmint-keepwarm-enhanced.py --check")
        print()
        print("  # Re-run your test")
        print(f"  python {sys.argv[0]}")
        print()
        print("For production deployment, install as systemd service:")
        print("  sudo systemctl start cardmint-keepwarm-enhanced")
        print("  sudo systemctl enable cardmint-keepwarm-enhanced")
        print()
        sys.exit(1)

    print(" ✅ HEALTHY")

    # Display daemon status
    if health_data:
        warmup_age = health_data.get('last_warmup_age', 999)
        warmup_count = health_data.get('warmup_count', 0)
        errors = health_data.get('errors', 0)

        print(f"   Status: {health_data.get('status', 'unknown')}")
        print(f"   Last warmup: {warmup_age:.1f}s ago")
        print(f"   Total warmups: {warmup_count}")

        if errors > 0:
            print(f"   ⚠️  Errors: {errors}")

        # Warn if last warmup is stale
        if warmup_age > 60:  # More than 1 minute
            print(f"   ⚠️  Warning: Last warmup {warmup_age:.1f}s ago (expected <30s)")

    print()
    return health_data or {}


def check_keepwarm_daemon_optional():
    """Optional daemon check - warns but allows test to continue.

    Used for tests that can work without daemon but perform better with it.
    """
    print("🔍 Checking for CardMint KeepWarm daemon...", end="")

    is_running, health_data = check_keepwarm_daemon()

    if not is_running:
        print(" ❌ NOT RUNNING")
        print()
        print("⚠️  PERFORMANCE WARNING")
        print("=" * 40)
        print("CardMint KeepWarm daemon is not running. This test will:")
        print("  • Include 3.5s warmup delay")
        print("  • Experience potential 36.5% performance variance")
        print("  • Show slower than optimal inference times")
        print()
        print("For optimal performance, start the enhanced daemon:")
        print("  python scripts/cardmint-keepwarm-enhanced.py --daemon")
        print()

        # Give user chance to reconsider
        try:
            response = input("Continue without daemon? [y/N]: ").strip().lower()
            if response not in ('y', 'yes'):
                print("Exiting. Start daemon first for optimal performance.")
                sys.exit(0)
        except KeyboardInterrupt:
            print("\nExiting.")
            sys.exit(0)

        print()
        return False, None
    else:
        print(" ✅ HEALTHY")
        if health_data:
            warmup_age = health_data.get('last_warmup_age', 999)
            print(f"   Last warmup: {warmup_age:.1f}s ago")
        print()
        return True, health_data


def wait_for_daemon_ready(max_wait_seconds: int = 30) -> bool:
    """Wait for daemon to become ready after startup.

    Args:
        max_wait_seconds: Maximum time to wait

    Returns:
        True if daemon became ready, False if timeout
    """
    print(f"⏳ Waiting for daemon to become ready (up to {max_wait_seconds}s)...")

    start_time = time.time()
    while time.time() - start_time < max_wait_seconds:
        is_running, health_data = check_keepwarm_daemon()

        if is_running and health_data:
            if health_data.get('status') == 'healthy':
                elapsed = time.time() - start_time
                print(f"✅ Daemon ready after {elapsed:.1f}s")
                return True

        time.sleep(1)

    print(f"❌ Daemon did not become ready within {max_wait_seconds}s")
    return False


# Integration examples for test scripts
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Daemon integration testing")
    parser.add_argument("--require", action="store_true", help="Test required daemon check")
    parser.add_argument("--optional", action="store_true", help="Test optional daemon check")
    parser.add_argument("--wait", action="store_true", help="Test wait for daemon ready")

    args = parser.parse_args()

    if args.require:
        health_data = require_keepwarm_daemon()
        print("✅ Required daemon check passed")

    elif args.optional:
        is_running, health_data = check_keepwarm_daemon_optional()
        print(f"✅ Optional daemon check completed (running: {is_running})")

    elif args.wait:
        ready = wait_for_daemon_ready()
        print(f"✅ Wait for ready completed (ready: {ready})")

    else:
        # Default: just check status
        is_running, health_data = check_keepwarm_daemon()
        print(f"Daemon running: {is_running}")
        if health_data:
            print(f"Health data: {health_data}")