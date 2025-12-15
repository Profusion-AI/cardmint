#!/usr/bin/env python3
"""CardMint KeepWarm Daemon - Path B (LM Studio) Fallback Readiness.

Updated for Dec 2025 dual-path inference architecture:

INFERENCE ARCHITECTURE:
- Path A (Primary): OpenAI GPT-5 Mini - handles production inference
- Path B (Fallback): LM Studio Mistral - activated only when Path A fails
- Path C (Set Disambiguation): PPT API triangulation - runs after Path A succeeds

KEEPWARM ROLE:
Since Path A (OpenAI) is primary, LM Studio (Path B) is only needed as fallback.
This daemon ensures Path B is ready for failover but no longer requires aggressive
warmup polling. The model stays loaded; we just verify it's responsive.

DEPRECATED (Dec 2025):
- Continuous warmup mode (10s polling) - unnecessary for fallback role
- Activity-based adaptive intervals - Path A handles active workloads
- Aggressive warmup sequences - one startup warmup sufficient for readiness

RETAINED FEATURES:
1. LM Studio process management (launch/detect)
2. API handshake verification on startup
3. Single startup warmup to confirm model is loaded
4. Health check endpoint for monitoring
5. Periodic liveness checks (extended interval)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import List, Optional, Tuple

import psutil

from openai import OpenAI


def _env_int(name: str, default: int) -> int:
    """Parse an integer from the environment with a safe fallback."""
    value = os.environ.get(name)
    if value is None:
        return default

    try:
        return int(value)
    except ValueError:
        return default

# Configuration Constants
# Read from LMSTUDIO_BASE_URL (set in apps/backend/.env) with localhost fallback
DEFAULT_SERVER_URL = os.environ.get("LMSTUDIO_BASE_URL", "http://127.0.0.1:12345").rstrip("/") + "/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# Daemon Configuration (updated Dec 2025 for fallback-only role)
# Since Path A (OpenAI) is primary, LM Studio only needs periodic liveness checks
KEEPWARM_INTERVAL_IDLE = 120        # seconds between liveness checks (was 30s, increased for fallback role)
KEEPWARM_INTERVAL_ACTIVE = 120      # DEPRECATED: same as idle, continuous mode removed
HEALTH_CHECK_PORT = 12346          # TCP port for health checks
STATE_FILE = Path("/tmp/cardmint-keepwarm-enhanced.state")
PID_FILE = Path("/tmp/cardmint-keepwarm-enhanced.pid")
LOG_FILE = Path("/var/log/cardmint-keepwarm-enhanced.log")

# Warmup Configuration
# Only one startup warmup needed to confirm model is loaded and responsive
DEFAULT_STARTUP_WARMUPS = _env_int("CARDMINT_KEEPWARM_STARTUP_WARMUPS", 1)  # Changed from 0 to 1 for fallback readiness
WARMUP_CONTEXT_LENGTH = 512        # Optimized context (reduced from 768)
WARMUP_MAX_TOKENS = 5               # Minimal tokens for warmup
WARMUP_TIMEOUT = 10                 # Timeout for warmup inference
WARMUP_QUALITY_THRESHOLD_MS = 5000  # Expected warmup response time
CONTINUOUS_MODE_THRESHOLD = 999     # DEPRECATED: effectively disabled (was 3)

# Handshake configuration (startup script is responsible for cold start)
SERVER_READY_TIMEOUT = _env_int("CARDMINT_KEEPWARM_HANDSHAKE_TIMEOUT", 300)
SERVER_POLL_INTERVAL = 3

# Activity Detection
ACTIVITY_FILE = Path("/tmp/cardmint_inference_activity")
ACTIVITY_WINDOW = 60                # Consider activity recent if within 60s
LM_STUDIO_LOG = Path("/var/log/lm-studio.log")  # Optional log monitoring

# LM Studio launch configuration
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
LMSTUDIO_AUTOLAUNCH_ENABLED = os.environ.get("CARDMINT_LMSTUDIO_AUTOLAUNCH", "1").lower() not in {"0", "false", "no"}
LMSTUDIO_STARTUP_DELAY = max(0, _env_int("CARDMINT_LMSTUDIO_STARTUP_DELAY", 5))
LMSTUDIO_COMMAND = os.environ.get("CARDMINT_LMSTUDIO_COMMAND")
LMSTUDIO_APPIMAGE = os.environ.get(
    "CARDMINT_LMSTUDIO_APPIMAGE",
    str(Path.home() / "Downloads/LM-Studio-0.3.27-1-x64.AppImage"),
)
LMSTUDIO_LAUNCHER = os.environ.get(
    "CARDMINT_LMSTUDIO_LAUNCHER",
    str(REPO_ROOT / "lmstudio-observability" / "start-lmstudio-intel.sh"),
)
LMSTUDIO_PROCESS_MATCHES = ("lm-studio", "lmstudio", "lm studio", "lms server", "lms ")
LMSTUDIO_STOP_STATUSES = {
    psutil.STATUS_STOPPED,
    psutil.STATUS_ZOMBIE,
    psutil.STATUS_DEAD,
}
if hasattr(psutil, "STATUS_TRACING_STOP"):
    LMSTUDIO_STOP_STATUSES.add(psutil.STATUS_TRACING_STOP)


def _lmstudio_process_pid() -> Optional[int]:
    """Return the PID of a running LM Studio process if present.

    Only returns PIDs of processes that are actually running (not stopped/zombie).
    """
    for proc in psutil.process_iter(["pid", "name", "cmdline", "status"]):
        try:
            name = (proc.info.get("name") or "").lower()
            cmdline = " ".join(proc.info.get("cmdline") or []).lower()
            status = proc.info.get("status")
            pid = proc.info["pid"]

            # Skip stopped, zombie, or dead processes
            if status in LMSTUDIO_STOP_STATUSES:
                continue

            # Check for LM Studio GUI process
            if any(match in name for match in LMSTUDIO_PROCESS_MATCHES):
                return pid
            if any(match in cmdline for match in LMSTUDIO_PROCESS_MATCHES):
                return pid

            # Also check for lms CLI server (used by systemd service)
            if "lms" in name and "server" in cmdline:
                return pid

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return None


def _resolve_lmstudio_command() -> List[str]:
    """Resolve the command used to launch LM Studio."""
    if LMSTUDIO_COMMAND:
        parts = shlex.split(LMSTUDIO_COMMAND)
        if parts:
            return parts

    launcher_path = Path(LMSTUDIO_LAUNCHER).expanduser()
    if launcher_path.is_file() and os.access(launcher_path, os.X_OK):
        return [str(launcher_path)]

    if LMSTUDIO_APPIMAGE:
        appimage_path = Path(LMSTUDIO_APPIMAGE).expanduser()
        if appimage_path.is_file() and os.access(appimage_path, os.X_OK):
            return [str(appimage_path)]

    cli_path = shutil.which("lmstudio")
    if cli_path:
        return [cli_path]

    return []


def _format_command(command: List[str]) -> str:
    """Return a human-readable command string."""
    return " ".join(shlex.quote(part) for part in command)


class EnhancedKeepWarmDaemon:
    """Path B (LM Studio) Fallback Readiness Daemon.

    Updated Dec 2025: With Path A (OpenAI) as primary and Path C (PPT) for
    set disambiguation, this daemon's role is simplified to ensuring Path B
    fallback readiness. Continuous warmup polling is deprecated.
    """

    def __init__(self, *, continuous_mode: bool = False, startup_warmups: int = DEFAULT_STARTUP_WARMUPS):
        self.client: Optional[OpenAI] = None
        self.running = False
        self.health_server: Optional[socket.socket] = None

        # Configuration (continuous_mode deprecated but kept for backwards compatibility)
        self.continuous_mode_enabled = continuous_mode  # DEPRECATED: no-op in Dec 2025
        self.startup_warmups = max(1, startup_warmups)  # Minimum 1 for fallback readiness
        self.current_interval = KEEPWARM_INTERVAL_IDLE  # Fixed interval, no longer adaptive
        self.slow_warmup_count = 0
        self.last_warmup_time_ms = 0
        self.auto_launched = False
        self.launched_pid: Optional[int] = None

        self.stats = {
            "start_time": 0,
            "warmup_count": 0,
            "startup_warmups": 0,
            "startup_warmup_target": self.startup_warmups,
            "quality_warmups": 0,  # Warmups meeting quality threshold
            "slow_warmups": 0,      # Warmups exceeding threshold
            "continuous_activations": 0,
            "last_warmup": 0,
            "errors": 0,
            "last_error": None,
            "model_ready": False,
            "avg_warmup_time_ms": 0,
            "min_warmup_time_ms": float('inf'),
            "max_warmup_time_ms": 0
        }

        # Warmup time tracking
        self.warmup_times: List[float] = []

        # Setup logging
        self.setup_logging()
        self.logger = logging.getLogger("keepwarm-enhanced")

    def setup_logging(self):
        """Configure production logging."""
        log_format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"

        try:
            LOG_FILE.parent.mkdir(exist_ok=True)
            logging.basicConfig(
                level=logging.INFO,
                format=log_format,
                handlers=[
                    logging.FileHandler(LOG_FILE),
                    logging.StreamHandler(sys.stdout)
                ]
            )
        except PermissionError:
            # Fall back to console only
            logging.basicConfig(
                level=logging.INFO,
                format=log_format,
                handlers=[logging.StreamHandler(sys.stdout)]
            )

    def ensure_lmstudio_running(self) -> bool:
        """Ensure LM Studio is running, launching it if necessary."""
        # Check for stopped/zombie processes first and warn about them
        stopped_pids = []
        for proc in psutil.process_iter(["pid", "name", "cmdline", "status"]):
            try:
                name = (proc.info.get("name") or "").lower()
                cmdline = " ".join(proc.info.get("cmdline") or []).lower()
                status = proc.info.get("status")

                # Check if this is a LM Studio process
                is_lmstudio = (
                    any(match in name for match in LMSTUDIO_PROCESS_MATCHES) or
                    any(match in cmdline for match in LMSTUDIO_PROCESS_MATCHES) or
                    ("lms" in name and "server" in cmdline)
                )

                # If it's LM Studio but stopped/zombie, track it
                if is_lmstudio and status in LMSTUDIO_STOP_STATUSES:
                    stopped_pids.append((proc.info["pid"], status))

            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

        # Warn about stopped processes
        if stopped_pids:
            self.logger.warning(
                "⚠️  Found %d stopped/zombie LM Studio process(es): %s",
                len(stopped_pids),
                ", ".join(f"PID {pid} ({status})" for pid, status in stopped_pids)
            )
            self.logger.warning("   These processes are frozen and cannot serve API requests")
            self.logger.warning("   Run 'npm run dev:cleanup' to clean them up")

        # Now check for a RUNNING LM Studio process
        existing_pid = _lmstudio_process_pid()
        if existing_pid is not None:
            self.logger.info("✅ LM Studio already running (PID: %s)", existing_pid)
            self.launched_pid = existing_pid

            # Check if it was started via systemd
            try:
                proc = psutil.Process(existing_pid)
                cmdline = " ".join(proc.cmdline())
                if "lms server" in cmdline or "lmstudio.service" in cmdline:
                    self.logger.info("   Detected systemd-managed LM Studio service")
            except Exception:
                pass

            return True

        if not LMSTUDIO_AUTOLAUNCH_ENABLED:
            self.logger.error(
                "❌ LM Studio is not running and auto-launch is disabled. "
                "Either start it via 'systemctl --user start lmstudio.service' "
                "or set CARDMINT_LMSTUDIO_AUTOLAUNCH=1 to enable auto-launch."
            )
            if stopped_pids:
                self.logger.error("   (Note: Found stopped LM Studio processes - run 'npm run dev:cleanup')")
            return False

        command = _resolve_lmstudio_command()
        if not command:
            self.logger.error(
                "LM Studio is not running and no launch command was found. Configure CARDMINT_LMSTUDIO_COMMAND or CARDMINT_LMSTUDIO_APPIMAGE."
            )
            return False

        self.logger.info("Starting LM Studio via: %s", _format_command(command))

        try:
            launch_path = Path(command[0]).expanduser()
        except Exception:
            launch_path = None

        try:
            if launch_path and launch_path.suffix == ".sh":
                subprocess.run(command, check=True)
            else:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    preexec_fn=os.setsid,
                )
                self.launched_pid = process.pid
            self.auto_launched = True

            if LMSTUDIO_STARTUP_DELAY:
                self.logger.info(
                    "Waiting %ss for LM Studio to expose the inference endpoint",
                    LMSTUDIO_STARTUP_DELAY,
                )
                time.sleep(LMSTUDIO_STARTUP_DELAY)

            confirmed_pid = _lmstudio_process_pid()
            if confirmed_pid is not None:
                self.launched_pid = confirmed_pid
                self.logger.info("LM Studio launch confirmed (PID: %s)", confirmed_pid)
            else:
                self.logger.warning("LM Studio PID not detected after launch attempt; proceeding with handshake retries")

            return True
        except FileNotFoundError:
            self.logger.error("LM Studio launch command not found: %s", command[0])
        except subprocess.CalledProcessError as exc:
            self.logger.error("LM Studio launcher exited with status %s", exc.returncode)
        except Exception as exc:
            self.logger.error("Failed to launch LM Studio: %s", exc)

        return False

    def initialize_client(self) -> bool:
        """Initialize OpenAI client with retry logic."""
        self.client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
        deadline = time.time() + SERVER_READY_TIMEOUT
        attempt = 0
        last_error: Optional[Exception] = None

        while time.time() < deadline:
            attempt += 1
            try:
                # Startup script is responsible for full model load; we only need the API handshake
                self.client.models.list()
                self.logger.info(
                    "✅ LM Studio API handshake successful after %s attempt(s)", attempt
                )
                self.stats["model_ready"] = True
                return True
            except Exception as exc:
                last_error = exc
                remaining = max(0, int(deadline - time.time()))
                self.logger.warning(
                    "LM Studio not ready yet (%s). Retrying in %ss (time left: %ss)",
                    exc,
                    SERVER_POLL_INTERVAL,
                    remaining,
                )
                time.sleep(SERVER_POLL_INTERVAL)

        self.logger.error(
            "Timed out waiting for LM Studio handshake after %ss: %s",
            SERVER_READY_TIMEOUT,
            last_error,
        )
        return False

    def perform_warmup(self, sequence_number: int = 1, total_sequences: int = 1) -> float:
        """Execute single warmup inference and return timing in ms.

        Returns:
            Warmup time in milliseconds, or -1 on failure
        """
        if not self.client:
            self.logger.error("Client not initialized, cannot perform warmup")
            return -1

        warmup_prompt = f"Warmup {sequence_number}/{total_sequences}: Identify Pokemon card"

        try:
            start_time = time.perf_counter()

            response = self.client.chat.completions.create(
                model=DEFAULT_MODEL_ID,
                messages=[
                    {"role": "system", "content": "Pokemon card identifier. Return JSON."},
                    {"role": "user", "content": warmup_prompt}
                ],
                temperature=0,
                max_tokens=WARMUP_MAX_TOKENS,
                timeout=WARMUP_TIMEOUT,
                extra_body={"context_length": WARMUP_CONTEXT_LENGTH}
            )

            warmup_time_ms = (time.perf_counter() - start_time) * 1000

            # Track timing statistics
            self.warmup_times.append(warmup_time_ms)
            if len(self.warmup_times) > 100:  # Keep last 100 warmups
                self.warmup_times.pop(0)

            # Update statistics
            self.stats["warmup_count"] += 1
            self.stats["last_warmup"] = time.time()
            self.stats["avg_warmup_time_ms"] = sum(self.warmup_times) / len(self.warmup_times)
            self.stats["min_warmup_time_ms"] = min(self.stats["min_warmup_time_ms"], warmup_time_ms)
            self.stats["max_warmup_time_ms"] = max(self.stats["max_warmup_time_ms"], warmup_time_ms)

            # Check warmup quality
            if warmup_time_ms <= WARMUP_QUALITY_THRESHOLD_MS:
                self.stats["quality_warmups"] += 1
                quality_indicator = "✓"
            else:
                self.stats["slow_warmups"] += 1
                self.slow_warmup_count += 1
                quality_indicator = "⚠️"

            self.logger.info(f"Warmup {sequence_number}/{total_sequences} completed in {warmup_time_ms:.1f}ms {quality_indicator}")

            # Adaptive interval based on warmup quality
            if self.slow_warmup_count >= CONTINUOUS_MODE_THRESHOLD:
                self.logger.warning(f"Switching to continuous mode after {self.slow_warmup_count} slow warmups")
                self.current_interval = KEEPWARM_INTERVAL_ACTIVE
                self.stats["continuous_activations"] += 1
                self.slow_warmup_count = 0  # Reset counter

            return warmup_time_ms

        except Exception as e:
            self.stats["errors"] += 1
            self.stats["last_error"] = str(e)
            self.logger.error(f"Warmup failed: {e}")
            return -1

    def perform_startup_warmup(self):
        """Execute enhanced startup warmup sequence."""
        if self.startup_warmups <= 0:
            return

        self.logger.info(
            "🚀 Performing %sx startup warmup sequence (post-handshake validation)",
            self.startup_warmups,
        )

        successful_warmups = 0
        total_time_ms = 0

        for i in range(self.startup_warmups):
            warmup_time = self.perform_warmup(i + 1, self.startup_warmups)
            if warmup_time > 0:
                successful_warmups += 1
                total_time_ms += warmup_time
                self.stats["startup_warmups"] += 1

            # Brief pause between warmups
            if i < self.startup_warmups - 1:
                time.sleep(1)

        if successful_warmups > 0:
            avg_time = total_time_ms / successful_warmups
            self.logger.info(f"✅ Startup warmup complete: {successful_warmups}/{self.startup_warmups} successful, "
                           f"avg {avg_time:.1f}ms")
        else:
            self.logger.error("❌ All startup warmups failed")

    def detect_activity(self) -> bool:
        """DEPRECATED: Activity detection no longer used for Path B fallback role.

        With Path A (OpenAI) as primary, LM Studio activity is only triggered
        when Path A fails. We don't need to detect activity for adaptive polling.
        """
        # Always return False - adaptive polling is deprecated
        return False

    def update_interval(self):
        """DEPRECATED: Adaptive interval no longer used for Path B fallback role.

        The interval is now fixed at KEEPWARM_INTERVAL_IDLE (120s) since
        aggressive warmup polling is unnecessary for fallback readiness.
        """
        # No-op: interval stays fixed at KEEPWARM_INTERVAL_IDLE
        pass

    def health_check_handler(self, client_socket: socket.socket):
        """Handle health check requests."""
        try:
            # Calculate last warmup age for compatibility with daemon_integration.py
            last_warmup_age = time.time() - self.stats["last_warmup"] if self.stats["last_warmup"] > 0 else 999

            health_data = {
                "status": "healthy" if self.stats["model_ready"] else "initializing",
                "uptime_seconds": int(time.time() - self.stats["start_time"]),
                "warmup_count": self.stats["warmup_count"],
                "last_warmup_age": last_warmup_age,  # Required by daemon_integration.py
                "quality_rate": (self.stats["quality_warmups"] / max(1, self.stats["warmup_count"])) * 100,
                "avg_warmup_ms": self.stats["avg_warmup_time_ms"],
                "current_interval": self.current_interval,
                "continuous_mode": self.continuous_mode_enabled,
                "errors": self.stats["errors"],
                "startup_warmup_target": self.stats.get("startup_warmup_target", 0)
            }

            response = json.dumps(health_data) + "\n"
            client_socket.sendall(response.encode())

        except Exception as e:
            self.logger.error(f"Health check error: {e}")
        finally:
            client_socket.close()

    def start_health_server(self):
        """Start TCP health check server."""
        try:
            self.health_server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.health_server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.health_server.bind(("127.0.0.1", HEALTH_CHECK_PORT))
            self.health_server.listen(5)
            self.health_server.settimeout(1.0)

            self.logger.info(f"Health check server listening on port {HEALTH_CHECK_PORT}")

            while self.running:
                try:
                    client_socket, _ = self.health_server.accept()
                    threading.Thread(target=self.health_check_handler, args=(client_socket,)).start()
                except socket.timeout:
                    continue
                except Exception as e:
                    if self.running:
                        self.logger.error(f"Health server error: {e}")

        except Exception as e:
            self.logger.error(f"Failed to start health server: {e}")

    def cleanup(self):
        """Clean shutdown."""
        self.running = False

        if self.health_server:
            try:
                self.health_server.close()
            except:
                pass

        # Remove PID file
        try:
            PID_FILE.unlink()
        except:
            pass

        # Save final state
        try:
            with STATE_FILE.open("w") as f:
                json.dump(self.stats, f, indent=2)
        except:
            pass

    def signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully."""
        self.logger.info(f"Received signal {signum}, shutting down...")
        self.cleanup()
        sys.exit(0)

    def run(self):
        """Main daemon loop."""
        self.stats["start_time"] = time.time()
        self.running = True

        # Setup signal handlers
        signal.signal(signal.SIGTERM, self.signal_handler)
        signal.signal(signal.SIGINT, self.signal_handler)

        # Check if another daemon is already running
        existing_pid, source = resolve_daemon_pid()
        if existing_pid is not None and existing_pid != os.getpid():
            try:
                # Check if it's actually alive
                if psutil.pid_exists(existing_pid):
                    self.logger.error(
                        f"Another keepwarm daemon is already running (PID: {existing_pid}, source: {source})"
                    )
                    self.logger.error("Use --stop to terminate the existing daemon first")
                    return 1
            except Exception:
                pass

        # Write PID file
        try:
            with PID_FILE.open("w") as f:
                f.write(str(os.getpid()))
        except Exception as e:
            self.logger.error(f"Failed to write PID file: {e}")
            return 1

        self.logger.info("🚀 CardMint Path B Fallback Daemon starting...")
        self.logger.info("   Role: Ensure LM Studio ready for Path A failover")
        self.logger.info("   Startup warmups: %s", self.startup_warmups)
        self.logger.info(f"   Liveness interval: {KEEPWARM_INTERVAL_IDLE}s")
        self.logger.info("   Note: Path A (OpenAI) is primary; Path C (PPT) handles set disambiguation")

        if not self.ensure_lmstudio_running():
            self.logger.error("Failed to ensure LM Studio is running, exiting")
            self.cleanup()
            return 1

        if self.auto_launched and self.startup_warmups < 1:
            self.logger.info("Auto-launched LM Studio detected; running one startup warmup to load the model")
            self.startup_warmups = 1
            self.stats["startup_warmup_target"] = self.startup_warmups

        # Initialize client
        if not self.initialize_client():
            self.logger.error("Failed to initialize client, exiting")
            self.cleanup()
            return 1

        # Perform startup warmup
        self.perform_startup_warmup()

        # Start health server in background
        health_thread = threading.Thread(target=self.start_health_server, daemon=True)
        health_thread.start()

        # Main liveness loop (simplified for fallback role)
        self.logger.info(f"✅ Path B fallback ready, starting liveness monitoring ({KEEPWARM_INTERVAL_IDLE}s interval)")

        while self.running:
            try:
                # Periodic liveness check (no adaptive interval needed for fallback role)
                warmup_time = self.perform_warmup()
                self.last_warmup_time_ms = warmup_time

                # Sleep until next liveness check
                time.sleep(self.current_interval)

            except KeyboardInterrupt:
                self.logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                self.logger.error(f"Unexpected error in main loop: {e}")
                self.stats["errors"] += 1
                time.sleep(5)  # Brief pause before retry

        # Cleanup
        self.cleanup()

        # Final statistics
        uptime = time.time() - self.stats["start_time"]
        self.logger.info(f"Daemon stopped. Uptime: {uptime:.1f}s, Warmups: {self.stats['warmup_count']}, "
                        f"Quality rate: {(self.stats['quality_warmups']/max(1, self.stats['warmup_count']))*100:.1f}%")

        return 0


