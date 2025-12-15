#!/usr/bin/env python3
"""Phase 3B Ultra-Aggressive Optimization - Maximum Reduction Test.

This script implements Phase 3B optimizations with lessons from Phase 3A variance discovery:
- Phase 3A showed 22.4% improvement with warm system (768 context + 40 max_tokens)
- Phase 3B tests maximum aggressive reduction: 512 context + 30 max_tokens
- CRITICAL: Includes warm-up protocol to avoid 36.5% performance variance

Optimizations Applied:
1. Maximum context reduction: 1K → 512 tokens (50% reduction from Phase 2)
2. Maximum max_tokens: 50 → 30 tokens (40% reduction from Phase 2)
3. System warm-up protocol: Pre-run inference to establish optimal GPU/memory state
4. Enhanced observability with Phase 2/3A comparison metrics

Target: Test the absolute limits of context/token reduction while maintaining accuracy.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import psutil
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

# PHASE 3B: Same aggressive reasoning suppression, optimized for ultra-minimal tokens
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


def get_system_metrics() -> Dict[str, Any]:
    """Capture system metrics for observability."""
    try:
        memory = psutil.virtual_memory()
        cpu_percent = psutil.cpu_percent(interval=0.1)
        return {
            "memory_used_gb": round(memory.used / (1024**3), 2),
            "memory_available_gb": round(memory.available / (1024**3), 2),
            "memory_percent": memory.percent,
            "cpu_percent": cpu_percent,
            "timestamp": time.time()
        }
    except Exception as e:
        return {"error": str(e), "timestamp": time.time()}


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


def system_warmup(client: OpenAI) -> Dict[str, float]:
    """Execute system warm-up to establish optimal GPU/memory state.

    Based on Phase 3A findings, this prevents 36.5% performance variance
    by pre-loading optimal Vulkan/GPU memory patterns.
    """
    print("🔥 Starting system warm-up protocol...")
    warmup_timing = {}

    # Simple warm-up inference to establish system state
    warmup_start = time.perf_counter()

    warmup_messages = [
        {"role": "system", "content": "Respond with just 'warm'"},
        {"role": "user", "content": "Warm-up test"}
    ]

    try:
        response = client.chat.completions.create(
            model=DEFAULT_MODEL_ID,
            messages=warmup_messages,
            temperature=0,
            max_tokens=5,
            # Use Phase 3B parameters for warm-up
            extra_body={"context_length": 512}
        )

        warmup_timing['warmup_inference_ms'] = (time.perf_counter() - warmup_start) * 1000

        if response.choices[0].message.content:
            print(f"✅ System warm-up completed in {warmup_timing['warmup_inference_ms']:.0f}ms")
        else:
            print("⚠️ Warm-up response empty, but model appears ready")

    except Exception as e:
        print(f"⚠️ Warm-up inference failed: {str(e)[:50]}...")
        warmup_timing['warmup_error'] = str(e)

    # Additional brief pause to settle GPU state
    time.sleep(2)
    warmup_timing['total_warmup_ms'] = (time.perf_counter() - warmup_start) * 1000

    return warmup_timing


def identify_card(
    client: OpenAI, image_path: Path, *, max_tokens: int = 30  # PHASE 3B: Reduced from 40 to 30
) -> Tuple[Dict[str, Any], Dict[str, float]]:
    """Identify a card and return both prediction and comprehensive timing metrics."""
    timing = {}

    # Capture system state before processing
    pre_system = get_system_metrics()
    timing['pre_memory_gb'] = pre_system.get('memory_used_gb', 0)
    timing['pre_cpu_percent'] = pre_system.get('cpu_percent', 0)

    # Time image encoding with detailed breakdown
    encode_start = time.perf_counter()
    data_url, encode_timing = encode_image_to_data_url(image_path)
    timing.update(encode_timing)

    # Time API call preparation
    prep_start = time.perf_counter()
    messages = build_messages(data_url)
    timing['api_prep_ms'] = (time.perf_counter() - prep_start) * 1000

    # Time inference with system monitoring
    inference_start = time.perf_counter()
    response = client.chat.completions.create(
        model=DEFAULT_MODEL_ID,
        messages=messages,
        temperature=0,
        seed=0,
        max_tokens=max_tokens,
        response_format=RESPONSE_SCHEMA,
        # PHASE 3B: Maximum aggressive context reduction from 1K to 512 tokens
        extra_body={"context_length": 512}
    )
    timing['inference_ms'] = (time.perf_counter() - inference_start) * 1000

    # Time parsing
    parse_start = time.perf_counter()
    raw_content = response.choices[0].message.content
    if raw_content is None:
        raise RuntimeError("Model returned empty content")
    prediction = parse_prediction(raw_content)
    timing['parse_ms'] = (time.perf_counter() - parse_start) * 1000

    # Capture system state after processing
    post_system = get_system_metrics()
    timing['post_memory_gb'] = post_system.get('memory_used_gb', 0)
    timing['post_cpu_percent'] = post_system.get('cpu_percent', 0)
    timing['memory_delta_gb'] = timing['post_memory_gb'] - timing['pre_memory_gb']

    # Calculate comprehensive timing
    timing['total_card_ms'] = (
        timing['total_encode_ms'] +
        timing['api_prep_ms'] +
        timing['inference_ms'] +
        timing['parse_ms']
    )

    return prediction, timing


def evaluate_batch(image_paths: Iterable[Path]) -> Tuple[List[Dict[str, Any]], Dict[str, int], Dict[str, float]]:
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    truth = load_ground_truth(GROUND_TRUTH_JSON)

    # CRITICAL: Execute warm-up protocol based on Phase 3A variance discovery
    warmup_metrics = system_warmup(client)

    results: List[Dict[str, Any]] = []
    tally = {"name_correct": 0, "hp_correct": 0, "set_number_correct": 0}
    timing_totals = {
        "total_batch_ms": 0,
        "total_inference_ms": 0,
        "total_encode_ms": 0,
        "total_parse_ms": 0,
        "total_api_prep_ms": 0,
        "card_count": 0,
        "total_memory_delta_gb": 0.0,
        "warmup_time_ms": warmup_metrics.get('total_warmup_ms', 0)
    }

    # Capture initial system state
    initial_system = get_system_metrics()
    print(f"🔬 Phase 3B Initial System State (post-warmup):")
    print(f"   Memory: {initial_system.get('memory_used_gb', 'N/A')}GB used")
    print(f"   CPU: {initial_system.get('cpu_percent', 'N/A')}%")

    batch_start = time.perf_counter()

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        ground_truth = truth.get(card_id)
        if not ground_truth:
            print(f"[WARN] No ground truth for {card_id}; skipping.", file=sys.stderr)
            continue

        print(f"🔍 Processing card {i}/{len(list(image_paths))}: {card_id}")

        card_start = time.perf_counter()
        prediction, timing = identify_card(client, image_path)
        card_total_ms = (time.perf_counter() - card_start) * 1000

        truth_set_number = resolve_truth_set_number(ground_truth, card_id)
        comparison = compare_fields(prediction, ground_truth, card_id)

        for key, value in comparison.items():
            if value:
                tally[key] += 1

        # Accumulate detailed timing statistics
        timing_totals["total_inference_ms"] += timing["inference_ms"]
        timing_totals["total_encode_ms"] += timing["total_encode_ms"]
        timing_totals["total_parse_ms"] += timing["parse_ms"]
        timing_totals["total_api_prep_ms"] += timing["api_prep_ms"]
        timing_totals["total_memory_delta_gb"] += timing.get("memory_delta_gb", 0)
        timing_totals["card_count"] += 1

        # Enhanced result record with comprehensive metrics
        result_record = {
            "image_file": str(image_path),
            "predicted_name": prediction.get("name"),
            "predicted_hp": prediction.get("hp"),
            "predicted_set_number": prediction.get("set_number"),
            "ground_truth_name": ground_truth.get("name"),
            "ground_truth_hp": ground_truth.get("hp"),
            "ground_truth_set_number": truth_set_number,
            "ground_truth_set_number_raw": ground_truth.get("card_number"),

            # Comprehensive timing breakdown
            "inference_time_ms": round(timing["inference_ms"], 2),
            "encode_time_ms": round(timing["total_encode_ms"], 2),
            "image_load_ms": round(timing.get("image_load_ms", 0), 2),
            "rgb_convert_ms": round(timing.get("rgb_convert_ms", 0), 2),
            "base64_encode_ms": round(timing.get("base64_encode_ms", 0), 2),
            "api_prep_ms": round(timing["api_prep_ms"], 2),
            "parse_time_ms": round(timing["parse_ms"], 2),
            "total_card_time_ms": round(card_total_ms, 2),

            # System metrics
            "memory_delta_gb": round(timing.get("memory_delta_gb", 0), 3),
            "pre_memory_gb": round(timing.get("pre_memory_gb", 0), 2),
            "post_memory_gb": round(timing.get("post_memory_gb", 0), 2),
            "cpu_percent": round(timing.get("post_cpu_percent", 0), 1),
        }
        result_record.update(comparison)
        results.append(result_record)

        # Real-time progress feedback
        print(f"   ✅ {card_id}: {timing['inference_ms']:.0f}ms inference, "
              f"{comparison['name_correct'] and comparison['hp_correct'] and comparison['set_number_correct']}")

    timing_totals["total_batch_ms"] = (time.perf_counter() - batch_start) * 1000

    # Calculate comprehensive averages and metrics
    if timing_totals["card_count"] > 0:
        timing_totals["avg_inference_ms"] = timing_totals["total_inference_ms"] / timing_totals["card_count"]
        timing_totals["avg_encode_ms"] = timing_totals["total_encode_ms"] / timing_totals["card_count"]
        timing_totals["avg_parse_ms"] = timing_totals["total_parse_ms"] / timing_totals["card_count"]
        timing_totals["avg_api_prep_ms"] = timing_totals["total_api_prep_ms"] / timing_totals["card_count"]
        timing_totals["avg_card_ms"] = timing_totals["total_batch_ms"] / timing_totals["card_count"]
        timing_totals["avg_memory_delta_gb"] = timing_totals["total_memory_delta_gb"] / timing_totals["card_count"]
        timing_totals["cards_per_second"] = timing_totals["card_count"] / (timing_totals["total_batch_ms"] / 1000)

    return results, tally, timing_totals


def write_results(results: List[Dict[str, Any]], output_path: Path) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


def determine_output_path(prefix: str = "id-results-phase3b") -> Path:
    timestamp = dt.datetime.now().strftime("%d%b%y")
    filename = f"{prefix}-{timestamp}.json"
    return Path(filename)


def collect_first_ten() -> List[Path]:
    if not FIRST_TEN_DIR.exists():
        raise FileNotFoundError(f"Missing directory: {FIRST_TEN_DIR}")
    return sorted(FIRST_TEN_DIR.glob("*.png"))


def wait_for_model_ready(client: OpenAI, max_wait_seconds: int = 300) -> bool:
    """Wait for model to be ready for inference after cold start."""
    print(f"⏳ Waiting for {DEFAULT_MODEL_ID} to load (up to {max_wait_seconds}s)...")

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
                timeout=30
            )
            if response.choices[0].message.content:
                elapsed = time.perf_counter() - start_time
                print(f"✅ Model ready after {elapsed:.1f}s")
                return True
        except Exception as e:
            print(f"⏳ Model not ready yet ({time.perf_counter() - start_time:.1f}s): {str(e)[:50]}...")
            time.sleep(10)

    print(f"❌ Model failed to become ready within {max_wait_seconds}s")
    return False


def display_comprehensive_comparison(timing_stats: Dict[str, float], accuracy_stats: Dict[str, int], total_cards: int) -> None:
    """Display comprehensive comparison with Phase 2 and Phase 3A results."""
    print(f"\n📊 PHASE 3B vs PHASE 2 vs PHASE 3A COMPARISON")
    print("=" * 90)

    # Historical baseline metrics
    phase2_avg_inference = 15368    # ms (Phase 2 breakthrough)
    phase3a_avg_inference = 11931   # ms (Phase 3A warmed system)
    phase2_accuracy = 100.0         # %
    phase3a_accuracy = 100.0        # %

    # Phase 3B metrics
    phase3b_avg_inference = timing_stats.get('avg_inference_ms', 0)
    phase3b_accuracy = (accuracy_stats['name_correct'] + accuracy_stats['hp_correct'] + accuracy_stats['set_number_correct']) / (3 * total_cards) * 100

    # Calculate improvements
    vs_phase2_improvement = ((phase2_avg_inference - phase3b_avg_inference) / phase2_avg_inference) * 100
    vs_phase3a_improvement = ((phase3a_avg_inference - phase3b_avg_inference) / phase3a_avg_inference) * 100

    print(f"Configuration Evolution:")
    print(f"  Phase 2:  1024 context + 50 max_tokens")
    print(f"  Phase 3A:  768 context + 40 max_tokens (-25% context, -20% tokens)")
    print(f"  Phase 3B:  512 context + 30 max_tokens (-50% context, -40% tokens)")

    print(f"\nPerformance Progression:")
    print(f"  Phase 2 Avg Inference:  {phase2_avg_inference:.0f}ms (baseline breakthrough)")
    print(f"  Phase 3A Avg Inference: {phase3a_avg_inference:.0f}ms (warm system)")
    print(f"  Phase 3B Avg Inference: {phase3b_avg_inference:.0f}ms (maximum reduction)")

    print(f"\nPhase 3B vs Phase 2:")
    if vs_phase2_improvement > 0:
        print(f"  ✅ IMPROVEMENT: {vs_phase2_improvement:.1f}% faster ({abs(phase2_avg_inference - phase3b_avg_inference):.0f}ms speedup)")
    elif vs_phase2_improvement < 0:
        print(f"  ⚠️ REGRESSION: {abs(vs_phase2_improvement):.1f}% slower ({abs(phase2_avg_inference - phase3b_avg_inference):.0f}ms slowdown)")
    else:
        print(f"  ➡️ NO CHANGE: Similar performance")

    print(f"\nPhase 3B vs Phase 3A:")
    if vs_phase3a_improvement > 0:
        print(f"  ✅ IMPROVEMENT: {vs_phase3a_improvement:.1f}% faster ({abs(phase3a_avg_inference - phase3b_avg_inference):.0f}ms speedup)")
    elif vs_phase3a_improvement < 0:
        print(f"  ⚠️ REGRESSION: {abs(vs_phase3a_improvement):.1f}% slower ({abs(phase3a_avg_inference - phase3b_avg_inference):.0f}ms slowdown)")
    else:
        print(f"  ➡️ NO CHANGE: Similar performance")

    print(f"\nAccuracy Stability:")
    print(f"  Phase 2:  {phase2_accuracy:.1f}%")
    print(f"  Phase 3A: {phase3a_accuracy:.1f}%")
    print(f"  Phase 3B: {phase3b_accuracy:.1f}%")

    if phase3b_accuracy >= 95.0:
        print(f"  ✅ MAINTAINED: Phase 3B accuracy meets ≥95% target")
    else:
        print(f"  ❌ DEGRADED: Phase 3B accuracy below 95% threshold")

    # Optimization efficiency analysis
    print(f"\nOptimization Efficiency Analysis:")
    total_context_reduction = ((1024 - 512) / 1024) * 100
    total_token_reduction = ((50 - 30) / 50) * 100
    print(f"  Total context reduction: {total_context_reduction:.0f}% (1024 → 512 tokens)")
    print(f"  Total token reduction: {total_token_reduction:.0f}% (50 → 30 tokens)")

    if vs_phase2_improvement > 0:
        efficiency_ratio = vs_phase2_improvement / total_context_reduction
        print(f"  Optimization efficiency: {efficiency_ratio:.2f}% performance per % context reduction")


def main(args: argparse.Namespace) -> int:
    image_paths = collect_first_ten()
    if not image_paths:
        print("No images found in first-ten directory.", file=sys.stderr)
        return 1

    print(f"🚀 Starting CardMint PHASE 3B maximum aggressive optimization test")
    print(f"Target: {DEFAULT_SERVER_URL} | Model: {DEFAULT_MODEL_ID}")
    print(f"Phase 3B Configuration: 512 context (-50% from Phase 2), 30 max_tokens (-40% from Phase 2)")
    print(f"Test Set: {len(image_paths)} cards with warm-up protocol + enhanced observability")
    print("=" * 95)

    # Wait for model readiness
    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    if not wait_for_model_ready(client):
        print("❌ Model not ready - aborting Phase 3B test", file=sys.stderr)
        return 1

    # Execute batch with warm-up protocol and enhanced observability
    print(f"\n🔬 Model ready - starting PHASE 3B maximum aggressive evaluation...")
    results, tally, timing_stats = evaluate_batch(image_paths)
    output_path = determine_output_path()
    write_results(results, output_path)

    # Comprehensive performance metrics
    print(f"\n📊 PHASE 3B PERFORMANCE METRICS")
    print(f"System warm-up time: {timing_stats.get('warmup_time_ms', 0):.0f}ms")
    print(f"Total batch time: {timing_stats['total_batch_ms']:.0f}ms ({timing_stats['total_batch_ms']/1000:.1f}s)")
    print(f"Cards processed: {timing_stats['card_count']}")
    print(f"Average per card: {timing_stats['avg_card_ms']:.1f}ms")
    print(f"Throughput: {timing_stats['cards_per_second']:.3f} cards/sec")

    print(f"\n⚡ DETAILED BREAKDOWN (averages):")
    print(f"  Image loading: {timing_stats.get('avg_image_load_ms', 0):.1f}ms")
    print(f"  RGB conversion: {timing_stats.get('avg_rgb_convert_ms', 0):.1f}ms")
    print(f"  Base64 encoding: {timing_stats.get('avg_base64_encode_ms', 0):.1f}ms")
    print(f"  Total encoding: {timing_stats['avg_encode_ms']:.1f}ms")
    print(f"  API preparation: {timing_stats['avg_api_prep_ms']:.1f}ms")
    print(f"  LM Studio inference: {timing_stats['avg_inference_ms']:.1f}ms")
    print(f"  JSON parsing: {timing_stats['avg_parse_ms']:.1f}ms")

    print(f"\n💾 SYSTEM IMPACT:")
    print(f"  Average memory delta: {timing_stats.get('avg_memory_delta_gb', 0):.3f}GB per card")
    print(f"  Total memory impact: {timing_stats.get('total_memory_delta_gb', 0):.3f}GB")

    # Comprehensive accuracy analysis
    print(f"\n🎯 PHASE 3B ACCURACY RESULTS")
    total_cards = len(results)
    name_acc = tally['name_correct'] / total_cards * 100
    hp_acc = tally['hp_correct'] / total_cards * 100
    set_acc = tally['set_number_correct'] / total_cards * 100
    avg_acc = (name_acc + hp_acc + set_acc) / 3

    print(f"Name accuracy: {tally['name_correct']}/{total_cards} ({name_acc:.1f}%)")
    print(f"HP accuracy: {tally['hp_correct']}/{total_cards} ({hp_acc:.1f}%)")
    print(f"Set number accuracy: {tally['set_number_correct']}/{total_cards} ({set_acc:.1f}%)")
    print(f"Average accuracy: {avg_acc:.1f}%")

    # Success criteria assessment
    if avg_acc >= 95.0:
        print(f"✅ SUCCESS: {avg_acc:.1f}% meets ≥95% accuracy target")
    else:
        print(f"⚠️  WARNING: {avg_acc:.1f}% below 95% accuracy target")

    # Display comprehensive phase comparison
    display_comprehensive_comparison(timing_stats, tally, total_cards)

    print(f"\n💾 Phase 3B results saved to: {output_path}")
    print(f"🎯 Phase 3B complete - maximum aggressive optimization tested")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    exit_code = main(parser.parse_args())
    sys.exit(exit_code)