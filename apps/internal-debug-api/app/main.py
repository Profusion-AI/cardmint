"""
CardMint Internal Debug API - FastAPI Application

Provides secure, internal-only diagnostic endpoints for LLM agents to
inspect EverShop schema, execute template-based queries, and tail logs.

Security:
- Bearer token authentication required
- Optional IP allowlist
- Rate limiting per command
- PII redaction on all outputs
- Audit logging for all commands

Usage:
    uvicorn app.main:app --host 127.0.0.1 --port 9010
"""

import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.openapi.utils import get_openapi

from .audit import (
    audit_command_error,
    audit_command_success,
    audit_rate_limit,
)
from .commands import (
    CommandContext,
    TimeoutError_,
    UnknownCommandError,
    ValidationError_,
    dispatch_command,
    get_command_info,
    list_commands,
)
from .config import get_settings
from .db import DatabaseManager
from .models import (
    DebugCommandRequest,
    DebugCommandResponse,
    ErrorCode,
    ErrorDetail,
    HealthResponse,
)
from .rate_limit import (
    RateLimiter,
    get_rate_limit_for_command,
    make_rate_limit_key,
)
from .redaction import sanitize_output
from .security import require_internal_access

# Module-level instances (initialized in lifespan)
settings = get_settings()
db_manager = DatabaseManager(settings)
rate_limiter = RateLimiter()
http_client: httpx.AsyncClient = None  # type: ignore

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan context manager for startup/shutdown.

    Initializes:
    - PostgreSQL connection pool
    - HTTP client for EverShop GraphQL

    Cleans up on shutdown.
    """
    global http_client

    logger.info("Starting Internal Debug API...")

    # Initialize database pool
    try:
        await db_manager.connect()
        logger.info("Database connection pool initialized")
    except Exception as e:
        logger.error(f"Failed to connect to database: {e}")
        # Continue without DB - health check will report degraded

    # Initialize HTTP client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(settings.command_timeout_sec),
    )
    logger.info("HTTP client initialized")

    logger.info(
        f"Internal Debug API started. Commands available: {list_commands()}"
    )

    yield

    # Shutdown
    logger.info("Shutting down Internal Debug API...")

    if http_client:
        await http_client.aclose()
        logger.info("HTTP client closed")

    await db_manager.disconnect()
    logger.info("Database connection pool closed")


# Create FastAPI app with lifespan
app = FastAPI(
    title="CardMint Internal Debug API",
    version="1.0.0",
    description="""
Internal diagnostic API for LLM agents to debug CardMint/EverShop admin UX issues.

## Security
- Bearer token authentication required on all endpoints
- Optional IP allowlist filtering
- Rate limiting per command category

