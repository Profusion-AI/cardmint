#!/usr/bin/env python3
"""
OpenAI Cost Tracking System (RFC-005 Budget Control)

Processes OpenAI ledger.jsonl files and maintains daily cost tracking spreadsheet
with automatic warnings at $15 threshold and enforcement of $20 monthly ceiling.

Usage:
    python scripts/update_cost_tracker.py --ledger results/openai-full-corpus/ledger.jsonl --description "Full corpus baseline"
    python scripts/update_cost_tracker.py --ledger results/openai-test/ledger.jsonl --check-budget
    python scripts/update_cost_tracker.py --summary  # Monthly summary only

Author: Claude Code (Lead Developer)
Date: October 8, 2025
RFC: RFC-005 Phase 5 Budget Control
"""

import argparse
import csv
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Optional
import sys


@dataclass
class DailySpend:
    """Daily spend record"""
    date: str
    run_name: str
    cards_processed: int
    total_cost_cents: float
    total_cost_dollars: float
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    avg_cost_per_card: float
    ledger_path: str


@dataclass
class MonthlyStatus:
    """Monthly budget status"""
    month: str
    current_date: str
    mtd_total_cents: float
    mtd_total_dollars: float
    days_elapsed: int
    avg_daily_spend: float
    projected_month_end: float
    budget_remaining: float
    status: str  # GREEN, YELLOW, RED


# Budget thresholds (from RFC-005)
WARNING_THRESHOLD_DOLLARS = 15.0
HARD_CEILING_DOLLARS = 20.0
WARNING_THRESHOLD_CENTS = WARNING_THRESHOLD_DOLLARS * 100
HARD_CEILING_CENTS = HARD_CEILING_DOLLARS * 100

# File paths
COST_TRACKER_CSV = Path("finance/openai_cost_tracker.csv")
MONTHLY_SUMMARY_CSV = Path("finance/openai_monthly_summary.csv")
DAILY_REVIEWS_LOG = Path("finance/daily_reviews.log")


