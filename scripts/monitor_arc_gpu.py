#!/usr/bin/env python3
"""Monitor Intel Arc A770 GPU utilization during CardMint inference.

This script provides real-time observability into GPU usage, temperature,
memory, and power consumption to verify GPU acceleration is active.
"""
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional


GPU_CARD_PATH = Path(os.environ.get("CARDMINT_GPU_CARD", "/sys/class/drm/card1"))
GPU_DEVICE_PATH = GPU_CARD_PATH / "device"
POWER_TRACKER = {"energy": None, "timestamp": None}


def resolve_hwmon_file(filename: str) -> Optional[Path]:
    """Locate a hwmon sensor file for the Arc device."""
    hwmon_root = GPU_DEVICE_PATH / "hwmon"
    if not hwmon_root.exists():
        return None

    for hwmon_dir in sorted(hwmon_root.glob("hwmon*")):
        candidate = hwmon_dir / filename
        if candidate.exists():
            return candidate
    return None


def resolve_render_node() -> Optional[Path]:
    """Resolve the render node associated with the Arc card."""
    try:
        target_device = GPU_DEVICE_PATH.resolve(strict=True)
    except FileNotFoundError:
        return None

    drm_root = GPU_CARD_PATH.parent
    for render_node in drm_root.glob("renderD*"):
        try:
            if (render_node / "device").resolve(strict=True) == target_device:
                return Path("/dev/dri") / render_node.name
        except FileNotFoundError:
            continue
    return None


def read_sysfs(path: Path) -> Optional[str]:
    """Read a sysfs file safely."""
    try:
        return path.read_text().strip()
    except Exception:
        return None


def get_gpu_temp() -> Optional[float]:
    """Get GPU temperature in Celsius."""
    temp_file = resolve_hwmon_file("temp1_input")
    if temp_file:
        temp_raw = read_sysfs(temp_file)
        if temp_raw:
            return int(temp_raw) / 1000.0
    return None


def get_fan_rpm() -> Optional[int]:
    """Get GPU fan speed in RPM."""
    fan_file = resolve_hwmon_file("fan1_input")
    if fan_file:
        rpm = read_sysfs(fan_file)
        if rpm:
            return int(rpm)
    return None


def get_gpu_power() -> Optional[float]:
    """Get GPU power consumption in Watts."""
    energy_file = resolve_hwmon_file("energy1_input")
    if not energy_file:
        return None

    energy_raw = read_sysfs(energy_file)
    if not energy_raw:
        return None

    try:
        energy = int(energy_raw)  # microjoules
    except ValueError:
        return None

    now = time.time()
    previous_energy = POWER_TRACKER["energy"]
    previous_timestamp = POWER_TRACKER["timestamp"]

    POWER_TRACKER["energy"] = energy
    POWER_TRACKER["timestamp"] = now

    if previous_energy is None or previous_timestamp is None:
        return None

    if energy < previous_energy:
        return None

    elapsed = now - previous_timestamp
    if elapsed <= 0:
        return None

    delta_energy_joules = (energy - previous_energy) / 1_000_000.0
    return delta_energy_joules / elapsed


def get_gpu_freq() -> Optional[int]:
    """Get current GPU frequency in MHz."""
    freq_path = GPU_CARD_PATH / "gt_cur_freq_mhz"
    freq = read_sysfs(freq_path)
    if freq:
        return int(freq)
    return None


def check_render_device() -> Dict[str, Any]:
    """Check if the Arc render node is currently in use."""
    render_node = resolve_render_node()
    if not render_node:
        return {"active": False, "error": "render node not found"}

    try:
        result = subprocess.run(
            ["lsof", str(render_node)],
            capture_output=True,
            text=True,
            timeout=5
        )
        processes: Dict[str, str] = {}
        for line in result.stdout.split("\n")[1:]:  # Skip header
            if line.strip():
                parts = line.split()
                if len(parts) >= 2:
                    pid = parts[1]
                    processes.setdefault(pid, parts[0])
        process_list = [
            {"command": command, "pid": pid}
            for pid, command in processes.items()
        ]
        return {
            "active": len(process_list) > 0,
            "processes": process_list
        }
    except Exception as e:
        return {"active": False, "error": str(e)}


def get_intel_gpu_top() -> Optional[Dict[str, float]]:
    """Get GPU utilization from intel_gpu_top (if available)."""
    try:
        result = subprocess.run(
            ["intel_gpu_top", "-l", "1", "-J"],
            capture_output=True,
            text=True,
            timeout=3
        )
        if result.returncode == 0:
            import json
            data = json.loads(result.stdout)
            if "engines" in data:
                engines = data["engines"]
                return {
                    "render": engines.get("Render/3D", {}).get("busy", 0.0),
                    "video": engines.get("Video", {}).get("busy", 0.0),
                    "compute": engines.get("VideoEnhance", {}).get("busy", 0.0),
                }
    except Exception:
        pass
    return None


def print_header():
    """Print monitoring header."""
    print("=" * 80)
    print("Intel Arc A770 GPU Monitoring - CardMint Inference")
    print("=" * 80)
    print()


def print_stats(iteration: int):
    """Print current GPU statistics."""
    temp = get_gpu_temp()
    fan_rpm = get_fan_rpm()
    power = get_gpu_power()
    freq = get_gpu_freq()
    render_check = check_render_device()
    gpu_util = get_intel_gpu_top()

    print(f"[{iteration:03d}] {time.strftime('%H:%M:%S')}", end=" | ")

    if temp:
        print(f"Temp: {temp:5.1f}°C", end=" | ")
    else:
        print("Temp: N/A    ", end=" | ")

    if fan_rpm is not None:
        print(f"Fan: {fan_rpm:4d} RPM", end=" | ")
    else:
        print("Fan: N/A     ", end=" | ")

    if power:
        print(f"Power: {power:5.1f}W", end=" | ")
    else:
        print("Power: N/A   ", end=" | ")

    if freq:
        print(f"Freq: {freq:4d} MHz", end=" | ")
    else:
        print("Freq: N/A     ", end=" | ")

    if render_check["active"]:
        print(f"GPU: ✅ ACTIVE ({len(render_check['processes'])} proc)", end="")
    else:
        print("GPU: ❌ IDLE  ", end="")

    if gpu_util:
        print(f" | Render: {gpu_util['render']:.1f}%", end="")

    print()


def monitor_continuous(interval: float = 1.0, max_iterations: Optional[int] = None):
    """Monitor GPU continuously."""
    print_header()
    print("Monitoring GPU activity... (Ctrl+C to stop)")
    print()
    print("Columns: Timestamp | Temperature | Fan Speed | Power | Frequency | GPU Status")
    print("-" * 80)

    iteration = 0
    try:
        while max_iterations is None or iteration < max_iterations:
            print_stats(iteration)
            iteration += 1
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n")
        print("=" * 80)
        print("Monitoring stopped.")


def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Monitor Intel Arc A770 GPU during CardMint inference"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Monitoring interval in seconds (default: 1.0)"
    )
    parser.add_argument(
        "--count",
        type=int,
        help="Number of samples to collect (default: continuous)"
    )
    parser.add_argument(
        "--check-once",
        action="store_true",
        help="Check GPU status once and exit"
    )

    args = parser.parse_args()

    if args.check_once:
        print_header()
        print_stats(0)
        return 0

    monitor_continuous(interval=args.interval, max_iterations=args.count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
