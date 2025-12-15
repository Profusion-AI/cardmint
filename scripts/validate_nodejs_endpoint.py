#!/usr/bin/env python3
"""Validate Node.js /api/jobs endpoint against Phase 4D baseline.

This script posts pre-captured images to the Node.js backend's /api/jobs endpoint
and validates that the LMStudio inference matches Phase 4D baseline performance.

Expected metrics (from Phase 4D Python baseline):
- Average inference: ~16.6s
- Variance: <10%
- JSON reliability: 100%
- Accuracy: ≥95%
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse

import requests

# Import baseline comparison utilities
from shared_prompts import CARDMINT_SYSTEM_PROMPT, CARDMINT_RESPONSE_SCHEMA

# Configuration
BACKEND_URL = "http://127.0.0.1:4000"
TEST_IMAGES_DIR = Path("/home/kyle/CardMint-workspace/pokemoncards")
GROUND_TRUTH_JSON = TEST_IMAGES_DIR / "pokemon_cards.json"

# Phase 4D baseline targets
BASELINE_TARGET_TIME_MS = 18000  # 18s average
ACCURACY_TARGET = 0.95
VARIANCE_TARGET = 10.0  # 10% max variance


def load_ground_truth(path: Path) -> Dict[str, Dict[str, Any]]:
    """Load ground-truth metadata keyed by card ID."""
    with path.open("r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)
    return {record["id"]: record for record in records}


def normalize_card_id(image_path: Path) -> str:
    """Extract card ID from filename (e.g., 'base1-10.png' -> 'base1-10')."""
    return image_path.stem


def resolve_truth_set_number(truth: Dict[str, Any], card_id: str) -> str:
    """Return the best available set number string for comparisons."""
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
    """Normalize set number format for accurate comparisons."""
    set_number = str(set_number).strip()

    if "/" in set_number:
        parts = set_number.split("/")
        if len(parts) == 2:
            try:
                numerator = int(parts[0].strip())
                denominator = int(parts[1].strip())

                if numerator == denominator and numerator > 100:
                    return f"INVALID:{set_number}"

                return str(numerator)
            except ValueError:
                return set_number

    return set_number


def compare_fields(pred: Dict[str, Any], truth: Dict[str, Any], card_id: str) -> Dict[str, bool]:
    """Compare predicted fields against ground truth."""
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
        pred_numerator = pred_set_number.split("/")[0].strip()
        set_number_correct = pred_numerator == expected_set_number
    elif "/" in expected_set_number:
        expected_numerator = expected_set_number.split("/")[0].strip()
        set_number_correct = pred_set_number == expected_numerator

    return {
        "name_correct": pred_name == expected_name,
        "hp_correct": pred_hp == expected_hp,
        "set_number_correct": set_number_correct,
    }


def run_inference(image_path: Path, backend_url: str) -> Dict[str, Any]:
    """Post image to Node.js /api/test/infer endpoint and return job with timing."""
    url = f"{backend_url}/api/test/infer"

    payload = {
        "imagePath": str(image_path)
    }

    response = requests.post(url, json=payload, timeout=30)
    response.raise_for_status()

    return response.json()


def run_validation(image_paths: List[Path], ground_truth: Dict[str, Dict[str, Any]], backend_url: str) -> Dict[str, Any]:
    """Run validation test against Node.js endpoint."""

    print(f"\n🚀 Node.js Endpoint Validation (Phase 4D Baseline)")
    print(f"Backend: {backend_url}")
    print(f"Target: ≤{BASELINE_TARGET_TIME_MS/1000}s avg, ≥{ACCURACY_TARGET*100}% accuracy, ≤{VARIANCE_TARGET}% variance")
    print("=" * 80)

    results = []
    inference_times = []
    accuracy_stats = {"name": 0, "hp": 0, "set_number": 0, "total": 0}

    batch_start = time.time()

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        truth = ground_truth.get(card_id, {})

        if not truth:
            print(f"[WARN] No ground truth for {card_id}; skipping.")
            continue

        print(f"[{i:2d}/{len(image_paths)}] {card_id}", end=" ... ", flush=True)

        try:
            # Run inference
            request_start = time.perf_counter()
            result = run_inference(image_path, backend_url)
            total_ms = (time.perf_counter() - request_start) * 1000

            if not result.get("ok"):
                raise RuntimeError("Inference request failed")

            job = result.get("job")
            if not job:
                raise RuntimeError("No job returned from inference")

            # Extract inference timing
            timing = result.get("timing", {})
            infer_ms = timing.get("infer_ms", 0)

            if infer_ms == 0:
                print(f"⚠️  WARNING: No inference timing recorded")

            # Extract predictions
            extracted = job.get("extracted", {})
            prediction = {
                "name": extracted.get("card_name"),
                "hp": extracted.get("hp_value"),
                "set_number": extracted.get("set_number")
            }

            # Compare with ground truth
            comparison = compare_fields(prediction, truth, card_id)

            # Track metrics
            inference_times.append(infer_ms)
            accuracy_stats["total"] += 1
            if comparison["name_correct"]:
                accuracy_stats["name"] += 1
            if comparison["hp_correct"]:
                accuracy_stats["hp"] += 1
            if comparison["set_number_correct"]:
                accuracy_stats["set_number"] += 1

            # Build result record
            result_record = {
                "card_number": i,
                "image_file": str(image_path),
                "card_id": card_id,
                "prediction": prediction,
                "ground_truth": {
                    "name": truth.get("name", ""),
                    "hp": truth.get("hp"),
                    "set_number": resolve_truth_set_number(truth, card_id)
                },
                "comparison": comparison,
                "timing": {
                    "inference_ms": infer_ms,
                    "total_ms": total_ms
                },
                "job_id": job.get("id"),
                "success": True
            }
            results.append(result_record)

            # Progress output
            accuracy_symbols = [
                "✓" if comparison["name_correct"] else "✗",
                "✓" if comparison["hp_correct"] else "✗",
                "✓" if comparison["set_number_correct"] else "✗"
            ]
            print(f"{infer_ms/1000:.1f}s {''.join(accuracy_symbols)}")

        except Exception as e:
            print(f"❌ FAILED: {e}")
            result = {
                "card_number": i,
                "image_file": str(image_path),
                "card_id": card_id,
                "error": str(e),
                "success": False
            }
            results.append(result)

    batch_time_ms = (time.time() - batch_start) * 1000

    # Calculate performance summary
    if inference_times:
        avg_time = sum(inference_times) / len(inference_times)
        variance = (sum((t - avg_time) ** 2 for t in inference_times) / len(inference_times)) ** 0.5
        variance_percent = (variance / avg_time) * 100 if avg_time > 0 else 0
    else:
        avg_time = variance_percent = 0

    total = accuracy_stats["total"]
    accuracies = {
        "name": accuracy_stats["name"] / total if total > 0 else 0,
        "hp": accuracy_stats["hp"] / total if total > 0 else 0,
        "set_number": accuracy_stats["set_number"] / total if total > 0 else 0,
    }
    full_accuracy = min(accuracies["name"], accuracies["hp"], accuracies["set_number"])

    # Performance gates
    time_gate = avg_time <= BASELINE_TARGET_TIME_MS
    accuracy_gate = full_accuracy >= ACCURACY_TARGET
    variance_gate = variance_percent <= VARIANCE_TARGET

    return {
        "test_metadata": {
            "test_name": "nodejs-endpoint-validation",
            "backend_url": backend_url,
            "total_cards": len(image_paths),
            "successful_cards": sum(1 for r in results if r["success"]),
            "timestamp": dt.datetime.now().isoformat()
        },
        "results": results,
        "performance_summary": {
            "performance": {
                "avg_inference_ms": avg_time,
                "min_inference_ms": min(inference_times) if inference_times else 0,
                "max_inference_ms": max(inference_times) if inference_times else 0,
                "variance_percent": variance_percent,
                "total_batch_ms": batch_time_ms,
                "total_cards": len(inference_times)
            },
            "accuracy": {
                **accuracies,
                "full_card_accuracy": full_accuracy,
                "total_cards": total
            },
            "baseline_gates": {
                "time_gate": time_gate,
                "accuracy_gate": accuracy_gate,
                "variance_gate": variance_gate,
                "ready": time_gate and accuracy_gate and variance_gate,
                "target_time_ms": BASELINE_TARGET_TIME_MS,
                "target_accuracy": ACCURACY_TARGET,
                "target_variance": VARIANCE_TARGET
            }
        }
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mini", action="store_true", help="Run mini test (5 cards)")
    parser.add_argument("--cards-limit", type=int, help="Limit number of cards for testing")
    parser.add_argument("--backend-url", type=str, default="http://127.0.0.1:4000",
                       help="Backend URL (default: http://127.0.0.1:4000)")

    args = parser.parse_args()

    backend_url = args.backend_url

    # Check backend health
    try:
        response = requests.get(f"{backend_url}/health", timeout=5)
        response.raise_for_status()
        health = response.json()
        print(f"✅ Backend healthy: {health}")
    except Exception as e:
        print(f"❌ Backend health check failed: {e}")
        return 1

    # Load test data
    if not TEST_IMAGES_DIR.exists():
        print(f"❌ Error: Image directory not found: {TEST_IMAGES_DIR}")
        return 1

    # Determine card limit
    card_limit = None
    if args.mini:
        card_limit = 5
    elif args.cards_limit:
        card_limit = args.cards_limit

    image_paths = sorted(TEST_IMAGES_DIR.glob("*.png"))[:card_limit] if card_limit else sorted(TEST_IMAGES_DIR.glob("*.png"))

    if not image_paths:
        print(f"❌ Error: No PNG images found in {TEST_IMAGES_DIR}")
        return 1

    ground_truth = load_ground_truth(GROUND_TRUTH_JSON)

    # Run validation
    test_results = run_validation(image_paths, ground_truth, backend_url)

    # Save results
    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")
    results_file = Path(f"results/nodejs-validation-results-{timestamp}.json")
    results_file.parent.mkdir(exist_ok=True)

    with results_file.open("w") as f:
        json.dump(test_results, f, indent=2)

    # Print summary
    perf = test_results["performance_summary"]
    print(f"\n📊 NODE.JS VALIDATION SUMMARY")
    print(f"{'='*55}")

    performance = perf["performance"]
    accuracy = perf["accuracy"]
    gates = perf["baseline_gates"]

    print(f"⏱️  Average Inference: {performance['avg_inference_ms']/1000:.1f}s (target: ≤18s)")
    print(f"📈 Variance: {performance['variance_percent']:.1f}% (target: ≤10%)")
    print(f"🎯 Full Accuracy: {accuracy['full_card_accuracy']*100:.1f}% (target: ≥95%)")

    print(f"\n🚦 PHASE 4D BASELINE GATES")
    print(f"{'='*55}")
    print(f"⏱️  Time Gate (≤18s): {'✅ PASS' if gates['time_gate'] else '❌ FAIL'}")
    print(f"🎯 Accuracy Gate (≥95%): {'✅ PASS' if gates['accuracy_gate'] else '❌ FAIL'}")
    print(f"📊 Variance Gate (≤10%): {'✅ PASS' if gates['variance_gate'] else '❌ FAIL'}")
    print(f"🌟 BASELINE READY: {'✅ YES' if gates['ready'] else '❌ NO'}")

    if not gates['ready']:
        print(f"\n🔧 OPTIMIZATION RECOMMENDATIONS:")
        if not gates['time_gate']:
            print(f"   • Verify LM Studio daemon is running and warm")
            print(f"   • Check Phase 4D parameters (777/42 config)")
        if not gates['accuracy_gate']:
            print(f"   • Review field extraction logic")
            print(f"   • Audit failing cards for ground truth accuracy")
        if not gates['variance_gate']:
            print(f"   • Check seed=0 determinism enforcement")
            print(f"   • Verify sampling parameter cleanup")

    print(f"\n💾 Results saved: {results_file}")
    return 0 if gates['ready'] else 1


if __name__ == "__main__":
    sys.exit(main())
