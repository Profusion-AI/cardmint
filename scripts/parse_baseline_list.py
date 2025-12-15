#!/usr/bin/env python3
"""
Parse kyles-50-baseline.txt into baseline_expected.csv for Nov 7 MVP baseline gate.

Expected CSV columns:
- sequence_index: 1-based card order
- expected_name: Pokemon/Trainer card name
- expected_hp: HP value (nullable, likely empty for this dataset)
- expected_collector_no: Collector number as TEXT (e.g., "26", "3/163")
- expected_set_name: Set name (will be matched via ground_truth_set_mapping.csv)
- notes: Optional metadata (PriceCharting IDs, TCGPlayer IDs, special editions)
"""

import csv
import re
from pathlib import Path


def parse_baseline_line(line: str, line_num: int) -> dict | None:
    """Parse a single line from kyles-50-baseline.txt.

    Format: <name> <collector_no> <set_name> [optional notes]

    Examples:
        appletun v 26 Fusion Strike
        Professor's Research 62 (Holo) Champion's Path [PriceCharting ID:1368340...]
        Squirtle 63 Base Set (First Edition)
    """
    line = line.strip()
    if not line:
        return None

    # Extract notes in brackets
    notes = ""
    note_matches = re.findall(r'\[([^\]]+)\]', line)
    if note_matches:
        notes = "; ".join(note_matches)
        # Remove notes from line
        line = re.sub(r'\[([^\]]+)\]', '', line).strip()

    # Parse line: <name> <collector_no> <set_name>
    # Strategy: split into tokens, find collector number by pattern matching
    tokens = line.split()
    if len(tokens) < 3:
        return None

    # Find collector number token (matches: "26", "3/163", "62", etc.)
    collector_no_idx = None
    for i, token in enumerate(tokens):
        # Collector number is purely numeric or X/Y format
        if re.match(r'^\d+(/\d+)?$', token):
            collector_no_idx = i
            break

    if collector_no_idx is None:
        # Can't find collector number - log and skip
        print(f"Warning: Could not parse collector_no from: {line}")
        return None

    # Everything before collector_no is the card name
    expected_name = " ".join(tokens[:collector_no_idx])
    expected_collector_no = tokens[collector_no_idx]
    # Everything after collector_no is the set name
    expected_set_name = " ".join(tokens[collector_no_idx + 1:])

    if not expected_name or not expected_set_name:
        print(f"Warning: Invalid parse - name='{expected_name}', set='{expected_set_name}'")
        return None

    return {
        "sequence_index": str(line_num),
        "expected_name": expected_name,
        "expected_hp": "",  # Not available in this dataset
        "expected_collector_no": expected_collector_no,
        "expected_set_name": expected_set_name,
        "notes": notes
    }


def main():
    input_file = Path("kyles-50-baseline.txt")
    output_file = Path("baseline_expected.csv")

    if not input_file.exists():
        print(f"Error: {input_file} not found")
        return 1

    rows = []
    with open(input_file, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            parsed = parse_baseline_line(line, line_num)
            if parsed:
                rows.append(parsed)
            elif line.strip():  # Only warn if non-empty line
                print(f"Line {line_num}: Failed to parse: {line.strip()[:50]}...")

    # Write CSV
    if rows:
        with open(output_file, 'w', newline='', encoding='utf-8') as f:
            fieldnames = ["sequence_index", "expected_name", "expected_hp",
                         "expected_collector_no", "expected_set_name", "notes"]
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        print(f"✓ Created {output_file} with {len(rows)} cards")
        return 0
    else:
        print("Error: No valid cards parsed")
        return 1


if __name__ == "__main__":
    exit(main())
