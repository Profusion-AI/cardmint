"""
Pytest fixtures for Internal Debug API tests.
"""

import os
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

# Set test environment before importing app
os.environ["INTERNAL_DEBUG_TOKEN"] = "test-token-12345"
os.environ["POSTGRES_HOST"] = "localhost"
os.environ["POSTGRES_PASSWORD"] = "testpassword"
os.environ["LOG_LEVEL"] = "DEBUG"


@pytest.fixture
def test_token() -> str:
    """Test authentication token."""
    return "test-token-12345"


@pytest.fixture
def auth_headers(test_token: str) -> dict:
    """Authorization headers for authenticated requests."""
    return {"Authorization": f"Bearer {test_token}"}


@pytest.fixture
def mock_db_manager():
    """Mock DatabaseManager for testing without real DB."""
    mock = AsyncMock()
    mock.health_check = AsyncMock(return_value=True)
    mock.is_connected = True

    # Mock connection context manager
    mock_conn = AsyncMock()
    mock_cursor = AsyncMock()
    mock_cursor.fetchall = AsyncMock(return_value=[])
    mock_cursor.description = [("col1",)]

    mock_conn.cursor = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_cursor), __aexit__=AsyncMock()))
    mock.connection = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_conn), __aexit__=AsyncMock()))

    return mock


@pytest.fixture
def mock_http_client():
    """Mock httpx AsyncClient for testing."""
    mock = AsyncMock()
    mock.post = AsyncMock()
    mock.get = AsyncMock()
    return mock


@pytest.fixture
def mock_settings():
    """Mock Settings for testing."""
    mock = MagicMock()
    mock.internal_debug_token = "test-token-12345"
    mock.allowed_ips_set = set()
    mock.trusted_proxies_set = set()
    mock.command_timeout_sec = 10
    mock.max_output_bytes = 65536
    mock.rate_limit_db_rpm = 10
    mock.rate_limit_evershop_rpm = 5
    mock.rate_limit_logs_rpm = 2
    mock.postgres_dsn = "host=localhost port=5432 user=test password=test dbname=test"
    mock.evershop_graphql_url = "http://localhost:3000/api/graphql"
    mock.evershop_admin_token = ""
    mock.log_source_nginx_access = "/var/log/nginx/access.log"
    mock.log_source_nginx_error = "/var/log/nginx/error.log"
    mock.log_source_cardmint_backend = ""
    mock.log_source_evershop_file = ""
    mock.log_source_postgres_file = ""
    mock.max_log_lines = 500
    return mock
