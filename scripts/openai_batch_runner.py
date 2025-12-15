#!/usr/bin/env python3
"""OpenAI Batch Runner - Production Grade

Full-corpus inference runner with:
- Resume/checkpoint support
- Budget guardrails with abort logic
- Concurrent workers with rate limiting
- Error rate monitoring
- JSONL + CSV export
- Watchdog timer

Usage:
    export OPENAI_API_KEY=sk-proj-...
    python scripts/openai_batch_runner.py --input pokemoncards --concurrency 4 --budget-cents 100
    python scripts/openai_batch_runner.py --resume  # Continue from last checkpoint
"""
from __future__ import annotations

import argparse
import base64
import csv
import glob
import json
import os
import shutil
import signal
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional

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


class CheckpointManager:
    """Manages checkpoint file for resume support."""

    def __init__(self, checkpoint_path: Path):
        self.checkpoint_path = checkpoint_path
        self.processed_paths: set[str] = set()
        self.load()

    def load(self):
        """Load processed paths from checkpoint file."""
        if self.checkpoint_path.exists():
            with open(self.checkpoint_path, "r") as f:
                self.processed_paths = set(line.strip() for line in f if line.strip())
            print(f"📂 Loaded checkpoint: {len(self.processed_paths)} cards already processed")

    def mark_processed(self, image_path: str):
        """Mark an image as processed and append to checkpoint file."""
        self.processed_paths.add(image_path)
        with open(self.checkpoint_path, "a") as f:
            f.write(f"{image_path}\n")

    def is_processed(self, image_path: str) -> bool:
        """Check if an image has already been processed."""
        return image_path in self.processed_paths

    def reset(self):
        """Clear checkpoint file and memory."""
        if self.checkpoint_path.exists():
            self.checkpoint_path.unlink()
        self.processed_paths.clear()


class BudgetMonitor:
    """Monitors API spend and enforces budget limits."""

    def __init__(self, budget_cents: float, alert_threshold_cents: float):
        self.budget_cents = budget_cents
        self.alert_threshold_cents = alert_threshold_cents
        self.total_spend_cents = 0.0
        self.alerted = False

    def add_spend(self, cost_cents: float):
        """Add cost to running total and check thresholds."""
        self.total_spend_cents += cost_cents

        if self.total_spend_cents >= self.budget_cents:
            raise BudgetExceededError(
                f"Budget exceeded: ${self.total_spend_cents/100:.4f} >= ${self.budget_cents/100:.4f}"
            )

        if not self.alerted and self.total_spend_cents >= self.alert_threshold_cents:
            print(f"\n⚠️  ALERT: Spend approaching budget (${self.total_spend_cents/100:.4f} / ${self.budget_cents/100:.4f})")
            self.alerted = True

    def get_remaining_cents(self) -> float:
        """Get remaining budget."""
        return self.budget_cents - self.total_spend_cents


class BudgetExceededError(Exception):
    """Raised when budget limit is exceeded."""
    pass


class ErrorRateMonitor:
    """Monitors error rate over rolling window."""

    def __init__(self, window_size: int = 100, max_error_rate: float = 0.01):
        self.window_size = window_size
        self.max_error_rate = max_error_rate
        self.results: deque[bool] = deque(maxlen=window_size)

    def record_success(self):
        """Record a successful request."""
        self.results.append(True)
        self._check_error_rate()

    def record_failure(self):
        """Record a failed request."""
        self.results.append(False)
        self._check_error_rate()

    def _check_error_rate(self):
        """Check if error rate exceeds threshold."""
        if len(self.results) < self.window_size:
            return  # Need full window before checking

        error_count = sum(1 for success in self.results if not success)
        error_rate = error_count / len(self.results)

        if error_rate > self.max_error_rate:
            raise ErrorRateExceededError(
                f"Error rate exceeded: {error_rate:.1%} > {self.max_error_rate:.1%} "
                f"({error_count}/{len(self.results)} failures in rolling window)"
            )

    def get_error_rate(self) -> float:
        """Get current error rate."""
        if not self.results:
            return 0.0
        error_count = sum(1 for success in self.results if not success)
        return error_count / len(self.results)


class ErrorRateExceededError(Exception):
    """Raised when error rate exceeds threshold."""
    pass


class WatchdogTimer:
    """Monitors runtime and enforces maximum duration."""

    def __init__(self, max_duration_hours: float = 16.0):
        self.max_duration_seconds = max_duration_hours * 3600
        self.start_time = time.time()

    def check(self):
        """Check if maximum runtime exceeded."""
        elapsed = time.time() - self.start_time
        if elapsed >= self.max_duration_seconds:
            raise WatchdogTimeoutError(
                f"Watchdog timeout: {elapsed/3600:.1f}h >= {self.max_duration_seconds/3600:.1f}h"
            )

    def get_elapsed_hours(self) -> float:
        """Get elapsed runtime in hours."""
        return (time.time() - self.start_time) / 3600


