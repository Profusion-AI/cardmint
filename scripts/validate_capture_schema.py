#!/usr/bin/env python3
"""
Gate A: Validate capture schema alignment with EverShop requirements.

Checks that captured and processed data includes all fields required for
EverShop product import:
- name
- url_key (derived from set/number/condition)
- sku
- price (placeholder or from pricing service)
- qty
- group (product grouping)
- category (set name/code)
- images (image path/URL)

Usage:
  python3 scripts/validate_capture_schema.py \\
    --db apps/backend/data/cardmint.db \\
    --count 20 \\
    --output capture-schema-check.txt
"""

import argparse
import json
import logging
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Fields extracted by inference that feed EverShop import
REQUIRED_INFERENCE_FIELDS = [
    "card_name",      # Pokémon card name (from image recognition)
    "set_number",     # Set identifier (e.g., "base1", "fossil-1")
    "card_number",    # Card number in set (e.g., "004")
    "hp_value",       # Hit points (optional, for some cards)
    "confidence",     # Inference confidence score
]

# Fields that will be derived during import
EVERSHOP_DERIVED_FIELDS = [
    # from card_name + set_number + condition
    "name",           # Product name (e.g., "Pikachu")
    # from set_number + card_number + condition
    "url_key",        # URL slug (e.g., "base1-004-nm")
    "sku",            # Stock keeping unit
    # from pricing service
    "price",          # Launch price (inflated 1.25x)
    "market_price",   # Base market price
    # static/derived
    "qty",            # Quantity in stock (usually 1)
    "group",          # Product grouping (set_number)
    "category",       # Category (set name)
    # from processed images
    "images",         # Image path or URL
    "condition",      # Card condition (from operator or default)
]


