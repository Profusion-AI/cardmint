"""
Tests for EverShop commands (evershop.graphql_test, evershop.extension_status).

Tests GraphQL execution, error handling, and mocked httpx responses.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.commands.evershop import (
    PRODUCTS_QUERY,
    EvershopExtensionStatusArgs,
    EvershopGraphqlTestArgs,
    cmd_evershop_extension_status,
    cmd_evershop_graphql_test,
)


class TestEvershopGraphqlTestArgs:
    """Tests for evershop.graphql_test argument validation."""

    def test_default_limit(self):
        args = EvershopGraphqlTestArgs()
        assert args.limit == 5

    def test_custom_limit(self):
        args = EvershopGraphqlTestArgs(limit=10)
        assert args.limit == 10

    def test_max_limit_enforced(self):
        with pytest.raises(ValueError):
            EvershopGraphqlTestArgs(limit=25)

    def test_min_limit_enforced(self):
        with pytest.raises(ValueError):
            EvershopGraphqlTestArgs(limit=0)


class TestEvershopExtensionStatusArgs:
    """Tests for evershop.extension_status argument validation."""

    def test_no_args_required(self):
        args = EvershopExtensionStatusArgs()
        assert args is not None


class TestCmdEvershopGraphqlTest:
    """Tests for evershop.graphql_test command execution."""

    @pytest.fixture
    def mock_context(self, mock_settings):
        ctx = MagicMock()
        ctx.settings = mock_settings
        ctx.settings.command_timeout_sec = 10
        ctx.settings.evershop_graphql_url = "http://localhost:3000/api/graphql"
        ctx.settings.evershop_admin_token = ""
        ctx.http_client = AsyncMock()
        ctx.db = MagicMock()
        return ctx

    @pytest.mark.asyncio
    async def test_successful_graphql_response(self, mock_context):
        """Successful GraphQL response should return items and summary."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {
                "products": {
                    "items": [
                        {
                            "productId": 1,
                            "name": "Test Card",
                            "sku": "SKU001",
                            "cmSetName": "Pokemon",
                            "cmVariant": "Holo",
                            "cmMarketPrice": "25.00",
                            "cmProductUid": "abc-123",
                        },
                        {
                            "productId": 2,
                            "name": "Another Card",
                            "sku": "SKU002",
                            "cmSetName": None,
                            "cmVariant": None,
                            "cmMarketPrice": None,
                            "cmProductUid": None,
                        },
                    ],
                    "total": 100,
                }
            }
        }
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is True
        assert result["total_products"] == 100
        assert result["sample_count"] == 2
        assert result["cm_field_summary"]["with_cm_set_name"] == 1
        assert result["cm_field_summary"]["with_cm_product_uid"] == 1

    @pytest.mark.asyncio
    async def test_http_error(self, mock_context):
        """HTTP error should return failure."""
        mock_context.http_client.post.side_effect = Exception("Connection refused")
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is False
        assert "Connection refused" in result["error"]
        assert "graphql_url" in result

    @pytest.mark.asyncio
    async def test_non_200_status(self, mock_context):
        """Non-200 status should return failure with status code."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is False
        assert result["status_code"] == 500
        assert "Internal Server Error" in result["response_text"]

    @pytest.mark.asyncio
    async def test_invalid_json_response(self, mock_context):
        """Invalid JSON response should return failure."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.side_effect = Exception("Invalid JSON")
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is False
        assert "Invalid JSON" in result["error"]

    @pytest.mark.asyncio
    async def test_graphql_errors_returned(self, mock_context):
        """GraphQL errors should be returned."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "errors": [{"message": "Field not found: cmInvalidField"}]
        }
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is False
        assert "graphql_errors" in result

    @pytest.mark.asyncio
    async def test_auth_token_included(self, mock_context):
        """Auth token should be included when configured."""
        mock_context.settings.evershop_admin_token = "secret-token"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"products": {"items": [], "total": 0}}}
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        await cmd_evershop_graphql_test(args, mock_context)

        # Verify auth header was passed
        call_args = mock_context.http_client.post.call_args
        headers = call_args.kwargs.get("headers", call_args[1].get("headers", {}))
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer secret-token"

    @pytest.mark.asyncio
    async def test_empty_products(self, mock_context):
        """Empty products list should return zero counts."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {"products": {"items": [], "total": 0}}
        }
        mock_context.http_client.post.return_value = mock_response
        args = EvershopGraphqlTestArgs(limit=5)

        result = await cmd_evershop_graphql_test(args, mock_context)

        assert result["success"] is True
        assert result["total_products"] == 0
        assert result["sample_count"] == 0
        assert result["cm_field_summary"]["total_items"] == 0


