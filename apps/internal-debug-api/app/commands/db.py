"""
Database inspection commands for Internal Debug API.

Commands:
- db.check_schema: Verify cm_* columns exist in EverShop product table
- db.query_postgres: Execute template-based queries (no raw SQL)
"""

from typing import Any, Optional

from pydantic import BaseModel, Field

from . import CommandContext, register_command

# Expected cm_* columns in EverShop product table (CardMint projection fields)
CM_COLUMNS = [
    "cm_set_name",
    "cm_variant",
    "cm_market_price",
    "cm_pricing_source",
    "cm_pricing_status",
    "cm_pricing_updated_at",
    "cm_product_uid",
    "cm_inventory_status",
]


# Query templates - ONLY these are allowed, no raw SQL
QUERY_TEMPLATES = {
    "product_count": {
        "description": "Count products with/without cm_* data",
        "query": """
            SELECT
                COUNT(*) as total,
                COUNT(cm_product_uid) as with_cm_data,
                COUNT(*) - COUNT(cm_product_uid) as without_cm_data
            FROM product
        """,
        "params": [],
    },
    "cm_field_population": {
        "description": "Check fill rates for each cm_* column",
        "query": """
            SELECT
                COUNT(*) as total,
                COUNT(cm_set_name) as cm_set_name_filled,
                COUNT(cm_variant) as cm_variant_filled,
                COUNT(cm_market_price) as cm_market_price_filled,
                COUNT(cm_pricing_source) as cm_pricing_source_filled,
                COUNT(cm_pricing_status) as cm_pricing_status_filled,
                COUNT(cm_pricing_updated_at) as cm_pricing_updated_at_filled,
                COUNT(cm_product_uid) as cm_product_uid_filled,
                COUNT(cm_inventory_status) as cm_inventory_status_filled
            FROM product
        """,
        "params": [],
    },
    "recent_products": {
        "description": "Get most recent products by created_at",
        "query": """
            SELECT
                product_id,
                sku,
                cm_set_name,
                cm_variant,
                cm_market_price,
                cm_pricing_status,
                cm_inventory_status,
                created_at
            FROM product
            ORDER BY created_at DESC
            LIMIT %(limit)s
        """,
        "params": ["limit"],
    },
}


# Pydantic models for argument validation
class DbCheckSchemaArgs(BaseModel):
    """Arguments for db.check_schema command."""

    tables: Optional[list[str]] = Field(
        default=None,
        description="Specific columns to check (default: all cm_* columns)",
    )


class DbQueryPostgresArgs(BaseModel):
    """Arguments for db.query_postgres command."""

    template: str = Field(
        ...,
        description="Query template name: product_count, cm_field_population, recent_products",
    )
    params: Optional[dict[str, Any]] = Field(
        default_factory=dict,
        description="Template parameters (e.g., {\"limit\": 10} for recent_products)",
    )


@register_command(
    "db.check_schema",
    DbCheckSchemaArgs,
    "Verify cm_* columns exist in EverShop product table",
)
async def cmd_db_check_schema(
    args: DbCheckSchemaArgs,
    ctx: CommandContext,
) -> dict[str, Any]:
    """
    Verify that CardMint projection columns exist in EverShop's product table.

    This checks for the presence of cm_* columns that CardMint sync writes to.
    Missing columns indicate the migration hasn't been run.
    """
    query = """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'product'
        AND column_name LIKE 'cm_%%'
        ORDER BY column_name
    """

    try:
        rows = await ctx.db.execute_query(query, timeout=ctx.settings.command_timeout_sec)
        found_columns = {row["column_name"] for row in rows}
    except Exception as e:
        return {
            "success": False,
            "error": f"Database query failed: {str(e)}",
        }

    # Determine expected columns
    expected = set(args.tables) if args.tables else set(CM_COLUMNS)
    missing = expected - found_columns
    extra = found_columns - set(CM_COLUMNS)

    return {
        "success": True,
        "schema_valid": len(missing) == 0,
        "expected_columns": sorted(expected),
        "found_columns": sorted(found_columns),
        "missing_columns": sorted(missing),
        "extra_columns": sorted(extra),
        "expected_count": len(expected),
        "found_count": len(found_columns),
    }


@register_command(
    "db.query_postgres",
    DbQueryPostgresArgs,
    "Execute template-based queries (no raw SQL allowed)",
)
async def cmd_db_query_postgres(
    args: DbQueryPostgresArgs,
    ctx: CommandContext,
) -> dict[str, Any]:
    """
    Execute a predefined query template.

    Only templates in the allowlist can be executed - no raw SQL is accepted.
    This prevents SQL injection and limits the API surface area.

    Available templates:
    - product_count: Count products with/without cm_* data
    - cm_field_population: Check fill rates for cm_* columns
    - recent_products: Get N most recent products (requires limit param)
    """
    if args.template not in QUERY_TEMPLATES:
        return {
            "success": False,
            "error": f"Unknown template: {args.template}",
            "available_templates": list(QUERY_TEMPLATES.keys()),
            "template_info": {
                name: info["description"]
                for name, info in QUERY_TEMPLATES.items()
            },
        }

    template = QUERY_TEMPLATES[args.template]
    query = template["query"]
    params = args.params or {}

    # Validate required params
    required_params = template["params"]
    missing_params = [p for p in required_params if p not in params]
    if missing_params:
        # Apply defaults where possible
        if "limit" in missing_params:
            params["limit"] = 10  # Default limit

    # Clamp limit to prevent large result sets
    if "limit" in params:
        params["limit"] = min(params["limit"], 100)

    try:
        rows = await ctx.db.execute_query(
            query,
            params if params else None,
            timeout=ctx.settings.command_timeout_sec,
        )
    except Exception as e:
        return {
            "success": False,
            "error": f"Query execution failed: {str(e)}",
            "template": args.template,
        }

    return {
        "success": True,
        "template": args.template,
        "description": template["description"],
        "row_count": len(rows),
        "results": rows,
    }
