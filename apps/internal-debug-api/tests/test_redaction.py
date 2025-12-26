"""
Tests for PII/secret redaction module.
"""

import pytest

from app.redaction import (
    REDACTED,
    is_sensitive_key,
    mask_ip_address,
    redact_log_line,
    redact_string,
    redact_value,
    sanitize_output,
)


class TestMaskIpAddress:
    def test_masks_last_octet(self):
        assert mask_ip_address("192.168.1.100") == "192.168.1.xxx"

    def test_handles_different_ips(self):
        assert mask_ip_address("10.0.0.1") == "10.0.0.xxx"
        assert mask_ip_address("172.16.254.1") == "172.16.254.xxx"

    def test_returns_non_ip_unchanged(self):
        assert mask_ip_address("not-an-ip") == "not-an-ip"


class TestRedactString:
    def test_redacts_email(self):
        result = redact_string("Contact: user@example.com for help")
        assert "user@example.com" not in result
        assert REDACTED in result

    def test_redacts_bearer_token(self):
        result = redact_string("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test")
        assert "Bearer" not in result or REDACTED in result

    def test_redacts_jwt(self):
        jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        result = redact_string(f"Token: {jwt}")
        assert jwt not in result
        assert REDACTED in result

    def test_redacts_postgres_uri(self):
        uri = "postgresql://user:password@localhost:5432/db"
        result = redact_string(f"Connection: {uri}")
        assert uri not in result
        assert REDACTED in result

    def test_redacts_secret_assignments(self):
        result = redact_string("password=supersecret123")
        assert "supersecret123" not in result

    def test_masks_ip_addresses(self):
        result = redact_string("Client IP: 192.168.1.100")
        assert "192.168.1.100" not in result
        assert "192.168.1.xxx" in result

    def test_preserves_safe_content(self):
        safe = "This is a normal log message"
        assert redact_string(safe) == safe


class TestIsSensitiveKey:
    def test_detects_password_key(self):
        assert is_sensitive_key("password") is True
        assert is_sensitive_key("PASSWORD") is True
        assert is_sensitive_key("db_password") is True

    def test_detects_token_key(self):
        assert is_sensitive_key("token") is True
        assert is_sensitive_key("access_token") is True
        assert is_sensitive_key("refresh_token") is True

    def test_detects_api_key(self):
        assert is_sensitive_key("api_key") is True
        assert is_sensitive_key("apikey") is True
        assert is_sensitive_key("api-key") is True

    def test_allows_safe_keys(self):
        assert is_sensitive_key("username") is False
        assert is_sensitive_key("count") is False
        assert is_sensitive_key("status") is False


class TestRedactValue:
    def test_redacts_dict_with_sensitive_keys(self):
        data = {"username": "john", "password": "secret123", "count": 42}
        result = redact_value(data)
        assert result["username"] == "john"
        assert result["password"] == REDACTED
        assert result["count"] == 42

    def test_redacts_nested_dict(self):
        # "credentials" is a sensitive key, so entire value is redacted
        data = {
            "user": {
                "name": "john",
                "credentials": {"api_key": "abc123"},
            }
        }
        result = redact_value(data)
        # credentials is a sensitive key, so entire value becomes REDACTED
        assert result["user"]["credentials"] == REDACTED

    def test_redacts_nested_sensitive_value(self):
        # Nested dict with sensitive key deeper in structure
        data = {
            "config": {
                "database": {
                    "host": "localhost",
                    "password": "secret123",
                }
            }
        }
        result = redact_value(data)
        assert result["config"]["database"]["host"] == "localhost"
        assert result["config"]["database"]["password"] == REDACTED

    def test_redacts_list_items(self):
        data = ["user@example.com", "normal text", "another@email.org"]
        result = redact_value(data)
        assert REDACTED in result[0]
        assert result[1] == "normal text"
        assert REDACTED in result[2]

    def test_preserves_numbers(self):
        data = {"count": 42, "price": 19.99}
        result = redact_value(data)
        assert result["count"] == 42
        assert result["price"] == 19.99

    def test_preserves_booleans(self):
        data = {"active": True, "deleted": False}
        result = redact_value(data)
        assert result["active"] is True
        assert result["deleted"] is False


class TestSanitizeOutput:
    def test_sanitizes_complex_output(self):
        output = {
            "status": "ok",
            "user_email": "Contact user@test.com",
            "config": {
                "api_key": "sk_test_12345678",
                "endpoint": "https://api.example.com",
            },
            "logs": [
                "Request from 192.168.1.50",
                "Normal log entry",
            ],
        }
        result = sanitize_output(output)

        assert result["status"] == "ok"
        assert "user@test.com" not in result["user_email"]
        assert result["config"]["api_key"] == REDACTED
        assert result["config"]["endpoint"] == "https://api.example.com"
        assert "192.168.1.xxx" in result["logs"][0]


class TestRedactLogLine:
    def test_redacts_log_with_email(self):
        line = "2024-01-01 12:00:00 User admin@company.com logged in"
        result = redact_log_line(line)
        assert "admin@company.com" not in result

    def test_redacts_log_with_ip(self):
        line = "Connection from 10.0.0.55 established"
        result = redact_log_line(line)
        assert "10.0.0.55" not in result
        assert "10.0.0.xxx" in result
