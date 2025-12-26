"""
EverShop integration commands for Internal Debug API.

Commands:
- evershop.graphql_test: Run admin products grid GraphQL query
- evershop.extension_status: Report CardMint extension status
"""

from typing import Any, Optional

from pydantic import BaseModel, Field

from ..redaction import sanitize_output
from . import CommandContext, register_command

# GraphQL query matching the admin products grid (from Grid.js)
# This is the exact query used by /admin/products page
PRODUCTS_QUERY = """
query Query($filters: [FilterInput]) {
  products(filters: $filters) {
    items {
      productId
      uuid
      name
      image {
        url
        alt
      }
      sku
      status
      category {
        name
      }
      inventory {
        qty
      }
      price {
        regular {
          value
          text
        }
      }
      editUrl
      updateApi
      deleteApi
      cmSetName
      cmVariant
      cmMarketPrice
      cmPricingSource
      cmPricingStatus
      cmPricingUpdatedAt
      cmProductUid
      cmInventoryStatus
    }
    total
    currentFilters {
      key
      operation
      value
    }
  }
}
"""


class EvershopGraphqlTestArgs(BaseModel):
    """Arguments for evershop.graphql_test command."""

    limit: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Number of products to fetch (1-20)",
    )


class EvershopExtensionStatusArgs(BaseModel):
    """Arguments for evershop.extension_status command (none required)."""

    pass


@register_command(
    "evershop.graphql_test",
    EvershopGraphqlTestArgs,
    "Run admin products grid GraphQL query and return sanitized results",
)
async def cmd_evershop_graphql_test(
    args: EvershopGraphqlTestArgs,
    ctx: CommandContext,
) -> dict[str, Any]:
    """
    Execute the admin products grid GraphQL query.

    This runs the same query that powers /admin/products in EverShop,
    including all CardMint projection fields (cm_*). Useful for diagnosing
    why the admin grid might be blank or missing data.

    Results are sanitized to remove any PII or sensitive data.
    """
    variables = {
        "filters": [
            {"key": "limit", "operation": "eq", "value": str(args.limit)},
        ]
    }

    headers = {"Content-Type": "application/json"}
    if ctx.settings.evershop_admin_token:
        headers["Authorization"] = f"Bearer {ctx.settings.evershop_admin_token}"

    try:
        response = await ctx.http_client.post(
            ctx.settings.evershop_graphql_url,
            json={"query": PRODUCTS_QUERY, "variables": variables},
            headers=headers,
            timeout=ctx.settings.command_timeout_sec,
        )
    except Exception as e:
        return {
            "success": False,
            "error": f"HTTP request failed: {str(e)}",
            "graphql_url": ctx.settings.evershop_graphql_url,
        }

    if response.status_code != 200:
        return {
            "success": False,
            "error": "GraphQL request failed",
            "status_code": response.status_code,
            "response_text": response.text[:500],  # Truncate for safety
        }

    try:
        data = response.json()
    except Exception:
        return {
            "success": False,
            "error": "Invalid JSON response from GraphQL",
            "status_code": response.status_code,
        }

    # Check for GraphQL errors
    if "errors" in data:
        return {
            "success": False,
            "graphql_errors": sanitize_output(data["errors"]),
        }

    # Extract products data
    products = data.get("data", {}).get("products", {})
    items = products.get("items", [])

    # Summarize cm_* field presence
    cm_field_summary = {
        "total_items": len(items),
        "with_cm_set_name": sum(1 for i in items if i.get("cmSetName")),
        "with_cm_variant": sum(1 for i in items if i.get("cmVariant")),
        "with_cm_market_price": sum(1 for i in items if i.get("cmMarketPrice")),
        "with_cm_product_uid": sum(1 for i in items if i.get("cmProductUid")),
    }

    return {
        "success": True,
        "total_products": products.get("total", 0),
        "sample_count": len(items),
        "cm_field_summary": cm_field_summary,
        "items": sanitize_output(items),
    }


@register_command(
    "evershop.extension_status",
    EvershopExtensionStatusArgs,
    "Report CardMint extension status and configuration",
)
async def cmd_evershop_extension_status(
    args: EvershopExtensionStatusArgs,
    ctx: CommandContext,
) -> dict[str, Any]:
    """
    Check if CardMint extensions are properly installed in EverShop.

    This verifies:
    1. cm_* columns exist in the product table (sync extension migration ran)
    2. cardmint_variant_tags attribute exists (variant attribute migration ran)
    3. GraphQL endpoint is reachable

    Use this when the admin UI is behaving unexpectedly to verify extension state.
    """
    result: dict[str, Any] = {
        "success": True,
    }

    # Check cm_* columns in product table
    try:
        cm_columns_query = """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'product'
            AND column_name LIKE 'cm_%%'
            ORDER BY column_name
        """
        rows = await ctx.db.execute_query(
            cm_columns_query,
            timeout=ctx.settings.command_timeout_sec,
        )
        cm_columns = [row["column_name"] for row in rows]

        result["cardmint_sync_extension"] = {
            "installed": len(cm_columns) > 0,
            "cm_columns_found": sorted(cm_columns),
            "expected_column_count": 8,
            "found_column_count": len(cm_columns),
            "migration_complete": len(cm_columns) >= 8,
        }
    except Exception as e:
        result["cardmint_sync_extension"] = {
            "installed": False,
            "error": f"Database query failed: {str(e)}",
        }

    # Check cardmint_variant_tags attribute
    try:
        variant_attr_query = """
            SELECT attribute_id, attribute_code, attribute_name
            FROM attribute
            WHERE attribute_code = 'cardmint_variant_tags'
        """
        rows = await ctx.db.execute_query(
            variant_attr_query,
            timeout=ctx.settings.command_timeout_sec,
        )

        if rows:
            attr = rows[0]
            result["cardmint_variant_tags_attribute"] = {
                "exists": True,
                "attribute_id": attr.get("attribute_id"),
                "attribute_code": attr.get("attribute_code"),
            }
        else:
            result["cardmint_variant_tags_attribute"] = {
                "exists": False,
                "note": "Attribute not found - variant tags sync will be disabled",
            }
    except Exception as e:
        result["cardmint_variant_tags_attribute"] = {
            "exists": False,
            "error": f"Database query failed: {str(e)}",
        }

    # Check GraphQL endpoint reachability
    try:
        # Simple introspection query to verify endpoint
        introspection_query = """
            query {
                __schema {
                    queryType { name }
                }
            }
        """
        response = await ctx.http_client.post(
            ctx.settings.evershop_graphql_url,
            json={"query": introspection_query},
            headers={"Content-Type": "application/json"},
            timeout=5,  # Short timeout for health check
        )

        result["graphql_endpoint"] = {
            "url": ctx.settings.evershop_graphql_url,
            "reachable": response.status_code == 200,
            "status_code": response.status_code,
        }

        if response.status_code == 200:
            data = response.json()
            if "errors" in data:
                result["graphql_endpoint"]["errors"] = sanitize_output(data["errors"])
    except Exception as e:
        result["graphql_endpoint"] = {
            "url": ctx.settings.evershop_graphql_url,
            "reachable": False,
            "error": str(e),
        }

    return result