def check_daemon_status() -> bool:
    """Check if Path B fallback daemon is running."""
    pid, source = resolve_daemon_pid()

    if pid is None:
        print("❌ Path B fallback daemon not running")
        return False

    if source == "recovered":
        print(f"⚠️  PID file missing or stale; discovered running daemon (PID: {pid})")

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        sock.connect(("127.0.0.1", HEALTH_CHECK_PORT))
        sock.sendall(b"health\n")
        response = sock.recv(4096).decode()
        sock.close()

        health_data = json.loads(response)
        print(f"✅ Path B fallback daemon running (PID: {pid})")
        print(f"   Status: {health_data['status']}")
        print(f"   Role: LM Studio fallback readiness for Path A failover")
        print(f"   Uptime: {health_data['uptime_seconds']}s")
        print(f"   Liveness checks: {health_data['warmup_count']}")
        print(f"   Avg response: {health_data['avg_warmup_ms']:.1f}ms")
        print(f"   Interval: {health_data.get('current_interval', KEEPWARM_INTERVAL_IDLE)}s")
        return True

    except Exception as exc:
        print(f"⚠️  Daemon running but health check failed: {exc}")
        return True


def resolve_daemon_pid() -> Tuple[Optional[int], str]:
    """Resolve daemon PID via PID file or process scan."""
    pid_from_file = read_pid_file()

    if pid_from_file is not None and psutil.pid_exists(pid_from_file):
        return pid_from_file, "pidfile"

    if pid_from_file is not None and PID_FILE.exists():
        try:
            PID_FILE.unlink()
        except OSError:
            pass

    discovered_pid = find_daemon_process()
    if discovered_pid is None:
        return None, "missing"

    try:
        PID_FILE.write_text(str(discovered_pid))
    except OSError:
        pass

    return discovered_pid, "recovered"


