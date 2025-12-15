#!/usr/bin/env python3
"""OpenAI Batch Testing with CSV Export

Batch test multiple Pokemon cards against OpenAI GPT-5 Mini with:
- Stored completions (store: true) for later retrieval
- CSV export of all results
- Ground truth comparison
- Cost tracking

Usage:
    export OPENAI_API_KEY=sk-proj-...
    python scripts/openai_batch_test.py --count 10
    python scripts/openai_batch_test.py --images "pokemoncards/*.png" --count 25
"""
from __future__ import annotations

import argparse
import base64
import csv
import glob
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

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


def encode_image_to_base64(image_path: Path) -> str:
    """Convert image to base64-encoded PNG data URL."""
    img = Image.open(image_path)
    from io import BytesIO
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    base64_data = base64.b64encode(buffer.read()).decode("utf-8")
    return f"data:image/png;base64,{base64_data}"


def run_openai_inference(
    image_path: Path,
    api_key: str,
    model: str = OPENAI_MODEL,
    detail: str = OPENAI_IMAGE_DETAIL,
    store: bool = True,
    reasoning_effort: str = "low",
) -> Dict[str, Any]:
    """
    Execute OpenAI inference with storage enabled.

    Returns dict with:
        - extracted: {name, hp, set_number}
        - infer_ms: inference time in milliseconds
        - cost_cents: estimated cost in cents
        - token_usage: {input_tokens, output_tokens, reasoning_tokens}
        - completion_id: stored completion ID (if store=True)
        - stop_reason: finish_reason from OpenAI
    """
    image_data_url = encode_image_to_base64(image_path)

    payload = {
        "model": model,
        "max_completion_tokens": 1000,  # Large buffer for reasoning + output
        "response_format": RESPONSE_SCHEMA,
        "store": store,  # Enable server-side storage
        "reasoning_effort": reasoning_effort,  # Reduce reasoning tokens (minimal | low | medium | high)
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
                            "detail": detail,
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

    start_time = time.perf_counter()
    response = requests.post(OPENAI_API_URL, json=payload, headers=headers, timeout=60)
    infer_ms = (time.perf_counter() - start_time) * 1000

    if not response.ok:
        raise RuntimeError(f"OpenAI API Error ({response.status_code}): {response.text}")

    data = response.json()

    # Extract completion ID
    completion_id = data.get("id", "")

    # Extract response content
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        raise RuntimeError(f"Empty content (completion_id: {completion_id})")

    # Parse JSON
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"JSON parse failed: {e}\nContent: {content}")

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
        "completion_id": completion_id,
        "stop_reason": data.get("choices", [{}])[0].get("finish_reason", "unknown"),
    }


def retrieve_stored_completion(completion_id: str, api_key: str) -> Dict[str, Any]:
    """Retrieve a stored completion from OpenAI."""
    url = f"https://api.openai.com/v1/chat/completions/{completion_id}"
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(url, headers=headers, timeout=30)

    if not response.ok:
        raise RuntimeError(f"Failed to retrieve completion {completion_id}: {response.text}")

    return response.json()


def export_to_csv(results: List[Dict[str, Any]], output_path: Path):
    """Export batch results to CSV."""
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "image_path",
                "name",
                "hp",
                "set_number",
                "infer_ms",
                "cost_cents",
                "input_tokens",
                "output_tokens",
                "reasoning_tokens",
                "completion_id",
                "stop_reason",
                "timestamp",
            ],
        )
        writer.writeheader()

        for result in results:
            writer.writerow({
                "image_path": result["image_path"],
                "name": result["extracted"]["name"],
                "hp": result["extracted"]["hp"],
                "set_number": result["extracted"]["set_number"],
                "infer_ms": f"{result['infer_ms']:.0f}",
                "cost_cents": f"{result['cost_cents']:.6f}",
                "input_tokens": result["token_usage"]["input_tokens"],
                "output_tokens": result["token_usage"]["output_tokens"],
                "reasoning_tokens": result["token_usage"]["reasoning_tokens"],
                "completion_id": result["completion_id"],
                "stop_reason": result["stop_reason"],
                "timestamp": result["timestamp"],
            })


