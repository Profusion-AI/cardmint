"""
Security middleware for Internal Debug API.

Provides:
- Bearer token authentication
- Optional IP allowlist filtering
- Structured error responses for auth failures
"""

from typing import Optional, Set

from fastapi import Header, HTTPException, Request, status

from .config import get_settings


def _require_token(authorization: Optional[str]) -> None:
    """
    Validate Bearer token from Authorization header.

    Args:
        authorization: Authorization header value

    Raises:
        HTTPException: 500 if token not configured
        HTTPException: 401 if token missing
        HTTPException: 403 if token invalid
    """
    settings = get_settings()
    expected_token = settings.internal_debug_token

    if not expected_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "code": "CONFIG_ERROR",
                "message": "INTERNAL_DEBUG_TOKEN is not configured",
            },
        )

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "AUTH_ERROR",
                "message": "Missing Authorization header",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "AUTH_ERROR",
                "message": "Invalid Authorization header format. Expected: Bearer <token>",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )

    provided_token = authorization[7:]  # Strip "Bearer " prefix

    if provided_token != expected_token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "AUTH_ERROR",
                "message": "Invalid token",
            },
        )


def _require_ip_allowlist(request: Request) -> None:
    """
    Check if client IP is in allowlist (if configured).

    Empty allowlist means no IP filtering (all IPs allowed).

    Args:
        request: FastAPI request object

    Raises:
        HTTPException: 403 if IP not in allowlist
    """
    settings = get_settings()
    allowlist: Set[str] = settings.allowed_ips_set

    if not allowlist:
        # No allowlist configured - allow all IPs
        return

    client_ip = request.client.host if request.client else ""

    # Only honor X-Forwarded-For if request came from a trusted proxy
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for and client_ip in settings.trusted_proxies_set:
        client_ip = forwarded_for.split(",")[0].strip()

    if client_ip not in allowlist:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "AUTH_ERROR",
                "message": "IP address not allowed",
            },
        )


def require_internal_access(
    request: Request,
    authorization: Optional[str] = Header(None),
) -> None:
    """
    FastAPI dependency for internal access control.

    Validates:
    1. Bearer token is present and valid
    2. Client IP is in allowlist (if configured)

    Usage:
        @app.get("/internal/debug/health")
        def health(_auth: None = Depends(require_internal_access)):
            ...

    Args:
        request: FastAPI request object
        authorization: Authorization header value

    Raises:
        HTTPException: On auth failure
    """
    _require_token(authorization)
    _require_ip_allowlist(request)
