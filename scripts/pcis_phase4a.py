#!/usr/bin/env python3
"""Phase 4A Medium-Scale Validation - 25-Card Daemon Stability Test.

This script implements Phase 4A validation with enhanced monitoring and stability testing:
- Tests 25 cards (base2 set) completely different from Phase 3A first-ten
- Enhanced resource monitoring and daemon health tracking
- Checkpointing every 5 cards for resumability
- Comprehensive metrics collection for production readiness assessment
- Variance analysis and performance consistency validation

Key Phase 4A Goals:
- Validate daemon stability over extended 25-card workloads
- Establish performance consistency metrics
- Test resource consumption patterns
- Identify potential memory leaks or degradation

Configuration: 768 context + 40 max_tokens (Phase 3A optimal, daemon-warmed)
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

# Phase 3A optimal configuration (validated)
SYSTEM_PROMPT = (
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

FIRST_TWENTYFIVE_DIR = Path.home() / "Pictures" / "pokemoncards" / "first-twentyfive"
GROUND_TRUTH_JSON = Path.home() / "Pictures" / "pokemoncards" / "pokemon_cards.json"
CHECKPOINT_DIR = Path("checkpoints")
CHECKPOINT_INTERVAL = 5  # Save checkpoint every 5 cards

# GPU Monitoring Configuration
GPU_MONITORING_ENABLED = True  # Enable GPU utilization tracking

class Phase4AMetrics:
    """Enhanced metrics collection for Phase 4A validation."""

    def __init__(self, restored_start_time: Optional[float] = None):
        self.start_time = restored_start_time or time.time()
        self.system_metrics = []
        self.daemon_health_checks = []
        self.inference_metrics = []
        self.checkpoint_times = []
        self.process = psutil.Process()

    def restore_from_checkpoint(self, checkpoint_data: Dict[str, Any]):
        """Restore metrics state from checkpoint data.

        Args:
            checkpoint_data: The full checkpoint JSON data
        """
        # Restore metrics summary if available
        if "metrics_summary" in checkpoint_data:
            summary = checkpoint_data["metrics_summary"]
            if "total_elapsed_s" in summary:
                # Calculate original start time from elapsed time
                checkpoint_time = dt.datetime.fromisoformat(checkpoint_data["timestamp"]).timestamp()
                self.start_time = checkpoint_time - summary["total_elapsed_s"]

        # Restore per-card inference metrics from results
        # CRITICAL FIX: Process ALL results (successful AND failed) to maintain accurate counts
        if "results" in checkpoint_data:
            for result in checkpoint_data["results"]:
                # Process EVERY result regardless of success flag to ensure accurate totals
                # Reconstruct timing from stored result data, defaulting missing fields to 0.0
                inference_ms = result.get("inference_time_ms", 0.0)
                total_card_ms = result.get("total_card_time_ms", inference_ms)  # Fallback to inference time
                encode_ms = result.get("encode_time_ms", 0.0)
                parse_ms = result.get("parse_time_ms", 0.0)

                # Reconstruct inference record for ALL attempts (success and failure)
                # This ensures that metrics like total_cards, variance, and success_rate are accurate
                inference_record = {
                    "card_number": result.get("card_number", len(self.inference_metrics) + 1),
                    "timestamp": self.start_time,  # Approximate timestamp
                    "inference_ms": inference_ms,
                    "total_ms": total_card_ms,
                    "encode_ms": encode_ms,
                    "parse_ms": parse_ms,
                    "success": result.get("success", True)  # Legacy compatibility: default True for missing field
                }
                self.inference_metrics.append(inference_record)

            print(f"📊 Restored {len(self.inference_metrics)} inference records from checkpoint")

    def record_system_snapshot(self):
        """Record current system resource state."""
        memory = psutil.virtual_memory()
        snapshot = {
            "timestamp": time.time(),
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "memory_used_mb": round(memory.used / (1024**2)),
            "memory_available_mb": round(memory.available / (1024**2)),
            "memory_percent": memory.percent,
            "process_memory_mb": round(self.process.memory_info().rss / (1024**2)),
            "process_cpu_percent": self.process.cpu_percent()
        }
        self.system_metrics.append(snapshot)
        return snapshot

    def record_daemon_health(self, health_data: Dict[str, Any]):
        """Record daemon health check result."""
        health_record = {
            "timestamp": time.time(),
            "status": health_data.get("status", "unknown"),
            "warmup_count": health_data.get("warmup_count", 0),
            "last_warmup_age": health_data.get("last_warmup_age", 999),
            "errors": health_data.get("errors", 0)
        }
        self.daemon_health_checks.append(health_record)
        return health_record

    def record_inference(self, timing: Dict[str, float], success: bool, card_number: int):
        """Record inference timing and success with detailed breakdown."""
        inference_record = {
            "card_number": card_number,
            "timestamp": time.time(),
            "inference_ms": timing.get("inference_ms", 0),
            "total_ms": timing.get("total_card_ms", 0),
            "encode_ms": timing.get("total_encode_ms", 0),
            "parse_ms": timing.get("parse_ms", 0),
            "success": success,
            # Enhanced diagnostic timing
            "api_prep_ms": timing.get("api_prep_ms", 0),
            "request_start_ms": timing.get("request_start_ms", 0),
            "time_to_first_byte_ms": timing.get("time_to_first_byte_ms", 0),
            "response_stream_ms": timing.get("response_stream_ms", 0),
            "enqueue_delay_ms": timing.get("enqueue_delay_ms", 0),
            # Raw timestamps for analysis
            "raw_timestamps": {
                "card_start": timing.get("card_start_timestamp", 0),
                "encode_start": timing.get("encode_start_timestamp", 0),
                "encode_end": timing.get("encode_end_timestamp", 0),
                "api_prep_start": timing.get("api_prep_start_timestamp", 0),
                "api_prep_end": timing.get("api_prep_end_timestamp", 0),
                "request_start": timing.get("request_start_timestamp", 0),
                "first_byte": timing.get("first_byte_timestamp", 0),
                "response_complete": timing.get("response_complete_timestamp", 0),
                "parse_start": timing.get("parse_start_timestamp", 0),
                "parse_end": timing.get("parse_end_timestamp", 0),
                "card_end": timing.get("card_end_timestamp", 0)
            }
        }
        self.inference_metrics.append(inference_record)
        return inference_record

    def record_checkpoint(self, card_count: int):
        """Record checkpoint creation time."""
        checkpoint_record = {
            "card_count": card_count,
            "timestamp": time.time(),
            "elapsed_time": time.time() - self.start_time
        }
        self.checkpoint_times.append(checkpoint_record)
        return checkpoint_record

    def get_summary_stats(self) -> Dict[str, Any]:
        """Calculate summary statistics."""
        if not self.inference_metrics:
            return {}

        successful_inferences = [m for m in self.inference_metrics if m.get("success", True)]
        inference_times = [m["inference_ms"] for m in successful_inferences]

        stats = {
            "total_cards": len(self.inference_metrics),
            "successful_cards": len(successful_inferences),
            "success_rate": len(successful_inferences) / len(self.inference_metrics) * 100,
            "avg_inference_ms": sum(inference_times) / len(inference_times) if inference_times else 0,
            "min_inference_ms": min(inference_times) if inference_times else 0,
            "max_inference_ms": max(inference_times) if inference_times else 0,
            "inference_variance": self._calculate_variance(inference_times) if len(inference_times) > 1 else 0,
            "total_elapsed_s": time.time() - self.start_time
        }

        # System resource trends
        if self.system_metrics:
            memory_usage = [m["process_memory_mb"] for m in self.system_metrics]
            stats["memory_start_mb"] = memory_usage[0]
            stats["memory_end_mb"] = memory_usage[-1]
            stats["memory_growth_mb"] = memory_usage[-1] - memory_usage[0]
            stats["max_memory_mb"] = max(memory_usage)

        return stats

    def _calculate_variance(self, values: List[float]) -> float:
        """Calculate variance percentage."""
        if len(values) < 2:
            return 0
        mean_val = sum(values) / len(values)
        variance = sum((x - mean_val) ** 2 for x in values) / len(values)
        return (variance ** 0.5) / mean_val * 100 if mean_val > 0 else 0

    def capture_gpu_utilization(self) -> Dict[str, Any]:
        """Capture GPU utilization snapshot for diagnostic analysis."""
        if not GPU_MONITORING_ENABLED:
            return {}

        gpu_data = {
            "timestamp": time.time(),
            "intel_arc_utilization": 0,
            "nvidia_utilization": 0,
            "gpu_memory_usage": 0,
            "monitoring_method": "none"
        }

        try:
            # Try intel_gpu_top for Intel Arc A770
            result = subprocess.run(
                ["intel_gpu_top", "-J", "-s", "100"],  # JSON output, 100ms sample
                capture_output=True,
                text=True,
                timeout=2
            )
            if result.returncode == 0:
                intel_data = json.loads(result.stdout)
                gpu_data["intel_arc_utilization"] = intel_data.get("engines", {}).get("Render/3D", {}).get("busy", 0)
                gpu_data["gpu_memory_usage"] = intel_data.get("memory", {}).get("used", 0)
                gpu_data["monitoring_method"] = "intel_gpu_top"
                return gpu_data

        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError):
            pass

        try:
            # Fallback: Try nvidia-smi for NVIDIA GTX 1050 Ti
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=2
            )
            if result.returncode == 0:
                lines = result.stdout.strip().split('\n')
                if lines:
                    parts = lines[0].split(', ')
                    if len(parts) >= 2:
                        gpu_data["nvidia_utilization"] = float(parts[0])
                        gpu_data["gpu_memory_usage"] = float(parts[1])
                        gpu_data["monitoring_method"] = "nvidia-smi"
                        return gpu_data

        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError, ValueError):
            pass

        # Fallback: Mock GPU data for development/testing
        gpu_data["monitoring_method"] = "mock"
        gpu_data["intel_arc_utilization"] = 50  # Mock utilization
        return gpu_data

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


def save_checkpoint(results: List[Dict[str, Any]], metrics: Phase4AMetrics, checkpoint_num: int, cards_attempted: int):
    """Save checkpoint data for resumability.

    Args:
        results: List of successful card processing results
        metrics: Phase4AMetrics instance with timing data
        checkpoint_num: Checkpoint sequence number
        cards_attempted: Total number of cards attempted (including failures)
    """
    CHECKPOINT_DIR.mkdir(exist_ok=True)
    checkpoint_path = CHECKPOINT_DIR / f"phase4a_checkpoint_{checkpoint_num}.json"

    checkpoint_data = {
        "checkpoint_number": checkpoint_num,
        "timestamp": dt.datetime.now().isoformat(),
        "cards_attempted": cards_attempted,  # CRITICAL: Track attempted, not just successful
        "cards_successful": len(results),
        "results": results,
        "metrics_summary": metrics.get_summary_stats()
    }

    with checkpoint_path.open("w", encoding="utf-8") as f:
        json.dump(checkpoint_data, f, indent=2)

    print(f"💾 Checkpoint {checkpoint_num} saved: {cards_attempted} attempted, {len(results)} successful")
    return checkpoint_path


def load_checkpoint(checkpoint_num: int) -> Optional[Tuple[List[Dict[str, Any]], int, Dict[str, int], Dict[str, Any]]]:
    """Load checkpoint data for resuming.

    Returns:
        Tuple of (results, cards_attempted, tally_state, checkpoint_data) or None if checkpoint doesn't exist
    """
    checkpoint_path = CHECKPOINT_DIR / f"phase4a_checkpoint_{checkpoint_num}.json"

    if not checkpoint_path.exists():
        return None

    try:
        with checkpoint_path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        # Reconstruct tally from existing results to maintain accuracy tracking
        results = data["results"]
        tally = {"name_correct": 0, "hp_correct": 0, "set_number_correct": 0}
        for result in results:
            if result.get("name_correct", False):
                tally["name_correct"] += 1
            if result.get("hp_correct", False):
                tally["hp_correct"] += 1
            if result.get("set_number_correct", False):
                tally["set_number_correct"] += 1

        # Use cards_attempted (new) or fall back to cards_processed (legacy)
        cards_attempted = data.get("cards_attempted", data.get("cards_processed", 0))

        return results, cards_attempted, tally, data
    except Exception as e:
        print(f"⚠️  Failed to load checkpoint {checkpoint_num}: {e}")
        return None


def perform_daemon_health_check(metrics: Phase4AMetrics) -> Dict[str, Any]:
    """Perform daemon health check and record metrics."""
    from daemon_integration import check_keepwarm_daemon

    is_running, health_data = check_keepwarm_daemon()

    if not is_running:
        raise RuntimeError("Daemon is not running - Phase 4A requires stable daemon")

    health_record = metrics.record_daemon_health(health_data or {})

    # Warn if daemon seems unhealthy
    if health_data:
        last_warmup = health_data.get("last_warmup_age", 999)
        if last_warmup > 60:
            print(f"⚠️  Daemon warmup stale: {last_warmup:.1f}s ago")

    return health_data or {}


def identify_card_with_monitoring(
    client: OpenAI,
    image_path: Path,
    metrics: Phase4AMetrics,
    card_number: int,
    *,
    max_tokens: int = 40
) -> Tuple[Dict[str, Any], Dict[str, float], bool]:
    """Identify a card with comprehensive diagnostic monitoring."""
    timing = {}
    success = False

    # High-resolution timestamps for diagnostic analysis
    card_start_time = time.perf_counter()
    timing['card_start_timestamp'] = card_start_time

    try:
        # Record system state before inference
        metrics.record_system_snapshot()

        # PHASE 0: GPU utilization snapshot (pre-inference)
        gpu_pre_inference = metrics.capture_gpu_utilization()
        timing['gpu_pre_inference'] = gpu_pre_inference

        # PHASE 1: Image encoding with detailed timing
        encode_start_time = time.perf_counter()
        timing['encode_start_timestamp'] = encode_start_time
        data_url, encode_timing = encode_image_to_data_url(image_path)
        encode_end_time = time.perf_counter()
        timing['encode_end_timestamp'] = encode_end_time
        timing.update(encode_timing)

        # PHASE 2: API preparation with detailed timing
        api_prep_start_time = time.perf_counter()
        timing['api_prep_start_timestamp'] = api_prep_start_time
        messages = build_messages(data_url)
        api_prep_end_time = time.perf_counter()
        timing['api_prep_end_timestamp'] = api_prep_end_time
        timing['api_prep_ms'] = (api_prep_end_time - api_prep_start_time) * 1000

        # PHASE 3: Critical inference timing with diagnostic breakdown
        request_start_time = time.perf_counter()
        timing['request_start_timestamp'] = request_start_time
        timing['request_start_ms'] = (request_start_time - card_start_time) * 1000

        # Calculate enqueue delay (time from request to actual send)
        timing['enqueue_delay_ms'] = 0  # Will be updated if we detect queueing

        # Create request with streaming capability for TTFB measurement
        response = client.chat.completions.create(
            model=DEFAULT_MODEL_ID,
            messages=messages,
            temperature=0,
            seed=0,
            max_tokens=max_tokens,
            response_format=RESPONSE_SCHEMA,
            extra_body={"context_length": 768}  # Phase 3A optimal
        )

        # Capture response complete time (synchronous call means no streaming data)
        response_complete_time = time.perf_counter()
        timing['response_complete_timestamp'] = response_complete_time
        timing['inference_ms'] = (response_complete_time - request_start_time) * 1000
        timing['response_stream_ms'] = 0  # No streaming in synchronous mode

        # PHASE 4: Response parsing with detailed timing
        parse_start_time = time.perf_counter()
        timing['parse_start_timestamp'] = parse_start_time
        raw_content = response.choices[0].message.content
        if raw_content is None:
            raise RuntimeError("Model returned empty content")
        prediction = parse_prediction(raw_content)
        parse_end_time = time.perf_counter()
        timing['parse_end_timestamp'] = parse_end_time
        timing['parse_ms'] = (parse_end_time - parse_start_time) * 1000

        # PHASE 5: GPU utilization snapshot (post-inference)
        gpu_post_inference = metrics.capture_gpu_utilization()
        timing['gpu_post_inference'] = gpu_post_inference

        # Calculate GPU utilization delta (support Intel Arc, NVIDIA, and mock data)
        gpu_pre_util = timing['gpu_pre_inference'].get('intel_arc_utilization',
                                                        timing['gpu_pre_inference'].get('nvidia_utilization', 0))
        gpu_post_util = gpu_post_inference.get('intel_arc_utilization',
                                               gpu_post_inference.get('nvidia_utilization', 0))
        timing['gpu_utilization_delta'] = gpu_post_util - gpu_pre_util

        # PHASE 6: Complete timing calculation
        card_end_time = time.perf_counter()
        timing['card_end_timestamp'] = card_end_time
        timing['total_card_ms'] = (card_end_time - card_start_time) * 1000

        # Diagnostic: Detect potential performance issues
        if timing['inference_ms'] > 20000:  # >20s suggests performance degradation
            print(f"⚠️  Slow inference detected: {timing['inference_ms']:.0f}ms")

        success = True
        return prediction, timing, success

    except Exception as e:
        print(f"❌ Card {card_number} failed: {e}")
        # Even on failure, capture timing data for diagnostic analysis
        failure_time = time.perf_counter()
        timing['card_end_timestamp'] = failure_time
        timing['total_card_ms'] = (failure_time - card_start_time) * 1000
        return {}, timing, success
    finally:
        # Record inference metrics regardless of success - critical for diagnostic analysis
        metrics.record_inference(timing, success, card_number)


def collect_twentyfive_cards() -> List[Path]:
    if not FIRST_TWENTYFIVE_DIR.exists():
        raise FileNotFoundError(f"Missing directory: {FIRST_TWENTYFIVE_DIR}")
    return sorted(FIRST_TWENTYFIVE_DIR.glob("*.png"))


def evaluate_phase4a_batch(
    image_paths: List[Path],
    resume_from_checkpoint: Optional[int] = None,
    diagnostic_mode: bool = False,
    skip_daemon_checks: bool = False
) -> Tuple[List[Dict[str, Any]], Dict[str, int], Phase4AMetrics]:
    """Phase 4A batch evaluation with enhanced monitoring and diagnostic capabilities."""

    client = OpenAI(base_url=DEFAULT_SERVER_URL, api_key="lm-studio")
    truth = load_ground_truth(GROUND_TRUTH_JSON)
    metrics = Phase4AMetrics()  # Will be updated if resuming from checkpoint

    # Check for resume from checkpoint
    results = []
    start_index = 0
    tally = {"name_correct": 0, "hp_correct": 0, "set_number_correct": 0}
    if resume_from_checkpoint:
        checkpoint_data = load_checkpoint(resume_from_checkpoint)
        if checkpoint_data:
            results, start_index, tally, checkpoint_json = checkpoint_data
            # Restore metrics state from checkpoint
            metrics.restore_from_checkpoint(checkpoint_json)
            print(f"🔄 Resuming from checkpoint {resume_from_checkpoint}: {start_index} cards attempted, {len(results)} successful")
            print(f"📊 Restored accuracy: {tally['name_correct']}/{len([r for r in results if r.get('success', True)])} names, {tally['hp_correct']}/{len([r for r in results if r.get('success', True)])} HP, {tally['set_number_correct']}/{len([r for r in results if r.get('success', True)])} set numbers")
            print(f"⏱️  Restored {len(metrics.inference_metrics)} prior inference records")

    # Daemon health check (skip if requested for diagnostic purposes)
    if not skip_daemon_checks:
        print("🔍 Performing initial daemon health check...")
        daemon_health = perform_daemon_health_check(metrics)
        print(f"✅ Daemon healthy - Status: {daemon_health.get('status', 'unknown')}")
        daemon_status = "daemon-warmed"
    else:
        print("⚠️  Skipping daemon health checks (diagnostic mode)")
        daemon_status = "cold-start"

    # Enhanced diagnostic mode reporting
    mode_label = "DIAGNOSTIC" if diagnostic_mode else "MEDIUM-SCALE VALIDATION"
    warmup_status = daemon_status

    print(f"🚀 CardMint PHASE 4A - {mode_label} ({len(image_paths)} cards)")
    print(f"Target: {DEFAULT_SERVER_URL} | Model: {DEFAULT_MODEL_ID}")
    print(f"Dataset: base2 cards (different from Phase 3A first-ten)")
    print(f"Configuration: 768 context + 40 max_tokens ({warmup_status})")

    if diagnostic_mode:
        print(f"🔬 Diagnostic features: Enhanced timing breakdown, raw timestamps")
    else:
        print(f"Enhanced monitoring: System resources, daemon health, checkpointing")
    print("=" * 80)

    # tally already initialized above for checkpoint compatibility
    batch_start = time.perf_counter()

    for i, image_path in enumerate(image_paths[start_index:], start_index + 1):
        card_id = normalize_card_id(image_path)
        ground_truth = truth.get(card_id)
        if not ground_truth:
            print(f"[WARN] No ground truth for {card_id}; skipping.", file=sys.stderr)
            continue

        print(f"🔍 Processing card {i}/{len(image_paths)}: {card_id}")

        # Daemon health check every 5 cards (skip if disabled for diagnostics)
        if i % 5 == 0 and not skip_daemon_checks:
            perform_daemon_health_check(metrics)

        # Diagnostic mode: Log detailed card-start information
        if diagnostic_mode:
            print(f"    🔬 Diagnostic: Starting card {i} at {time.strftime('%H:%M:%S.%f')[:-3]}")
            print(f"    🔬 Pattern analysis: Card {i} is {'EVEN' if i % 2 == 0 else 'ODD'} index")

        card_start = time.perf_counter()
        prediction, timing, success = identify_card_with_monitoring(
            client, image_path, metrics, i
        )
        card_total_ms = (time.perf_counter() - card_start) * 1000

        # CRITICAL FIX: Always create a result record, regardless of success
        # This ensures cards_attempted count matches actual processing progress
        truth_set_number = resolve_truth_set_number(ground_truth, card_id)

        if success:
            comparison = compare_fields(prediction, ground_truth, card_id)

            for key, value in comparison.items():
                if value:
                    tally[key] += 1

            # Success result record
            result_record = {
                "card_number": i,
                "image_file": str(image_path),
                "predicted_name": prediction.get("name"),
                "predicted_hp": prediction.get("hp"),
                "predicted_set_number": prediction.get("set_number"),
                "ground_truth_name": ground_truth.get("name"),
                "ground_truth_hp": ground_truth.get("hp"),
                "ground_truth_set_number": truth_set_number,
                "inference_time_ms": round(timing["inference_ms"], 2),
                "encode_time_ms": round(timing["total_encode_ms"], 2),
                "parse_time_ms": round(timing["parse_ms"], 2),
                "total_card_time_ms": round(card_total_ms, 2),
                "success": True
            }
            result_record.update(comparison)
            if diagnostic_mode:
                # Detailed diagnostic output with timing breakdown
                ttfb = timing.get('time_to_first_byte_ms', 0)
                stream = timing.get('response_stream_ms', 0)
                encode = timing.get('total_encode_ms', 0)
                parse = timing.get('parse_ms', 0)
                enqueue = timing.get('enqueue_delay_ms', 0)

                print(f"   ✅ {card_id}: {timing['inference_ms']:.0f}ms total")
                print(f"      🔬 Encode: {encode:.1f}ms | TTFB: {ttfb:.0f}ms | Stream: {stream:.1f}ms | Parse: {parse:.2f}ms")
                if enqueue > 0:
                    print(f"      ⚠️  Enqueue delay: {enqueue:.0f}ms (potential queueing)")

                # GPU utilization analysis
                gpu_pre = timing.get('gpu_pre_inference', {})
                gpu_post = timing.get('gpu_post_inference', {})
                gpu_delta = timing.get('gpu_utilization_delta', 0)
                monitoring_method = gpu_pre.get('monitoring_method', 'none')

                if monitoring_method != 'none':
                    pre_util = gpu_pre.get('intel_arc_utilization', gpu_pre.get('nvidia_utilization', 0))
                    post_util = gpu_post.get('intel_arc_utilization', gpu_post.get('nvidia_utilization', 0))
                    print(f"      🔧 GPU: {pre_util:.0f}% → {post_util:.0f}% (Δ{gpu_delta:+.0f}%) via {monitoring_method}")
                else:
                    print(f"      🔧 GPU: Monitoring not available")

                # Pattern correlation analysis
                pattern_type = "FAST" if timing['inference_ms'] < 25000 else "SLOW"
                index_type = "EVEN" if i % 2 == 0 else "ODD"
                print(f"      📊 Pattern: {pattern_type} card on {index_type} index ({i})")
            else:
                print(f"   ✅ {card_id}: {timing['inference_ms']:.0f}ms inference")
        else:
            # Failure result record - still track the attempt to prevent skipping
            result_record = {
                "card_number": i,
                "image_file": str(image_path),
                "predicted_name": None,
                "predicted_hp": None,
                "predicted_set_number": None,
                "ground_truth_name": ground_truth.get("name"),
                "ground_truth_hp": ground_truth.get("hp"),
                "ground_truth_set_number": truth_set_number,
                "inference_time_ms": timing.get("inference_ms", 0),
                "encode_time_ms": timing.get("total_encode_ms", 0),
                "parse_time_ms": timing.get("parse_ms", 0),
                "total_card_time_ms": round(card_total_ms, 2),
                "success": False,
                "name_correct": False,
                "hp_correct": False,
                "set_number_correct": False
            }
            if diagnostic_mode:
                print(f"   ❌ {card_id}: Processing failed")
                print(f"      🔬 Pattern: FAILED card on {'EVEN' if i % 2 == 0 else 'ODD'} index ({i})")
            else:
                print(f"   ❌ {card_id}: Processing failed")

        results.append(result_record)  # Always append to maintain index consistency

        # Checkpoint every 5 cards
        if i % CHECKPOINT_INTERVAL == 0:
            checkpoint_num = i // CHECKPOINT_INTERVAL
            save_checkpoint(results, metrics, checkpoint_num, i)  # Pass cards_attempted
            metrics.record_checkpoint(i)

            # Force garbage collection to prevent memory leaks
            gc.collect()

    batch_total_ms = (time.perf_counter() - batch_start) * 1000

    # Final checkpoint
    total_cards_attempted = len(image_paths)
    if total_cards_attempted % CHECKPOINT_INTERVAL != 0:
        final_checkpoint = (total_cards_attempted // CHECKPOINT_INTERVAL) + 1
        save_checkpoint(results, metrics, final_checkpoint, total_cards_attempted)

    return results, tally, metrics


def write_results(results: List[Dict[str, Any]], output_path: Path) -> None:
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


def write_comprehensive_report(
    results: List[Dict[str, Any]],
    tally: Dict[str, int],
    metrics: Phase4AMetrics,
    output_dir: Path,
    diagnostic_mode: bool = False
) -> Tuple[Path, Path]:
    """Write comprehensive Phase 4A analysis report with optional diagnostic timing."""

    output_dir.mkdir(exist_ok=True)
    timestamp = dt.datetime.now().strftime("%d%b%y-%H%M")
    mode_suffix = "-diagnostic" if diagnostic_mode else ""

    # Main results
    results_path = output_dir / f"phase4a-results{mode_suffix}-{timestamp}.json"
    write_results(results, results_path)

    # Diagnostic timing breakdown (if enabled)
    if diagnostic_mode:
        diagnostic_path = output_dir / f"phase4a-diagnostic-timing-{timestamp}.json"
        diagnostic_timing = {
            "test_metadata": {
                "diagnostic_mode": True,
                "timestamp": dt.datetime.now().isoformat(),
                "total_cards": len(results)
            },
            "raw_timing_data": [
                {
                    "card_number": metric.get("card_number", 0),
                    "inference_ms": metric.get("inference_ms", 0),
                    "time_to_first_byte_ms": metric.get("time_to_first_byte_ms", 0),
                    "response_stream_ms": metric.get("response_stream_ms", 0),
                    "encode_ms": metric.get("encode_ms", 0),
                    "parse_ms": metric.get("parse_ms", 0),
                    "enqueue_delay_ms": metric.get("enqueue_delay_ms", 0),
                    "gpu_utilization_delta": metric.get("gpu_utilization_delta", 0),
                    "gpu_pre_inference": metric.get("gpu_pre_inference", {}),
                    "gpu_post_inference": metric.get("gpu_post_inference", {}),
                    "raw_timestamps": metric.get("raw_timestamps", {}),
                    "pattern_analysis": {
                        "index_type": "EVEN" if metric.get("card_number", 0) % 2 == 0 else "ODD",
                        "speed_category": "FAST" if metric.get("inference_ms", 0) < 25000 else "SLOW",
                        "success": metric.get("success", True)
                    }
                }
                for metric in metrics.inference_metrics
            ]
        }

        with diagnostic_path.open("w", encoding="utf-8") as f:
            json.dump(diagnostic_timing, f, indent=2)

        print(f"🔬 Diagnostic timing report: {diagnostic_path}")

    # Comprehensive metrics report
    metrics_path = output_dir / f"phase4a-metrics-{timestamp}.json"
    comprehensive_report = {
        "test_metadata": {
            "phase": "4A",
            "total_cards": len(results),
            "start_time": dt.datetime.fromtimestamp(metrics.start_time).isoformat(),
            "end_time": dt.datetime.now().isoformat(),
            "daemon_version": "1.0",
            "checkpoint_interval": CHECKPOINT_INTERVAL
        },
        "aggregate_metrics": metrics.get_summary_stats(),
        "accuracy_metrics": {
            "name_correct": tally["name_correct"],
            "hp_correct": tally["hp_correct"],
            "set_number_correct": tally["set_number_correct"],
            "total_cards": len(results),
            "name_accuracy": tally["name_correct"] / len(results) * 100 if results else 0,
            "hp_accuracy": tally["hp_correct"] / len(results) * 100 if results else 0,
            "set_accuracy": tally["set_number_correct"] / len(results) * 100 if results else 0,
            "fully_correct_cards": sum(
                1 for result in results
                if (result.get('success', True) and  # Legacy compatibility: default True
                    result.get('name_correct', False) and
                    result.get('hp_correct', False) and
                    result.get('set_number_correct', False))
            ),
            "full_card_accuracy": sum(
                1 for result in results
                if (result.get('success', True) and  # Legacy compatibility: default True
                    result.get('name_correct', False) and
                    result.get('hp_correct', False) and
                    result.get('set_number_correct', False))
            ) / len(results) * 100 if results else 0
        },
        "system_metrics": metrics.system_metrics,
        "daemon_health_checks": metrics.daemon_health_checks,
        "checkpoint_times": metrics.checkpoint_times,
        "per_card_results": results
    }

    with metrics_path.open("w", encoding="utf-8") as f:
        json.dump(comprehensive_report, f, indent=2)

    print(f"📊 Comprehensive report saved: {metrics_path}")
    return results_path, metrics_path


def determine_output_dir() -> Path:
    return Path("results")


def main(args: argparse.Namespace) -> int:
    # DIAGNOSTIC MODE: Enhanced instrumentation for performance investigation
    if args.diagnostic_mode:
        print("🔬 DIAGNOSTIC MODE ENABLED - Enhanced timing instrumentation active")
        if args.skip_daemon:
            print("⚠️  DAEMON CHECKS DISABLED - Performance may be impacted by cold starts")
        if args.cards_limit:
            print(f"🔢 CARDS LIMITED - Processing only first {args.cards_limit} cards")

    # DAEMON INTEGRATION: Require keepwarm daemon unless explicitly skipped
    if not args.skip_daemon:
        print("🔧 Phase 4A Initialization...")
        daemon_health = require_keepwarm_daemon()
    else:
        print("🔧 Phase 4A Initialization (daemon checks skipped)...")
        daemon_health = None

    image_paths = collect_twentyfive_cards()
    if not image_paths:
        print("No images found in first-twentyfive directory.", file=sys.stderr)
        return 1

    # Apply card limit if specified (diagnostic mode)
    if args.cards_limit:
        image_paths = image_paths[:args.cards_limit]
        print(f"📋 Limited to {len(image_paths)} cards for diagnostic testing")
    else:
        print(f"📋 Found {len(image_paths)} test cards for Phase 4A validation")

    # Signal activity to keepwarm daemon
    try:
        Path("/tmp/cardmint_inference_activity").touch()
    except Exception:
        pass  # Continue even if activity signal fails

    # Execute Phase 4A batch evaluation
    try:
        results, tally, metrics = evaluate_phase4a_batch(
            image_paths,
            resume_from_checkpoint=args.resume_checkpoint if hasattr(args, 'resume_checkpoint') else None,
            diagnostic_mode=args.diagnostic_mode,
            skip_daemon_checks=args.skip_daemon
        )

        output_dir = determine_output_dir()
        results_path, metrics_path = write_comprehensive_report(results, tally, metrics, output_dir, args.diagnostic_mode)

        # Performance analysis
        stats = metrics.get_summary_stats()
        print(f"\n📊 PHASE 4A PERFORMANCE ANALYSIS")
        print(f"Total cards processed: {stats.get('total_cards', 0)}")
        print(f"Successful cards: {stats.get('successful_cards', 0)}")
        print(f"Success rate: {stats.get('success_rate', 0):.1f}%")
        print(f"Average inference: {stats.get('avg_inference_ms', 0):.1f}ms")
        print(f"Inference variance: {stats.get('inference_variance', 0):.1f}%")
        print(f"Total elapsed time: {stats.get('total_elapsed_s', 0):.1f}s")

        # Memory analysis
        print(f"\n🧠 MEMORY ANALYSIS")
        print(f"Starting memory: {stats.get('memory_start_mb', 0):.1f}MB")
        print(f"Ending memory: {stats.get('memory_end_mb', 0):.1f}MB")
        print(f"Memory growth: {stats.get('memory_growth_mb', 0):.1f}MB")
        print(f"Peak memory: {stats.get('max_memory_mb', 0):.1f}MB")

        # Accuracy results
        print(f"\n🎯 PHASE 4A ACCURACY RESULTS")
        total_cards = len(results)
        if total_cards > 0:
            name_acc = tally['name_correct'] / total_cards * 100
            hp_acc = tally['hp_correct'] / total_cards * 100
            set_acc = tally['set_number_correct'] / total_cards * 100

            # CRITICAL FIX: Calculate cards with ALL fields correct (not averaged accuracy)
            # LEGACY COMPATIBILITY: Default success=True for checkpoints without success field
            fully_correct_cards = sum(
                1 for result in results
                if (result.get('success', True) and  # Legacy compatibility: default True
                    result.get('name_correct', False) and
                    result.get('hp_correct', False) and
                    result.get('set_number_correct', False))
            )
            full_accuracy = fully_correct_cards / total_cards * 100

            print(f"Name accuracy: {tally['name_correct']}/{total_cards} ({name_acc:.1f}%)")
            print(f"HP accuracy: {tally['hp_correct']}/{total_cards} ({hp_acc:.1f}%)")
            print(f"Set number accuracy: {tally['set_number_correct']}/{total_cards} ({set_acc:.1f}%)")
            print(f"Cards fully correct: {fully_correct_cards}/{total_cards} ({full_accuracy:.1f}%)")
            print(f"Field-averaged accuracy: {(name_acc + hp_acc + set_acc) / 3:.1f}% (legacy metric)")

            # Phase 4A Success Criteria Evaluation
            print(f"\n✅ PHASE 4A SUCCESS CRITERIA EVALUATION")
            criteria_met = 0
            total_criteria = 4

            # Criterion 1: Full card accuracy ≥95%
            if full_accuracy >= 95.0:
                print(f"✅ Full card accuracy ≥95%: {full_accuracy:.1f}% ({fully_correct_cards}/{total_cards} cards) (PASS)")
                criteria_met += 1
            else:
                print(f"❌ Full card accuracy ≥95%: {full_accuracy:.1f}% ({fully_correct_cards}/{total_cards} cards) (FAIL)")

            # Criterion 2: Inference variance <15%
            variance = stats.get('inference_variance', 0)
            if variance < 15.0:
                print(f"✅ Inference variance <15%: {variance:.1f}% (PASS)")
                criteria_met += 1
            else:
                print(f"❌ Inference variance <15%: {variance:.1f}% (FAIL)")

            # Criterion 3: Memory stability (growth <50MB)
            memory_growth = abs(stats.get('memory_growth_mb', 0))
            if memory_growth < 50:
                print(f"✅ Memory stable (<50MB growth): {memory_growth:.1f}MB (PASS)")
                criteria_met += 1
            else:
                print(f"❌ Memory stable (<50MB growth): {memory_growth:.1f}MB (FAIL)")

            # Criterion 4: No daemon restarts
            daemon_checks = len(metrics.daemon_health_checks)
            daemon_healthy = all(check.get('status') == 'healthy' for check in metrics.daemon_health_checks)
            if daemon_healthy and daemon_checks > 0:
                print(f"✅ Daemon stability: All {daemon_checks} health checks passed (PASS)")
                criteria_met += 1
            else:
                print(f"❌ Daemon stability: Health check issues detected (FAIL)")

            # Overall Phase 4A assessment
            print(f"\n🏆 PHASE 4A OVERALL ASSESSMENT")
            print(f"Criteria met: {criteria_met}/{total_criteria}")
            if criteria_met == total_criteria:
                print("🎉 PHASE 4A: COMPLETE SUCCESS - Ready for Phase 4B")
                return_code = 0
            elif criteria_met >= 3:
                print("⚠️  PHASE 4A: PARTIAL SUCCESS - Review failures before Phase 4B")
                return_code = 0
            else:
                print("❌ PHASE 4A: NEEDS INVESTIGATION - Address issues before proceeding")
                return_code = 1
        else:
            print("❌ No cards processed successfully")
            return_code = 1

        print(f"\n💾 Results: {results_path}")
        print(f"📊 Metrics: {metrics_path}")

        return return_code

    except Exception as e:
        print(f"❌ Phase 4A failed with error: {e}")
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume-checkpoint", type=int, help="Resume from checkpoint number")
    parser.add_argument("--diagnostic-mode", action="store_true",
                        help="Enable detailed diagnostic timing and save raw timing breakdown to /results")
    parser.add_argument("--skip-daemon", action="store_true",
                        help="Skip daemon health checks (diagnostic mode only - may impact performance)")
    parser.add_argument("--cards-limit", type=int, default=None,
                        help="Limit processing to first N cards (useful for diagnostic runs)")
    exit_code = main(parser.parse_args())
    sys.exit(exit_code)