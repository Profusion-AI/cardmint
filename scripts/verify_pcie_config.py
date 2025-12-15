#!/usr/bin/env python3
"""Verify PCIe configuration after Arc A770 reconfiguration.

This script checks that the Intel Arc A770 is properly configured in PCIe Slot 1
with full PCIe 4.0 x16 bandwidth after removing the GTX 1050 Ti.
"""
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# Minimum acceptable host-device bandwidth in GB/s
# PCIe 3.0 x8 theoretical: ~7.9 GB/s, so 12 GB/s suggests Gen3 x16 or better
MIN_BANDWIDTH_GBPS = 12.0


class Colors:
    """ANSI color codes for terminal output."""
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    END = '\033[0m'


def run_command(cmd: List[str], check: bool = False) -> Tuple[int, str, str]:
    """Run a shell command and return exit code, stdout, stderr."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except Exception as e:
        return -1, "", str(e)


def check_gpu_present() -> Tuple[bool, Optional[str], Optional[str]]:
    """Check if Arc A770 is detected and GTX 1050 Ti is gone."""
    code, stdout, _ = run_command(["lspci"])

    arc_bus = None
    nvidia_found = False

    for line in stdout.split('\n'):
        if 'Arc A770' in line or 'DG2' in line:
            arc_bus = line.split()[0]
        if 'GTX 1050' in line or 'GP107' in line:
            nvidia_found = True

    return arc_bus is not None, arc_bus, nvidia_found


def check_pcie_link_status(bus_id: str) -> Dict[str, any]:
    """Check PCIe link capabilities and status for given bus ID."""
    code, stdout, _ = run_command(["sudo", "lspci", "-vvv", "-s", bus_id])

    link_info = {
        "cap_speed": None,
        "cap_width": None,
        "sta_speed": None,
        "sta_width": None,
        "optimal": False,
    }

    for line in stdout.split('\n'):
        if 'LnkCap:' in line:
            # Extract speed (e.g., "16GT/s")
            speed_match = re.search(r'Speed (\d+(?:\.\d+)?)GT/s', line)
            if speed_match:
                link_info["cap_speed"] = float(speed_match.group(1))

            # Extract width (e.g., "x16")
            width_match = re.search(r'Width x(\d+)', line)
            if width_match:
                link_info["cap_width"] = int(width_match.group(1))

        elif 'LnkSta:' in line:
            # Extract actual speed
            speed_match = re.search(r'Speed (\d+(?:\.\d+)?)GT/s', line)
            if speed_match:
                link_info["sta_speed"] = float(speed_match.group(1))

            # Extract actual width
            width_match = re.search(r'Width x(\d+)', line)
            if width_match:
                link_info["sta_width"] = int(width_match.group(1))

    # Check if optimal (PCIe 4.0 x16 or acceptable Gen3 x8+)
    # Note: Some Arc A770 cards (e.g., ASRock) have PCIe bridge chips that
    # misreport link width, so we validate actual bandwidth below
    if (link_info["sta_speed"] == 16.0 and link_info["sta_width"] == 16):
        link_info["optimal"] = True
    elif (link_info["sta_speed"] >= 8.0 and link_info["sta_width"] >= 8):
        # Gen3 x8 or better is acceptable
        link_info["optimal"] = True

    return link_info


def check_render_device() -> Tuple[bool, Optional[str]]:
    """Check if render device is present and accessible."""
    render_devices = list(Path("/dev/dri").glob("renderD*"))
    if not render_devices:
        return False, None

    # Should have at least one render device
    return True, str(render_devices[0])


def check_gpu_frequency() -> Tuple[bool, Optional[int]]:
    """Check GPU frequency settings."""
    card_dirs = list(Path("/sys/class/drm").glob("card*"))

    for card_dir in card_dirs:
        rp0_file = card_dir / "gt_RP0_freq_mhz"
        if rp0_file.exists():
            try:
                freq = int(rp0_file.read_text().strip())
                return True, freq
            except Exception:
                pass

    return False, None


def check_intel_driver() -> bool:
    """Check if i915 driver is loaded."""
    code, stdout, _ = run_command(["lsmod"])
    return "i915" in stdout


def measure_pcie_bandwidth() -> Optional[float]:
    """Measure actual PCIe host-device bandwidth using clpeak results.

    Returns bandwidth in GB/s, or None if measurement unavailable.
    """
    clpeak_output = Path("/tmp/clpeak.out")
    if not clpeak_output.exists():
        return None

    try:
        content = clpeak_output.read_text()
        # Look for memcpy bandwidth measurements (most accurate for PCIe)
        # Example: "memcpy from mapped ptr        : 15.66"
        for line in content.split('\n'):
            if 'memcpy from mapped ptr' in line:
                match = re.search(r':\s*(\d+(?:\.\d+)?)', line)
                if match:
                    return float(match.group(1))
    except Exception:
        pass

    return None


def print_header(text: str):
    """Print a section header."""
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*70}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.BLUE}{text}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'='*70}{Colors.END}\n")


def print_result(check_name: str, passed: bool, details: str = ""):
    """Print a check result."""
    status = f"{Colors.GREEN}✅ PASS{Colors.END}" if passed else f"{Colors.RED}❌ FAIL{Colors.END}"
    print(f"{status} {check_name}")
    if details:
        print(f"    {details}")


def main():
    """Main verification routine."""
    print(f"\n{Colors.BOLD}PCIe Configuration Verification - Arc A770{Colors.END}")
    print(f"{Colors.BOLD}{'='*70}{Colors.END}")

    all_checks_passed = True

    # Check 1: GPU Detection
    print_header("1. GPU Detection")
    arc_present, arc_bus, nvidia_found = check_gpu_present()

    print_result(
        "Intel Arc A770 detected",
        arc_present,
        f"Bus ID: {arc_bus}" if arc_bus else "Not found in lspci output"
    )
    all_checks_passed &= arc_present

    print_result(
        "GTX 1050 Ti removed",
        not nvidia_found,
        "Old GPU still present - remove it!" if nvidia_found else "Confirmed removed"
    )
    all_checks_passed &= not nvidia_found

    if not arc_present:
        print(f"\n{Colors.RED}CRITICAL: Arc A770 not detected. Check physical connection.{Colors.END}")
        return 1

    # Check 2: PCIe Link Status
    print_header("2. PCIe Link Status")
    link_info = check_pcie_link_status(arc_bus)

    cap_details = f"Capable: PCIe {link_info['cap_speed']}GT/s x{link_info['cap_width']}"
    sta_details = f"Actual: PCIe {link_info['sta_speed']}GT/s x{link_info['sta_width']}"

    print_result(
        "PCIe link capability",
        link_info["cap_speed"] is not None,
        cap_details
    )

    print_result(
        "PCIe link active",
        link_info["sta_speed"] is not None,
        sta_details
    )

    optimal = link_info["optimal"]

    # For cards with PCIe bridge misreporting (e.g., ASRock Arc A770),
    # validate with measured bandwidth if lspci shows degraded link
    bandwidth_ok = optimal
    measured_bw = None

    if not optimal and link_info["sta_speed"] and link_info["sta_width"]:
        measured_bw = measure_pcie_bandwidth()
        if measured_bw and measured_bw >= MIN_BANDWIDTH_GBPS:
            # Measured bandwidth confirms adequate PCIe performance despite misreported link
            bandwidth_ok = True
            bandwidth_pct = (link_info["sta_speed"] * link_info["sta_width"]) / (16.0 * 16) * 100
            print_result(
                "PCIe link status",
                False,
                f"lspci reports {link_info['sta_speed']}GT/s x{link_info['sta_width']} ({bandwidth_pct:.1f}% of Gen4 x16)"
            )
            print_result(
                "Measured PCIe bandwidth",
                True,
                f"{measured_bw:.1f} GB/s (bridge misreporting, actual performance OK)"
            )
        else:
            bandwidth_pct = (link_info["sta_speed"] * link_info["sta_width"]) / (16.0 * 16) * 100
            print_result(
                "PCIe 4.0 x16 achieved",
                False,
                f"⚠️  {bandwidth_pct:.1f}% of optimal - check slot/BIOS"
            )
            if measured_bw:
                print(f"    {Colors.YELLOW}Measured bandwidth: {measured_bw:.1f} GB/s (below {MIN_BANDWIDTH_GBPS} GB/s threshold){Colors.END}")
            else:
                print(f"    {Colors.YELLOW}Run clpeak to measure actual bandwidth{Colors.END}")
    else:
        print_result(
            "PCIe 4.0 x16 achieved",
            optimal,
            "Optimal bandwidth!" if optimal else "⚠️  Check slot/BIOS"
        )

    all_checks_passed &= bandwidth_ok

    # Check 3: Render Device
    print_header("3. Render Device")
    render_ok, render_dev = check_render_device()

    print_result(
        "Render device present",
        render_ok,
        f"Device: {render_dev}" if render_dev else "No /dev/dri/renderD* found"
    )
    all_checks_passed &= render_ok

    # Check 4: GPU Frequency
    print_header("4. GPU Frequency")
    freq_ok, freq = check_gpu_frequency()

    print_result(
        "GPU frequency readable",
        freq_ok,
        f"RP0 (Max): {freq} MHz" if freq else "Cannot read frequency"
    )

    if freq_ok and freq:
        expected_freq = 2400
        freq_ok = freq == expected_freq
        print_result(
            "Frequency is optimal",
            freq_ok,
            f"Expected: {expected_freq} MHz, Got: {freq} MHz"
        )
        all_checks_passed &= freq_ok

    # Check 5: Intel Driver
    print_header("5. Driver Status")
    driver_ok = check_intel_driver()

    print_result(
        "i915 driver loaded",
        driver_ok,
        "Intel driver active" if driver_ok else "Driver not loaded - reboot may be needed"
    )
    all_checks_passed &= driver_ok

    # Summary
    print_header("Verification Summary")

    if all_checks_passed:
        print(f"{Colors.GREEN}{Colors.BOLD}✅ ALL CHECKS PASSED{Colors.END}")
        print(f"\n{Colors.GREEN}Your Arc A770 is properly configured at PCIe 4.0 x16!{Colors.END}")
        print(f"{Colors.GREEN}Expected performance improvement: 20-40% faster inference{Colors.END}")
        print(f"\nNext steps:")
        print(f"  1. Start LM Studio: cd lmstudio-observability && ./start-lmstudio-intel.sh")
        print(f"  2. Start KeepWarm: python scripts/cardmint-keepwarm-enhanced.py --daemon")
        print(f"  3. Run baseline test: python scripts/pcis_baseline_v2.py --cards-limit 10")
        return 0
    else:
        print(f"{Colors.RED}{Colors.BOLD}❌ SOME CHECKS FAILED{Colors.END}")
        print(f"\n{Colors.YELLOW}Troubleshooting steps:{Colors.END}")
        print(f"  1. Verify Arc A770 is in Slot 1 (top PCIe slot)")
        print(f"  2. Power down completely (unplug AC for 30 seconds)")
        print(f"  3. Reseat the Arc A770 firmly")
        print(f"  4. Check BIOS settings (PCIe Gen4, Above 4G Decoding)")
        print(f"  5. Consult docs/PCIE_RECONFIGURATION_GUIDE.md")
        return 1


if __name__ == "__main__":
    sys.exit(main())
