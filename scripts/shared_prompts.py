"""Shared prompt and response schema definitions for CardMint inference harnesses."""
from __future__ import annotations

from typing import Any, Dict

CARDMINT_SYSTEM_PROMPT: str = (
    "Pokemon card identifier. Provide name, hp, and set_number. "
    "CRITICAL: Set number is in bottom 15% of image, left or right corner. "
    "Format: '25/102' or '25'. NOT level (LV.XX)."
)

CARDMINT_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "pokemon_card_identity",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "hp": {"type": "integer"},
                "set_number": {"type": "string"},
            },
            "required": ["name", "hp", "set_number"],
            "additionalProperties": False,
        },
    },
}

__all__ = ["CARDMINT_SYSTEM_PROMPT", "CARDMINT_RESPONSE_SCHEMA"]
