#!/usr/bin/env python3
"""OpenAI Inference Smoke Test

Single-card smoke test to verify OpenAI gpt-5-mini-2025-08-07 endpoint is working
with CardMint's current prompt and JSON schema (Phase 4D configuration).

This script:
1. Loads a single test card image
2. Sends it to OpenAI's /v1/chat/completions endpoint
3. Validates JSON parse success
4. Compares with ground truth
5. Reports cost and timing

Usage:
    export OPENAI_API_KEY=sk-proj-...
    python scripts/openai_smoke_test.py [--image path/to/card.png]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict

import requests
from PIL import Image

# Shared prompts from Phase 4D baseline
SYSTEM_PROMPT = (
    "Pokemon card identifier. Provide name, hp, and set_number. "
    "CRITICAL: Set number is in bottom 15% of image, left or right corner. "
    "Format: '25/102' or '25'. NOT level (LV.XX)."
)

RESPONSE_SCHEMA = {
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

# OpenAI Configuration
OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini-2025-08-07")
OPENAI_IMAGE_DETAIL = os.getenv("OPENAI_IMAGE_DETAIL", "high")

# Default test image (from existing baseline)
DEFAULT_TEST_IMAGE = Path("/home/kyle/CardMint-workspace/pokemoncards/001.png")


def encode_image_to_base64(image_path: Path) -> str:
    """Convert image to base64-encoded PNG data URL (same as LM Studio approach)."""
    img = Image.open(image_path)

    # Convert to PNG in memory
    from io import BytesIO
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)

    # Base64 encode
    base64_data = base64.b64encode(buffer.read()).decode("utf-8")
    return f"data:image/png;base64,{base64_data}"


def run_openai_inference(
    image_path: Path,
    api_key: str,
    model: str = OPENAI_MODEL,
    detail: str = OPENAI_IMAGE_DETAIL,
) -> Dict[str, Any]:
    """
    Execute OpenAI inference with CardMint Phase 4D parameters.

    Returns dict with:
        - extracted: {name, hp, set_number}
        - infer_ms: inference time in milliseconds
        - cost_cents: estimated cost in cents
        - token_usage: {input_tokens, output_tokens, reasoning_tokens}
    """
    print(f"📸 Encoding image: {image_path.name}")
    image_data_url = encode_image_to_base64(image_path)

    payload = {
        "model": model,
        # GPT-5 Mini only supports temperature=1 (default) - cannot use deterministic mode
        "max_completion_tokens": 1000,  # Large buffer for reasoning + output
        "response_format": RESPONSE_SCHEMA,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Identify this Pokemon card."},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_data_url,
                            "detail": detail,  # OpenAI-specific
                        },
                    },
                ],
            },
        ],
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    print(f"🌐 Sending request to OpenAI ({model}, detail={detail})...")
    start_time = time.perf_counter()

    response = requests.post(OPENAI_API_URL, json=payload, headers=headers, timeout=30)

    infer_ms = (time.perf_counter() - start_time) * 1000

    if not response.ok:
        print(f"❌ OpenAI API Error ({response.status_code}): {response.text}")
        sys.exit(1)

    data = response.json()

    # Extract response content
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        print("❌ OpenAI response missing content")
        print(f"Debug - Full response: {json.dumps(data, indent=2)}")
        sys.exit(1)

    # Parse JSON (same validation as LM Studio)
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse OpenAI JSON: {e}")
        print(f"Raw content: {content}")
        sys.exit(1)

    # Validate fields
    name = parsed.get("name", "").strip() if isinstance(parsed.get("name"), str) else None
    hp_raw = parsed.get("hp")
    set_number = parsed.get("set_number", "").strip() if isinstance(parsed.get("set_number"), str) else None

    hp_value = hp_raw if isinstance(hp_raw, int) and hp_raw > 0 else None

    extracted = {
        "name": name,
        "hp": hp_value,
        "set_number": set_number,
    }

    # Calculate cost
    usage = data.get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)
    reasoning_tokens = usage.get("completion_tokens_details", {}).get("reasoning_tokens", 0)

    # GPT-5 Mini pricing: $0.25/1M input, $2.00/1M output
    cost_cents = (input_tokens / 1_000_000) * 0.25 + (output_tokens / 1_000_000) * 2.0

    return {
        "extracted": extracted,
        "infer_ms": infer_ms,
        "cost_cents": cost_cents,
        "token_usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
        },
        "stop_reason": data.get("choices", [{}])[0].get("finish_reason", "unknown"),
    }


def main():
    parser = argparse.ArgumentParser(description="OpenAI smoke test for CardMint inference")
    parser.add_argument(
        "--image",
        type=Path,
        default=DEFAULT_TEST_IMAGE,
        help="Path to test card image (default: pokemoncards/001.png)",
    )
    parser.add_argument(
        "--model",
        default=OPENAI_MODEL,
        help="OpenAI model to use (default: gpt-5-mini-2025-08-07)",
    )
    parser.add_argument(
        "--detail",
        choices=["high", "low", "auto"],
        default=OPENAI_IMAGE_DETAIL,
        help="Image detail level (default: high)",
    )
    args = parser.parse_args()

    # Check API key
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("❌ OPENAI_API_KEY environment variable not set")
        print("   export OPENAI_API_KEY=sk-proj-...")
        sys.exit(1)

    # Validate image exists
    if not args.image.exists():
        print(f"❌ Image not found: {args.image}")
        sys.exit(1)

    print("=" * 60)
    print("🧪 OpenAI Inference Smoke Test")
    print("=" * 60)
    print(f"Model:        {args.model}")
    print(f"Image:        {args.image}")
    print(f"Detail Level: {args.detail}")
    print(f"API Key:      {api_key[:20]}...{api_key[-4:]}")
    print("=" * 60)
    print()

    # Run inference
    result = run_openai_inference(args.image, api_key, args.model, args.detail)

    # Display results
    print()
    print("✅ Inference Complete!")
    print("=" * 60)
    print("📊 Results:")
    print(f"  Name:       {result['extracted']['name']}")
    print(f"  HP:         {result['extracted']['hp']}")
    print(f"  Set Number: {result['extracted']['set_number']}")
    print()
    print("⏱️  Performance:")
    print(f"  Inference Time: {result['infer_ms']:.0f} ms ({result['infer_ms']/1000:.2f}s)")
    print()
    print("💰 Cost:")
    print(f"  Total Cost:     ${result['cost_cents']/100:.6f} ({result['cost_cents']:.4f}¢)")
    print(f"  Input Tokens:   {result['token_usage']['input_tokens']}")
    print(f"  Output Tokens:  {result['token_usage']['output_tokens']}")
    if result['token_usage']['reasoning_tokens'] > 0:
        print(f"  Reasoning Tokens: {result['token_usage']['reasoning_tokens']}")
    print(f"  Stop Reason:    {result['stop_reason']}")
    print("=" * 60)

    # Compare with known ground truth for default image
    if args.image == DEFAULT_TEST_IMAGE:
        print()
        print("🎯 Ground Truth Comparison (001.png = Bulbasaur):")
        expected = {
            "name": "Bulbasaur",
            "hp": 40,
            "set_number": "1/102",
        }

        name_match = result['extracted']['name'] == expected['name']
        hp_match = result['extracted']['hp'] == expected['hp']
        set_match = result['extracted']['set_number'] == expected['set_number']

        print(f"  Name:       {'✅' if name_match else '❌'} (expected: {expected['name']})")
        print(f"  HP:         {'✅' if hp_match else '❌'} (expected: {expected['hp']})")
        print(f"  Set Number: {'✅' if set_match else '❌'} (expected: {expected['set_number']})")

        if name_match and hp_match and set_match:
            print()
            print("🎉 SMOKE TEST PASSED - All fields match ground truth!")
        else:
            print()
            print("⚠️  SMOKE TEST PARTIAL - Some fields don't match (may be acceptable)")
        print("=" * 60)

    # Save result to file
    output_path = Path("results/openai-smoke-test.json")
    output_path.parent.mkdir(exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(
            {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "image_path": str(args.image),
                "model": args.model,
                "detail_level": args.detail,
                "result": result,
            },
            f,
            indent=2,
        )

    print()
    print(f"📝 Results saved to: {output_path}")
    print()


if __name__ == "__main__":
    main()