def parse_ledger(ledger_path: Path) -> Dict[str, any]:
    """
    Parse OpenAI ledger.jsonl and extract cost metrics.

    Returns:
        dict: {
            'total_cost_cents': float,
            'total_cards': int,
            'input_tokens': int,
            'output_tokens': int,
            'reasoning_tokens': int,
            'first_timestamp': str,
            'last_timestamp': str
        }
    """
    if not ledger_path.exists():
        raise FileNotFoundError(f"Ledger not found: {ledger_path}")

    total_cost = 0.0
    total_cards = 0
    total_input = 0
    total_output = 0
    total_reasoning = 0
    first_timestamp = None
    last_timestamp = None

    with open(ledger_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
                total_cost += record.get("cost_cents", 0)
                total_cards += 1

                token_usage = record.get("token_usage", {})
                total_input += token_usage.get("input_tokens", 0)
                total_output += token_usage.get("output_tokens", 0)
                total_reasoning += token_usage.get("reasoning_tokens", 0)

                timestamp = record.get("timestamp")
                if timestamp:
                    if first_timestamp is None:
                        first_timestamp = timestamp
                    last_timestamp = timestamp

            except json.JSONDecodeError as e:
                print(f"⚠️  Skipping malformed line: {e}")
                continue

    return {
        "total_cost_cents": total_cost,
        "total_cards": total_cards,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "reasoning_tokens": total_reasoning,
        "first_timestamp": first_timestamp,
        "last_timestamp": last_timestamp
    }


def load_existing_tracker() -> List[DailySpend]:
    """Load existing cost tracker records"""
    records = []

    if not COST_TRACKER_CSV.exists():
        return records

    with open(COST_TRACKER_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            records.append(DailySpend(
                date=row["date"],
                run_name=row["run_name"],
                cards_processed=int(row["cards_processed"]),
                total_cost_cents=float(row["total_cost_cents"]),
                total_cost_dollars=float(row["total_cost_dollars"]),
                input_tokens=int(row["input_tokens"]),
                output_tokens=int(row["output_tokens"]),
                reasoning_tokens=int(row["reasoning_tokens"]),
                avg_cost_per_card=float(row["avg_cost_per_card"]),
                ledger_path=row["ledger_path"]
            ))

    return records


def append_to_tracker(spend: DailySpend):
    """Append new spend record to tracker CSV"""
    # Create directory if needed
    COST_TRACKER_CSV.parent.mkdir(parents=True, exist_ok=True)

    # Check if file exists to write header
    write_header = not COST_TRACKER_CSV.exists()

    with open(COST_TRACKER_CSV, "a", newline="") as f:
        fieldnames = [
            "date", "run_name", "cards_processed", "total_cost_cents",
            "total_cost_dollars", "input_tokens", "output_tokens",
            "reasoning_tokens", "avg_cost_per_card", "ledger_path"
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)

        if write_header:
            writer.writeheader()

        writer.writerow({
            "date": spend.date,
            "run_name": spend.run_name,
            "cards_processed": spend.cards_processed,
            "total_cost_cents": f"{spend.total_cost_cents:.6f}",
            "total_cost_dollars": f"{spend.total_cost_dollars:.6f}",
            "input_tokens": spend.input_tokens,
            "output_tokens": spend.output_tokens,
            "reasoning_tokens": spend.reasoning_tokens,
            "avg_cost_per_card": f"{spend.avg_cost_per_card:.10f}",
            "ledger_path": spend.ledger_path
        })


def calculate_monthly_status(records: List[DailySpend], current_date: datetime) -> MonthlyStatus:
    """Calculate month-to-date status and budget warnings"""
    current_month = current_date.strftime("%Y-%m")

    # Filter records for current month
    month_records = [
        r for r in records
        if r.date.startswith(current_month)
    ]

    mtd_total_cents = sum(r.total_cost_cents for r in month_records)
    mtd_total_dollars = mtd_total_cents / 100

    # Calculate days elapsed (from first spend to current date)
    if month_records:
        first_spend_date = datetime.strptime(month_records[0].date, "%Y-%m-%d")
        days_elapsed = (current_date - first_spend_date).days + 1
    else:
        days_elapsed = current_date.day

    # Calculate projections
    avg_daily_spend = mtd_total_dollars / days_elapsed if days_elapsed > 0 else 0
    days_in_month = 30  # Conservative estimate
    projected_month_end = avg_daily_spend * days_in_month

    budget_remaining = HARD_CEILING_DOLLARS - mtd_total_dollars

    # Determine status
    if mtd_total_dollars >= HARD_CEILING_DOLLARS:
        status = "RED - CEILING EXCEEDED"
    elif mtd_total_dollars >= WARNING_THRESHOLD_DOLLARS:
        status = "YELLOW - WARNING THRESHOLD"
    else:
        status = "GREEN - NORMAL"

    return MonthlyStatus(
        month=current_month,
        current_date=current_date.strftime("%Y-%m-%d"),
        mtd_total_cents=mtd_total_cents,
        mtd_total_dollars=mtd_total_dollars,
        days_elapsed=days_elapsed,
        avg_daily_spend=avg_daily_spend,
        projected_month_end=projected_month_end,
        budget_remaining=budget_remaining,
        status=status
    )


def update_monthly_summary(status: MonthlyStatus):
    """Update monthly summary CSV with current status"""
    MONTHLY_SUMMARY_CSV.parent.mkdir(parents=True, exist_ok=True)

    with open(MONTHLY_SUMMARY_CSV, "w", newline="") as f:
        fieldnames = [
            "month", "current_date", "mtd_total_cents", "mtd_total_dollars",
            "days_elapsed", "avg_daily_spend", "projected_month_end",
            "budget_remaining", "warning_threshold", "hard_ceiling", "status"
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        writer.writerow({
            "month": status.month,
            "current_date": status.current_date,
            "mtd_total_cents": f"{status.mtd_total_cents:.6f}",
            "mtd_total_dollars": f"{status.mtd_total_dollars:.6f}",
            "days_elapsed": status.days_elapsed,
            "avg_daily_spend": f"{status.avg_daily_spend:.6f}",
            "projected_month_end": f"{status.projected_month_end:.2f}",
            "budget_remaining": f"{status.budget_remaining:.2f}",
            "warning_threshold": f"{WARNING_THRESHOLD_DOLLARS:.2f}",
            "hard_ceiling": f"{HARD_CEILING_DOLLARS:.2f}",
            "status": status.status
        })


def print_summary(status: MonthlyStatus):
    """Print budget status summary to console"""
    print("\n" + "="*80)
    print("💰 OpenAI Cost Tracker - Monthly Summary")
    print("="*80)
    print(f"Month: {status.month}")
    print(f"As of: {status.current_date}")
    print(f"\n📊 Spend Summary:")
    print(f"  MTD Total: ${status.mtd_total_dollars:.4f} ({status.mtd_total_cents:.4f}¢)")
    print(f"  Days Elapsed: {status.days_elapsed}")
    print(f"  Avg Daily: ${status.avg_daily_spend:.4f}")
    print(f"  Projected Month-End: ${status.projected_month_end:.2f}")
    print(f"\n🎯 Budget Status:")
    print(f"  Remaining: ${status.budget_remaining:.2f}")
    print(f"  Warning Threshold: ${WARNING_THRESHOLD_DOLLARS:.2f}")
    print(f"  Hard Ceiling: ${HARD_CEILING_DOLLARS:.2f}")

    # Visual status indicator
    if "RED" in status.status:
        print(f"\n❌ {status.status}")
        print("   ⚠️  CRITICAL: Budget ceiling exceeded!")
        print("   ⛔ All non-essential API calls must be halted.")
        print("   📞 Contact CEO (Kyle) for budget approval.")
    elif "YELLOW" in status.status:
        print(f"\n⚠️  {status.status}")
        print("   💡 Approaching budget ceiling")
        print(f"   📈 Only ${HARD_CEILING_DOLLARS - status.mtd_total_dollars:.2f} remaining")
        print("   ⚡ Monitor all API usage carefully")
    else:
        print(f"\n✅ {status.status}")
        print(f"   💚 {(status.budget_remaining / HARD_CEILING_DOLLARS * 100):.1f}% budget remaining")

    print("="*80 + "\n")


def check_budget_before_run(cards_to_process: int, avg_cost_per_card: float = 0.0000038968) -> bool:
    """
    Check if proposed run would exceed budget ceiling.

    Args:
        cards_to_process: Number of cards in planned run
        avg_cost_per_card: Expected cost per card (default: $0.0000038968 from RFC-004)

    Returns:
        bool: True if run is safe, False if would exceed ceiling
    """
    records = load_existing_tracker()
    current_date = datetime.now()
    status = calculate_monthly_status(records, current_date)

    estimated_cost = cards_to_process * avg_cost_per_card
    projected_total = status.mtd_total_dollars + estimated_cost

    print("\n" + "="*80)
    print("🔍 Pre-Run Budget Check")
    print("="*80)
    print(f"Planned cards: {cards_to_process:,}")
    print(f"Estimated cost: ${estimated_cost:.6f}")
    print(f"Current MTD: ${status.mtd_total_dollars:.4f}")
    print(f"Projected after run: ${projected_total:.4f}")
    print(f"Budget ceiling: ${HARD_CEILING_DOLLARS:.2f}")
    print(f"Remaining headroom: ${status.budget_remaining - estimated_cost:.4f}")

    if projected_total > HARD_CEILING_DOLLARS:
        print("\n❌ RUN BLOCKED - Would exceed $20 ceiling")
        print("="*80 + "\n")
        return False
    elif projected_total > WARNING_THRESHOLD_DOLLARS:
        print("\n⚠️  RUN APPROVED - Will trigger warning threshold")
        print("="*80 + "\n")
        return True
    else:
        print("\n✅ RUN APPROVED - Within budget")
        print("="*80 + "\n")
        return True


def is_business_day(date: datetime) -> bool:
    """Check if date is a weekday (Mon-Fri)"""
    return date.weekday() < 5  # 0=Monday, 4=Friday


def load_signoff_log() -> List[Dict[str, str]]:
    """Load existing CFO sign-off records"""
    signoffs = []

    if not DAILY_REVIEWS_LOG.exists():
        return signoffs

    with open(DAILY_REVIEWS_LOG) as f:
        reader = csv.DictReader(f)
        for row in reader:
            signoffs.append(row)

    return signoffs


def record_signoff(status: MonthlyStatus, reviewer: str = "Codex (CFO)"):
    """
    Record CFO sign-off in audit log.

    Args:
        status: Current monthly budget status
        reviewer: Name of person signing off (default: Codex CFO)
    """
    DAILY_REVIEWS_LOG.parent.mkdir(parents=True, exist_ok=True)

    write_header = not DAILY_REVIEWS_LOG.exists()

    with open(DAILY_REVIEWS_LOG, "a", newline="") as f:
        fieldnames = [
            "signoff_date", "signoff_time", "reviewer", "month",
            "mtd_total_dollars", "status", "days_elapsed",
            "projected_month_end", "budget_remaining"
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames)

        if write_header:
            writer.writeheader()

        now = datetime.now()
        writer.writerow({
            "signoff_date": now.strftime("%Y-%m-%d"),
            "signoff_time": now.strftime("%H:%M:%S"),
            "reviewer": reviewer,
            "month": status.month,
            "mtd_total_dollars": f"{status.mtd_total_dollars:.6f}",
            "status": status.status,
            "days_elapsed": status.days_elapsed,
            "projected_month_end": f"{status.projected_month_end:.2f}",
            "budget_remaining": f"{status.budget_remaining:.2f}"
        })


def check_missed_business_days() -> Optional[str]:
    """
    Check if any business days were missed since last sign-off.

    Returns:
        Warning message if days were missed, None otherwise
    """
    signoffs = load_signoff_log()

    if not signoffs:
        return None  # First sign-off, no history to check

    # Get last sign-off date
    last_signoff = signoffs[-1]
    last_date = datetime.strptime(last_signoff["signoff_date"], "%Y-%m-%d")
    today = datetime.now()

    # Count business days between last sign-off and today
    missed_days = []
    check_date = last_date + timedelta(days=1)

    while check_date < today:
        if is_business_day(check_date):
            missed_days.append(check_date.strftime("%Y-%m-%d"))
        check_date += timedelta(days=1)

    if missed_days:
        return f"⚠️  ALERT: {len(missed_days)} business day(s) missed since last sign-off: {', '.join(missed_days)}"

    return None


def main():
    parser = argparse.ArgumentParser(
        description="OpenAI Cost Tracking System (RFC-005 Budget Control)"
    )
    parser.add_argument(
        "--ledger",
        type=Path,
        help="Path to ledger.jsonl file to process"
    )
    parser.add_argument(
        "--description",
        type=str,
        help="Description of the run (e.g., 'Full corpus baseline')"
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Show monthly summary only (no ledger processing)"
    )
    parser.add_argument(
        "--signoff",
        action="store_true",
        help="CFO sign-off mode: Record daily review in audit log (use with --summary)"
    )
    parser.add_argument(
        "--check-budget",
        type=int,
        metavar="CARDS",
        help="Check if planned run of N cards would exceed budget"
    )

    args = parser.parse_args()

    # Load existing records
    existing_records = load_existing_tracker()
    current_date = datetime.now()

    # Mode 1: Pre-run budget check
    if args.check_budget:
        safe = check_budget_before_run(args.check_budget)
        sys.exit(0 if safe else 1)

    # Mode 2: Process new ledger
    if args.ledger:
        print(f"\n📖 Processing ledger: {args.ledger}")

        try:
            metrics = parse_ledger(args.ledger)

            # Extract date from ledger timestamp (or use current date)
            if metrics["first_timestamp"]:
                run_date = datetime.fromisoformat(metrics["first_timestamp"]).strftime("%Y-%m-%d")
            else:
                run_date = current_date.strftime("%Y-%m-%d")

            # Create spend record
            spend = DailySpend(
                date=run_date,
                run_name=args.description or args.ledger.stem,
                cards_processed=metrics["total_cards"],
                total_cost_cents=metrics["total_cost_cents"],
                total_cost_dollars=metrics["total_cost_cents"] / 100,
                input_tokens=metrics["input_tokens"],
                output_tokens=metrics["output_tokens"],
                reasoning_tokens=metrics["reasoning_tokens"],
                avg_cost_per_card=metrics["total_cost_cents"] / metrics["total_cards"] if metrics["total_cards"] > 0 else 0,
                ledger_path=str(args.ledger)
            )

            # Append to tracker
            append_to_tracker(spend)
            print(f"✅ Added record: {spend.run_name} ({spend.cards_processed:,} cards, ${spend.total_cost_dollars:.6f})")

            # Update existing records list
            existing_records.append(spend)

        except Exception as e:
            print(f"❌ Error processing ledger: {e}")
            sys.exit(1)

    # Mode 3: Calculate and display monthly summary
    if args.summary or args.ledger or not any([args.check_budget]):
        status = calculate_monthly_status(existing_records, current_date)
        update_monthly_summary(status)

        # Mode 3a: CFO sign-off (daily review)
        if args.signoff:
            # Check for missed business days
            missed_warning = check_missed_business_days()
            if missed_warning:
                print("\n" + "="*80)
                print(missed_warning)
                print("="*80 + "\n")

            # Record sign-off
            record_signoff(status)
            print("="*80)
            print("✅ CFO SIGN-OFF RECORDED")
            print("="*80)
            print(f"Date: {current_date.strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Reviewer: Codex (CFO)")
            print(f"Month: {status.month}")
            print(f"MTD Total: ${status.mtd_total_dollars:.6f}")
            print(f"Status: {status.status}")
            print(f"Audit log: {DAILY_REVIEWS_LOG}")
            print("="*80 + "\n")

        print_summary(status)

        # Exit with error code if ceiling exceeded
        if "RED" in status.status:
            sys.exit(2)


if __name__ == "__main__":
    main()