def read_pid_file() -> Optional[int]:
    """Read PID from PID file if present."""
    if not PID_FILE.exists():
        return None

    try:
        content = PID_FILE.read_text().strip()
        if not content:
            return None
        return int(content)
    except (OSError, ValueError):
        return None


def find_daemon_process() -> Optional[int]:
    """Locate running daemon process when PID file is unavailable."""
    current_pid = os.getpid()
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = proc.info.get("cmdline") or []
            if proc.pid == current_pid:
                continue

            if "--daemon" not in cmdline:
                continue

            # Accept both enhanced and legacy script names for compatibility
            if not any("cardmint-keepwarm" in arg for arg in cmdline):
                continue

            if not psutil.pid_exists(proc.pid):
                continue

            return proc.pid
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return None


def stop_daemon() -> bool:
    """Stop the Path B fallback daemon."""
    pid, _ = resolve_daemon_pid()

    if pid is None:
        print("Path B fallback daemon not running")
        return True

    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to PID {pid}")

        for _ in range(10):
            time.sleep(0.5)
            if not psutil.pid_exists(pid):
                print("✅ Path B fallback daemon stopped successfully")
                try:
                    if PID_FILE.exists():
                        PID_FILE.unlink()
                except OSError:
                    pass
                return True

        os.kill(pid, signal.SIGKILL)
        print("⚠️  Force killed Path B fallback daemon")
        try:
            if PID_FILE.exists():
                PID_FILE.unlink()
        except OSError:
            pass
        return True

    except Exception as exc:
        print(f"Error stopping daemon: {exc}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="CardMint Path B Fallback Daemon - ensures LM Studio ready for Path A failover"
    )
    parser.add_argument("--daemon", action="store_true", help="Run as daemon")
    parser.add_argument("--check", action="store_true", help="Check daemon status")
    parser.add_argument("--stop", action="store_true", help="Stop daemon")
    parser.add_argument(
        "--continuous",
        action="store_true",
        help="DEPRECATED: no-op (continuous mode removed in Dec 2025 for Path B fallback role)"
    )
    parser.add_argument(
        "--startup-warmups",
        type=int,
        default=DEFAULT_STARTUP_WARMUPS,
        help=(
            "Number of startup warmups to confirm model is loaded (default 1 for fallback readiness). "
            "Env: CARDMINT_KEEPWARM_STARTUP_WARMUPS"
        ),
    )
    parser.add_argument(
        "--legacy-triple",
        action="store_true",
        help="DEPRECATED: back-compat flag, kept for script compatibility but no longer recommended.",
    )

    args = parser.parse_args()

    if args.check:
        return 0 if check_daemon_status() else 1

    if args.stop:
        return 0 if stop_daemon() else 1

    if args.daemon:
        startup_warmups = max(0, args.startup_warmups)
        if args.legacy_triple:
            startup_warmups = max(startup_warmups, 3)

        daemon = EnhancedKeepWarmDaemon(
            continuous_mode=args.continuous,
            startup_warmups=startup_warmups
        )
        return daemon.run()

    # Default: show help
    parser.print_help()
    return 0


if __name__ == "__main__":
    exit(main())