def main():
    parser = argparse.ArgumentParser(description="OpenAI batch test with CSV export")
    parser.add_argument(
        "--images",
        type=str,
        default="pokemoncards/*.png",
        help='Glob pattern for images (default: "pokemoncards/*.png")',
    )
    parser.add_argument(
        "--count",
        type=int,
        default=10,
        help="Number of cards to test (default: 10)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("results/openai-batch-test.csv"),
        help="CSV output path (default: results/openai-batch-test.csv)",
    )
    parser.add_argument(
        "--detail",
        choices=["high", "low", "auto"],
        default=OPENAI_IMAGE_DETAIL,
        help="Image detail level (default: high)",
    )
    parser.add_argument(
        "--reasoning-effort",
        choices=["minimal", "low", "medium", "high"],
        default="low",
        help="Reasoning effort level (default: low)",
    )
    args = parser.parse_args()

    # Check API key
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("❌ OPENAI_API_KEY environment variable not set")
        print("   export OPENAI_API_KEY=sk-proj-...")
        sys.exit(1)

    # Find images
    image_paths = sorted(glob.glob(args.images))[: args.count]
    if not image_paths:
        print(f"❌ No images found matching pattern: {args.images}")
        sys.exit(1)

    print("=" * 60)
    print("🧪 OpenAI Batch Test")
    print("=" * 60)
    print(f"Model:            {OPENAI_MODEL}")
    print(f"Images:           {len(image_paths)} cards")
    print(f"Detail Level:     {args.detail}")
    print(f"Reasoning Effort: {args.reasoning_effort}")
    print(f"Output CSV:       {args.output}")
    print("=" * 60)
    print()

    results = []
    total_cost = 0.0
    total_time = 0.0

    for i, image_path in enumerate(image_paths, 1):
        image_name = Path(image_path).name
        print(f"[{i}/{len(image_paths)}] Processing {image_name}...", end=" ", flush=True)

        try:
            result = run_openai_inference(
                Path(image_path),
                api_key,
                model=OPENAI_MODEL,
                detail=args.detail,
                store=True,
                reasoning_effort=args.reasoning_effort,
            )

            result["image_path"] = image_path
            result["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            results.append(result)

            total_cost += result["cost_cents"]
            total_time += result["infer_ms"]

            print(
                f"✅ {result['extracted']['name']} | "
                f"{result['infer_ms']:.0f}ms | "
                f"{result['cost_cents']:.4f}¢"
            )

        except Exception as e:
            print(f"❌ Error: {e}")

    print()
    print("=" * 60)
    print("📊 Batch Test Complete")
    print("=" * 60)
    print(f"Processed:       {len(results)}/{len(image_paths)} cards")
    print(f"Total Time:      {total_time/1000:.2f}s")
    print(f"Avg Time/Card:   {total_time/len(results):.0f}ms" if results else "N/A")
    print(f"Total Cost:      {total_cost:.4f}¢ (${total_cost/100:.6f})")
    print(f"Avg Cost/Card:   {total_cost/len(results):.4f}¢" if results else "N/A")
    print("=" * 60)

    # Export to CSV
    args.output.parent.mkdir(exist_ok=True)
    export_to_csv(results, args.output)
    print(f"\n📝 Results exported to: {args.output}")

    # Save detailed JSON
    json_output = args.output.with_suffix(".json")
    with open(json_output, "w") as f:
        json.dump(
            {
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "model": OPENAI_MODEL,
                "detail_level": args.detail,
                "total_cards": len(results),
                "total_cost_cents": total_cost,
                "total_time_ms": total_time,
                "results": results,
            },
            f,
            indent=2,
        )
    print(f"📝 Detailed JSON saved to: {json_output}")


if __name__ == "__main__":
    main()
