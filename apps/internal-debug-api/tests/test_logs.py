"""
Tests for logs.tail command.

Tests file-based log tailing, subprocess execution, filter sanitization,
and PII redaction.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.commands.logs import (
    LOG_SOURCES,
    LogsTailArgs,
    _validate_filter,
    cmd_logs_tail,
)


class TestValidateFilter:
    """Tests for filter sanitization."""

    def test_allows_simple_string(self):
        assert _validate_filter("error") == "error"

    def test_allows_alphanumeric(self):
        assert _validate_filter("ERROR404") == "ERROR404"

    def test_allows_spaces(self):
        assert _validate_filter("connection error") == "connection error"

    def test_strips_shell_pipe(self):
        result = _validate_filter("foo | bar")
        assert "|" not in result

    def test_strips_semicolon(self):
        result = _validate_filter("foo; rm -rf /")
        assert ";" not in result

    def test_strips_backticks(self):
        result = _validate_filter("foo`whoami`")
        assert "`" not in result

    def test_strips_dollar_sign(self):
        result = _validate_filter("$HOME")
        assert "$" not in result

    def test_strips_ampersand(self):
        result = _validate_filter("foo && bar")
        assert "&" not in result

    def test_empty_string_returns_none(self):
        assert _validate_filter("") is None

    def test_none_returns_none(self):
        assert _validate_filter(None) is None

    def test_only_dangerous_chars_returns_none(self):
        result = _validate_filter("|;&$`")
        # All characters stripped, result is empty or None
        assert result is None or result == ""


class TestLogsTailArgs:
    """Tests for argument validation."""

    def test_valid_args(self):
        args = LogsTailArgs(source="nginx_access", lines=50)
        assert args.source == "nginx_access"
        assert args.lines == 50

    def test_default_lines(self):
        args = LogsTailArgs(source="nginx_error")
        assert args.lines == 50

    def test_max_lines_enforced(self):
        with pytest.raises(ValueError):
            LogsTailArgs(source="nginx_access", lines=1000)

    def test_min_lines_enforced(self):
        with pytest.raises(ValueError):
            LogsTailArgs(source="nginx_access", lines=0)

    def test_filter_max_length(self):
        # 100 chars is allowed
        args = LogsTailArgs(source="nginx_access", filter="x" * 100)
        assert len(args.filter) == 100

        # >100 chars should fail
        with pytest.raises(ValueError):
            LogsTailArgs(source="nginx_access", filter="x" * 101)


class TestCmdLogsTail:
    """Tests for logs.tail command execution."""

    @pytest.fixture
    def mock_context(self, mock_settings):
        ctx = MagicMock()
        ctx.settings = mock_settings
        ctx.settings.command_timeout_sec = 10
        ctx.settings.max_log_lines = 500
        ctx.settings.log_source_nginx_access = "/var/log/nginx/access.log"
        ctx.settings.log_source_nginx_error = "/var/log/nginx/error.log"
        ctx.settings.log_source_cardmint_backend = "/var/log/cardmint/backend.log"
        ctx.settings.log_source_evershop_file = "/var/log/evershop/stdout.log"
        ctx.settings.log_source_postgres_file = "/var/log/postgres/postgres.log"
        return ctx

    @pytest.mark.asyncio
    async def test_unknown_source_returns_error(self, mock_context):
        """Unknown source should return error with available sources."""
        args = LogsTailArgs(source="unknown_source")

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is False
        assert "unknown_source" in result["error"].lower()
        assert "available_sources" in result
        assert "nginx_access" in result["available_sources"]

    @pytest.mark.asyncio
    async def test_unconfigured_source_returns_error(self, mock_context):
        """Source without configured path should return error."""
        mock_context.settings.log_source_nginx_access = ""
        args = LogsTailArgs(source="nginx_access")

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is False
        assert "not configured" in result["error"]

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_successful_tail(self, mock_subprocess, mock_context):
        """Successful tail should return redacted lines."""
        mock_subprocess.return_value = (
            True,
            "192.168.1.100 - - [22/Dec/2025:10:00:00] GET /admin\n"
            "10.0.0.50 - - [22/Dec/2025:10:00:01] POST /api/data\n",
            "",
        )
        args = LogsTailArgs(source="nginx_access", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        assert result["source"] == "nginx_access"
        assert result["lines_returned"] == 2
        # IPs should be redacted
        for line in result["content"]:
            # Last octet should be masked
            assert "192.168.1.xxx" in line or "10.0.0.xxx" in line

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_email_redaction_in_logs(self, mock_subprocess, mock_context):
        """Emails in logs should be redacted."""
        mock_subprocess.return_value = (
            True,
            "User user@example.com logged in from 192.168.1.1\n",
            "",
        )
        args = LogsTailArgs(source="nginx_access", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        # Email should be redacted
        content = result["content"][0]
        assert "user@example.com" not in content

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_filter_applied(self, mock_subprocess, mock_context):
        """Filter should case-insensitively match lines."""
        mock_subprocess.return_value = (
            True,
            "Line 1: Normal request\n"
            "Line 2: ERROR something went wrong\n"
            "Line 3: Another normal request\n"
            "Line 4: error lowercase match\n",
            "",
        )
        args = LogsTailArgs(source="nginx_access", lines=50, filter="error")

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        assert result["filter_applied"] == "error"
        assert result["lines_returned"] == 2

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_subprocess_failure(self, mock_subprocess, mock_context):
        """Subprocess failure should return error."""
        mock_subprocess.return_value = (False, "", "Permission denied")
        args = LogsTailArgs(source="nginx_access", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is False
        assert "Failed to read log source" in result["error"]

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_lines_capped_to_max(self, mock_subprocess, mock_context):
        """Lines should be capped to max_log_lines setting."""
        mock_context.settings.max_log_lines = 100
        mock_subprocess.return_value = (True, "\n".join([f"Line {i}" for i in range(200)]), "")
        args = LogsTailArgs(source="nginx_access", lines=500)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        # Should be capped to 100 (max_log_lines)
        assert result["lines_returned"] <= 100

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_journalctl_source(self, mock_subprocess, mock_context):
        """Backend journalctl source should use correct command."""
        mock_context.settings.log_source_cardmint_backend = "cardmint-backend.service"
        mock_subprocess.return_value = (True, "Jan 01 12:00:00 server systemd[1]: Started\n", "")
        args = LogsTailArgs(source="cardmint_backend", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        # Verify journalctl was called (check the mock call args)
        call_args = mock_subprocess.call_args[0][0]
        assert "journalctl" in call_args
        assert "-u" in call_args
        assert "cardmint-backend.service" in call_args

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_evershop_file_source(self, mock_subprocess, mock_context):
        """Evershop file source should tail the configured file."""
        mock_context.settings.log_source_evershop_file = "/var/log/evershop/stdout.log"
        mock_subprocess.return_value = (
            True,
            "[2025-12-22 10:00:00] info: Request from 192.168.1.100\n"
            "[2025-12-22 10:00:01] info: Response sent\n",
            "",
        )
        args = LogsTailArgs(source="evershop", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        assert result["source"] == "evershop"
        assert result["source_type"] == "file"
        assert result["lines_returned"] == 2
        # Verify tail was called with correct file
        call_args = mock_subprocess.call_args[0][0]
        assert "tail" in call_args
        assert "/var/log/evershop/stdout.log" in call_args

    @pytest.mark.asyncio
    @patch("app.commands.logs._run_subprocess")
    async def test_postgres_file_source(self, mock_subprocess, mock_context):
        """Postgres file source should tail the configured file."""
        mock_context.settings.log_source_postgres_file = "/var/log/postgres/postgres.log"
        mock_subprocess.return_value = (
            True,
            "2025-12-22 10:00:00.000 UTC [1] LOG: database system is ready\n",
            "",
        )
        args = LogsTailArgs(source="postgres", lines=50)

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is True
        assert result["source"] == "postgres"
        assert result["source_type"] == "file"
        # Verify tail was called with correct file
        call_args = mock_subprocess.call_args[0][0]
        assert "tail" in call_args
        assert "/var/log/postgres/postgres.log" in call_args

    @pytest.mark.asyncio
    async def test_evershop_unconfigured_returns_hint(self, mock_context):
        """Unconfigured evershop source should return helpful hint."""
        mock_context.settings.log_source_evershop_file = ""
        args = LogsTailArgs(source="evershop")

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is False
        assert "not configured" in result["error"]
        assert "LOG_SOURCE_EVERSHOP_FILE" in result["hint"]

    @pytest.mark.asyncio
    async def test_postgres_unconfigured_returns_hint(self, mock_context):
        """Unconfigured postgres source should return helpful hint."""
        mock_context.settings.log_source_postgres_file = ""
        args = LogsTailArgs(source="postgres")

        result = await cmd_logs_tail(args, mock_context)

        assert result["success"] is False
        assert "not configured" in result["error"]
        assert "LOG_SOURCE_POSTGRES_FILE" in result["hint"]


class TestLogSources:
    """Tests for log source configuration."""

    def test_all_expected_sources_defined(self):
        expected = ["nginx_access", "nginx_error", "cardmint_backend", "evershop", "postgres"]
        for source in expected:
            assert source in LOG_SOURCES

    def test_sources_have_valid_types(self):
        valid_types = {"file", "journalctl_or_file"}
        for source, source_type in LOG_SOURCES.items():
            assert source_type in valid_types, f"Invalid type for {source}"
