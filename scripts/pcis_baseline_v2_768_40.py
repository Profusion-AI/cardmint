#!/usr/bin/env python3
"""Phase 4C Token Parameter Regression Test - 768/40 vs 512/30 Configuration

Testing Kyle's hypothesis that the Phase 4A token parameters (768/40) may
provide better accuracy and variance than the Phase 4B optimized parameters (512/30).

This script tests the original 768 context + 40 max_tokens configuration
against the current 512/30 baseline to validate performance regression.
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

from openai import OpenAI
from PIL import Image

# Import daemon integration
from daemon_integration import require_keepwarm_daemon

DEFAULT_SERVER_URL = "http://127.0.0.1:12345/v1"
DEFAULT_MODEL_ID = "mistralai/magistral-small-2509"

# PHASE 4A ORIGINAL: 768/40 configuration
PHASE_4A_SYSTEM_PROMPT = (
    "You are a Pokémon card identification assistant. Given an image, respond "
    "only with JSON containing name, hp, and set_number fields. Do not include "
    "confidence values or extra commentary.\n\n"
    "IMPORTANT: For set_number identification, look specifically in the bottom 15% "
    "of the image in either the left or right corner. The set number appears as "
    "a fraction format like '25/102' or just a number like '25'. Do NOT confuse "
    "this with level indicators (LV.XX) or other text elements on the card."
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

# Test configurations
FIRST_TWENTYFIVE_DIR = Path.home() / "Pictures" / "pokemoncards" / "first-twentyfive"
GROUND_TRUTH_JSON = Path.home() / "Pictures" / "pokemoncards" / "pokemon_cards.json"

class TokenParamMetrics:
    """Metrics for comparing token parameter configurations."""

    def __init__(self, config_name: str):
        self.config_name = config_name
        self.start_time = time.time()
        self.inference_times = []
        self.accuracy_stats = {"name": 0, "hp": 0, "set_number": 0, "total": 0}

    def add_inference(self, inference_ms: float, card_info: Dict[str, Any]):
        self.inference_times.append(inference_ms)
        self.accuracy_stats["total"] += 1
        if card_info.get("name_correct"):
            self.accuracy_stats["name"] += 1
        if card_info.get("hp_correct"):
            self.accuracy_stats["hp"] += 1
        if card_info.get("set_number_correct"):
            self.accuracy_stats["set_number"] += 1

    def get_summary(self) -> Dict[str, Any]:
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

        return {
            "config": self.config_name,
            "performance": {
                "avg_inference_ms": avg_time,
                "variance_percent": variance_percent,
                "total_cards": len(self.inference_times)
            },
            "accuracy": {
                **accuracies,
                "full_card_accuracy": full_accuracy,
            }
        }


def encode_image_to_data_url(image_path: Path) -> str:
    with Image.open(image_path) as img:
        rgb_image = img.convert("RGB")
        buffer = BytesIO()
        rgb_image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{encoded}"


def build_messages(image_data_url: str) -> List[Dict[str, Any]]:
    return [
        {"role": "system", "content": PHASE_4A_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Identify this Pokemon card."},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]


def inference_request(client: OpenAI, image_path: Path, context_tokens: int, max_tokens: int) -> Dict[str, Any]:
    image_data_url = encode_image_to_data_url(image_path)
    messages = build_messages(image_data_url)

    inference_start = time.perf_counter()

    response = client.chat.completions.create(
        model=DEFAULT_MODEL_ID,
        messages=messages,
        temperature=0,
        seed=0,
        max_tokens=max_tokens,
        response_format=RESPONSE_SCHEMA,
        extra_body={"context_length": context_tokens}
    )

    inference_time_ms = (time.perf_counter() - inference_start) * 1000

    try:
        prediction = json.loads(response.choices[0].message.content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model output is not valid JSON: {response.choices[0].message.content}") from exc

    return {
        "prediction": prediction,
        "inference_ms": inference_time_ms
    }


def load_ground_truth(path: Path) -> Dict[str, Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        records: List[Dict[str, Any]] = json.load(f)
    return {record["id"]: record for record in records}


def normalize_card_id(image_path: Path) -> str:
    return image_path.stem


def resolve_truth_set_number(truth: Dict[str, Any], card_id: str) -> str:
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

    # Simple set number comparison - extract numerator from fraction if needed
    set_number_correct = False
    if pred_set_number == expected_set_number:
        set_number_correct = True
    elif "/" in pred_set_number:
        pred_numerator = pred_set_number.split("/")[0].strip()
        set_number_correct = pred_numerator == expected_set_number

    return {
        "name_correct": pred_name == expected_name,
        "hp_correct": pred_hp == expected_hp,
        "set_number_correct": set_number_correct,
    }


def run_config_test(image_paths: List[Path], ground_truth: Dict[str, Dict[str, Any]],
                   context_tokens: int, max_tokens: int, config_name: str) -> Dict[str, Any]:

    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    metrics = TokenParamMetrics(config_name)
    results = []

    print(f"\n🧪 Testing {config_name} ({context_tokens} context, {max_tokens} max_tokens)")

    for i, image_path in enumerate(image_paths, 1):
        card_id = normalize_card_id(image_path)
        truth = ground_truth.get(card_id, {})

        print(f"[{i}/{len(image_paths)}] {card_id}", end=" ... ", flush=True)

        try:
            result = inference_request(client, image_path, context_tokens, max_tokens)
            comparison = compare_fields(result["prediction"], truth, card_id)

            card_result = {
                "card_number": i,
                "card_id": card_id,
                "prediction": result["prediction"],
                "ground_truth": {
                    "name": truth.get("name", ""),
                    "hp": truth.get("hp"),
                    "set_number": resolve_truth_set_number(truth, card_id)
                },
                "comparison": comparison,
                "inference_ms": result["inference_ms"],
                "success": True
            }

            results.append(card_result)
            metrics.add_inference(result["inference_ms"], comparison)

            # Progress output
            accuracy_symbols = [
                "✓" if comparison["name_correct"] else "✗",
                "✓" if comparison["hp_correct"] else "✗",
                "✓" if comparison["set_number_correct"] else "✗"
            ]
            print(f"{result['inference_ms']/1000:.1f}s {''.join(accuracy_symbols)}")

        except Exception as e:
            print(f"❌ FAILED: {e}")
            results.append({
                "card_number": i,
                "card_id": card_id,
                "error": str(e),
                "success": False
            })

    summary = metrics.get_summary()

    return {
        "config_metadata": {
            "name": config_name,
            "context_tokens": context_tokens,
            "max_tokens": max_tokens,
            "timestamp": dt.datetime.now().isoformat()
        },
        "results": results,
        "summary": summary
    }


def main():
    parser = argparse.ArgumentParser(description="Token Parameter Regression Test")
    parser.add_argument("--compare", action="store_true", help="Compare both configurations")
    parser.add_argument("--orig-only", action="store_true", help="Test only 768/40 config")
    parser.add_argument("--opt-only", action="store_true", help="Test only 512/30 config")

    args = parser.parse_args()

    # Check daemon
    require_keepwarm_daemon()

    # Load data
    image_paths = sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))[:5]  # Mini test
    ground_truth = load_ground_truth(GROUND_TRUTH_JSON)

    print("🔬 TOKEN PARAMETER REGRESSION TEST")
    print("=" * 50)
    print("Testing Kyle's hypothesis: 768/40 may outperform 512/30")

    test_results = {}

    if args.compare or args.orig_only:
        # Test Kyle's enhanced configuration (777/42)
        test_results["777_42"] = run_config_test(image_paths, ground_truth, 777, 42, "Kyle-777/42")

    if args.compare or args.opt_only:
        # Test Phase 4C configuration (512/30)
        test_results["512_30"] = run_config_test(image_paths, ground_truth, 512, 30, "Phase4C-512/30")

    # Print comparison
    print(f"\n📊 CONFIGURATION COMPARISON")
    print("=" * 60)

    for config_key, result in test_results.items():
        if result and "summary" in result:
            summary = result["summary"]
            perf = summary["performance"]
            acc = summary["accuracy"]

            print(f"\n{summary['config']}:")
            print(f"  ⏱️  Avg Time: {perf['avg_inference_ms']/1000:.1f}s")
            print(f"  📈 Variance: {perf['variance_percent']:.1f}%")
            print(f"  🎯 Full Accuracy: {acc['full_card_accuracy']*100:.1f}%")
            print(f"  📝 Set Number: {acc['set_number']*100:.1f}%")

    # Save results
    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")
    results_file = Path(f"results/token-param-regression-{timestamp}.json")
    results_file.parent.mkdir(exist_ok=True)

    with results_file.open("w") as f:
        json.dump(test_results, f, indent=2)

    print(f"\n💾 Results saved: {results_file}")

    if len(test_results) == 2:
        # Provide recommendation
        s768 = test_results["768_40"]["summary"]
        s512 = test_results["512_30"]["summary"]

        print(f"\n🎯 RECOMMENDATION:")
        if s768["accuracy"]["full_card_accuracy"] > s512["accuracy"]["full_card_accuracy"]:
            print("✅ 768/40 configuration shows better accuracy - Kyle's hypothesis CONFIRMED")
        else:
            print("❌ 512/30 configuration maintains accuracy advantage")

        if s768["performance"]["variance_percent"] < s512["performance"]["variance_percent"]:
            print("✅ 768/40 configuration shows better variance stability")
        else:
            print("❌ 512/30 configuration shows better variance")

    return 0


if __name__ == "__main__":
    exit(main())