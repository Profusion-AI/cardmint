"""
PII and secret sanitization for Internal Debug API.

Provides recursive redaction of sensitive data from outputs before returning
to clients. No customer data or secrets should ever leave this API unredacted.
"""

import re
from typing import Any

# Redaction marker
REDACTED = "[REDACTED]"

# Patterns for sensitive data
# Order matters - more specific patterns should come first
REDACTION_PATTERNS = {
    # API keys and tokens (generic patterns)
    "bearer_token": re.compile(r"Bearer\s+[\w.-]{10,}", re.IGNORECASE),
    "authorization_header": re.compile(
        r"(?i)(authorization|x-api-key|api[_-]?key)\s*[:=]\s*['\"]?[\w.-]{10,}['\"]?"
    ),

    # JWT tokens (three base64 segments separated by dots)
    "jwt": re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"),

    # Database connection strings
    "postgres_uri": re.compile(
        r"postgres(?:ql)?://[^\s@]+:[^\s@]+@[^\s]+", re.IGNORECASE
    ),
    "generic_db_uri": re.compile(
        r"(?:mysql|mongodb|redis)://[^\s@]+:[^\s@]+@[^\s]+", re.IGNORECASE
    ),

    # Secrets in key=value format
    "secret_assignment": re.compile(
        r"(?i)(password|secret|token|api[_-]?key|private[_-]?key)\s*[=:]\s*['\"]?[^\s'\"]{8,}['\"]?"
    ),

    # Email addresses (customer PII)
    "email": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),

    # Phone numbers (US format - customer PII)
    "phone_us": re.compile(r"\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"),

    # Credit card numbers (should never appear, but safety net)
    "credit_card": re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b"),

    # SSH private keys
    "ssh_key": re.compile(r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----"),

    # IP addresses - mask last octet for privacy while keeping debug utility
    # This is handled separately to preserve partial information
}

# Keys that should have their values redacted entirely
SENSITIVE_KEYS = {
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
    "privatekey",
    "authorization",
    "auth",
    "credential",
    "credentials",
    "access_token",
    "refresh_token",
    "bearer",
    "stripe_key",
    "webhook_secret",
}


def mask_ip_address(ip: str) -> str:
    """Mask the last octet of an IP address for privacy."""
    parts = ip.split(".")
    if len(parts) == 4:
        return f"{parts[0]}.{parts[1]}.{parts[2]}.xxx"
    return ip


def redact_string(value: str, mask_ips: bool = True) -> str:
    """
    Apply redaction patterns to a string value.

    Args:
        value: String to redact
        mask_ips: Whether to mask IP addresses (default True)

    Returns:
        Redacted string
    """
    if not value or not isinstance(value, str):
        return value

    result = value

    # Apply pattern-based redaction
    for pattern in REDACTION_PATTERNS.values():
        result = pattern.sub(REDACTED, result)

    # Mask IP addresses (preserve structure but hide last octet)
    if mask_ips:
        ip_pattern = re.compile(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})\b")
        result = ip_pattern.sub(r"\1.xxx", result)

    return result


def is_sensitive_key(key: str) -> bool:
    """Check if a dictionary key is sensitive and should have its value redacted."""
    if not isinstance(key, str):
        return False
    key_lower = key.lower().replace("-", "_")
    return any(sensitive in key_lower for sensitive in SENSITIVE_KEYS)


def redact_value(value: Any, mask_ips: bool = True) -> Any:
    """
    Recursively redact sensitive data from a value.

    Handles dicts, lists, and strings. Other types pass through unchanged.

    Args:
        value: Value to redact (dict, list, str, or other)
        mask_ips: Whether to mask IP addresses

    Returns:
        Redacted value with same structure
    """
    if isinstance(value, str):
        return redact_string(value, mask_ips)

    elif isinstance(value, dict):
        result = {}
        for k, v in value.items():
            if is_sensitive_key(k):
                # Redact entire value for sensitive keys
                result[k] = REDACTED
            else:
                # Recurse for non-sensitive keys
                result[k] = redact_value(v, mask_ips)
        return result

    elif isinstance(value, list):
        return [redact_value(item, mask_ips) for item in value]

    elif isinstance(value, tuple):
        return tuple(redact_value(item, mask_ips) for item in value)

    # Pass through numbers, booleans, None, etc.
    return value


def sanitize_output(output: dict, mask_ips: bool = True) -> dict:
    """
    Sanitize command output before returning to client.

    This is the main entry point for output sanitization.

    Args:
        output: Command output dictionary
        mask_ips: Whether to mask IP addresses

    Returns:
        Sanitized output dictionary
    """
    return redact_value(output, mask_ips)


def redact_log_line(line: str) -> str:
    """
    Redact a single log line.

    More aggressive redaction for log content which may contain
    arbitrary user data.

    Args:
        line: Log line to redact

    Returns:
        Redacted log line
    """
    return redact_string(line, mask_ips=True)
