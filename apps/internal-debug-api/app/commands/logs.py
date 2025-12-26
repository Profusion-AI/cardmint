"""
Log tailing commands for Internal Debug API.

Commands:
- logs.tail: Tail logs from allowlisted sources with PII redaction

Security:
- Uses subprocess with shell=False and explicit argv (no shell injection)
- Log sources map to fixed allowlisted commands/paths (no user interpolation)
- Least-privileged access - no Docker socket exposure or elevated perms
"""

import asyncio
import logging
import subprocess
from typing import Any, Optional

from pydantic import BaseModel, Field

from ..redaction import redact_log_line
from . import CommandContext, register_command

logger = logging.getLogger(__name__)

# Allowlisted log sources - maps source name to source type
# Source types determine how to fetch logs
LOG_SOURCES = {
    "nginx_access": "file",
    "nginx_error": "file",
    "cardmint_backend": "journalctl_or_file",
    "evershop": "file",
    "postgres": "file",
}


class LogsTailArgs(BaseModel):
    """Arguments for logs.tail command."""

    source: str = Field(
        ...,
        description="Log source: nginx_access, nginx_error, cardmint_backend, evershop, postgres",
    )
    lines: int = Field(
        default=50,
        ge=1,
        le=500,
        description="Number of lines to tail (1-500)",
    )
    filter: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Case-insensitive filter pattern (no regex)",
    )


def _validate_filter(filter_str: Optional[str]) -> Optional[str]:
    """
    Validate and sanitize filter string.

    Prevents shell metacharacter injection.
    """
    if not filter_str:
        return None

    # Remove any shell-dangerous characters
    dangerous_chars = ["|", ";", "&", "$", "`", "(", ")", "{", "}", "<", ">", "\\", "\n", "\r"]
    sanitized = filter_str
    for char in dangerous_chars:
        sanitized = sanitized.replace(char, "")

    return sanitized.strip() if sanitized.strip() else None


async def _run_subprocess(
    args: list[str],
    timeout: float,
) -> tuple[bool, str, str]:
    """
    Run subprocess with timeout and return output.

    Uses shell=False and explicit argv for security.
    Terminates subprocess on timeout to avoid orphans.

    Args:
        args: Command arguments (argv)
        timeout: Timeout in seconds

    Returns:
        Tuple of (success, stdout, stderr)
    """
    try:
        # Run in thread pool to not block event loop
        loop = asyncio.get_event_loop()

        def run_blocking() -> tuple[int, str, str]:
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                shell=False,  # SECURITY: No shell
            )
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
                return proc.returncode, stdout, stderr
            except subprocess.TimeoutExpired:
                proc.kill()  # Terminate to avoid orphan
                proc.wait()
                raise

        returncode, stdout, stderr = await asyncio.wait_for(
            loop.run_in_executor(None, run_blocking),
            timeout=timeout + 1,  # Extra second for cleanup
        )

        return returncode == 0, stdout, stderr

    except asyncio.TimeoutError:
        return False, "", "Command timed out"
    except FileNotFoundError as e:
        return False, "", f"Command not found: {e}"
    except Exception as e:
        return False, "", f"Subprocess error: {str(e)}"


@register_command(
    "logs.tail",
    LogsTailArgs,
    "Tail logs from allowlisted sources with PII redaction",
)
async def cmd_logs_tail(
    args: LogsTailArgs,
    ctx: CommandContext,
) -> dict[str, Any]:
    """
    Tail logs from an allowlisted log source.

    Only predefined log sources can be accessed:
    - nginx_access: Nginx access log
    - nginx_error: Nginx error log
    - cardmint_backend: CardMint backend service (journalctl or file)
    - evershop: EverShop Docker container logs
    - postgres: PostgreSQL Docker container logs

    All output is redacted for PII (emails, IPs, tokens, etc.).
    """
    if args.source not in LOG_SOURCES:
        return {
            "success": False,
            "error": f"Unknown log source: {args.source}",
            "available_sources": list(LOG_SOURCES.keys()),
        }

    source_type = LOG_SOURCES[args.source]
    sanitized_filter = _validate_filter(args.filter)
    timeout = ctx.settings.command_timeout_sec
    max_lines = min(args.lines, ctx.settings.max_log_lines)

    # Build command based on source type
    command_args: list[str] = []
    source_description = ""

    if source_type == "file":
        # File-based log sources - route by source name
        path: str = ""
        hint: str = ""

        if args.source == "nginx_access":
            path = ctx.settings.log_source_nginx_access
            hint = "Set LOG_SOURCE_NGINX_ACCESS"
        elif args.source == "nginx_error":
            path = ctx.settings.log_source_nginx_error
            hint = "Set LOG_SOURCE_NGINX_ERROR"
        elif args.source == "evershop":
            path = ctx.settings.log_source_evershop_file
            hint = "Set LOG_SOURCE_EVERSHOP_FILE"
        elif args.source == "postgres":
            path = ctx.settings.log_source_postgres_file
            hint = "Set LOG_SOURCE_POSTGRES_FILE"
        else:
            return {"success": False, "error": f"Unknown file source: {args.source}"}

        if not path:
            return {
                "success": False,
                "error": f"Log source not configured: {args.source}",
                "hint": hint,
            }

        command_args = ["tail", "-n", str(max_lines), path]
        source_description = f"file:{path}"

    elif source_type == "journalctl_or_file":
        # CardMint backend - try file first, fall back to journalctl
        backend_source = ctx.settings.log_source_cardmint_backend

        if not backend_source:
            return {
                "success": False,
                "error": "CardMint backend log source not configured",
                "note": "Set LOG_SOURCE_CARDMINT_BACKEND to file path or journalctl unit name",
            }

        if backend_source.startswith("/"):
            # File path
            command_args = ["tail", "-n", str(max_lines), backend_source]
            source_description = f"file:{backend_source}"
        else:
            # journalctl unit name
            command_args = [
                "journalctl",
                "-u", backend_source,
                "-n", str(max_lines),
                "--no-pager",
                "-o", "short",
            ]
            source_description = f"journalctl:{backend_source}"

    else:
        return {"success": False, "error": f"Unknown source type: {source_type}"}

    # Execute command
    success, stdout, stderr = await _run_subprocess(command_args, timeout)

    if not success:
        error_msg = stderr or "Command failed"
        # Don't expose full error in response, log it server-side
        logger.warning(
            f"Log tail failed for {args.source}",
            extra={"command": command_args[0], "error": error_msg[:200]},
        )
        return {
            "success": False,
            "error": "Failed to read log source",
            "source": args.source,
            "hint": "Check if log source exists and is accessible",
        }

    # Process output - docker logs may go to stderr
    raw_output = stdout or stderr
    raw_lines = raw_output.splitlines()

    # Apply filter if provided
    if sanitized_filter:
        filter_lower = sanitized_filter.lower()
        raw_lines = [line for line in raw_lines if filter_lower in line.lower()]

    # Limit to requested lines (in case source returned more)
    raw_lines = raw_lines[-max_lines:]

    # Redact PII from each line
    redacted_lines = [redact_log_line(line) for line in raw_lines]

    return {
        "success": True,
        "source": args.source,
        "source_type": source_type,
        "lines_requested": args.lines,
        "lines_returned": len(redacted_lines),
        "filter_applied": sanitized_filter,
        "content": redacted_lines,
    }