class WatchdogTimeoutError(Exception):
    """Raised when watchdog timer expires."""
    pass


def encode_image_to_base64(image_path: Path) -> str:
    """Convert image to base64-encoded PNG data URL."""
    img = Image.open(image_path)
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
        "max_completion_tokens": 1000,
        "response_format": RESPONSE_SCHEMA,
        "store": store,
        "reasoning_effort": reasoning_effort,
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

    # Retry logic with exponential backoff for rate limits
    max_retries = 5
    for attempt in range(max_retries):
        try:
            start_time = time.perf_counter()
            response = requests.post(OPENAI_API_URL, json=payload, headers=headers, timeout=60)
            infer_ms = (time.perf_counter() - start_time) * 1000

            # Handle rate limiting
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", 2 ** attempt))
                print(f"⏳ Rate limited (429), retrying after {retry_after}s...")
                time.sleep(retry_after)
                continue

            # Handle server errors with backoff
            if response.status_code >= 500:
                backoff = 2 ** attempt
                print(f"⏳ Server error ({response.status_code}), retrying after {backoff}s...")
                time.sleep(backoff)
                continue

            if not response.ok:
                raise RuntimeError(f"OpenAI API Error ({response.status_code}): {response.text}")

            break  # Success

        except requests.exceptions.Timeout:
            if attempt == max_retries - 1:
                raise
            backoff = 2 ** attempt
            print(f"⏳ Timeout, retrying after {backoff}s...")
            time.sleep(backoff)

    else:
        raise RuntimeError(f"Failed after {max_retries} retries")

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

    # Capture rate limit headers for telemetry
    rate_limit_headers = {
        "remaining_requests": response.headers.get("x-ratelimit-remaining-requests"),
        "remaining_tokens": response.headers.get("x-ratelimit-remaining-tokens"),
        "reset_requests": response.headers.get("x-ratelimit-reset-requests"),
        "reset_tokens": response.headers.get("x-ratelimit-reset-tokens"),
    }

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
        "rate_limits": rate_limit_headers,
    }


