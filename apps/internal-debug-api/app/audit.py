"""
Structured audit logging for Internal Debug API.

All command executions are logged with:
- Timestamp (Unix + ISO 8601)
- Request ID for correlation
- Command name and category
- Actor identification (IP)
- Status and timing
- Additional context

Logs go to the 'audit' logger, which can be configured to write to
a dedicated audit log file in production.
"""

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

# Dedicated audit logger
_AUDIT_LOGGER = logging.getLogger("audit")


def audit_event(
    event_type: str,
    request_id: str,
    command: str,
    actor: str,
    status: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Log an audit event.

    Args:
        event_type: Event category (e.g., "command", "auth_failure")
        request_id: Unique request identifier
        command: Command name being executed
        actor: Identifier for who made the request (usually IP)
        status: Result status (ok, error, denied, rate_limited, timeout)
        extra: Additional context (redacted as needed)
    """
    now = time.time()

    payload = {
        "ts": int(now),
        "iso_ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        "event": event_type,
        "request_id": request_id,
        "command": command,
        "command_category": command.split(".")[0] if "." in command else "general",
        "actor": actor,
        "status": status,
    }

    if extra:
        # Merge extra fields, avoiding overwrites of core fields
        for key, value in extra.items():
            if key not in payload:
                payload[key] = value
            else:
                # Nest under 'extra' to avoid conflicts
                if "extra" not in payload:
                    payload["extra"] = {}
                payload["extra"][key] = value

    _AUDIT_LOGGER.info(json.dumps(payload, sort_keys=True, default=str))


def audit_auth_failure(
    request_id: str,
    actor: str,
    reason: str,
) -> None:
    """
    Log an authentication/authorization failure.

    Args:
        request_id: Unique request identifier
        actor: IP address or identifier
        reason: Failure reason (e.g., "invalid_token", "ip_blocked")
    """
    audit_event(
        event_type="auth_failure",
        request_id=request_id,
        command="",
        actor=actor,
        status="denied",
        extra={"reason": reason},
    )


def audit_rate_limit(
    request_id: str,
    command: str,
    actor: str,
) -> None:
    """
    Log a rate limit event.

    Args:
        request_id: Unique request identifier
        command: Command that was rate limited
        actor: IP address or identifier
    """
    audit_event(
        event_type="rate_limit",
        request_id=request_id,
        command=command,
        actor=actor,
        status="rate_limited",
    )


def audit_command_success(
    request_id: str,
    command: str,
    actor: str,
    execution_ms: int,
    dry_run: bool = False,
) -> None:
    """
    Log a successful command execution.

    Args:
        request_id: Unique request identifier
        command: Command that was executed
        actor: IP address or identifier
        execution_ms: Execution time in milliseconds
        dry_run: Whether this was a dry run
    """
    audit_event(
        event_type="command",
        request_id=request_id,
        command=command,
        actor=actor,
        status="ok",
        extra={
            "execution_ms": execution_ms,
            "dry_run": dry_run,
        },
    )


def audit_command_error(
    request_id: str,
    command: str,
    actor: str,
    error_type: str,
    error_message: Optional[str] = None,
) -> None:
    """
    Log a command execution error.

    Args:
        request_id: Unique request identifier
        command: Command that failed
        actor: IP address or identifier
        error_type: Error category (e.g., "timeout", "database_error")
        error_message: Optional error message (should be sanitized)
    """
    extra = {"error_type": error_type}
    if error_message:
        # Truncate long error messages
        extra["error_message"] = error_message[:200]

    audit_event(
        event_type="command",
        request_id=request_id,
        command=command,
        actor=actor,
        status="error",
        extra=extra,
    )
