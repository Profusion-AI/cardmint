"""
Tests for database commands (db.check_schema, db.query_postgres).

Tests template routing, parameter validation, error mapping, and mocked DB execution.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.commands.db import (
    CM_COLUMNS,
    QUERY_TEMPLATES,
    DbCheckSchemaArgs,
    DbQueryPostgresArgs,
    cmd_db_check_schema,
    cmd_db_query_postgres,
)


class TestDbCheckSchemaArgs:
    """Tests for db.check_schema argument validation."""

    def test_default_args(self):
        args = DbCheckSchemaArgs()
        assert args.tables is None

    def test_specific_columns(self):
        args = DbCheckSchemaArgs(tables=["cm_set_name", "cm_variant"])
        assert args.tables == ["cm_set_name", "cm_variant"]


class TestDbQueryPostgresArgs:
    """Tests for db.query_postgres argument validation."""

    def test_template_required(self):
        with pytest.raises(ValueError):
            DbQueryPostgresArgs()

    def test_valid_template(self):
        args = DbQueryPostgresArgs(template="product_count")
        assert args.template == "product_count"

    def test_params_optional(self):
        args = DbQueryPostgresArgs(template="recent_products")
        assert args.params == {}

    def test_params_provided(self):
        args = DbQueryPostgresArgs(template="recent_products", params={"limit": 20})
        assert args.params == {"limit": 20}


class TestCmdDbCheckSchema:
    """Tests for db.check_schema command execution."""

    @pytest.fixture
    def mock_context(self, mock_settings):
        ctx = MagicMock()
        ctx.settings = mock_settings
        ctx.settings.command_timeout_sec = 10
        ctx.db = MagicMock()
        ctx.db.execute_query = AsyncMock()
        return ctx

    @pytest.mark.asyncio
    async def test_all_columns_present(self, mock_context):
        """All expected cm_* columns present should report schema valid."""
        mock_context.db.execute_query.return_value = [
            {"column_name": col} for col in CM_COLUMNS
        ]
        args = DbCheckSchemaArgs()

        result = await cmd_db_check_schema(args, mock_context)

        assert result["success"] is True
        assert result["schema_valid"] is True
        assert result["missing_columns"] == []
        assert result["found_count"] == 8
        assert result["expected_count"] == 8

    @pytest.mark.asyncio
    async def test_missing_columns(self, mock_context):
        """Missing columns should report schema invalid."""
        # Only return some columns
        mock_context.db.execute_query.return_value = [
            {"column_name": "cm_set_name"},
            {"column_name": "cm_variant"},
        ]
        args = DbCheckSchemaArgs()

        result = await cmd_db_check_schema(args, mock_context)

        assert result["success"] is True
        assert result["schema_valid"] is False
        assert len(result["missing_columns"]) == 6
        assert "cm_market_price" in result["missing_columns"]

    @pytest.mark.asyncio
    async def test_extra_columns_detected(self, mock_context):
        """Extra cm_* columns should be reported."""
        mock_context.db.execute_query.return_value = [
            {"column_name": col} for col in CM_COLUMNS
        ] + [{"column_name": "cm_custom_field"}]
        args = DbCheckSchemaArgs()

        result = await cmd_db_check_schema(args, mock_context)

        assert result["success"] is True
        assert result["schema_valid"] is True
        assert "cm_custom_field" in result["extra_columns"]

    @pytest.mark.asyncio
    async def test_specific_columns_check(self, mock_context):
        """Check only specific columns when tables arg provided."""
        mock_context.db.execute_query.return_value = [
            {"column_name": "cm_set_name"},
            {"column_name": "cm_variant"},
        ]
        args = DbCheckSchemaArgs(tables=["cm_set_name", "cm_variant"])

        result = await cmd_db_check_schema(args, mock_context)

        assert result["success"] is True
        assert result["schema_valid"] is True
        assert result["expected_count"] == 2
        assert result["found_count"] == 2

    @pytest.mark.asyncio
    async def test_database_error(self, mock_context):
        """Database error should return failure."""
        mock_context.db.execute_query.side_effect = Exception("Connection refused")
        args = DbCheckSchemaArgs()

        result = await cmd_db_check_schema(args, mock_context)

        assert result["success"] is False
        assert "Connection refused" in result["error"]


class TestCmdDbQueryPostgres:
    """Tests for db.query_postgres command execution."""

    @pytest.fixture
    def mock_context(self, mock_settings):
        ctx = MagicMock()
        ctx.settings = mock_settings
        ctx.settings.command_timeout_sec = 10
        ctx.db = MagicMock()
        ctx.db.execute_query = AsyncMock()
        return ctx

    @pytest.mark.asyncio
    async def test_unknown_template(self, mock_context):
        """Unknown template should return error with available templates."""
        args = DbQueryPostgresArgs(template="invalid_template")

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is False
        assert "invalid_template" in result["error"]
        assert "available_templates" in result
        assert "product_count" in result["available_templates"]
        assert "template_info" in result

    @pytest.mark.asyncio
    async def test_product_count_template(self, mock_context):
        """product_count template should return count stats."""
        mock_context.db.execute_query.return_value = [
            {"total": 100, "with_cm_data": 85, "without_cm_data": 15}
        ]
        args = DbQueryPostgresArgs(template="product_count")

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is True
        assert result["template"] == "product_count"
        assert result["row_count"] == 1
        assert result["results"][0]["total"] == 100

    @pytest.mark.asyncio
    async def test_cm_field_population_template(self, mock_context):
        """cm_field_population template should return fill rates."""
        mock_context.db.execute_query.return_value = [
            {
                "total": 100,
                "cm_set_name_filled": 80,
                "cm_variant_filled": 75,
                "cm_market_price_filled": 90,
                "cm_pricing_source_filled": 85,
                "cm_pricing_status_filled": 70,
                "cm_pricing_updated_at_filled": 70,
                "cm_product_uid_filled": 100,
                "cm_inventory_status_filled": 95,
            }
        ]
        args = DbQueryPostgresArgs(template="cm_field_population")

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is True
        assert result["template"] == "cm_field_population"
        assert result["results"][0]["cm_product_uid_filled"] == 100

    @pytest.mark.asyncio
    async def test_recent_products_with_limit(self, mock_context):
        """recent_products template should accept limit param."""
        mock_context.db.execute_query.return_value = [
            {"product_id": 1, "sku": "SKU001", "cm_set_name": "Pokemon"},
            {"product_id": 2, "sku": "SKU002", "cm_set_name": "Magic"},
        ]
        args = DbQueryPostgresArgs(template="recent_products", params={"limit": 2})

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is True
        assert result["template"] == "recent_products"
        assert result["row_count"] == 2

        # Verify limit was clamped and passed to query
        call_args = mock_context.db.execute_query.call_args
        assert call_args[0][1]["limit"] == 2

    @pytest.mark.asyncio
    async def test_limit_default_applied(self, mock_context):
        """Missing limit param should default to 10."""
        mock_context.db.execute_query.return_value = []
        args = DbQueryPostgresArgs(template="recent_products")

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is True
        call_args = mock_context.db.execute_query.call_args
        assert call_args[0][1]["limit"] == 10

    @pytest.mark.asyncio
    async def test_limit_capped_to_100(self, mock_context):
        """Limit should be capped to 100."""
        mock_context.db.execute_query.return_value = []
        args = DbQueryPostgresArgs(template="recent_products", params={"limit": 500})

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is True
        call_args = mock_context.db.execute_query.call_args
        assert call_args[0][1]["limit"] == 100

    @pytest.mark.asyncio
    async def test_database_error(self, mock_context):
        """Database error should return failure with template info."""
        mock_context.db.execute_query.side_effect = Exception("Syntax error")
        args = DbQueryPostgresArgs(template="product_count")

        result = await cmd_db_query_postgres(args, mock_context)

        assert result["success"] is False
        assert "Syntax error" in result["error"]
        assert result["template"] == "product_count"


class TestQueryTemplates:
    """Tests for query template definitions."""

    def test_all_templates_have_required_fields(self):
        required_fields = {"description", "query", "params"}
        for name, template in QUERY_TEMPLATES.items():
            for field in required_fields:
                assert field in template, f"Template {name} missing {field}"

    def test_product_count_no_params(self):
        assert QUERY_TEMPLATES["product_count"]["params"] == []

    def test_cm_field_population_no_params(self):
        assert QUERY_TEMPLATES["cm_field_population"]["params"] == []

    def test_recent_products_requires_limit(self):
        assert "limit" in QUERY_TEMPLATES["recent_products"]["params"]

    def test_all_templates_have_descriptions(self):
        for name, template in QUERY_TEMPLATES.items():
            assert len(template["description"]) > 10, f"Template {name} needs description"


class TestCmColumns:
    """Tests for CM_COLUMNS definition."""

    def test_has_eight_columns(self):
        assert len(CM_COLUMNS) == 8

    def test_all_columns_prefixed(self):
        for col in CM_COLUMNS:
            assert col.startswith("cm_"), f"Column {col} missing cm_ prefix"

    def test_expected_columns_present(self):
        expected = [
            "cm_set_name",
            "cm_variant",
            "cm_market_price",
            "cm_pricing_source",
            "cm_pricing_status",
            "cm_pricing_updated_at",
            "cm_product_uid",
            "cm_inventory_status",
        ]
        for col in expected:
            assert col in CM_COLUMNS, f"Missing expected column {col}"