class TestCmdEvershopExtensionStatus:
    """Tests for evershop.extension_status command execution."""

    @pytest.fixture
    def mock_context(self, mock_settings):
        ctx = MagicMock()
        ctx.settings = mock_settings
        ctx.settings.command_timeout_sec = 10
        ctx.settings.evershop_graphql_url = "http://localhost:3000/api/graphql"
        ctx.http_client = AsyncMock()
        ctx.db = MagicMock()
        ctx.db.execute_query = AsyncMock()
        return ctx

    @pytest.mark.asyncio
    async def test_all_checks_pass(self, mock_context):
        """All extension checks passing should return success."""
        # Mock cm_* columns found
        mock_context.db.execute_query.side_effect = [
            # First call: cm_* columns
            [{"column_name": f"cm_{i}"} for i in ["set_name", "variant", "market_price", "pricing_source", "pricing_status", "pricing_updated_at", "product_uid", "inventory_status"]],
            # Second call: variant_tags attribute
            [{"attribute_id": 1, "attribute_code": "cardmint_variant_tags", "attribute_name": "CardMint Variant Tags"}],
        ]

        # Mock GraphQL health check
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"__schema": {"queryType": {"name": "Query"}}}}
        mock_context.http_client.post.return_value = mock_response

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["success"] is True
        assert result["cardmint_sync_extension"]["installed"] is True
        assert result["cardmint_sync_extension"]["migration_complete"] is True
        assert result["cardmint_variant_tags_attribute"]["exists"] is True
        assert result["graphql_endpoint"]["reachable"] is True

    @pytest.mark.asyncio
    async def test_missing_cm_columns(self, mock_context):
        """Missing cm_* columns should report sync extension not installed."""
        mock_context.db.execute_query.side_effect = [
            [],  # No cm_* columns
            [],  # No variant_tags attribute
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"__schema": {"queryType": {"name": "Query"}}}}
        mock_context.http_client.post.return_value = mock_response

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["success"] is True
        assert result["cardmint_sync_extension"]["installed"] is False
        assert result["cardmint_sync_extension"]["found_column_count"] == 0

    @pytest.mark.asyncio
    async def test_partial_cm_columns(self, mock_context):
        """Partial cm_* columns should report migration incomplete."""
        mock_context.db.execute_query.side_effect = [
            [{"column_name": "cm_set_name"}, {"column_name": "cm_variant"}],  # Only 2 columns
            [],
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"__schema": {"queryType": {"name": "Query"}}}}
        mock_context.http_client.post.return_value = mock_response

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["cardmint_sync_extension"]["installed"] is True
        assert result["cardmint_sync_extension"]["migration_complete"] is False
        assert result["cardmint_sync_extension"]["found_column_count"] == 2

    @pytest.mark.asyncio
    async def test_database_error_on_columns(self, mock_context):
        """Database error checking columns should report error."""
        mock_context.db.execute_query.side_effect = [
            Exception("Connection refused"),
            [],
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": {"__schema": {"queryType": {"name": "Query"}}}}
        mock_context.http_client.post.return_value = mock_response

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["success"] is True  # Overall still returns
        assert result["cardmint_sync_extension"]["installed"] is False
        assert "Connection refused" in result["cardmint_sync_extension"]["error"]

    @pytest.mark.asyncio
    async def test_graphql_unreachable(self, mock_context):
        """GraphQL endpoint unreachable should report error."""
        mock_context.db.execute_query.side_effect = [
            [{"column_name": "cm_product_uid"}],
            [],
        ]

        mock_context.http_client.post.side_effect = Exception("Connection timeout")

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["success"] is True
        assert result["graphql_endpoint"]["reachable"] is False
        assert "Connection timeout" in result["graphql_endpoint"]["error"]

    @pytest.mark.asyncio
    async def test_graphql_returns_errors(self, mock_context):
        """GraphQL returning errors should be reported."""
        mock_context.db.execute_query.side_effect = [
            [{"column_name": "cm_product_uid"}],
            [],
        ]

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "data": {"__schema": {"queryType": {"name": "Query"}}},
            "errors": [{"message": "Introspection disabled"}],
        }
        mock_context.http_client.post.return_value = mock_response

        args = EvershopExtensionStatusArgs()
        result = await cmd_evershop_extension_status(args, mock_context)

        assert result["graphql_endpoint"]["reachable"] is True
        assert "errors" in result["graphql_endpoint"]


class TestProductsQuery:
    """Tests for PRODUCTS_QUERY definition."""

    def test_query_includes_cm_fields(self):
        cm_fields = [
            "cmSetName",
            "cmVariant",
            "cmMarketPrice",
            "cmPricingSource",
            "cmPricingStatus",
            "cmPricingUpdatedAt",
            "cmProductUid",
            "cmInventoryStatus",
        ]
        for field in cm_fields:
            assert field in PRODUCTS_QUERY, f"Missing field {field} in query"

    def test_query_includes_base_fields(self):
        base_fields = ["productId", "uuid", "name", "sku", "status"]
        for field in base_fields:
            assert field in PRODUCTS_QUERY, f"Missing field {field} in query"

    def test_query_uses_filters_variable(self):
        assert "$filters" in PRODUCTS_QUERY
        assert "filters: $filters" in PRODUCTS_QUERY
