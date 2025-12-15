#!/usr/bin/env python3
"""LM Studio model initializer used by the Intel Arc startup script.

The KeepWarm daemon now assumes that LM Studio has already completed cold-start
initialization. This helper performs the heavy warmup sequence immediately after
launching LM Studio so the daemon can focus on handshake validation and ongoing
maintenance.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import List, Optional

from openai import OpenAI


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Initialize LM Studio model state before KeepWarm handoff"
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:12345/v1",
        help="LM Studio OpenAI-compatible base URL",
    )
    parser.add_argument(
        "--model",
        default="mistralai/magistral-small-2509",
        help="Model identifier to initialize",
    )
    parser.add_argument(
        "--api-key",
        default="lm-studio",
        help="API key used for LM Studio requests",
    )
    parser.add_argument(
        "--context-length",
        type=int,
        default=777,
        help="Context length to use for warmup requests",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=32,
        help="Max tokens to request during warmup completions",
    )
    parser.add_argument(
        "--warmup-count",
        type=int,
        default=2,
        help="Number of successful warmup completions required",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=6,
        help="Maximum warmup attempts before giving up",
    )
    parser.add_argument(
        "--request-timeout",
        type=int,
        default=360,
        help="Timeout (seconds) for each warmup completion request",
    )
    parser.add_argument(
        "--retry-delay",
        type=int,
        default=10,
        help="Initial retry delay (seconds) when warmup fails",
    )
    parser.add_argument(
        "--max-retry-delay",
        type=int,
        default=60,
        help="Maximum backoff delay between attempts",
    )
    parser.add_argument(
        "--handshake-timeout",
        type=int,
        default=420,
        help="Maximum time to wait for LM Studio HTTP endpoint to become ready",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=5,
        help="Interval between handshake polls (seconds)",
    )
    parser.add_argument(
        "--handshake-file",
        type=Path,
        help="Optional path to write handshake metadata JSON",
    )
    return parser.parse_args()


def wait_for_endpoint(client: OpenAI, timeout: int, poll_interval: int) -> bool:
    deadline = time.time() + timeout
    attempt = 0
    last_error: Optional[Exception] = None

    while time.time() < deadline:
        attempt += 1
        try:
            client.models.list()
            print(f"[OK] LM Studio endpoint ready after {attempt} handshake attempt(s)")
            return True
        except Exception as exc:  # pragma: no cover - broad surface from httpx
            last_error = exc
            remaining = max(0, int(deadline - time.time()))
            print(
                f"Waiting for LM Studio endpoint (attempt {attempt}, time left ~{remaining}s)...",
                flush=True,
            )
            time.sleep(poll_interval)

    print(f"ERROR LM Studio endpoint did not respond within {timeout}s: {last_error}")
    return False


def perform_warmups(
    client: OpenAI,
    model: str,
    context_length: int,
    max_tokens: int,
    warmup_count: int,
    max_attempts: int,
    request_timeout: int,
    retry_delay: int,
    max_retry_delay: int,
) -> List[float]:
    prompt = "Initialize Pokemon card identification pipeline"
    attempts = 0
    successes = 0
    durations: List[float] = []
    delay = retry_delay
    last_error: Optional[Exception] = None

    while attempts < max_attempts and successes < warmup_count:
        attempts += 1
        try:
            start = time.perf_counter()
            client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "Prepare Pokemon card identification assistant.",
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0,
                max_tokens=max_tokens,
                timeout=request_timeout,
                extra_body={"context_length": context_length},
            )
            duration_ms = (time.perf_counter() - start) * 1000
            durations.append(duration_ms)
            successes += 1
            print(
                f"[OK] Warmup {successes}/{warmup_count} completed in {duration_ms:.1f}ms",
                flush=True,
            )
            delay = retry_delay  # Reset delay after success
        except Exception as exc:  # pragma: no cover
            last_error = exc
            remaining = warmup_count - successes
            print(
                f"WARN Warmup attempt {attempts} failed ({remaining} remaining). Retrying in {delay}s...",
                flush=True,
            )
            time.sleep(delay)
            delay = min(delay * 2, max_retry_delay)

    if successes < warmup_count:
        raise RuntimeError(f"Warmup failed after {attempts} attempts: {last_error}")

    return durations


def write_handshake_file(path: Path, durations: List[float]) -> None:
    metadata = {
        "timestamp": time.time(),
        "warmup_durations_ms": durations,
        "warmup_count": len(durations),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, indent=2))
    print(f"Wrote handshake metadata to {path}")


def main() -> int:
    args = parse_args()

    client = OpenAI(base_url=args.base_url, api_key=args.api_key)

    if not wait_for_endpoint(client, args.handshake_timeout, args.poll_interval):
        return 1

    max_attempts = max(args.max_attempts, args.warmup_count)

    try:
        durations = perform_warmups(
            client=client,
            model=args.model,
            context_length=args.context_length,
            max_tokens=args.max_tokens,
            warmup_count=args.warmup_count,
            max_attempts=max_attempts,
            request_timeout=args.request_timeout,
            retry_delay=args.retry_delay,
            max_retry_delay=args.max_retry_delay,
        )
    except Exception as exc:  # pragma: no cover
        print(f"ERROR Model initialization failed: {exc}")
        return 1

    avg = sum(durations) / len(durations)
    print(
        f"DONE Model initialization complete. {len(durations)} warmups, avg {avg:.1f}ms, "
        f"min {min(durations):.1f}ms, max {max(durations):.1f}ms",
    )

    if args.handshake_file:
        write_handshake_file(args.handshake_file, durations)

    return 0


if __name__ == "__main__":
    sys.exit(main())
