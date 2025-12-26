"""
In-memory rate limiting for Internal Debug API.

Uses a sliding window algorithm to enforce per-command, per-client limits.
State is lost on restart (acceptable for internal debug API).
"""

import time
from collections import defaultdict
from threading import Lock
from typing import Tuple

from .config import Settings


class RateLimiter:
    """
    Sliding window rate limiter.

    Tracks request timestamps per key and enforces limits over a rolling window.
    Thread-safe for concurrent access.
    """

    def __init__(self, window_sec: int = 60):
        """
        Initialize rate limiter.

        Args:
            window_sec: Size of the sliding window in seconds (default 60s = 1 minute)
        """
        self._windows: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()
        self._window_sec = window_sec

    def check(self, key: str, limit: int) -> Tuple[bool, int]:
        """
        Check if a request is allowed and record it if so.

        Args:
            key: Unique key for rate limiting (e.g., "db.check_schema:192.168.1.1")
            limit: Maximum requests allowed in the window

        Returns:
            Tuple of (allowed: bool, remaining: int)
            - allowed: True if request is permitted
            - remaining: Number of requests remaining in window
        """
        now = time.time()
        cutoff = now - self._window_sec

        with self._lock:
            # Clean expired entries
            self._windows[key] = [ts for ts in self._windows[key] if ts > cutoff]

            current_count = len(self._windows[key])

            if current_count >= limit:
                return False, 0

            # Record this request
            self._windows[key].append(now)
            remaining = limit - current_count - 1

            return True, remaining

    def get_remaining(self, key: str, limit: int) -> int:
        """
        Get remaining requests without consuming one.

        Args:
            key: Rate limit key
            limit: Maximum requests allowed

        Returns:
            Number of requests remaining
        """
        now = time.time()
        cutoff = now - self._window_sec

        with self._lock:
            # Clean and count without recording
            valid_timestamps = [ts for ts in self._windows[key] if ts > cutoff]
            self._windows[key] = valid_timestamps
            return max(0, limit - len(valid_timestamps))

    def reset(self, key: str) -> None:
        """
        Reset rate limit for a key (for testing).

        Args:
            key: Rate limit key to reset
        """
        with self._lock:
            self._windows.pop(key, None)

    def reset_all(self) -> None:
        """Reset all rate limits (for testing)."""
        with self._lock:
            self._windows.clear()


def get_rate_limit_for_command(command: str, settings: Settings) -> int:
    """
    Get the rate limit for a command based on its prefix.

    Args:
        command: Command name (e.g., "db.check_schema")
        settings: Application settings

    Returns:
        Rate limit (requests per minute)
    """
    if command.startswith("db."):
        return settings.rate_limit_db_rpm
    elif command.startswith("evershop."):
        return settings.rate_limit_evershop_rpm
    elif command.startswith("logs."):
        return settings.rate_limit_logs_rpm
    else:
        # Default fallback
        return 10


def make_rate_limit_key(command: str, client_ip: str) -> str:
    """
    Create a rate limit key from command and client IP.

    Args:
        command: Command name
        client_ip: Client IP address

    Returns:
        Rate limit key string
    """
    return f"{command}:{client_ip}"
