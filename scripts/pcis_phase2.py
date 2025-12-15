#!/usr/bin/env python3
"""Phase 2 Advanced Optimization - Aggressive Parameter Reduction.

This script implements Phase 2 optimizations based on Phase 1 findings:
- Phase 1 showed token-level optimizations had no speed benefit
- Flash Attention reduces Vulkan performance by ~50% (avoiding)
- Focus on more aggressive reductions to find the bottleneck threshold

Optimizations Applied:
1. Aggressive context reduction: 2K → 1K tokens
2. More aggressive max_tokens: 75 → 50 tokens
3. Enhanced reasoning suppression with explicit JSON-only instruction
4. Verify if extreme reductions finally show performance impact

Target: Find the threshold where optimizations finally impact inference speed.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple
from urllib.parse import urlparse

from openai import OpenAI
from PIL import Image

DEFAULT_SERVER_URL = "http://127.0.0.1:12345/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# PHASE 2 OPTIMIZATION: Enhanced reasoning suppression with explicit JSON-only instruction
SYSTEM_PROMPT = (
    "You are a Pokémon card identification assistant. Given an image, respond "
    "only with JSON containing name, hp, and set_number fields. Do not include "
    "confidence values or extra commentary.\n\n"
    "IMPORTANT: For set_number identification, look specifically in the bottom 15% "
    "of the image in either the left or right corner. The set number appears as "
    "a fraction format like '25/102' or just a number like '25'. Do NOT confuse "
    "this with level indicators (LV.XX) or other text elements on the card.\n\n"
    "CRITICAL: Output ONLY valid JSON. No reasoning, no explanations, no thinking process. "
    "Identify the Pokemon card directly and respond immediately with ONLY the JSON: "
    "{\"name\": \"...\", \"hp\": 123, \"set_number\": \"...\"}"
)

RESPONSE_SCHEMA: Dict[str, Any] = {
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
FIRST_TEN_DIR = Path.home() / "Pictures" / "pokemoncards" / "first-ten"
GROUND_TRUTH_JSON = Path.home() / "Pictures" / "pokemoncards" / "pokemon_cards.json"


def encode_image_to_data_url(image_path: Path) -> str:
    """Load image, ensure RGB, and return a data URL with base64 content."""
    with Image.open(image_path) as img:
        rgb_image = img.convert("RGB")
        buffer = BytesIO()
        rgb_image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"


def load_ground_truth(path: Path) -> Dict[str, Dict[str, Any]]:
    """Load ground-truth metadata keyed by card ID (derived from filenames)."""
    with path.open("r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)
    return {record["id"]: record for record in records}


def build_messages(image_data_url: str) -> List[Dict[str, Any]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Identify the Pokémon card."},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]


def parse_prediction(raw_content: str) -> Dict[str, Any]:
    try:
        return json.loads(raw_content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model output is not valid JSON: {raw_content}") from exc


def normalize_card_id(image_path: Path) -> str:
    return image_path.stem


def resolve_truth_set_number(truth: Dict[str, Any], card_id: str) -> str:
    """Return the best available set number string for comparisons and logs."""
    image_url = truth.get("image_url", "")
    if image_url:
        parsed = urlparse(image_url)
        stem = Path(parsed.path).stem
        if stem:
            number_part = stem.split("_")[0]
            if number_part:
                return number_part

    if "-" in card_id:
        return card_id.split("-", 1)[1]

    card_number = str(truth.get("card_number", "")).strip()
    if card_number and card_number.lower() != "nan":
        return card_number
    return card_id


def compare_fields(pred: Dict[str, Any], truth: Dict[str, Any], card_id: str) -> Dict[str, bool]:
    expected_name = truth.get("name", "").strip().lower()
    expected_hp = truth.get("hp")
    expected_card_number = resolve_truth_set_number(truth, card_id).strip().lower()

    provided_name = str(pred.get("name", "")).strip().lower()
    provided_hp = pred.get("hp")
    provided_set_number = str(pred.get("set_number", "")).strip().lower()

    set_number_matches = provided_set_number == expected_card_number or (
        expected_card_number and expected_card_number in provided_set_number
    )

    return {
        "name_correct": provided_name == expected_name,
        "hp_correct": provided_hp == expected_hp,
        "set_number_correct": set_number_matches,
    }


def identify_card(
    client: OpenAI, image_path: Path, *, max_tokens: int = 50  # PHASE 2: Reduced from 75 to 50
) -> Tuple[Dict[str, Any], Dict[str, float]]:
    """Identify a card and return both prediction and timing metrics."""
    timing = {}

    # Time image encoding
    encode_start = time.perf_counter()
    data_url = encode_image_to_data_url(image_path)
    timing['image_encode_ms'] = (time.perf_counter() - encode_start) * 1000

    # Time inference
    inference_start = time.perf_counter()
    response = client.chat.completions.create(
        model=DEFAULT_MODEL_ID,
        messages=build_messages(data_url),
        temperature=0,
        seed=0,
        max_tokens=max_tokens,
        response_format=RESPONSE_SCHEMA,
        # PHASE 2: More aggressive context reduction from 2K to 1K tokens
        extra_body={"context_length": 1024}
    )
    timing['inference_ms'] = (time.perf_counter() - inference_start) * 1000

    # Time parsing
    parse_start = time.perf_counter()
    raw_content = response.choices[0].message.content
    if raw_content is None:
        raise RuntimeError("Model returned empty content")
    prediction = parse_prediction(raw_content)
    timing['parse_ms'] = (time.perf_counter() - parse_start) * 1000

    # Total processing time
    timing['total_ms'] = timing['image_encode_ms'] + timing['inference_ms'] + timing['parse_ms']

    return prediction, timing


def evaluate_batch(image_paths: Iterable[Path]) -> Tuple[List[Dict[str, Any]], Dict[str, int], Dict[str, float]]:
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    truth = load_ground_truth(GROUND_TRUTH_JSON)

    results: List[Dict[str, Any]] = []
    tally = {"name_correct": 0, "hp_correct": 0, "set_number_correct": 0}
    timing_totals = {
        "total_batch_ms": 0,
        "total_inference_ms": 0,
        "total_encode_ms": 0,
        "total_parse_ms": 0,
        "card_count": 0
    }

    batch_start = time.perf_counter()

    for image_path in image_paths:
        card_id = normalize_card_id(image_path)
        ground_truth = truth.get(card_id)
        if not ground_truth:
            print(f"[WARN] No ground truth for {card_id}; skipping.", file=sys.stderr)
            continue

        card_start = time.perf_counter()
        prediction, timing = identify_card(client, image_path)
        card_total_ms = (time.perf_counter() - card_start) * 1000

        truth_set_number = resolve_truth_set_number(ground_truth, card_id)
        comparison = compare_fields(prediction, ground_truth, card_id)

        for key, value in comparison.items():
            if value:
                tally[key] += 1

        # Accumulate timing statistics
        timing_totals["total_inference_ms"] += timing["inference_ms"]
        timing_totals["total_encode_ms"] += timing["image_encode_ms"]
        timing_totals["total_parse_ms"] += timing["parse_ms"]
        timing_totals["card_count"] += 1

        result_record = {
            "image_file": str(image_path),
            "predicted_name": prediction.get("name"),
            "predicted_hp": prediction.get("hp"),
            "predicted_set_number": prediction.get("set_number"),
            "ground_truth_name": ground_truth.get("name"),
            "ground_truth_hp": ground_truth.get("hp"),
            "ground_truth_set_number": truth_set_number,
            "ground_truth_set_number_raw": ground_truth.get("card_number"),
            # Performance metrics per card
            "inference_time_ms": round(timing["inference_ms"], 2),
            "encode_time_ms": round(timing["image_encode_ms"], 2),
            "parse_time_ms": round(timing["parse_ms"], 2),
            "total_card_time_ms": round(card_total_ms, 2)
        }
        result_record.update(comparison)
        results.append(result_record)

    timing_totals["total_batch_ms"] = (time.perf_counter() - batch_start) * 1000

    # Calculate averages and throughput
    if timing_totals["card_count"] > 0:
        timing_totals["avg_inference_ms"] = timing_totals["total_inference_ms"] / timing_totals["card_count"]
        timing_totals["avg_encode_ms"] = timing_totals["total_encode_ms"] / timing_totals["card_count"]
        timing_totals["avg_parse_ms"] = timing_totals["total_parse_ms"] / timing_totals["card_count"]
        timing_totals["avg_card_ms"] = timing_totals["total_batch_ms"] / timing_totals["card_count"]
        timing_totals["cards_per_second"] = timing_totals["card_count"] / (timing_totals["total_batch_ms"] / 1000)

    return results, tally, timing_totals


def write_results(results: List[Dict[str, Any]], output_path: Path) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


def determine_output_path(prefix: str = "id-results-phase2") -> Path:
    timestamp = dt.datetime.now().strftime("%d%b%y")
    filename = f"{prefix}-{timestamp}.json"
    return Path(filename)


def collect_first_ten() -> List[Path]:
    if not FIRST_TEN_DIR.exists():
        raise FileNotFoundError(f"Missing directory: {FIRST_TEN_DIR}")
    return sorted(FIRST_TEN_DIR.glob("*.png"))


def wait_for_model_ready(client: OpenAI, max_wait_seconds: int = 300) -> bool:
    """Wait for model to be ready for inference after cold start.

    LM Studio loads the ~15GB magistral-small-2509 model into memory which takes 3-4 minutes.
    This function tests model readiness with a minimal inference request.
    """
    print(f"⏳ Waiting for {DEFAULT_MODEL_ID} to load (up to {max_wait_seconds}s)...")

    # Simple test message to verify model inference readiness
    test_messages = [
        {"role": "system", "content": "Respond with just 'ready'"},
        {"role": "user", "content": "Test"}
    ]

    start_time = time.perf_counter()
    while time.perf_counter() - start_time < max_wait_seconds:
        try:
            response = client.chat.completions.create(
                model=DEFAULT_MODEL_ID,
                messages=test_messages,
                temperature=0,
                max_tokens=10,
                timeout=30  # Short timeout per request
            )
            if response.choices[0].message.content:
                elapsed = time.perf_counter() - start_time
                print(f"✅ Model ready after {elapsed:.1f}s")
                return True
        except Exception as e:
            print(f"⏳ Model not ready yet ({time.perf_counter() - start_time:.1f}s): {str(e)[:50]}...")
            time.sleep(10)  # Check every 10 seconds

    print(f"❌ Model failed to become ready within {max_wait_seconds}s")
    return False


def main(args: argparse.Namespace) -> int:
    image_paths = collect_first_ten()
    if not image_paths:
        print("No images found in first-ten directory.", file=sys.stderr)
        return 1

    print(f"🔬 Starting CardMint PHASE 2 test on {len(image_paths)} cards...")
    print(f"Target: {DEFAULT_SERVER_URL} | Model: {DEFAULT_MODEL_ID}")
    print("Phase 2 Optimizations: 1K context, 50 max_tokens, aggressive reasoning suppression")
    print("=" * 75)

    # Wait for model to be ready (critical for cold-start)
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    if not wait_for_model_ready(client):
        print("❌ Model not ready - aborting Phase 2 test", file=sys.stderr)
        return 1

    # Model is ready - proceed with batch evaluation
    print(f"🔬 Model ready - starting PHASE 2 batch evaluation...\n")
    results, tally, timing_stats = evaluate_batch(image_paths)
    output_path = determine_output_path()
    write_results(results, output_path)

    # Performance Summary
    print(f"\n📊 PHASE 2 PERFORMANCE METRICS")
    print(f"Total batch time: {timing_stats['total_batch_ms']:.0f}ms")
    print(f"Cards processed: {timing_stats['card_count']}")
    print(f"Average per card: {timing_stats['avg_card_ms']:.1f}ms")
    print(f"Throughput: {timing_stats['cards_per_second']:.2f} cards/sec")

    print(f"\n⚡ BREAKDOWN (averages):")
    print(f"  Image encoding: {timing_stats['avg_encode_ms']:.1f}ms")
    print(f"  LM Studio inference: {timing_stats['avg_inference_ms']:.1f}ms")
    print(f"  JSON parsing: {timing_stats['avg_parse_ms']:.1f}ms")

    # Accuracy Summary
    print(f"\n🎯 PHASE 2 ACCURACY RESULTS")
    total_cards = len(results)
    name_acc = tally['name_correct'] / total_cards * 100
    hp_acc = tally['hp_correct'] / total_cards * 100
    set_acc = tally['set_number_correct'] / total_cards * 100
    avg_acc = (name_acc + hp_acc + set_acc) / 3

    print(f"Name accuracy: {tally['name_correct']}/{total_cards} ({name_acc:.1f}%)")
    print(f"HP accuracy: {tally['hp_correct']}/{total_cards} ({hp_acc:.1f}%)")
    print(f"Set number accuracy: {tally['set_number_correct']}/{total_cards} ({set_acc:.1f}%)")
    print(f"Average accuracy: {avg_acc:.1f}%")

    # Success criteria check
    if avg_acc >= 95.0:
        print(f"✅ SUCCESS: {avg_acc:.1f}% meets ≥95% accuracy target")
    else:
        print(f"⚠️  WARNING: {avg_acc:.1f}% below 95% accuracy target")

    print(f"\n💾 Phase 2 results saved to: {output_path}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    exit_code = main(parser.parse_args())
    sys.exit(exit_code)