def process_single_card(
    image_path: str,
    api_key: str,
    checkpoint: CheckpointManager,
    budget: BudgetMonitor,
    error_monitor: ErrorRateMonitor,
    watchdog: WatchdogTimer,
    model: str,
    detail: str,
    reasoning_effort: str,
) -> Optional[Dict[str, Any]]:
    """Process a single card with all monitoring."""
    # Check watchdog
    watchdog.check()

    # Skip if already processed
    if checkpoint.is_processed(image_path):
        return None

    image_name = Path(image_path).name

    try:
        result = run_openai_inference(
            Path(image_path),
            api_key,
            model=model,
            detail=detail,
            store=True,
            reasoning_effort=reasoning_effort,
        )

        # Update monitoring
        budget.add_spend(result["cost_cents"])
        error_monitor.record_success()

        # Mark as processed
        checkpoint.mark_processed(image_path)

        # Add metadata
        result["image_path"] = image_path
        result["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        return result

    except Exception as e:
        error_monitor.record_failure()
        print(f"❌ Error processing {image_name}: {e}")
        raise  # Re-raise to be caught by caller


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


def export_to_jsonl(results: List[Dict[str, Any]], output_path: Path):
    """Export batch results to JSONL."""
    with open(output_path, "w") as f:
        for result in results:
            f.write(json.dumps(result) + "\n")


def backup_file(path: Path):
    """Create a timestamped backup if the file already exists."""
    if path.exists():
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = path.with_suffix(path.suffix + f".bak.{timestamp}")
        shutil.copy2(path, backup_path)
        print(f"📦 Backup created: {backup_path}")


def main():
    parser = argparse.ArgumentParser(description="OpenAI batch runner with production features")
    parser.add_argument(
        "--input",
        type=str,
        default="pokemoncards",
        help='Input directory or glob pattern (default: "pokemoncards")',
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("results/openai-full-corpus"),
        help="Output directory (default: results/openai-full-corpus)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Number of concurrent workers (default: 4)",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="Limit number of cards to process (default: all)",
    )
    parser.add_argument(
        "--budget-cents",
        type=float,
        default=100.0,
        help="Budget limit in cents (default: 100)",
    )
    parser.add_argument(
        "--alert-threshold-cents",
        type=float,
        default=80.0,
        help="Alert threshold in cents (default: 80)",
    )
    parser.add_argument(
        "--max-hours",
        type=float,
        default=16.0,
        help="Maximum runtime in hours (default: 16)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from last checkpoint",
    )
    parser.add_argument(
        "--reset-checkpoint",
        action="store_true",
        help="Clear checkpoint and start fresh",
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

    # Setup log streaming
    log_dir = Path("logs")
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "openai-full-corpus.log"

    # Tee stdout to log file
    class TeeLogger:
        def __init__(self, *files):
            self.files = files
        def write(self, data):
            for f in self.files:
                f.write(data)
                f.flush()
        def flush(self):
            for f in self.files:
                f.flush()

    log_handle = open(log_file, "a")
    sys.stdout = TeeLogger(sys.stdout, log_handle)
    sys.stderr = TeeLogger(sys.stderr, log_handle)

    print(f"📝 Logging to: {log_file}")
    print(f"⏰ Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    # Find images
    if os.path.isdir(args.input):
        pattern = f"{args.input}/**/*.png"
        image_paths = sorted(glob.glob(pattern, recursive=True))
    else:
        image_paths = sorted(glob.glob(args.input))

    if not image_paths:
        print(f"❌ No images found matching pattern: {args.input}")
        sys.exit(1)

    # Setup output directory
    args.output.mkdir(parents=True, exist_ok=True)

    # Initialize monitoring
    checkpoint_path = args.output / "checkpoint.txt"
    checkpoint = CheckpointManager(checkpoint_path)

    if args.reset_checkpoint:
        checkpoint.reset()
        print("🔄 Checkpoint reset")

    budget = BudgetMonitor(args.budget_cents, args.alert_threshold_cents)
    error_monitor = ErrorRateMonitor(window_size=100, max_error_rate=0.01)
    watchdog = WatchdogTimer(max_duration_hours=args.max_hours)

    # Apply count limit if specified
    if args.count is not None:
        image_paths = image_paths[:args.count]

    # Filter out already processed images
    remaining_paths = [p for p in image_paths if not checkpoint.is_processed(p)]

    print("=" * 80)
    print("🚀 OpenAI Batch Runner - Production Mode")
    print("=" * 80)
    print(f"Model:             {OPENAI_MODEL}")
    print(f"Total Images:      {len(image_paths)} cards")
    print(f"Already Processed: {len(checkpoint.processed_paths)} cards")
    print(f"Remaining:         {len(remaining_paths)} cards")
    print(f"Concurrency:       {args.concurrency} workers")
    print(f"Budget:            ${args.budget_cents/100:.2f} (alert at ${args.alert_threshold_cents/100:.2f})")
    print(f"Max Runtime:       {args.max_hours:.1f} hours")
    print(f"Detail Level:      {args.detail}")
    print(f"Reasoning Effort:  {args.reasoning_effort}")
    print(f"Output Dir:        {args.output}")
    print(f"Checkpoint:        {checkpoint_path}")
    print("=" * 80)
    print()

    if not remaining_paths:
        print("✅ All images already processed!")
        sys.exit(0)

    # Load existing results when resuming
    results_map: Dict[str, Dict[str, Any]] = {}
    if args.resume:
        jsonl_output = args.output / "ledger.jsonl"
        if jsonl_output.exists():
            print(f"📂 Loading existing results from {jsonl_output}")
            with open(jsonl_output) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError as e:
                        print(f"⚠️  Skipping malformed JSONL line: {e}")
                        continue
                    image_path = record.get("image_path")
                    if not image_path:
                        print("⚠️  Existing record missing image_path; skipping")
                        continue
                    results_map[image_path] = record
            print(f"   Loaded {len(results_map)} existing results")

    # Seed error monitor with prior successes so the final error rate reflects the full corpus
    preexisting_results = len(results_map)
    for _ in range(min(preexisting_results, error_monitor.window_size)):
        error_monitor.record_success()

    total_cost = sum(r.get("cost_cents", 0) for r in results_map.values())
    total_time = sum(r.get("infer_ms", 0) for r in results_map.values())
    errors = 0
    processed_this_run = 0

    # Graceful shutdown handler
    shutdown_requested = False

    def signal_handler(sig, frame):
        nonlocal shutdown_requested
        print("\n\n⚠️  Shutdown requested (Ctrl+C). Finishing current batch and saving results...")
        shutdown_requested = True

    signal.signal(signal.SIGINT, signal_handler)

    # Process with concurrency
    start_time = time.time()

    try:
        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            # Submit all tasks
            futures = {
                executor.submit(
                    process_single_card,
                    image_path,
                    api_key,
                    checkpoint,
                    budget,
                    error_monitor,
                    watchdog,
                    OPENAI_MODEL,
                    args.detail,
                    args.reasoning_effort,
                ): image_path
                for image_path in remaining_paths
            }

            # Process results as they complete
            for i, future in enumerate(as_completed(futures), 1):
                if shutdown_requested:
                    print("⏸️  Cancelling remaining tasks...")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break

                image_path = futures[future]
                image_name = Path(image_path).name

                try:
                    result = future.result()

                    if result is None:
                        # Already processed (shouldn't happen, but handle gracefully)
                        continue

                    existing_result = results_map.get(image_path)
                    if existing_result:
                        total_cost -= existing_result.get("cost_cents", 0)
                        total_time -= existing_result.get("infer_ms", 0)
                        print(f"♻️  Replacing prior result for {image_name}")

                    results_map[image_path] = result
                    total_cost += result["cost_cents"]
                    total_time += result["infer_ms"]
                    processed_this_run += 1

                    # Progress update
                    elapsed = time.time() - start_time
                    rate = i / elapsed if elapsed > 0 else 0
                    eta_seconds = (len(remaining_paths) - i) / rate if rate > 0 else 0
                    eta_hours = eta_seconds / 3600

                    print(
                        f"[{i}/{len(remaining_paths)}] ✅ {result['extracted']['name']:30s} | "
                        f"{result['infer_ms']:6.0f}ms | "
                        f"{result['cost_cents']:.4f}¢ | "
                        f"${total_cost/100:.4f} spent | "
                        f"ETA {eta_hours:.1f}h"
                    )

                    # Periodic checkpoint summary (every 250 cards)
                    if i % 250 == 0:
                        print(f"\n📊 Checkpoint: {i} cards processed, ${total_cost/100:.4f} spent, "
                              f"{error_monitor.get_error_rate():.1%} error rate\n")

                except BudgetExceededError as e:
                    print(f"\n❌ BUDGET EXCEEDED: {e}")
                    print("⏸️  Stopping execution to prevent overspend")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break

                except ErrorRateExceededError as e:
                    print(f"\n❌ ERROR RATE EXCEEDED: {e}")
                    print("⏸️  Stopping execution due to high error rate")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break

                except WatchdogTimeoutError as e:
                    print(f"\n❌ WATCHDOG TIMEOUT: {e}")
                    print("⏸️  Stopping execution due to runtime limit")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break

                except Exception as e:
                    errors += 1
                    print(f"❌ Error on {image_name}: {e}")
                    # Error already recorded by process_single_card

    except KeyboardInterrupt:
        print("\n⚠️  Interrupted by user")

    # Final summary
    elapsed_hours = (time.time() - start_time) / 3600
    results = list(results_map.values())
    processed_count = len(results)

    print()
    print("=" * 80)
    print("📊 Batch Run Complete")
    print("=" * 80)
    unique_inputs = len(image_paths)
    print(f"Processed (unique): {processed_count} cards")
    print(f"Processed this run: {processed_this_run}/{len(remaining_paths)} cards")
    print(f"Input set size:  {unique_inputs} cards")
    print(f"Errors:          {errors}")
    print(f"Total Time:      {elapsed_hours:.2f}h")
    print(f"Avg Time/Card:   {total_time/processed_count:.0f}ms" if processed_count else "N/A")
    print(f"Total Cost:      ${total_cost/100:.4f}")
    print(f"Avg Cost/Card:   {total_cost/processed_count:.4f}¢" if processed_count else "N/A")
    print(f"Error Rate:      {error_monitor.get_error_rate():.1%}")
    print(f"Budget Used:     {(total_cost/budget.budget_cents)*100:.1f}%")
    print("=" * 80)

    if not results:
        print("\n⚠️  No results to export")
        sys.exit(1)

    # Export results
    csv_output = args.output / "metrics.csv"
    jsonl_output = args.output / "ledger.jsonl"
    json_output = args.output / "aggregates.json"

    backup_file(csv_output)
    export_to_csv(results, csv_output)
    print(f"\n📝 Results exported to: {csv_output}")

    backup_file(jsonl_output)
    export_to_jsonl(results, jsonl_output)
    print(f"📝 JSONL ledger saved to: {jsonl_output}")

    # Save aggregates
    latencies = [r["infer_ms"] for r in results]
    costs = [r["cost_cents"] for r in results]

    aggregates = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "model": OPENAI_MODEL,
        "detail_level": args.detail,
        "reasoning_effort": args.reasoning_effort,
        "total_cards": processed_count,
        "total_errors": errors,
        "total_cost_cents": total_cost,
        "total_time_hours": elapsed_hours,
        "avg_latency_ms": sum(latencies) / len(latencies) if latencies else 0,
        "p50_latency_ms": sorted(latencies)[len(latencies) // 2] if latencies else 0,
        "p95_latency_ms": sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0,
        "p99_latency_ms": sorted(latencies)[int(len(latencies) * 0.99)] if latencies else 0,
        "avg_cost_cents": sum(costs) / len(costs) if costs else 0,
        "error_rate": error_monitor.get_error_rate(),
    }

    backup_file(json_output)
    with open(json_output, "w") as f:
        json.dump(aggregates, f, indent=2)
    print(f"📝 Aggregates saved to: {json_output}")

    print("\n✅ Run complete!")


if __name__ == "__main__":
    main()
