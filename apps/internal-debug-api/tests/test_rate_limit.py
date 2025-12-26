"""
Tests for rate limiting module.
"""

import time

import pytest

from app.rate_limit import (
    RateLimiter,
    get_rate_limit_for_command,
    make_rate_limit_key,
)


class TestRateLimiter:
    def test_allows_requests_under_limit(self):
        limiter = RateLimiter(window_sec=60)
        key = "test:127.0.0.1"

        for i in range(5):
            allowed, remaining = limiter.check(key, limit=5)
            if i < 5:
                assert allowed is True
                assert remaining == 5 - i - 1

    def test_blocks_requests_over_limit(self):
        limiter = RateLimiter(window_sec=60)
        key = "test:127.0.0.1"

        # Use up the limit
        for _ in range(3):
            limiter.check(key, limit=3)

        # Next request should be blocked
        allowed, remaining = limiter.check(key, limit=3)
        assert allowed is False
        assert remaining == 0

    def test_different_keys_independent(self):
        limiter = RateLimiter(window_sec=60)
        key1 = "cmd1:127.0.0.1"
        key2 = "cmd2:127.0.0.1"

        # Use up limit on key1
        for _ in range(2):
            limiter.check(key1, limit=2)

        # key2 should still be allowed
        allowed, remaining = limiter.check(key2, limit=2)
        assert allowed is True

    def test_get_remaining_without_consuming(self):
        limiter = RateLimiter(window_sec=60)
        key = "test:127.0.0.1"

        # Make 2 requests
        limiter.check(key, limit=5)
        limiter.check(key, limit=5)

        # Check remaining without consuming
        remaining = limiter.get_remaining(key, limit=5)
        assert remaining == 3

        # Still 3 remaining (didn't consume)
        remaining = limiter.get_remaining(key, limit=5)
        assert remaining == 3

    def test_reset_clears_key(self):
        limiter = RateLimiter(window_sec=60)
        key = "test:127.0.0.1"

        # Make some requests
        limiter.check(key, limit=5)
        limiter.check(key, limit=5)

        # Reset
        limiter.reset(key)

        # Should have full limit again
        remaining = limiter.get_remaining(key, limit=5)
        assert remaining == 5

    def test_reset_all(self):
        limiter = RateLimiter(window_sec=60)

        limiter.check("key1:ip1", limit=5)
        limiter.check("key2:ip2", limit=5)

        limiter.reset_all()

        assert limiter.get_remaining("key1:ip1", limit=5) == 5
        assert limiter.get_remaining("key2:ip2", limit=5) == 5


class TestMakeRateLimitKey:
    def test_creates_key_with_command_and_ip(self):
        key = make_rate_limit_key("db.check_schema", "192.168.1.1")
        assert key == "db.check_schema:192.168.1.1"

    def test_handles_ipv6(self):
        key = make_rate_limit_key("evershop.graphql_test", "::1")
        assert key == "evershop.graphql_test:::1"


class TestGetRateLimitForCommand:
    def test_db_commands_use_db_limit(self, mock_settings):
        mock_settings.rate_limit_db_rpm = 15
        limit = get_rate_limit_for_command("db.check_schema", mock_settings)
        assert limit == 15

    def test_evershop_commands_use_evershop_limit(self, mock_settings):
        mock_settings.rate_limit_evershop_rpm = 8
        limit = get_rate_limit_for_command("evershop.graphql_test", mock_settings)
        assert limit == 8

    def test_logs_commands_use_logs_limit(self, mock_settings):
        mock_settings.rate_limit_logs_rpm = 3
        limit = get_rate_limit_for_command("logs.tail", mock_settings)
        assert limit == 3

    def test_unknown_commands_use_default(self, mock_settings):
        limit = get_rate_limit_for_command("unknown.command", mock_settings)
        assert limit == 10  # Default fallback
