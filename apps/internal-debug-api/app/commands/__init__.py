"""
Command registry and dispatch for Internal Debug API.

Provides a decorator-based command registration system with per-command
argument validation using Pydantic models.
"""

import asyncio
import logging
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable, Coroutine, Optional, Type

import httpx
from pydantic import BaseModel, ValidationError

from ..config import Settings
from ..db import DatabaseManager
from ..rate_limit import RateLimiter

logger = logging.getLogger(__name__)

# Type alias for async command handlers
CommandHandler = Callable[..., Coroutine[Any, Any, dict[str, Any]]]


@dataclass
class CommandContext:
    """
    Context passed to command handlers.

    Contains all dependencies needed for command execution.
    """

    db: DatabaseManager
    http_client: httpx.AsyncClient
    settings: Settings
    rate_limiter: RateLimiter


@dataclass
class CommandEntry:
    """Registry entry for a command."""

    handler: CommandHandler
    args_model: Optional[Type[BaseModel]]
    description: str


# Global command registry
_REGISTRY: dict[str, CommandEntry] = {}


def register_command(
    name: str,
    args_model: Optional[Type[BaseModel]] = None,
    description: str = "",
):
    """
    Decorator to register a command handler.

    Usage:
        @register_command("db.check_schema", DbCheckSchemaArgs, "Verify schema")
        async def cmd_db_check_schema(args: DbCheckSchemaArgs, ctx: CommandContext):
            ...

    Args:
        name: Command name (e.g., "db.check_schema")
        args_model: Optional Pydantic model for argument validation
        description: Human-readable description

    Returns:
        Decorator function
    """

    def decorator(fn: CommandHandler) -> CommandHandler:
        _REGISTRY[name] = CommandEntry(
            handler=fn,
            args_model=args_model,
            description=description or fn.__doc__ or "",
        )

        @wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
            return await fn(*args, **kwargs)

        return wrapper

    return decorator


def get_command(name: str) -> Optional[CommandEntry]:
    """
    Look up a command by name.

    Args:
        name: Command name

    Returns:
        CommandEntry if found, None otherwise
    """
    return _REGISTRY.get(name)


def list_commands() -> list[str]:
    """
    Get sorted list of all registered command names.

    Returns:
        List of command names
    """
    return sorted(_REGISTRY.keys())


def get_command_info() -> list[dict[str, Any]]:
    """
    Get information about all registered commands.

    Returns:
        List of command info dicts with name, description, and args_schema
    """
    result = []
    for name, entry in sorted(_REGISTRY.items()):
        info = {
            "name": name,
            "description": entry.description,
            "has_args": entry.args_model is not None,
        }
        if entry.args_model:
            # Include JSON schema for args
            info["args_schema"] = entry.args_model.model_json_schema()
        result.append(info)
    return result


class CommandError(Exception):
    """Base exception for command errors."""

    pass


class UnknownCommandError(CommandError):
    """Raised when command is not in registry."""

    pass


class ValidationError_(CommandError):
    """Raised when command arguments fail validation."""

    pass


class TimeoutError_(CommandError):
    """Raised when command exceeds timeout."""

    pass


async def dispatch_command(
    name: str,
    raw_args: dict[str, Any],
    ctx: CommandContext,
    timeout_sec: float,
) -> dict[str, Any]:
    """
    Dispatch a command by name with validated arguments.

    Args:
        name: Command name
        raw_args: Raw argument dictionary from request
        ctx: Command context with dependencies
        timeout_sec: Maximum execution time in seconds

    Returns:
        Command result dictionary

    Raises:
        UnknownCommandError: Command not registered
        ValidationError_: Arguments failed validation
        TimeoutError_: Command exceeded timeout
        Exception: Other command execution errors
    """
    entry = get_command(name)
    if entry is None:
        raise UnknownCommandError(f"Unknown command: {name}")

    # Validate arguments if model provided
    validated_args: Any = None
    if entry.args_model is not None:
        try:
            validated_args = entry.args_model(**raw_args)
        except ValidationError as e:
            raise ValidationError_(f"Argument validation failed: {e}")
    else:
        # No validation, pass raw args
        validated_args = raw_args

    # Execute with timeout
    try:
        if entry.args_model is not None:
            # Pass validated Pydantic model
            result = await asyncio.wait_for(
                entry.handler(validated_args, ctx),
                timeout=timeout_sec,
            )
        else:
            # Pass raw dict
            result = await asyncio.wait_for(
                entry.handler(validated_args, ctx),
                timeout=timeout_sec,
            )
        return result

    except asyncio.TimeoutError:
        raise TimeoutError_(f"Command '{name}' timed out after {timeout_sec}s")


# Import command modules to trigger registration
# This must be at the bottom to avoid circular imports
from . import db as _db_commands  # noqa: F401, E402
from . import evershop as _evershop_commands  # noqa: F401, E402
from . import logs as _logs_commands  # noqa: F401, E402
