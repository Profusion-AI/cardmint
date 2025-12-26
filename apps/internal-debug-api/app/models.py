"""
Pydantic models for Internal Debug API request/response schemas.

Provides typed models for:
- Command requests with validation
- Structured responses with error codes
- OpenAPI schema generation
"""

from enum import Enum
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class ErrorCode(str, Enum):
    """
    Typed error codes for command failures.

    These appear in the response body, not as HTTP status codes.
    Allows agents to programmatically handle specific error types.
    """

    UNKNOWN_COMMAND = "UNKNOWN_COMMAND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    RATE_LIMITED = "RATE_LIMITED"
    TIMEOUT = "TIMEOUT"
    DATABASE_ERROR = "DATABASE_ERROR"
    EVERSHOP_ERROR = "EVERSHOP_ERROR"
    LOG_ACCESS_ERROR = "LOG_ACCESS_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    AUTH_ERROR = "AUTH_ERROR"
    CONFIG_ERROR = "CONFIG_ERROR"


class ErrorDetail(BaseModel):
    """
    Structured error information.

    Provides machine-readable error code plus human-readable message.
    Optional details field for additional context.
    """

    code: ErrorCode = Field(
        ...,
        description="Machine-readable error code",
    )
    message: str = Field(
        ...,
        description="Human-readable error message",
    )
    details: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Additional error context (e.g., available commands, validation errors)",
    )


class DebugCommandRequest(BaseModel):
    """
    Request model for POST /internal/debug/command.

    The command field determines which handler is invoked.
    Args are validated per-command using dedicated Pydantic models.
    """

    command: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="Command name (e.g., 'db.check_schema', 'evershop.graphql_test')",
        json_schema_extra={
            "examples": [
                "db.check_schema",
                "db.query_postgres",
                "evershop.graphql_test",
                "evershop.extension_status",
                "logs.tail",
            ]
        },
    )
    args: Dict[str, Any] = Field(
        default_factory=dict,
        description="Command-specific arguments (validated per-command)",
        json_schema_extra={
            "examples": [
                {},
                {"template": "product_count"},
                {"limit": 5},
                {"source": "nginx_access", "lines": 100},
            ]
        },
    )
    dry_run: bool = Field(
        default=False,
        description="Preview mode - logs command but doesn't execute (reserved for future use)",
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "command": "db.check_schema",
                    "args": {},
                },
                {
                    "command": "db.query_postgres",
                    "args": {"template": "cm_field_population"},
                },
                {
                    "command": "evershop.graphql_test",
                    "args": {"limit": 5},
                },
                {
                    "command": "logs.tail",
                    "args": {"source": "nginx_access", "lines": 50},
                },
            ]
        }
    }


class DebugCommandResponse(BaseModel):
    """
    Response model for POST /internal/debug/command.

    Provides consistent structure for both success and error cases.
    """

    request_id: str = Field(
        ...,
        description="Unique request identifier for audit correlation",
    )
    status: Literal["ok", "error"] = Field(
        ...,
        description="Overall request status",
    )
    output: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Command output (present on success)",
    )
    error: Optional[ErrorDetail] = Field(
        default=None,
        description="Error details (present on failure)",
    )
    truncated: bool = Field(
        default=False,
        description="True if output was truncated due to size limits",
    )
    execution_ms: Optional[int] = Field(
        default=None,
        description="Command execution time in milliseconds",
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "request_id": "550e8400-e29b-41d4-a716-446655440000",
                    "status": "ok",
                    "output": {
                        "success": True,
                        "schema_valid": True,
                        "found_columns": ["cm_set_name", "cm_variant"],
                    },
                    "truncated": False,
                    "execution_ms": 42,
                },
                {
                    "request_id": "550e8400-e29b-41d4-a716-446655440001",
                    "status": "error",
                    "error": {
                        "code": "UNKNOWN_COMMAND",
                        "message": "Unknown command: db.invalid",
                        "details": {
                            "available_commands": [
                                "db.check_schema",
                                "db.query_postgres",
                            ]
                        },
                    },
                },
            ]
        }
    }


class HealthResponse(BaseModel):
    """
    Response model for GET /internal/debug/health.

    Reports service and dependency health status.
    """

    status: Literal["ok", "degraded", "error"] = Field(
        ...,
        description="Overall health status",
    )
    database: Literal["connected", "disconnected"] = Field(
        ...,
        description="PostgreSQL connection status",
    )
    available_commands: list[str] = Field(
        ...,
        description="List of registered command names",
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "status": "ok",
                    "database": "connected",
                    "available_commands": [
                        "db.check_schema",
                        "db.query_postgres",
                        "evershop.graphql_test",
                        "evershop.extension_status",
                        "logs.tail",
                    ],
                }
            ]
        }
    }