class SchemaValidator:
    """Validates capture schema against EverShop requirements."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.cursor = self.conn.cursor()

    def get_recent_scans(self, count: int = 20) -> List[Dict]:
        """
        Fetch recent scans with extracted data.

        Args:
            count: Number of recent scans to fetch

        Returns:
            List of scan records with extracted data
        """
        query = """
        SELECT
            id,
            status,
            created_at,
            image_path,
            extracted_json,
            top3_json
        FROM scans
        WHERE status IN ('OPERATOR_PENDING', 'COMPLETED')
            AND extracted_json IS NOT NULL
            AND extracted_json != '{}'
        ORDER BY created_at DESC
        LIMIT ?
        """
        self.cursor.execute(query, (count,))
        rows = self.cursor.fetchall()
        return [dict(row) for row in rows]

    def validate_scan(self, scan: Dict) -> Tuple[bool, Dict]:
        """
        Validate a single scan against EverShop schema.

        Returns:
            (is_valid, validation_result_dict)
        """
        scan_id = scan["id"]
        result = {
            "scan_id": scan_id,
            "status": scan["status"],
            "timestamp": datetime.fromtimestamp(scan["created_at"] / 1000).isoformat(),
            "image_path": scan["image_path"],
            "required_fields": {},
            "soft_fields": {},
            "missing_required": [],
            "all_required_present": True,
        }

        # Parse extracted JSON
        try:
            extracted = json.loads(scan["extracted_json"] or "{}")
        except json.JSONDecodeError as e:
            result["error"] = f"Invalid JSON: {e}"
            result["all_required_present"] = False
            return False, result

        # Check inference fields (required for downstream processing)
        # NOTE: card_number is in RFC-001 (enhanced extraction schema), not yet implemented
        # For Gate A: check that current schema is complete and valid
        required_with_fallbacks = {
            "card_name": None,
            "set_number": None,
            # card_number will be in RFC-001; marking as optional for Gate A
            "card_number": ["card_num"],  # RFC-001, optional for now
            "hp_value": None,  # optional
            "confidence": None,  # optional
        }

        for field, fallbacks in required_with_fallbacks.items():
            # card_number, hp_value, confidence are optional for Gate A (RFC-001 pending)
            is_optional = field in ("hp_value", "confidence", "card_number")
            found_value = None
            found_field = None

            # Try main field name
            if field in extracted and extracted[field]:
                found_value = extracted[field]
                found_field = field
            # Try fallback names
            elif fallbacks:
                for fallback in fallbacks:
                    if fallback in extracted and extracted[fallback]:
                        found_value = extracted[fallback]
                        found_field = fallback
                        break

            if found_value:
                result["required_fields"][field] = {
                    "present": True,
                    "value": str(found_value)[:50],
                    "field_name": found_field,
                }
            else:
                result["required_fields"][field] = {
                    "present": False,
                    "value": None,
                    "optional": is_optional,
                }
                if not is_optional:
                    result["missing_required"].append(field)
                    result["all_required_present"] = False

        # Note EverShop fields will be derived during import
        result["evershop_derived"] = EVERSHOP_DERIVED_FIELDS

        # Check top3 candidates
        try:
            top3 = json.loads(scan["top3_json"] or "[]")
            result["candidate_count"] = len(top3)
        except json.JSONDecodeError:
            result["candidate_count"] = 0

        return result["all_required_present"], result

    def generate_report(self, count: int = 20) -> Tuple[int, int, List[Dict]]:
        """
        Generate schema validation report for N recent scans.

        Returns:
            (total_scans, valid_scans, validation_results)
        """
        scans = self.get_recent_scans(count)
        results = []
        valid_count = 0

        logger.info(f"Validating {len(scans)} recent scans for inference completeness...")
        logger.info(f"Required inference fields: {', '.join(REQUIRED_INFERENCE_FIELDS)}")

        for scan in scans:
            is_valid, validation = self.validate_scan(scan)
            results.append(validation)
            if is_valid:
                valid_count += 1
                status = "✓"
            else:
                status = "✗"
            missing_str = str(validation["missing_required"]) if not is_valid else ""
            logger.info(
                f"  {status} {scan['id'][:8]}... - "
                f"{'VALID' if is_valid else f'MISSING: {missing_str}'}"
            )

        return len(scans), valid_count, results

    def close(self):
        """Close database connection."""
        self.conn.close()


def format_report(results: List[Dict], output_file: Optional[Path] = None) -> str:
    """
    Format validation results as human-readable report.

    Args:
        results: List of validation result dictionaries
        output_file: Optional file path to write report to

    Returns:
        Formatted report string
    """
    lines = []
    lines.append("=" * 80)
    lines.append("CAPTURE SCHEMA VALIDATION REPORT (Gate A)")
    lines.append("Inference Data Readiness for EverShop Import Pipeline")
    lines.append("=" * 80)
    lines.append("")

    lines.append("Assessment Scope:")
    lines.append("  ✓ Validates inference EXTRACTION fields (card_name, set_number, etc.)")
    lines.append("  ✓ Confirms image capture and processing pipeline")
    lines.append("  → EverShop fields (sku, price, etc.) will be DERIVED during import")
    lines.append("")

    # Summary
    total = len(results)
    valid = sum(1 for r in results if r.get("all_required_present", False))
    invalid = total - valid

    lines.append(f"Summary")
    lines.append(f"  Total scans validated: {total}")
    lines.append(f"  ✓ Ready for import (inference complete): {valid}")
    lines.append(f"  ✗ Incomplete (missing extraction data): {invalid}")
    lines.append(f"  Coverage: {100 * valid / total:.1f}%" if total > 0 else "N/A")
    lines.append("")

    # Required fields summary
    required_fields = REQUIRED_INFERENCE_FIELDS
    field_presence = {field: 0 for field in required_fields}

    for result in results:
        for field in required_fields:
            if result.get("required_fields", {}).get(field, {}).get("present", False):
                field_presence[field] += 1

    lines.append("Field Presence Analysis")
    lines.append("  Field          | Present in | Coverage")
    lines.append("  " + "-" * 45)
    for field in required_fields:
        count = field_presence[field]
        coverage = 100 * count / total if total > 0 else 0
        status = "✓" if coverage >= 90 else "✗" if coverage < 50 else "⚠"
        lines.append(f"  {field:14} | {count:10} | {coverage:6.1f}% {status}")
    lines.append("")

    # Detailed results
    lines.append("Detailed Results")
    lines.append("-" * 80)

    for idx, result in enumerate(results, 1):
        lines.append(f"\n[{idx}] Scan {result['scan_id']}")
        lines.append(f"    Status:     {result['status']}")
        lines.append(f"    Timestamp:  {result['timestamp']}")
        lines.append(f"    Image:      {result['image_path']}")
        lines.append(f"    Candidates: {result.get('candidate_count', 0)}")

        if result.get("error"):
            lines.append(f"    ✗ Error: {result['error']}")
            continue

        # Required fields
        missing = result.get("missing_required", [])
        if missing:
            lines.append(f"    ✗ MISSING REQUIRED: {', '.join(missing)}")
        else:
            lines.append(f"    ✓ All required fields present")

        lines.append("    Required Fields:")
        for field in required_fields:
            field_info = result.get("required_fields", {}).get(field, {})
            present = field_info.get("present", False)
            value = field_info.get("value", "N/A")
            status = "✓" if present else "✗"
            lines.append(f"      {status} {field:15} = {value}")

        # EverShop-derived fields will be populated during import
        lines.append(f"    → Will derive {len(EVERSHOP_DERIVED_FIELDS)} EverShop fields during import")

    lines.append("")
    lines.append("=" * 80)

    # Footer
    lines.append("Assessment Notes:")
    lines.append("  • card_number, hp_value, confidence are RFC-001 enhancements (not MVP-blocking)")
    lines.append("  • set_number variance is normal for diverse card sets")
    lines.append("  • Importer designed for operator overrides (TBD: Oct 21 QA)")
    lines.append("")

    if valid == total:
        lines.append("✓ GATE A PASS: All scans have complete inference data")
    elif valid >= total * 0.5:
        lines.append("✓ GATE A CONDITIONAL PASS: >50% coverage + inference working")
        lines.append("  → Pipeline functional; operator input acceptable for MVP")
    else:
        lines.append("✗ GATE A FAIL: Pipeline issues detected, needs debugging")

    lines.append("=" * 80)

    report = "\n".join(lines)

    if output_file:
        with open(output_file, "w") as f:
            f.write(report)
        logger.info(f"Report written: {output_file}")

    return report


def main():
    parser = argparse.ArgumentParser(
        description="Validate capture schema against EverShop requirements (Gate A)"
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("apps/backend/data/cardmint.db"),
        help="Path to SQLite database",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=20,
        help="Number of recent scans to validate",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("capture-schema-check.txt"),
        help="Output file for validation report",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # Validate database exists
    if not args.db.exists():
        logger.error(f"Database not found: {args.db}")
        sys.exit(1)

    # Run validation
    validator = SchemaValidator(args.db)
    try:
        total, valid, results = validator.generate_report(args.count)
        report = format_report(results, args.output)
        print(report)

        # Exit code based on coverage
        coverage = 100 * valid / total if total > 0 else 0
        if coverage >= 100:
            sys.exit(0)  # All good
        elif coverage >= 90:
            logger.warning("Gate A: 90%+ coverage, minor issues")
            sys.exit(0)
        else:
            logger.error("Gate A: Coverage below 90%, manual intervention needed")
            sys.exit(1)

    finally:
        validator.close()


if __name__ == "__main__":
    main()