## Available Commands
- `db.check_schema` - Verify cm_* columns exist in EverShop product table
- `db.query_postgres` - Execute template-based queries (no raw SQL)
- `evershop.graphql_test` - Run admin products grid GraphQL query
- `evershop.extension_status` - Report CardMint extension status
- `logs.tail` - Tail logs from allowlisted sources with redaction
    """,
    lifespan=lifespan,
    openapi_tags=[
        {"name": "health", "description": "Health check endpoints"},
        {"name": "commands", "description": "Debug command execution"},
    ],
)


def custom_openapi():
    """
    Customize OpenAPI schema with security scheme and per-command examples.
    """
    if app.openapi_schema:
        return app.openapi_schema

    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )

    # Add security scheme
    openapi_schema["components"]["securitySchemes"] = {
        "BearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "description": "Internal debug token (INTERNAL_DEBUG_TOKEN env var)",
        }
    }

    # Apply security globally
    openapi_schema["security"] = [{"BearerAuth": []}]

    # Add per-command request/response examples to POST /internal/debug/command
    for path_item in openapi_schema.get("paths", {}).values():
        if "post" in path_item:
            post_op = path_item["post"]
            if post_op.get("operationId") == "executeCommand":
                # Add request body examples
                if "requestBody" in post_op:
                    content = post_op["requestBody"].get("content", {})
                    if "application/json" in content:
                        content["application/json"]["examples"] = {
                            "db.check_schema": {
                                "summary": "Check EverShop schema for cm_* columns",
                                "value": {
                                    "command": "db.check_schema",
                                    "args": {},
                                },
                            },
                            "db.query_postgres_product_count": {
                                "summary": "Count products with/without cm_* data",
                                "value": {
                                    "command": "db.query_postgres",
                                    "args": {"template": "product_count"},
                                },
                            },
                            "db.query_postgres_recent": {
                                "summary": "Get recent products",
                                "value": {
                                    "command": "db.query_postgres",
                                    "args": {
                                        "template": "recent_products",
                                        "params": {"limit": 10},
                                    },
                                },
                            },
                            "evershop.graphql_test": {
                                "summary": "Run admin products grid query",
                                "value": {
                                    "command": "evershop.graphql_test",
                                    "args": {"limit": 5},
                                },
                            },
                            "evershop.extension_status": {
                                "summary": "Check CardMint extension installation",
                                "value": {
                                    "command": "evershop.extension_status",
                                    "args": {},
                                },
                            },
                            "logs.tail": {
                                "summary": "Tail nginx access logs",
                                "value": {
                                    "command": "logs.tail",
                                    "args": {
                                        "source": "nginx_access",
                                        "lines": 50,
                                    },
                                },
                            },
                            "logs.tail_filtered": {
                                "summary": "Tail logs with filter",
                                "value": {
                                    "command": "logs.tail",
                                    "args": {
                                        "source": "nginx_error",
                                        "lines": 100,
                                        "filter": "error",
                                    },
                                },
                            },
                        }

                # Add richer response examples
                responses = post_op.get("responses", {})
                if "200" in responses:
                    content = responses["200"].get("content", {})
                    if "application/json" in content:
                        content["application/json"]["examples"] = {
                            "schema_check_success": {
                                "summary": "Schema check passed",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440000",
                                    "status": "ok",
                                    "output": {
                                        "success": True,
                                        "schema_valid": True,
                                        "expected_columns": ["cm_inventory_status", "cm_market_price", "cm_pricing_source", "cm_pricing_status", "cm_pricing_updated_at", "cm_product_uid", "cm_set_name", "cm_variant"],
                                        "found_columns": ["cm_inventory_status", "cm_market_price", "cm_pricing_source", "cm_pricing_status", "cm_pricing_updated_at", "cm_product_uid", "cm_set_name", "cm_variant"],
                                        "missing_columns": [],
                                        "expected_count": 8,
                                        "found_count": 8,
                                    },
                                    "truncated": False,
                                    "execution_ms": 42,
                                },
                            },
                            "product_count": {
                                "summary": "Product count query result",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440001",
                                    "status": "ok",
                                    "output": {
                                        "success": True,
                                        "template": "product_count",
                                        "description": "Count products with/without cm_* data",
                                        "row_count": 1,
                                        "results": [
                                            {"total": 156, "with_cm_data": 142, "without_cm_data": 14}
                                        ],
                                    },
                                    "truncated": False,
                                    "execution_ms": 28,
                                },
                            },
                            "logs_tail": {
                                "summary": "Log tail result",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440002",
                                    "status": "ok",
                                    "output": {
                                        "success": True,
                                        "source": "nginx_access",
                                        "source_type": "file",
                                        "lines_requested": 50,
                                        "lines_returned": 50,
                                        "filter_applied": None,
                                        "content": [
                                            "192.168.1.xxx - - [22/Dec/2025:10:00:00 +0000] \"GET /admin HTTP/1.1\" 200 ...",
                                        ],
                                    },
                                    "truncated": False,
                                    "execution_ms": 85,
                                },
                            },
                            "unknown_command": {
                                "summary": "Unknown command error",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440003",
                                    "status": "error",
                                    "error": {
                                        "code": "UNKNOWN_COMMAND",
                                        "message": "Unknown command: db.invalid",
                                        "details": {
                                            "available_commands": ["db.check_schema", "db.query_postgres", "evershop.graphql_test", "evershop.extension_status", "logs.tail"]
                                        },
                                    },
                                },
                            },
                            "validation_error": {
                                "summary": "Validation error",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440004",
                                    "status": "error",
                                    "error": {
                                        "code": "VALIDATION_ERROR",
                                        "message": "Invalid arguments: 1 validation error for LogsTailArgs\nlines\n  Input should be less than or equal to 500 [type=less_than_equal, input_value=1000]",
                                    },
                                },
                            },
                            "database_error": {
                                "summary": "Database error",
                                "value": {
                                    "request_id": "550e8400-e29b-41d4-a716-446655440005",
                                    "status": "error",
                                    "error": {
                                        "code": "DATABASE_ERROR",
                                        "message": "Database query failed: connection refused",
                                        "details": {
                                            "output": {"success": False, "error": "connection refused"}
                                        },
                                    },
                                },
                            },
                        }

    app.openapi_schema = openapi_schema
    return app.openapi_schema


app.openapi = custom_openapi


def _resolve_client_ip(request: Request) -> str:
    client_ip = request.client.host if request.client else "unknown"
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for and client_ip in settings.trusted_proxies_set:
        client_ip = forwarded_for.split(",")[0].strip()
    return client_ip


def _map_command_error_code(command: str) -> ErrorCode:
    if command.startswith("db."):
        return ErrorCode.DATABASE_ERROR
    if command.startswith("evershop."):
        return ErrorCode.EVERSHOP_ERROR
    if command.startswith("logs."):
        return ErrorCode.LOG_ACCESS_ERROR
    return ErrorCode.INTERNAL_ERROR


@app.get(
    "/internal/debug/health",
    response_model=HealthResponse,
    operation_id="getHealth",
    tags=["health"],
    summary="Health check",
    description="Verify API is running and check database connectivity.",
    responses={
        200: {
            "description": "Health status",
            "content": {
                "application/json": {
                    "example": {
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
                }
            },
        }
    },
)
async def health(
    _auth: None = Depends(require_internal_access),
) -> HealthResponse:
    """
    Health check endpoint.

    Returns service status, database connectivity, and available commands.
    """
    db_healthy = await db_manager.health_check()

    return HealthResponse(
        status="ok" if db_healthy else "degraded",
        database="connected" if db_healthy else "disconnected",
        available_commands=list_commands(),
    )


@app.get(
    "/internal/debug/commands",
    operation_id="listCommands",
    tags=["commands"],
    summary="List available commands",
    description="Get detailed information about all registered commands.",
)
async def list_commands_endpoint(
    _auth: None = Depends(require_internal_access),
) -> Dict[str, Any]:
    """
    List all available commands with their schemas.
    """
    return {
        "commands": get_command_info(),
    }


@app.post(
    "/internal/debug/command",
    response_model=DebugCommandResponse,
    operation_id="executeCommand",
    tags=["commands"],
    summary="Execute debug command",
    description="Execute a registered debug command with arguments.",
    responses={
        200: {
            "description": "Command result (success or error)",
            "content": {
                "application/json": {
                    "examples": {
                        "success": {
                            "summary": "Successful command",
                            "value": {
                                "request_id": "550e8400-e29b-41d4-a716-446655440000",
                                "status": "ok",
                                "output": {"schema_valid": True},
                                "truncated": False,
                                "execution_ms": 42,
                            },
                        },
                        "error": {
                            "summary": "Command error",
                            "value": {
                                "request_id": "550e8400-e29b-41d4-a716-446655440001",
                                "status": "error",
                                "error": {
                                    "code": "UNKNOWN_COMMAND",
                                    "message": "Unknown command: db.invalid",
                                },
                            },
                        },
                    }
                }
            },
        },
        429: {"description": "Rate limited"},
    },
)
async def execute_command(
    request: DebugCommandRequest,
    http_request: Request,
    _auth: None = Depends(require_internal_access),
) -> DebugCommandResponse:
    """
    Execute a debug command.

    Commands are dispatched to registered handlers with validated arguments.
    All output is sanitized for PII before returning.
    """
    request_id = str(uuid.uuid4())
    client_ip = _resolve_client_ip(http_request)

    actor = client_ip
    start_time = time.time()

    # Rate limiting
    limit = get_rate_limit_for_command(request.command, settings)
    rate_key = make_rate_limit_key(request.command, client_ip)
    allowed, remaining = rate_limiter.check(rate_key, limit)

    if not allowed:
        audit_rate_limit(request_id, request.command, actor)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMITED",
                "message": f"Rate limit exceeded for command '{request.command}'",
            },
            headers={"X-RateLimit-Remaining": "0"},
        )

    # Build command context
    ctx = CommandContext(
        db=db_manager,
        http_client=http_client,
        settings=settings,
        rate_limiter=rate_limiter,
    )

    try:
        # Dispatch command
        output = await dispatch_command(
            request.command,
            request.args,
            ctx,
            timeout_sec=settings.command_timeout_sec,
        )

        # Sanitize output
        output = sanitize_output(output)

        # Normalize command-level failures to typed error responses
        if isinstance(output, dict) and output.get("success") is False:
            error_message = str(output.get("error") or "Command failed")
            execution_ms = int((time.time() - start_time) * 1000)
            audit_command_error(
                request_id=request_id,
                command=request.command,
                actor=actor,
                error_type="command_failed",
                error_message=error_message,
            )
            return DebugCommandResponse(
                request_id=request_id,
                status="error",
                error=ErrorDetail(
                    code=_map_command_error_code(request.command),
                    message=error_message,
                    details={
                        "output": output,
                    },
                ),
                execution_ms=execution_ms,
            )

        # Check output size
        output_json = json.dumps(output, default=str)
        truncated = False
        if len(output_json) > settings.max_output_bytes:
            output = {
                "message": "[OUTPUT TRUNCATED]",
                "original_size_bytes": len(output_json),
                "max_size_bytes": settings.max_output_bytes,
            }
            truncated = True

        execution_ms = int((time.time() - start_time) * 1000)

        audit_command_success(
            request_id=request_id,
            command=request.command,
            actor=actor,
            execution_ms=execution_ms,
            dry_run=request.dry_run,
        )

        return DebugCommandResponse(
            request_id=request_id,
            status="ok",
            output=output,
            truncated=truncated,
            execution_ms=execution_ms,
        )

    except UnknownCommandError as e:
        audit_command_error(
            request_id=request_id,
            command=request.command,
            actor=actor,
            error_type="unknown_command",
        )
        return DebugCommandResponse(
            request_id=request_id,
            status="error",
            error=ErrorDetail(
                code=ErrorCode.UNKNOWN_COMMAND,
                message=str(e),
                details={"available_commands": list_commands()},
            ),
        )

    except ValidationError_ as e:
        audit_command_error(
            request_id=request_id,
            command=request.command,
            actor=actor,
            error_type="validation_error",
            error_message=str(e),
        )
        return DebugCommandResponse(
            request_id=request_id,
            status="error",
            error=ErrorDetail(
                code=ErrorCode.VALIDATION_ERROR,
                message=str(e),
            ),
        )

    except TimeoutError_ as e:
        audit_command_error(
            request_id=request_id,
            command=request.command,
            actor=actor,
            error_type="timeout",
        )
        return DebugCommandResponse(
            request_id=request_id,
            status="error",
            error=ErrorDetail(
                code=ErrorCode.TIMEOUT,
                message=str(e),
            ),
        )

    except Exception as exc:
        # Log full traceback server-side only
        logger.exception(f"Command '{request.command}' failed unexpectedly")

        audit_command_error(
            request_id=request_id,
            command=request.command,
            actor=actor,
            error_type=type(exc).__name__,
        )

        return DebugCommandResponse(
            request_id=request_id,
            status="error",
            error=ErrorDetail(
                code=ErrorCode.INTERNAL_ERROR,
                message="Command execution failed",
            ),
        )
