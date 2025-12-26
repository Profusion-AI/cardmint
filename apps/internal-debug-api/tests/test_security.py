"""
Tests for security module.
"""

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.security import require_internal_access


class TestRequireInternalAccess:
    def test_valid_token_passes(self):
        """Valid bearer token should pass authentication."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"
        request.headers = {}

        # Should not raise
        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token-12345"
            mock_settings.allowed_ips_set = set()
            mock_get_settings.return_value = mock_settings

            require_internal_access(request, "Bearer test-token-12345")

    def test_missing_token_raises_401(self):
        """Missing Authorization header should raise 401."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"
        request.headers = {}

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = set()
            mock_get_settings.return_value = mock_settings

            with pytest.raises(HTTPException) as exc_info:
                require_internal_access(request, None)

            assert exc_info.value.status_code == 401
            assert "Missing Authorization" in exc_info.value.detail["message"]

    def test_invalid_token_raises_403(self):
        """Invalid token should raise 403."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"
        request.headers = {}

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "correct-token"
            mock_settings.allowed_ips_set = set()
            mock_get_settings.return_value = mock_settings

            with pytest.raises(HTTPException) as exc_info:
                require_internal_access(request, "Bearer wrong-token")

            assert exc_info.value.status_code == 403
            assert "Invalid token" in exc_info.value.detail["message"]

    def test_malformed_auth_header_raises_401(self):
        """Malformed Authorization header should raise 401."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"
        request.headers = {}

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = set()
            mock_get_settings.return_value = mock_settings

            with pytest.raises(HTTPException) as exc_info:
                require_internal_access(request, "Basic dXNlcjpwYXNz")

            assert exc_info.value.status_code == 401
            assert "Bearer" in exc_info.value.detail["message"]

    def test_ip_allowlist_blocks_unauthorized_ip(self):
        """IP not in allowlist should be blocked."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "192.168.1.100"
        request.headers = MagicMock()
        request.headers.get = MagicMock(return_value="")

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = {"127.0.0.1", "10.0.0.1"}
            mock_get_settings.return_value = mock_settings

            with pytest.raises(HTTPException) as exc_info:
                require_internal_access(request, "Bearer test-token")

            assert exc_info.value.status_code == 403
            assert "IP address not allowed" in exc_info.value.detail["message"]

    def test_ip_allowlist_allows_authorized_ip(self):
        """IP in allowlist should be allowed."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "10.0.0.1"
        request.headers = MagicMock()
        request.headers.get = MagicMock(return_value="")

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = {"127.0.0.1", "10.0.0.1"}
            mock_get_settings.return_value = mock_settings

            # Should not raise
            require_internal_access(request, "Bearer test-token")

    def test_empty_allowlist_allows_all(self):
        """Empty allowlist should allow all IPs."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "192.168.1.100"
        request.headers = MagicMock()
        request.headers.get = MagicMock(return_value="")

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = set()  # Empty = allow all
            mock_get_settings.return_value = mock_settings

            # Should not raise
            require_internal_access(request, "Bearer test-token")

    def test_x_forwarded_for_used_when_present(self):
        """X-Forwarded-For header should be used for IP check."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"  # Proxy IP
        request.headers = MagicMock()
        request.headers.get = MagicMock(return_value="192.168.1.100, 10.0.0.1")

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = "test-token"
            mock_settings.allowed_ips_set = {"192.168.1.100"}  # Allow forwarded IP
            mock_settings.trusted_proxies_set = {"127.0.0.1"}  # Trust proxy IP
            mock_get_settings.return_value = mock_settings

            # Should not raise - uses first IP from X-Forwarded-For
            require_internal_access(request, "Bearer test-token")

    def test_unconfigured_token_raises_500(self):
        """Unconfigured token should raise 500."""
        request = MagicMock()
        request.client = MagicMock()
        request.client.host = "127.0.0.1"
        request.headers = {}

        with patch("app.security.get_settings") as mock_get_settings:
            mock_settings = MagicMock()
            mock_settings.internal_debug_token = ""  # Not configured
            mock_settings.allowed_ips_set = set()
            mock_get_settings.return_value = mock_settings

            with pytest.raises(HTTPException) as exc_info:
                require_internal_access(request, "Bearer some-token")

            assert exc_info.value.status_code == 500
            assert "not configured" in exc_info.value.detail["message"]
