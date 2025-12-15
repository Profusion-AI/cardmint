#!/usr/bin/env python3
"""Phase 4A-mini - Rapid Iteration Test Script.

A lightweight 5-card test harness for quickly testing optimization configurations.
Designed for rapid A/B testing and parameter tuning before full-scale validation.

Benefits:
- Fast iteration (~1 minute per test)
- Quick validation of configuration changes
- Immediate performance feedback
- Minimal resource consumption
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import urlparse

from openai import OpenAI
from PIL import Image

# Import daemon integration
from daemon_integration import check_keepwarm_daemon_optional

DEFAULT_SERVER_URL = "http://127.0.0.1:12345/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# Test configurations
TEST_CONFIGS = {
    "baseline": {
        "name": "Baseline (Phase 3A)",
        "context": 768,
        "max_tokens": 40,
        "prompt": "standard"
    },
    "optimized-1": {
        "name": "Optimized-1 (Reduced Context)",
        "context": 512,
        "max_tokens": 40,
        "prompt": "standard"
    },
    "optimized-2": {
        "name": "Optimized-2 (Reduced Tokens)",
        "context": 768,
        "max_tokens": 30,
        "prompt": "standard"
    },
    "optimized-3": {
        "name": "Optimized-3 (Combined Reduction)",
        "context": 512,
        "max_tokens": 30,
        "prompt": "standard"
    },
    "aggressive": {
        "name": "Aggressive (Ultra-minimal)",
        "context": 256,
        "max_tokens": 25,
        "prompt": "minimal"
    }
}

# Prompt variants
PROMPTS = {
    "standard": (
        "You are a Pokémon card identification assistant. Given an image, respond "
        "only with JSON containing name, hp, and set_number fields. Do not include "
        "confidence values or extra commentary.\\n\\n"
        "IMPORTANT: For set_number identification, look specifically in the bottom 15% "
        "of the image in either the left or right corner. The set number appears as "
        "a fraction format like '25/102' or just a number like '25'. Do NOT confuse "
        "this with level indicators (LV.XX) or other text elements on the card.\\n\\n"
        "CRITICAL: Output ONLY valid JSON. No reasoning, no explanations, no thinking process. "
        "Identify the Pokemon card directly and respond immediately with ONLY the JSON: "
        "{\\\"name\\\": \\\"...\\\", \\\"hp\\\": 123, \\\"set_number\\\": \\\"...\\\"}"
    ),
    "minimal": (
        "Pokemon card identifier. JSON only: {\\\"name\\\": \\\"...\\\", \\\"hp\\\": 123, \\\"set_number\\\": \\\"...\\\"}. "
        "Set number in bottom corners."
    ),
    "ultra-minimal": "Identify Pokemon card. Return JSON: name, hp, set_number."
}

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

FIRST_TWENTYFIVE_DIR = Path.home() / "Pictures" / "pokemoncards" / "first-twentyfive"
GROUND_TRUTH_JSON = Path.home() / "Pictures" / "pokemoncards" / "pokemon_cards.json"
MINI_TEST_SIZE = 5  # Fixed size for rapid testing


def encode_image_to_data_url(image_path: Path) -> Tuple[str, float]:
    """Load image and return data URL with encoding time."""
    start = time.perf_counter()
    with Image.open(image_path) as img:
        rgb_image = img.convert("RGB")
        buffer = BytesIO()
        rgb_image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    encode_time_ms = (time.perf_counter() - start) * 1000
    return f"data:image/png;base64,{encoded}", encode_time_ms


def load_ground_truth(path: Path) -> Dict[str, Dict[str, Any]]:
    """Load ground-truth metadata keyed by card ID."""
    with path.open("r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)
    return {record["id"]: record for record in records}


def normalize_card_id(image_path: Path) -> str:
    return image_path.stem


def resolve_truth_set_number(truth: Dict[str, Any], card_id: str) -> str:
    """Return the best available set number string."""
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


def run_mini_test(config_name: str) -> Dict[str, Any]:
    """Run a mini test with specified configuration."""

    config = TEST_CONFIGS[config_name]
    print(f"\n🧪 Running Mini Test: {config['name']}")
    print(f"   Context: {config['context']} tokens")
    print(f"   Max Tokens: {config['max_tokens']} tokens")
    print(f"   Prompt: {config['prompt']}")
    print(f"   Cards: {MINI_TEST_SIZE}")

    # Initialize client
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")

    # Load test data
    image_paths = sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))[:MINI_TEST_SIZE]
    ground_truth = load_ground_truth(GROUND_TRUTH_JSON)

    results = []
    inference_times = []
    accuracy_counts = {"name": 0, "hp": 0, "set": 0}

    test_start = time.time()

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        truth = ground_truth.get(card_id, {})

        print(f"   [{i}/{MINI_TEST_SIZE}] {card_id}", end=" ... ", flush=True)

        try:
            # Encode image
            image_data_url, encode_ms = encode_image_to_data_url(image_path)

            # Build messages
            system_prompt = PROMPTS[config["prompt"]]
            messages = [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Identify the Pokémon card."},
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                },
            ]

            # Run inference
            inference_start = time.perf_counter()
            response = client.chat.completions.create(
                model=DEFAULT_MODEL_ID,
                messages=messages,
                temperature=0,
                seed=0,
                max_tokens=config["max_tokens"],
                response_format=RESPONSE_SCHEMA,
                extra_body={"context_length": config["context"]}
            )
            inference_ms = (time.perf_counter() - inference_start) * 1000
            inference_times.append(inference_ms)

            # Parse response
            prediction = json.loads(response.choices[0].message.content)

            # Compare with ground truth
            expected_name = truth.get("name", "").strip().lower()
            expected_hp = truth.get("hp")
            expected_set = resolve_truth_set_number(truth, card_id)

            pred_name = prediction.get("name", "").strip().lower()
            pred_hp = prediction.get("hp")
            pred_set = str(prediction.get("set_number", "")).strip()

            name_correct = pred_name == expected_name
            hp_correct = pred_hp == expected_hp
            set_correct = pred_set == expected_set

            if name_correct:
                accuracy_counts["name"] += 1
            if hp_correct:
                accuracy_counts["hp"] += 1
            if set_correct:
                accuracy_counts["set"] += 1

            # Display result
            accuracy_str = f"{'✓' if name_correct else '✗'}{'✓' if hp_correct else '✗'}{'✓' if set_correct else '✗'}"
            print(f"{inference_ms/1000:.1f}s {accuracy_str}")

            results.append({
                "card": card_id,
                "inference_ms": inference_ms,
                "name_correct": name_correct,
                "hp_correct": hp_correct,
                "set_correct": set_correct
            })

        except Exception as e:
            print(f"❌ ERROR: {e}")
            results.append({
                "card": card_id,
                "error": str(e)
            })

    test_duration = time.time() - test_start

    # Calculate summary statistics
    if inference_times:
        avg_inference = sum(inference_times) / len(inference_times)
        min_inference = min(inference_times)
        max_inference = max(inference_times)
    else:
        avg_inference = min_inference = max_inference = 0

    accuracy_pct = {
        "name": (accuracy_counts["name"] / MINI_TEST_SIZE) * 100,
        "hp": (accuracy_counts["hp"] / MINI_TEST_SIZE) * 100,
        "set": (accuracy_counts["set"] / MINI_TEST_SIZE) * 100
    }
    full_accuracy = min(accuracy_pct.values())

    return {
        "config": config,
        "results": results,
        "summary": {
            "total_duration_s": test_duration,
            "avg_inference_ms": avg_inference,
            "min_inference_ms": min_inference,
            "max_inference_ms": max_inference,
            "accuracy": {
                "name_pct": accuracy_pct["name"],
                "hp_pct": accuracy_pct["hp"],
                "set_pct": accuracy_pct["set"],
                "full_card_pct": full_accuracy
            }
        }
    }


def compare_configs(results: List[Dict[str, Any]]):
    """Compare results from multiple configurations."""

    print("\n" + "="*70)
    print("📊 CONFIGURATION COMPARISON")
    print("="*70)

    # Sort by average inference time
    results.sort(key=lambda x: x["summary"]["avg_inference_ms"])

    baseline_time = None
    for i, result in enumerate(results):
        config = result["config"]
        summary = result["summary"]

        if i == 0:
            baseline_time = summary["avg_inference_ms"]

        speedup = ((baseline_time - summary["avg_inference_ms"]) / baseline_time) * 100 if baseline_time else 0

        print(f"\n{i+1}. {config['name']}")
        print(f"   Config: {config['context']} context / {config['max_tokens']} tokens")
        print(f"   Speed: {summary['avg_inference_ms']/1000:.1f}s avg ({speedup:+.1f}% vs fastest)")
        print(f"   Accuracy: {summary['accuracy']['full_card_pct']:.0f}% full card")
        print(f"   Details: Name={summary['accuracy']['name_pct']:.0f}%, "
              f"HP={summary['accuracy']['hp_pct']:.0f}%, "
              f"Set={summary['accuracy']['set_pct']:.0f}%")

    # Find optimal configuration
    print("\n" + "="*70)
    optimal = None
    for result in results:
        if (result["summary"]["avg_inference_ms"] <= 18000 and
            result["summary"]["accuracy"]["full_card_pct"] >= 80):  # Relaxed for mini test
            optimal = result
            break

    if optimal:
        print(f"✅ RECOMMENDED: {optimal['config']['name']}")
        print(f"   Meets performance targets with good accuracy")
    else:
        print(f"⚠️  No configuration meets all targets")
        print(f"   Consider further optimization or hybrid approach")


def main():
    parser = argparse.ArgumentParser(description="Phase 4A-mini Rapid Test")
    parser.add_argument("--config", choices=list(TEST_CONFIGS.keys()),
                       help="Run specific configuration")
    parser.add_argument("--compare", nargs="+", choices=list(TEST_CONFIGS.keys()),
                       help="Compare multiple configurations")
    parser.add_argument("--all", action="store_true",
                       help="Test all configurations")

    args = parser.parse_args()

    # Check daemon (warn but continue)
    check_keepwarm_daemon_optional()

    # Verify test data
    if not FIRST_TWENTYFIVE_DIR.exists():
        print(f"❌ Error: Image directory not found: {FIRST_TWENTYFIVE_DIR}")
        return 1

    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")

    if args.config:
        # Single configuration test
        result = run_mini_test(args.config)

        # Save results
        output_file = Path(f"results/mini-{args.config}-{timestamp}.json")
        output_file.parent.mkdir(exist_ok=True)
        with output_file.open("w") as f:
            json.dump(result, f, indent=2)

        # Print summary
        summary = result["summary"]
        print(f"\n📊 SUMMARY: {result['config']['name']}")
        print(f"   Average: {summary['avg_inference_ms']/1000:.1f}s")
        print(f"   Accuracy: {summary['accuracy']['full_card_pct']:.0f}%")
        print(f"💾 Saved: {output_file}")

    elif args.compare or args.all:
        # Multiple configuration comparison
        configs = args.compare if args.compare else list(TEST_CONFIGS.keys())
        all_results = []

        for config_name in configs:
            result = run_mini_test(config_name)
            all_results.append(result)

        # Save combined results
        output_file = Path(f"results/mini-comparison-{timestamp}.json")
        output_file.parent.mkdir(exist_ok=True)
        with output_file.open("w") as f:
            json.dump(all_results, f, indent=2)

        # Compare configurations
        compare_configs(all_results)
        print(f"\n💾 Results saved: {output_file}")

    else:
        # Default: run baseline
        result = run_mini_test("baseline")
        summary = result["summary"]
        print(f"\n📊 BASELINE SUMMARY")
        print(f"   Average: {summary['avg_inference_ms']/1000:.1f}s")
        print(f"   Accuracy: {summary['accuracy']['full_card_pct']:.0f}%")

    return 0


if __name__ == "__main__":
    exit(main())