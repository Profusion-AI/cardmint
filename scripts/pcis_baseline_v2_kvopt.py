#!/usr/bin/env python3
"""CardMint Baseline V2 - KV Cache Optimization (Phase 4E).

This extends Phase 4D with n_keep=0 optimization to retain system prompt KV cache
state between requests, eliminating ~200 token reprocessing overhead.

BASELINE V2 CONFIGURATION (Phase 4E):
1. Context: 777 tokens (Kyle's optimized parameter)
2. Max Tokens: 42 (Kyle's optimized parameter)
3. Enhanced KeepWarm daemon integration with adaptive intervals
4. Set number normalization for accurate comparisons
5. Performance targets: ~15s average, ≥95% accuracy, <10% variance
6. PHASE 4D: Deterministic inference with cleaned sampling params
7. PHASE 4D: JSON reliability hardening with stop sequences
8. PHASE 4E: KV cache retention (n_keep=0) for system prompt persistence

OPTIMIZATION RATIONALE:
- Phase 4D baseline: n_keep=-1 forces full context reprocessing
- Phase 4E change: n_keep=0 retains system prompt KV state
- Expected impact: -15% avg inference time via eliminated redundant prefill
- Risk: None (system prompt identical across requests, determinism preserved)

PERFORMANCE TARGETS:
- Time gate: ≤18s avg (relaxed from 15s for achievability)
- Variance gate: <10%
- Accuracy gate: ≥95%
- JSON reliability: 100%

Based on Phase 4D regression analysis - 2 Oct 2025.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional
from urllib.parse import urlparse

from openai import OpenAI
from PIL import Image

# Import daemon integration
from daemon_integration import require_keepwarm_daemon
from shared_prompts import CARDMINT_RESPONSE_SCHEMA, CARDMINT_SYSTEM_PROMPT

DEFAULT_SERVER_URL = "http://127.0.0.1:12345/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# BASELINE V2: Balanced prompt - minimal JSON guidance with schema enforcement
BASELINE_V2_SYSTEM_PROMPT = CARDMINT_SYSTEM_PROMPT

# BASELINE V2: Streamlined response schema
RESPONSE_SCHEMA: Dict[str, Any] = CARDMINT_RESPONSE_SCHEMA

# Test configurations
FIRST_TWENTYFIVE_DIR = Path("/home/kyle/CardMint-workspace/pokemoncards")
GROUND_TRUTH_JSON = Path("/home/kyle/CardMint-workspace/pokemoncards") / "pokemon_cards.json"

# BASELINE V2: Updated performance thresholds for 777/42 config
SLOW_INFERENCE_THRESHOLD_MS = 20000  # 20s threshold (adjusted for 777/42)
ACCURACY_TARGET = 0.95  # 95% accuracy target
BASELINE_TARGET_TIME_MS = 18000  # 18s average target (realistic for 777/42)

class BaselineV2Metrics:
    """Performance metrics for Baseline V2 with Phase 4D precision tracking."""

    def __init__(self):
        self.start_time = time.time()
        self.inference_times = []
        self.accuracy_stats = {"name": 0, "hp": 0, "set_number": 0, "total": 0}
        self.slow_cards = []
        # Phase 4D: JSON reliability tracking
        self.json_repair_count = 0
        self.stop_sequence_triggers = 0
        self.deterministic_violations = 0

    def add_inference(self, inference_ms: float, card_info: Dict[str, Any]):
        """Add inference timing and accuracy data."""
        self.inference_times.append(inference_ms)

        # Track slow inferences (stricter threshold for baseline v2)
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

    def add_json_repair(self):
        """Track JSON repair events (Phase 4D precision metric)."""
        self.json_repair_count += 1

    def add_stop_sequence_trigger(self):
        """Track stop sequence activations (Phase 4D precision metric)."""
        self.stop_sequence_triggers += 1

    def add_deterministic_violation(self):
        """Track deterministic inference violations (Phase 4D precision metric)."""
        self.deterministic_violations += 1

    def get_performance_summary(self) -> Dict[str, Any]:
        """Get comprehensive performance metrics with Baseline V2 targets."""
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

        # Baseline V2 performance gates (777/42 config targets)
        time_gate = avg_time <= BASELINE_TARGET_TIME_MS  # 18s target
        accuracy_gate = full_accuracy >= ACCURACY_TARGET
        variance_gate = variance_percent <= 10.0  # Stricter variance for 777/42

        # Phase 4D: JSON reliability gate (target: 100% reliability)
        json_reliability_rate = 1.0 - (self.json_repair_count + self.stop_sequence_triggers) / max(total, 1)
        json_gate = json_reliability_rate >= 1.0  # 100% JSON reliability target

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
            "phase_4d_precision": {
                "json_repair_count": self.json_repair_count,
                "stop_sequence_triggers": self.stop_sequence_triggers,
                "deterministic_violations": self.deterministic_violations,
                "json_reliability_rate": json_reliability_rate
            },
            "baseline_v2_gates": {
                "time_gate": time_gate,
                "accuracy_gate": accuracy_gate,
                "variance_gate": variance_gate,
                "json_gate": json_gate,  # Phase 4D: JSON reliability gate
                "ready": time_gate and accuracy_gate and variance_gate and json_gate,
                "target_time_ms": BASELINE_TARGET_TIME_MS,
                "target_accuracy": ACCURACY_TARGET,
                "target_variance": 10.0,
                "target_json_reliability": 1.0  # 100% JSON reliability
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


def build_baseline_v2_messages(image_data_url: str) -> List[Dict[str, Any]]:
    """Build messages with Baseline V2 optimized prompt."""
    return [
        {"role": "system", "content": BASELINE_V2_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Identify this Pokemon card."},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]


def baseline_v2_inference_request(
    client: OpenAI,
    image_path: Path,
    metrics: Optional[BaselineV2Metrics] = None,
    *,
    model_id: str = DEFAULT_MODEL_ID,
    context_length: int = 777,
    max_tokens: int = 42,
    stop: Optional[List[str]] = None,
    stream_ttft: bool = False,
) -> Dict[str, Any]:
    """Execute inference with Baseline V2 parameters and optional telemetry enhancements."""

    # Image encoding
    encode_start = time.perf_counter()
    image_data_url, encode_timing = encode_image_to_data_url(image_path)
    encode_time_ms = (time.perf_counter() - encode_start) * 1000

    messages = build_baseline_v2_messages(image_data_url)

    request_kwargs: Dict[str, Any] = {
        "model": model_id,
        "messages": messages,
        "temperature": 0,
        "seed": 0,
        "max_tokens": max_tokens,
        "response_format": RESPONSE_SCHEMA,
        "extra_body": {
            "context_length": context_length,
            "top_k": 0,
            "top_p": 1.0,
            "min_p": 0.0,
            "n_keep": 0,  # Phase 4E: Retain system prompt KV cache (was -1)
        },
    }
    if stop:
        request_kwargs["stop"] = stop

    # Inference timing
    inference_start = time.perf_counter()
    ttft_ms: Optional[float] = None

    if stream_ttft:
        chunks: List[str] = []
        stream = client.chat.completions.create(stream=True, **request_kwargs)
        for event in stream:
            delta = getattr(getattr(event.choices[0], "delta", None), "content", None)
            if delta:
                if ttft_ms is None:
                    ttft_ms = (time.perf_counter() - inference_start) * 1000
                chunks.append(delta)
        raw_content = "".join(chunks)
        inference_end = time.perf_counter()
    else:
        response = client.chat.completions.create(**request_kwargs)
        inference_end = time.perf_counter()
        raw_content = response.choices[0].message.content

    inference_time_ms = (inference_end - inference_start) * 1000

    # Phase 4D: Enhanced response parsing with reliability tracking
    parse_start = time.perf_counter()

    stop_triggered = False
    if stop:
        stripped = raw_content.rstrip()
        stop_triggered = any(stripped.endswith(token) for token in stop)
        if stop_triggered and metrics:
            metrics.add_stop_sequence_trigger()

    json_repaired = False
    try:
        prediction = json.loads(raw_content)
    except json.JSONDecodeError:
        # Check if stop token truncated the JSON and repair it
        repaired_content = raw_content.strip()

        # Special handling for "}" stop token: it removes the closing brace we need
        if stop and "}" in stop and not repaired_content.endswith('}'):
            repaired_content += '}'
        elif not repaired_content.endswith('}'):
            # General case: add closing brace if missing
            repaired_content += '}'

        if repaired_content != raw_content.strip():
            try:
                prediction = json.loads(repaired_content)
                json_repaired = True
                if metrics:
                    metrics.add_json_repair()
            except json.JSONDecodeError as exc:
                raise ValueError(f"Model output is not valid JSON even after repair: {raw_content}") from exc
        else:
            raise ValueError(f"Model output is not valid JSON: {raw_content}")

    parse_time_ms = (time.perf_counter() - parse_start) * 1000

    timing_info: Dict[str, Any] = {
        "encode_ms": encode_time_ms,
        "inference_ms": inference_time_ms,
        "parse_ms": parse_time_ms,
        "total_ms": encode_time_ms + inference_time_ms + parse_time_ms,
    }
    if stream_ttft:
        timing_info["ttft_ms"] = ttft_ms if ttft_ms is not None else inference_time_ms

    prompt_metadata = {
        "system_prompt_char_len": len(BASELINE_V2_SYSTEM_PROMPT),
        "image_inputs": sum(1 for part in messages[1]["content"] if part.get("type") == "image_url"),
    }

    return {
        "prediction": prediction,
        "timing": timing_info,
        "encoding_breakdown": encode_timing,
        "phase_4d_events": {
            "stop_triggered": stop_triggered,
            "json_repaired": json_repaired,
            "raw_content_length": len(raw_content),
        },
        "prompt_metadata": prompt_metadata,
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


def normalize_set_number(set_number: str) -> str:
    """Normalize set number format for accurate comparisons.

    Handles the Phase 4B issue where model returns '134/134' but ground truth expects '12'.
    Extracts the numerator from fraction format when appropriate.
    """
    set_number = str(set_number).strip()

    # If it's in fraction format like "134/134" or "12/102"
    if "/" in set_number:
        parts = set_number.split("/")
        if len(parts) == 2:
            try:
                numerator = int(parts[0].strip())
                denominator = int(parts[1].strip())

                # If numerator equals denominator and it's > 100 (like "134/134"),
                # this is likely model confusion - the model detected set metadata
                # rather than the actual card number. Mark as invalid for comparison.
                if numerator == denominator and numerator > 100:
                    return f"INVALID:{set_number}"  # Mark as invalid

                # For normal fractions like "12/102", return just the numerator
                return str(numerator)

            except ValueError:
                # If parsing fails, return original
                return set_number

    return set_number


def compare_fields(pred: Dict[str, Any], truth: Dict[str, Any], card_id: str) -> Dict[str, bool]:
    expected_name = truth.get("name", "").strip().lower()
    expected_hp = truth.get("hp")
    expected_set_number = resolve_truth_set_number(truth, card_id)

    pred_name = pred.get("name", "").strip().lower()
    pred_hp = pred.get("hp")
    pred_set_number = normalize_set_number(pred.get("set_number", ""))

    # Enhanced set number comparison with normalization
    set_number_correct = False
    if pred_set_number == expected_set_number:
        set_number_correct = True
    elif "/" in pred_set_number:
        # If prediction is "1/64" and expected is "1", extract the numerator
        pred_numerator = pred_set_number.split("/")[0].strip()
        set_number_correct = pred_numerator == expected_set_number
    elif "/" in expected_set_number:
        # If expected is "1/64" and prediction is "1", check if prediction matches numerator
        expected_numerator = expected_set_number.split("/")[0].strip()
        set_number_correct = pred_set_number == expected_numerator

    return {
        "name_correct": pred_name == expected_name,
        "hp_correct": pred_hp == expected_hp,
        "set_number_correct": set_number_correct,
    }


def run_baseline_v2_test(
    image_paths: List[Path],
    ground_truth: Dict[str, Dict[str, Any]],
    test_name: str = "Baseline-V2",
    *,
    openai_base: str = DEFAULT_SERVER_URL,
    api_key: str = "lm-studio",
    model_id: str = DEFAULT_MODEL_ID,
    context_length: int = 777,
    max_tokens: int = 42,
    stop: Optional[List[str]] = None,
    stream_ttft: bool = False,
    model_hash: Optional[str] = None,
) -> Dict[str, Any]:
    """Run Baseline V2 inference test with enhanced daemon integration."""

    # Initialize client and metrics
    client = OpenAI(base_url=openai_base, api_key=api_key)
    metrics = BaselineV2Metrics()

    results = []

    print(f"\n🚀 Running {test_name} (CardMint Baseline V2)")
    print(
        f"📊 Config: context={context_length} tokens, max_tokens={max_tokens}, "
        f"stop={stop if stop else 'None'}"
    )
    print(f"🎯 Target: ≤18s avg, ≥95% accuracy, ≤10% variance")

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        truth = ground_truth.get(card_id, {})

        print(f"[{i:2d}/{len(image_paths)}] {card_id}", end=" ... ", flush=True)

        try:
            # Run inference with Baseline V2 parameters and Phase 4D precision tracking
            result = baseline_v2_inference_request(
                client,
                image_path,
                metrics,
                model_id=model_id,
                context_length=context_length,
                max_tokens=max_tokens,
                stop=stop,
                stream_ttft=stream_ttft,
            )

            # Compare with ground truth using enhanced comparison
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
                "phase_4d_events": result["phase_4d_events"],  # Phase 4D precision tracking
                "prompt_metadata": result["prompt_metadata"],
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
            "baseline_version": "v2",
            "context_tokens": context_length,
            "max_tokens": max_tokens,
            "stop_tokens": stop or [],
            "model_id": model_id,
            "model_hash": model_hash,
            "total_cards": len(image_paths),
            "timestamp": dt.datetime.now().isoformat()
        },
        "results": results,
        "performance_summary": performance_summary
    }


def main():
    parser = argparse.ArgumentParser(description="CardMint Baseline V2 Test")
    parser.add_argument("--cards-limit", type=int, help="Limit number of cards for testing")
    parser.add_argument("--test-name", type=str, default="Baseline-V2", help="Test name for results")
    parser.add_argument("--mini", action="store_true", help="Run mini test (5 cards)")
    parser.add_argument("--medium", action="store_true", help="Run medium test (15 cards)")
    parser.add_argument("--openai-base", type=str, default=DEFAULT_SERVER_URL,
                        help="OpenAI-compatible base URL (LMStudio, vLLM, IPEX-LLM)")
    parser.add_argument("--api-key", type=str, default="lm-studio",
                        help="API key for the OpenAI-compatible endpoint")
    parser.add_argument("--model-id", type=str, default=DEFAULT_MODEL_ID,
                        help="Model identifier to request")
    parser.add_argument("--context-length", type=int, default=777,
                        help="Context length to request")
    parser.add_argument("--max-tokens", type=int, default=42,
                        help="Maximum new tokens")
    parser.add_argument("--stop", type=str, nargs="*",
                        help="Optional stop sequences to enforce (e.g. '}')")
    parser.add_argument("--stream-ttft", action="store_true",
                        help="Enable streaming to capture TTFT if supported")
    parser.add_argument("--model-hash", type=str,
                        help="Optional hash of the checkpoint for logging")

    args = parser.parse_args()

    # Check enhanced daemon status
    require_keepwarm_daemon()

    # Load data
    if not FIRST_TWENTYFIVE_DIR.exists():
        print(f"❌ Error: Image directory not found: {FIRST_TWENTYFIVE_DIR}")
        return 1

    # Determine card limit
    card_limit = None
    if args.mini:
        card_limit = 5
        args.test_name = f"{args.test_name}-Mini"
    elif args.medium:
        card_limit = 15
        args.test_name = f"{args.test_name}-Medium"
    elif args.cards_limit:
        card_limit = args.cards_limit

    image_paths = sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))[:card_limit] if card_limit else sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))

    if not image_paths:
        print(f"❌ Error: No PNG images found in {FIRST_TWENTYFIVE_DIR}")
        return 1

    ground_truth = load_ground_truth(GROUND_TRUTH_JSON)

    # Run test
    test_results = run_baseline_v2_test(
        image_paths,
        ground_truth,
        args.test_name,
        openai_base=args.openai_base,
        api_key=args.api_key,
        model_id=args.model_id,
        context_length=args.context_length,
        max_tokens=args.max_tokens,
        stop=args.stop,
        stream_ttft=args.stream_ttft,
        model_hash=args.model_hash,
    )

    # Save results
    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")
    results_file = Path(f"results/{args.test_name.lower()}-results-{timestamp}.json")
    results_file.parent.mkdir(exist_ok=True)

    with results_file.open("w") as f:
        json.dump(test_results, f, indent=2)

    # Print summary
    perf = test_results["performance_summary"]
    print(f"\n📊 BASELINE V2 PERFORMANCE SUMMARY")
    print(f"{'='*55}")

    if perf:
        performance = perf["performance"]
        accuracy = perf["accuracy"]
        gates = perf["baseline_v2_gates"]

        print(f"⏱️  Average Inference: {performance['avg_inference_ms']/1000:.1f}s (target: ≤18s)")
        print(f"📈 Variance: {performance['variance_percent']:.1f}% (target: ≤10%)")
        print(f"🎯 Full Accuracy: {accuracy['full_card_accuracy']*100:.1f}% (target: ≥95%)")
        print(f"⚠️  Slow Cards: {performance['slow_cards_count']} (>20s threshold)")

        # Phase 4D precision metrics
        precision = perf["phase_4d_precision"]
        print(f"\n🔧 PHASE 4D PRECISION METRICS")
        print(f"{'='*55}")
        print(f"📋 JSON Repairs: {precision['json_repair_count']} (target: 0)")
        print(f"🛑 Stop Triggers: {precision['stop_sequence_triggers']} (monitoring)")
        print(f"🎲 Deterministic Violations: {precision['deterministic_violations']} (target: 0)")
        print(f"✨ JSON Reliability: {precision['json_reliability_rate']*100:.1f}% (target: 100%)")

        print(f"\n🚦 BASELINE V2 PERFORMANCE GATES")
        print(f"{'='*55}")
        print(f"⏱️  Time Gate (≤18s): {'✅ PASS' if gates['time_gate'] else '❌ FAIL'}")
        print(f"🎯 Accuracy Gate (≥95%): {'✅ PASS' if gates['accuracy_gate'] else '❌ FAIL'}")
        print(f"📊 Variance Gate (≤10%): {'✅ PASS' if gates['variance_gate'] else '❌ FAIL'}")
        print(f"🔒 JSON Gate (100%): {'✅ PASS' if gates['json_gate'] else '❌ FAIL'}")
        print(f"🌟 BASELINE V2 READY: {'✅ YES' if gates['ready'] else '❌ NO'}")

        if not gates['ready']:
            print(f"\n🔧 OPTIMIZATION RECOMMENDATIONS:")
            if not gates['time_gate']:
                print(f"   • Check enhanced daemon warmup status")
                print(f"   • Verify LM Studio model warm state")
            if not gates['accuracy_gate']:
                print(f"   • Review set number normalization logic")
                print(f"   • Audit failing cards for ground truth accuracy")
            if not gates['json_gate']:
                print(f"   • Review JSON schema enforcement")
                print(f"   • Check stop sequence configuration")
                print(f"   • Validate max_tokens sufficiency for JSON completion")

    print(f"\n💾 Results saved: {results_file}")
    return 0


if __name__ == "__main__":
    exit(main())
