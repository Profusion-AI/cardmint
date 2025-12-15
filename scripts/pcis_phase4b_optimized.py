#!/usr/bin/env python3
"""Phase 4B Optimized Configuration - Performance Recovery Implementation.

This script implements the performance optimizations identified for Phase 4B readiness:

OPTIMIZATIONS IMPLEMENTED:
1. Context Reduction: 768 → 512 tokens (33% reduction)
2. Token Limit: 40 → 30 tokens (25% reduction)
3. Enhanced Reasoning Suppression: Ultra-concise prompt
4. Performance Monitoring: Real-time alerting for >20s inference

Based on Phase 4A analysis showing 26.9s average vs 15s target.
Target: Achieve ≤18s average inference and ≥95% accuracy for Phase 4B readiness.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import psutil
import subprocess
import sys
import time
import gc
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple, Optional
from urllib.parse import urlparse

from openai import OpenAI
from PIL import Image

# Import daemon integration
from daemon_integration import require_keepwarm_daemon

DEFAULT_SERVER_URL = "http://127.0.0.1:12345/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# OPTIMIZATION 1: Concise prompt with critical set_number instructions preserved
OPTIMIZED_SYSTEM_PROMPT = (
    "Pokemon card identifier. Return ONLY JSON: {\"name\": \"...\", \"hp\": 123, \"set_number\": \"...\"}. "
    "CRITICAL: Set number is in bottom 15% of image, left or right corner. "
    "Format: '25/102' or '25'. NOT level (LV.XX). No reasoning."
)

# OPTIMIZATION 2: Streamlined schema
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

# Test configurations
FIRST_TWENTYFIVE_DIR = Path.home() / "Pictures" / "pokemoncards" / "first-twentyfive"
GROUND_TRUTH_JSON = Path.home() / "Pictures" / "pokemoncards" / "pokemon_cards.json"

# Performance monitoring thresholds
SLOW_INFERENCE_THRESHOLD_MS = 20000  # 20s threshold for alerts
ACCURACY_TARGET = 0.95  # 95% accuracy target

class OptimizedMetrics:
    """Performance metrics with regression detection."""

    def __init__(self):
        self.start_time = time.time()
        self.inference_times = []
        self.accuracy_stats = {"name": 0, "hp": 0, "set_number": 0, "total": 0}
        self.slow_cards = []

    def add_inference(self, inference_ms: float, card_info: Dict[str, Any]):
        """Add inference timing and accuracy data."""
        self.inference_times.append(inference_ms)

        # Track slow inferences
        if inference_ms > SLOW_INFERENCE_THRESHOLD_MS:
            self.slow_cards.append({
                "card": card_info.get("image_file", "unknown"),
                "time_ms": inference_ms,
                "card_number": len(self.inference_times)
            })
            print(f"⚠️  SLOW INFERENCE ALERT: Card {len(self.inference_times)} took {inference_ms/1000:.1f}s")

        # Track accuracy
        self.accuracy_stats["total"] += 1
        if card_info.get("name_correct"):
            self.accuracy_stats["name"] += 1
        if card_info.get("hp_correct"):
            self.accuracy_stats["hp"] += 1
        if card_info.get("set_number_correct"):
            self.accuracy_stats["set_number"] += 1

    def get_performance_summary(self) -> Dict[str, Any]:
        """Get comprehensive performance metrics."""
        if not self.inference_times:
            return {}

        avg_time = sum(self.inference_times) / len(self.inference_times)
        variance = (sum((t - avg_time) ** 2 for t in self.inference_times) / len(self.inference_times)) ** 0.5
        variance_percent = (variance / avg_time) * 100

        total = self.accuracy_stats["total"]
        accuracies = {
            "name": self.accuracy_stats["name"] / total if total > 0 else 0,
            "hp": self.accuracy_stats["hp"] / total if total > 0 else 0,
            "set_number": self.accuracy_stats["set_number"] / total if total > 0 else 0,
        }

        full_accuracy = min(accuracies["name"], accuracies["hp"], accuracies["set_number"])

        # Performance gate assessment
        time_gate = avg_time <= 18000  # 18s target
        accuracy_gate = full_accuracy >= ACCURACY_TARGET
        variance_gate = variance_percent <= 15.0

        return {
            "performance": {
                "avg_inference_ms": avg_time,
                "min_inference_ms": min(self.inference_times),
                "max_inference_ms": max(self.inference_times),
                "variance_percent": variance_percent,
                "total_cards": len(self.inference_times),
                "slow_cards_count": len(self.slow_cards),
                "slow_cards": self.slow_cards
            },
            "accuracy": {
                **accuracies,
                "full_card_accuracy": full_accuracy,
                "total_cards": total
            },
            "phase4b_readiness": {
                "time_gate": time_gate,
                "accuracy_gate": accuracy_gate,
                "variance_gate": variance_gate,
                "ready": time_gate and accuracy_gate and variance_gate,
                "target_time_ms": 18000,
                "target_accuracy": ACCURACY_TARGET,
                "target_variance": 15.0
            }
        }


def encode_image_to_data_url(image_path: Path) -> Tuple[str, Dict[str, float]]:
    """Load image, ensure RGB, and return a data URL with base64 content plus timing."""
    timing = {}

    load_start = time.perf_counter()
    with Image.open(image_path) as img:
        timing['image_load_ms'] = (time.perf_counter() - load_start) * 1000

        convert_start = time.perf_counter()
        rgb_image = img.convert("RGB")
        timing['rgb_convert_ms'] = (time.perf_counter() - convert_start) * 1000

        encode_start = time.perf_counter()
        buffer = BytesIO()
        rgb_image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        timing['base64_encode_ms'] = (time.perf_counter() - encode_start) * 1000

        timing['total_encode_ms'] = sum(timing.values())

        return f"data:image/png;base64,{encoded}", timing


def build_optimized_messages(image_data_url: str) -> List[Dict[str, Any]]:
    """Build messages with optimized prompt."""
    return [
        {"role": "system", "content": OPTIMIZED_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Identify this Pokemon card."},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]


def optimized_inference_request(client: OpenAI, image_path: Path, *,
                               context_tokens: int = 512, max_tokens: int = 30) -> Dict[str, Any]:
    """Execute inference with optimized parameters."""

    # Image encoding
    encode_start = time.perf_counter()
    image_data_url, encode_timing = encode_image_to_data_url(image_path)
    encode_time_ms = (time.perf_counter() - encode_start) * 1000

    messages = build_optimized_messages(image_data_url)

    # Inference timing
    inference_start = time.perf_counter()

    # OPTIMIZATION: Reduced context and max tokens
    response = client.chat.completions.create(
        model=DEFAULT_MODEL_ID,
        messages=messages,
        temperature=0,
        seed=0,
        max_tokens=max_tokens,
        response_format=RESPONSE_SCHEMA,
        extra_body={"context_length": context_tokens}  # OPTIMIZED from 768
    )

    inference_time_ms = (time.perf_counter() - inference_start) * 1000

    # Parse response
    parse_start = time.perf_counter()
    try:
        prediction = json.loads(response.choices[0].message.content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model output is not valid JSON: {response.choices[0].message.content}") from exc
    parse_time_ms = (time.perf_counter() - parse_start) * 1000

    return {
        "prediction": prediction,
        "timing": {
            "encode_ms": encode_time_ms,
            "inference_ms": inference_time_ms,
            "parse_ms": parse_time_ms,
            "total_ms": encode_time_ms + inference_time_ms + parse_time_ms
        },
        "encoding_breakdown": encode_timing
    }


def load_ground_truth(path: Path) -> Dict[str, Dict[str, Any]]:
    """Load ground-truth metadata keyed by card ID (derived from filenames)."""
    with path.open("r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)
    return {record["id"]: record for record in records}


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
    expected_set_number = resolve_truth_set_number(truth, card_id)

    pred_name = pred.get("name", "").strip().lower()
    pred_hp = pred.get("hp")
    pred_set_number = str(pred.get("set_number", "")).strip()

    # Handle set number comparison - accept both "1/64" and "1" formats
    set_number_correct = False
    if pred_set_number == expected_set_number:
        set_number_correct = True
    elif "/" in pred_set_number:
        # If prediction is "1/64" and expected is "1", extract the numerator
        pred_numerator = pred_set_number.split("/")[0].strip()
        set_number_correct = pred_numerator == expected_set_number

    return {
        "name_correct": pred_name == expected_name,
        "hp_correct": pred_hp == expected_hp,
        "set_number_correct": set_number_correct,
    }


def run_optimized_test(image_paths: List[Path], ground_truth: Dict[str, Dict[str, Any]],
                      context_tokens: int, max_tokens: int, test_name: str) -> Dict[str, Any]:
    """Run optimized inference test with performance monitoring."""

    # Initialize client and metrics
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    metrics = OptimizedMetrics()

    results = []

    print(f"\n🚀 Running {test_name}")
    print(f"📊 Config: {context_tokens} context, {max_tokens} max_tokens")
    print(f"🎯 Target: ≤18s avg, ≥95% accuracy, ≤15% variance")

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        truth = ground_truth.get(card_id, {})

        print(f"[{i:2d}/{len(image_paths)}] {card_id}", end=" ... ", flush=True)

        try:
            # Run inference
            result = optimized_inference_request(client, image_path,
                                               context_tokens=context_tokens,
                                               max_tokens=max_tokens)

            # Compare with ground truth
            comparison = compare_fields(result["prediction"], truth, card_id)

            # Build result record
            card_result = {
                "card_number": i,
                "image_file": str(image_path),
                "card_id": card_id,
                "prediction": result["prediction"],
                "ground_truth": {
                    "name": truth.get("name", ""),
                    "hp": truth.get("hp"),
                    "set_number": resolve_truth_set_number(truth, card_id)
                },
                "comparison": comparison,
                "timing": result["timing"],
                "success": True
            }

            results.append(card_result)

            # Add to metrics
            metrics.add_inference(result["timing"]["inference_ms"], {
                "image_file": str(image_path),
                **comparison
            })

            # Progress output
            accuracy_symbols = [
                "✓" if comparison["name_correct"] else "✗",
                "✓" if comparison["hp_correct"] else "✗",
                "✓" if comparison["set_number_correct"] else "✗"
            ]
            print(f"{result['timing']['inference_ms']/1000:.1f}s {''.join(accuracy_symbols)}")

        except Exception as e:
            print(f"❌ FAILED: {e}")
            card_result = {
                "card_number": i,
                "image_file": str(image_path),
                "card_id": card_id,
                "error": str(e),
                "success": False
            }
            results.append(card_result)

    # Generate comprehensive report
    performance_summary = metrics.get_performance_summary()

    return {
        "test_metadata": {
            "test_name": test_name,
            "context_tokens": context_tokens,
            "max_tokens": max_tokens,
            "total_cards": len(image_paths),
            "timestamp": dt.datetime.now().isoformat()
        },
        "results": results,
        "performance_summary": performance_summary
    }


def main():
    parser = argparse.ArgumentParser(description="Phase 4B Optimized Performance Test")
    parser.add_argument("--context", type=int, default=512, help="Context window size (default: 512)")
    parser.add_argument("--max-tokens", type=int, default=30, help="Max tokens (default: 30)")
    parser.add_argument("--cards-limit", type=int, help="Limit number of cards for testing")
    parser.add_argument("--test-name", type=str, default="Phase4B-Optimized", help="Test name for results")

    args = parser.parse_args()

    # Check daemon status
    require_keepwarm_daemon()

    # Load data
    if not FIRST_TWENTYFIVE_DIR.exists():
        print(f"❌ Error: Image directory not found: {FIRST_TWENTYFIVE_DIR}")
        return 1

    image_paths = sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))[:args.cards_limit] if args.cards_limit else sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))

    if not image_paths:
        print(f"❌ Error: No PNG images found in {FIRST_TWENTYFIVE_DIR}")
        return 1

    ground_truth = load_ground_truth(GROUND_TRUTH_JSON)

    # Run test
    test_results = run_optimized_test(image_paths, ground_truth, args.context, args.max_tokens, args.test_name)

    # Save results
    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")
    results_file = Path(f"results/{args.test_name.lower()}-results-{timestamp}.json")
    results_file.parent.mkdir(exist_ok=True)

    with results_file.open("w") as f:
        json.dump(test_results, f, indent=2)

    # Print summary
    perf = test_results["performance_summary"]
    print(f"\n📊 PERFORMANCE SUMMARY")
    print(f"{'='*50}")

    if perf:
        performance = perf["performance"]
        accuracy = perf["accuracy"]
        readiness = perf["phase4b_readiness"]

        print(f"⏱️  Average Inference: {performance['avg_inference_ms']/1000:.1f}s (target: ≤18s)")
        print(f"📈 Variance: {performance['variance_percent']:.1f}% (target: ≤15%)")
        print(f"🎯 Full Accuracy: {accuracy['full_card_accuracy']*100:.1f}% (target: ≥95%)")
        print(f"⚠️  Slow Cards: {performance['slow_cards_count']} (>20s threshold)")

        print(f"\n🚦 PHASE 4B READINESS ASSESSMENT")
        print(f"{'='*50}")
        print(f"⏱️  Time Gate (<18s): {'✅ PASS' if readiness['time_gate'] else '❌ FAIL'}")
        print(f"🎯 Accuracy Gate (≥95%): {'✅ PASS' if readiness['accuracy_gate'] else '❌ FAIL'}")
        print(f"📊 Variance Gate (<15%): {'✅ PASS' if readiness['variance_gate'] else '❌ FAIL'}")
        print(f"🚀 READY FOR PHASE 4B: {'✅ YES' if readiness['ready'] else '❌ NO'}")

        if not readiness['ready']:
            print(f"\n🔧 OPTIMIZATION RECOMMENDATIONS:")
            if not readiness['time_gate']:
                print(f"   • Further context reduction needed")
                print(f"   • Enhanced daemon warmup strategy")
            if not readiness['accuracy_gate']:
                print(f"   • Prompt engineering improvements")
                print(f"   • Set number detection refinement")

    print(f"\n💾 Results saved: {results_file}")
    return 0


if __name__ == "__main__":
    exit(main())