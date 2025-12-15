#!/usr/bin/env python3
"""
CardMint Canonical Inventory Backfill Script (Phase 1.4)
Purpose: Populate cm_sets, cm_cards, and cm_pricecharting_bridge from PriceCharting CSV
Reference: docs/tasks/manifest-inventory-overhaul.md Phase 1.4
Date: 2025-10-24

IMPORTANT: This script populates dev/throwaway data for validation only.
Production inventory will be reset before the Oct 27 1,000-card baseline run.
"""

import argparse
import csv
import hashlib
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Set, Tuple

# Paths
WORKSPACE_ROOT = Path(__file__).parent.parent
PRICECHARTING_CSV = WORKSPACE_ROOT / "data" / "pricecharting-pokemon-cards.csv"
SYNONYM_CSV = WORKSPACE_ROOT / "ground_truth2_set_mapping.csv"
DEFAULT_DB = WORKSPACE_ROOT / "apps" / "backend" / "cardmint_dev.db"


def sanitize_name(value: str) -> str:
    """Normalize names for consistent matching."""
    if not value:
        return ""

    sanitized = value.replace("\xa0", " ")
    sanitized = sanitized.replace("Pokémon", "Pokemon").replace("pokémon", "pokemon")
    sanitized = sanitized.replace("Poké", "Poke").replace("poké", "poke")
    sanitized = sanitized.replace("—", "-").replace("–", "-")
    sanitized = sanitized.replace("’", "'")
    sanitized = re.sub(r"\s+", " ", sanitized)
    return sanitized.strip()


# Prefixes that should be stripped when generating canonical variants (e.g., EX Sandstorm)
CANONICAL_PREFIXES_TO_STRIP = (
    "ex ",
)

NAME_PREFIXES_TO_STRIP = (
    "pokemon japanese ",
    "pokémon japanese ",
    "pokemon tcg ",
    "pokémon tcg ",
    "pokemon ",
    "pokémon ",
    "pokemo ",
)


def add_synonym(mapping: Dict[str, str], raw_key: str, canonical_name: str) -> None:
    """Register a synonym → canonical name mapping."""
    key = sanitize_name(raw_key).lower()
    if key:
        mapping[key] = canonical_name


def generate_canonical_variants(canonical_name: str) -> Set[str]:
    """Generate normalized variants for a canonical set name."""
    base = sanitize_name(canonical_name).lower()
    variants: Set[str] = set()
    if not base:
        return variants

    variants.add(base)

    for prefix in CANONICAL_PREFIXES_TO_STRIP:
        if base.startswith(prefix) and len(base) > len(prefix):
            variants.add(base[len(prefix):].lstrip())

    return variants


# Canonical set name → CardMint cm_set_id mapping
# Based on ground_truth2_set_mapping.csv and existing cm_sets structure
# This maps the CANONICAL set name (from ground_truth2) to the proper CardMint ID
CANONICAL_TO_CM_ID_RAW = {
    # WotC Era
    "Base Set": "BASE",
    "Jungle": "JUNGLE",
    "Fossil": "FOSSIL",
    "Base Set 2": "BASE2",
    "Team Rocket": "TEAMROCKET",
    "Gym Heroes": "GYM1",
    "Gym Challenge": "GYM2",
    "Neo Genesis": "NEO1",
    "Neo Discovery": "NEO2",
    "Neo Revelation": "NEO3",
    "Neo Destiny": "NEO4",
    "Legendary Collection": "LC",
    "Expedition Base Set": "EXPEDITION",
    "Aquapolis": "AQUAPOLIS",
    "Skyridge": "SKYRIDGE",

    # EX Era
    "EX Ruby & Sapphire": "RS",
    "EX Sandstorm": "SS",
    "EX Dragon": "DR",
    "EX Team Magma vs Team Aqua": "MA",
    "EX FireRed & LeafGreen": "FL",
    "EX Team Rocket Returns": "TRR",
    "EX Deoxys": "DX",
    "EX Emerald": "EM",
    "EX Unseen Forces": "UF",
    "EX Delta Species": "DS",
    "EX Legend Maker": "LM",
    "EX Holon Phantoms": "HP",
    "EX Crystal Guardians": "CG",
    "EX Dragon Frontiers": "DF",

    # Diamond & Pearl Era
    "Diamond & Pearl": "DP",
    "Mysterious Treasures": "MT",
    "Secret Wonders": "SW",
    "Great Encounters": "GE",
    "Majestic Dawn": "MD",
    "Legends Awakened": "LA",
    "Stormfront": "SF",
    "Platinum": "PL",
    "Rising Rivals": "RR",
    "Supreme Victors": "SV",
    "Arceus": "AR",

    # HeartGold & SoulSilver Era
    "HeartGold & SoulSilver": "HGSS",
    "Unleashed": "UL",
    "Undaunted": "UD",
    "Triumphant": "TM",
    "Call of Legends": "CL",

    # Black & White Era
    "Black & White": "BW",
    "Emerging Powers": "EPO",
    "Noble Victories": "NVI",
    "Next Destinies": "NXD",
    "Dark Explorers": "DEX",
    "Dragon Vault": "DRV",
    "Boundaries Crossed": "BCR",
    "Plasma Storm": "PLS",
    "Plasma Freeze": "PLF",
    "Plasma Blast": "PLB",
    "Legendary Treasures": "LTR",

    # XY Era
    "XY": "XY",
    "Flashfire": "FLF",
    "Furious Fists": "FFI",
    "Phantom Forces": "PHF",
    "Primal Clash": "PRC",
    "Double Crisis": "DCR",
    "Roaring Skies": "ROS",
    "Ancient Origins": "AOR",
    "BREAKthrough": "BKT",
    "BREAKpoint": "BKP",
    "Generations": "GEN",
    "Fates Collide": "FCO",
    "Steam Siege": "STS",
    "Evolutions": "EVO",

    # Sun & Moon Era
    "Sun & Moon": "SM",
    "Guardians Rising": "GRI",
    "Burning Shadows": "BUS",
    "Shining Legends": "SLG",
    "Crimson Invasion": "CIN",
    "Ultra Prism": "UPR",
    "Forbidden Light": "FLI",
    "Celestial Storm": "CES",
    "Dragon Majesty": "DRM",
    "Lost Thunder": "LOT",
    "Team Up": "TEU",
    "Unbroken Bonds": "UNB",
    "Unified Minds": "UNM",
    "Hidden Fates": "HIF",
    "Cosmic Eclipse": "CEC",

    # Sword & Shield Era
    "Sword & Shield": "SSH",
    "Rebel Clash": "RCL",
    "Darkness Ablaze": "DAA",
    "Champion's Path": "CPA",
    "Vivid Voltage": "VV",
    "Shining Fates": "SHF",
    "Battle Styles": "BS",
    "Chilling Reign": "CRE",
    "Evolving Skies": "ES",
    "Celebrations": "CEL",
    "Fusion Strike": "FST",
    "Brilliant Stars": "BRS",
    "Astral Radiance": "ASR",
    "Pokémon GO": "PGO",
    "Lost Origin": "LOR",
    "Silver Tempest": "SIT",
    "Crown Zenith": "CRZ",

    # Scarlet & Violet Era
    "Scarlet & Violet": "SVI",
    "Paldea Evolved": "PAL",
    "Obsidian Flames": "OBF",
    "151": "MEW",
    "Paradox Rift": "PAR",
    "Paldean Fates": "PAF",
    "Temporal Forces": "TEF",
    "Twilight Masquerade": "TWM",
    "Shrouded Fable": "SFA",
    "Stellar Crown": "SCR",
    "Surging Sparks": "SSP",
    "Prismatic Evolutions": "PRE",
    "Journey Together": "JTG",
    "Destined Rivals": "DRI",

    # Promo Sets (partial - expand as needed)
    "Wizards Black Star Promos": "PROMO_WOTC",
    "Nintendo Black Star Promos": "PROMO_NINTY",
    "HeartGold & SoulSilver Black Star Promos": "PROMO_HGSS",
    "Black & White Black Star Promos": "PROMO_BW",
    "XY Black Star Promos": "PROMO_XY",
    "Sun & Moon Black Star Promos": "PROMO_SM",
    "Sword & Shield Black Star Promos": "PROMO_SWSH",
    "Scarlet & Violet Black Star Promos": "PROMO_SV",
}

CANONICAL_TO_CM_ID = {
    sanitize_name(name).lower(): cm_id for name, cm_id in CANONICAL_TO_CM_ID_RAW.items()
}

# Variant bit patterns extracted from card names
VARIANT_PATTERNS = [
    (r"\b(Full Art|Full-Art)\b", "full-art"),
    (r"\b(Alt Art|Alternate Art)\b", "alt-art"),
    (r"\b(Rainbow|Rainbow Rare)\b", "rainbow"),
    (r"\b(Gold|Gold Rare)\b", "gold"),
    (r"\b(Hyper Rare)\b", "hyper"),
    (r"\b(Ultra Rare)\b", "ultra"),
    (r"\b(Secret Rare)\b", "secret"),
    (r"\b(Reverse Holo|Reverse Holofoil)\b", "reverse-holo"),
    (r"\b(Holofoil|Holo)\b", "holo"),
    (r"\b(V|VMAX|VSTAR|ex|GX|EX)\b", "special-mechanic"),
    (r"\b(Promo)\b", "promo"),
]


def load_synonym_map(csv_path: Path) -> Dict[str, str]:
    """
    Load set synonym mapping from ground_truth2_set_mapping.csv.
    Returns dict mapping all variations (synonyms, alternates, canonical variants) -> canonical_set_name.
    The canonical name is then mapped to cm_set_id via CANONICAL_TO_CM_ID.
    """
    synonym_to_canonical: Dict[str, str] = {}

    if not csv_path.exists():
        print(f"⚠ Synonym CSV not found: {csv_path}")
        print(f"  Continuing with hardcoded map only")
        return synonym_to_canonical

    with open(csv_path, 'r', encoding='utf-8') as f:
        # Skip first line if it's all commas (formatting artifact)
        first_line = f.readline()
        if not first_line.strip(',\n').strip():
            # First line is all commas, real header is on second line
            pass
        else:
            # First line is the header, rewind
            f.seek(0)

        reader = csv.DictReader(f)
        for row in reader:
            canonical_name = sanitize_name(row.get('canonical_set_name', '').strip())
            synonyms = row.get('synonyms', '').strip()
            alternate_name = sanitize_name(row.get('alternate_set_name', '').strip())

            if not canonical_name:
                continue

            # Map canonical name to itself (for direct lookups)
            add_synonym(synonym_to_canonical, canonical_name, canonical_name)

            # Map canonical variants (e.g., remove EX prefix)
            for variant in generate_canonical_variants(canonical_name):
                add_synonym(synonym_to_canonical, variant, canonical_name)

            # Map all comma-separated synonyms to canonical name
            if synonyms:
                for syn in synonyms.split(','):
                    syn = sanitize_name(syn.strip())
                    if syn:
                        add_synonym(synonym_to_canonical, syn, canonical_name)

            # Map alternate name to canonical name
            if alternate_name:
                add_synonym(synonym_to_canonical, alternate_name, canonical_name)

    # Ensure every canonical mapping has at least itself + variants registered
    for canonical_name in CANONICAL_TO_CM_ID_RAW.keys():
        add_synonym(synonym_to_canonical, canonical_name, canonical_name)
        for variant in generate_canonical_variants(canonical_name):
            add_synonym(synonym_to_canonical, variant, canonical_name)

    print(f"✓ Loaded {len(synonym_to_canonical)} set synonyms from {csv_path.name}")
    return synonym_to_canonical


def normalize_set_name(console_name: str) -> str:
    """Normalize console-name to match set code map keys."""
    sanitized = sanitize_name(console_name)
    normalized = re.sub(r'\s+\d{4}$', '', sanitized)
    return normalized.strip()


def extract_set_code(console_name: str, synonym_to_canonical: Dict[str, str]) -> str:
    """
    Map PriceCharting console-name to CardMint cm_set_id.
    Two-phase strategy:
    1. Normalize console-name to canonical set name (via synonym_to_canonical)
    2. Map canonical name to cm_set_id (via CANONICAL_TO_CM_ID)
    3. Fall back to UNKNOWN only if no mapping exists

    This avoids the substring-matching bug that caused mislabeling.
    """
    normalized = normalize_set_name(console_name)
    normalized_lower = normalized.lower()

    # Build search terms by stripping known prefixes
    search_terms = [normalized_lower]
    for prefix in NAME_PREFIXES_TO_STRIP:
        if normalized_lower.startswith(prefix):
            candidate = normalized_lower[len(prefix):].lstrip()
            if candidate:
                search_terms.append(candidate)

    # Phase 1: Normalize to canonical set name
    canonical_name = None
    for term in dict.fromkeys(search_terms):  # preserve order, avoid duplicates
        if term in synonym_to_canonical:
            canonical_name = synonym_to_canonical[term]
            break

    # Phase 2: Map canonical name to cm_set_id
    canonical_key = sanitize_name(canonical_name).lower() if canonical_name else ""
    if canonical_key and canonical_key in CANONICAL_TO_CM_ID:
        return CANONICAL_TO_CM_ID[canonical_key]

    # Fallback: generate stable hash-based code for truly unknown sets
    # Format: UNKNOWN_{first 6 chars of SHA256}
    hash_hex = hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:6].upper()
    return f"UNKNOWN_{hash_hex}"


def extract_collector_number(product_name: str) -> str:
    """
    Extract collector number from product name.
    Examples:
      "Charizard #6" → "6"
      "Pikachu #025/165" → "025/165"
      "Mew ex #151" → "151"
    """
    # Match patterns like "#6", "#025/165", "#151/264"
    match = re.search(r'#(\d+(?:/\d+)?)', product_name)
    if match:
        return match.group(1)

    # Fallback: no collector number found
    return "UNKNOWN"


def normalize_collector_number(collector_no: str) -> str:
    """
    Normalize collector number to 3-digit padded format.
    Examples:
      "6" → "006"
      "46" → "046"
      "46/102" → "046"
      "151" → "151"
      "UNKNOWN" → "UNKNOWN"
    """
    if collector_no == "UNKNOWN":
        return collector_no

    # Extract numerator from fraction
    numerator = collector_no.split('/')[0]

    # Pad to 3 digits
    try:
        return numerator.zfill(3)
    except:
        return collector_no


def extract_variant_bits(product_name: str) -> str:
    """
    Extract variant flags from product name.
    Returns single primary variant bit for cm_card_id generation.
    Priority order: holo > reverse-holo > full-art > alt-art > rainbow > gold > etc.
    Returns "base" for non-variant cards.
    """
    # Check patterns in priority order
    for pattern, variant_bit in VARIANT_PATTERNS:
        if re.search(pattern, product_name, re.IGNORECASE):
            return variant_bit

    # Default to "base" if no variants found
    return "base"


def extract_card_name(product_name: str) -> str:
    """
    Extract card name from product name, removing collector number and variant suffixes.
    Examples:
      "Charizard #6" → "Charizard"
      "Pikachu V #025/165 Full Art" → "Pikachu V"
    """
    # Remove collector number pattern
    name = re.sub(r'\s*#\d+(?:/\d+)?\s*', ' ', product_name)

    # Remove variant keywords (keep V/VMAX/ex/GX/EX as part of name)
    for pattern, _ in VARIANT_PATTERNS:
        if pattern != r"\b(V|VMAX|VSTAR|ex|GX|EX)\b":  # Keep special mechanics
            name = re.sub(pattern, '', name, flags=re.IGNORECASE)

    # Clean up extra whitespace
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def parse_pricecharting_csv(csv_path: Path) -> List[Dict]:
    """Parse PriceCharting CSV and return list of card records."""
    records = []

    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Skip rows with missing critical data
            if not row.get('id') or not row.get('product-name'):
                continue

            records.append({
                'id': row['id'],
                'console_name': row.get('console-name', ''),
                'product_name': row['product-name'],
                'release_date': row.get('release-date', ''),
                'sales_volume': int(row.get('sales-volume', 0) or 0),
                'card_number': extract_collector_number(row['product-name']),
            })

    return records


def group_by_sets(records: List[Dict], synonym_map: Dict[str, str]) -> Dict[str, List[Dict]]:
    """Group PriceCharting records by cm_set_id."""
    sets = defaultdict(list)

    for record in records:
        cm_set_id = extract_set_code(record['console_name'], synonym_map)
        sets[cm_set_id].append(record)

    return dict(sets)


def populate_cm_sets(conn: sqlite3.Connection, sets: Dict[str, List[Dict]], dry_run: bool = False) -> int:
    """Populate cm_sets table from grouped set data."""
    cursor = conn.cursor()
    now = int(datetime.now().timestamp())
    inserted = 0
    skipped = 0

    for cm_set_id, cards in sets.items():
        # Extract set metadata from first card
        first_card = cards[0]
        set_name = normalize_set_name(first_card['console_name'])

        # Extract release year from release_date
        release_date = first_card.get('release_date', '')
        release_year = None
        if release_date:
            match = re.search(r'(\d{4})', release_date)
            if match:
                release_year = int(match.group(1))

        # Determine series from cm_set_id
        if cm_set_id.startswith('SV'):
            series = 'Scarlet & Violet'
        elif cm_set_id.startswith('SWSH'):
            series = 'Sword & Shield'
        elif cm_set_id.startswith('SM'):
            series = 'Sun & Moon'
        elif cm_set_id.startswith('XY'):
            series = 'XY'
        elif cm_set_id.startswith('BW'):
            series = 'Black & White'
        else:
            series = 'Special'

        # Total cards in set (approximate from card numbers)
        total_cards = len(cards)

        if dry_run:
            print(f"  [DRY-RUN] Would insert set: {cm_set_id} ({set_name})")
            inserted += 1
        else:
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO cm_sets (
                        cm_set_id, set_name, release_date, release_year,
                        total_cards, series, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    cm_set_id,
                    set_name,
                    release_date or None,
                    release_year,
                    total_cards,
                    series,
                    f"Backfilled from PriceCharting on {datetime.now().isoformat()}",
                    now,
                    now,
                ))
                if cursor.rowcount > 0:
                    inserted += 1
                else:
                    skipped += 1
                    print(f"  ⊘ Skipped duplicate set: {cm_set_id} ({set_name})")
            except sqlite3.IntegrityError as e:
                skipped += 1
                print(f"  ⚠ Error inserting set {cm_set_id}: {e}")

    if not dry_run:
        conn.commit()

    if dry_run:
        print(f"✓ [DRY-RUN] Would populate {inserted} sets into cm_sets")
    else:
        print(f"✓ Populated {inserted} new sets into cm_sets ({skipped} duplicates skipped)")

    return inserted


def populate_cm_cards_and_bridge(
    conn: sqlite3.Connection,
    sets: Dict[str, List[Dict]],
    dry_run: bool = False
) -> Tuple[int, int]:
    """Populate cm_cards and cm_pricecharting_bridge from card data."""
    cursor = conn.cursor()
    now = int(datetime.now().timestamp())

    cards_inserted = 0
    cards_skipped = 0
    bridge_inserted = 0

    for cm_set_id, cards in sets.items():
        for card in cards:
            # Extract card metadata
            card_name = extract_card_name(card['product_name'])
            collector_no_full = card['card_number']  # Full format: "046/102"
            variant_bits = extract_variant_bits(card['product_name'])
            lang = 'EN'  # PriceCharting data is English by default

            # Normalize collector number for cm_card_id generation ONLY
            # (pad to 3 digits, extract numerator)
            normalized_collector_no = normalize_collector_number(collector_no_full)

            # Generate cm_card_id
            # Format: {cm_set_id}-{normalized_collector_no}-{variant_bits}
            # Example: BASE-046-base
            cm_card_id = f"{cm_set_id}-{normalized_collector_no}-{variant_bits}"

            # Determine card type (heuristic based on name)
            card_type = 'Pokemon'  # Default
            if 'Energy' in card['product_name']:
                card_type = 'Energy'
            elif any(trainer in card['product_name'] for trainer in ['Trainer', 'Supporter', 'Item', 'Stadium']):
                card_type = 'Trainer'

            # Extract HP value (if Pokemon card)
            hp_value = None
            if card_type == 'Pokemon':
                # Pattern: "Charizard 120 HP" or "Pikachu HP90"
                hp_match = re.search(r'(\d+)\s*HP|HP\s*(\d+)', card['product_name'])
                if hp_match:
                    hp_value = int(hp_match.group(1) or hp_match.group(2))

            if dry_run:
                # Just count in dry-run mode
                cards_inserted += 1
                bridge_inserted += 1
            else:
                # Insert into cm_cards
                try:
                    cursor.execute("""
                        INSERT OR IGNORE INTO cm_cards (
                            cm_card_id, cm_set_id, collector_no, card_name,
                            hp_value, card_type, variant_bits, lang,
                            notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        cm_card_id,
                        cm_set_id,
                        collector_no_full,  # Store full collector number as printed
                        card_name,
                        hp_value,
                        card_type,
                        variant_bits,
                        lang,
                        f"Backfilled from PriceCharting product: {card['product_name']}",
                        now,
                        now,
                    ))
                    if cursor.rowcount > 0:
                        cards_inserted += 1
                    else:
                        cards_skipped += 1
                except sqlite3.IntegrityError as e:
                    cards_skipped += 1
                    print(f"  ⚠ Error inserting cm_card {cm_card_id}: {e}")
                    continue

                # Insert into cm_pricecharting_bridge
                try:
                    cursor.execute("""
                        INSERT OR IGNORE INTO cm_pricecharting_bridge (
                            cm_card_id, pricecharting_id, confidence, match_method,
                            notes, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (
                        cm_card_id,
                        card['id'],
                        1.0,  # Exact mapping confidence
                        'backfill',
                        f"Auto-mapped from PriceCharting CSV backfill",
                        now,
                        now,
                    ))
                    if cursor.rowcount > 0:
                        bridge_inserted += 1
                except sqlite3.IntegrityError as e:
                    print(f"  ⚠ Error inserting bridge for {cm_card_id}: {e}")

    if not dry_run:
        conn.commit()

    if dry_run:
        print(f"✓ [DRY-RUN] Would populate {cards_inserted} cards into cm_cards")
        print(f"✓ [DRY-RUN] Would create {bridge_inserted} bridge entries")
    else:
        print(f"✓ Populated {cards_inserted} new cards into cm_cards ({cards_skipped} duplicates skipped)")
        print(f"✓ Created {bridge_inserted} new bridge entries in cm_pricecharting_bridge")

    return (cards_inserted, bridge_inserted)


def populate_pricecharting_cards(conn: sqlite3.Connection, records: List[Dict], dry_run: bool = False) -> int:
    """Populate pricecharting_cards reference table."""
    cursor = conn.cursor()
    inserted = 0
    skipped = 0

    for record in records:
        # Extract release year
        release_year = None
        if record.get('release_date'):
            match = re.search(r'(\d{4})', record['release_date'])
            if match:
                release_year = int(match.group(1))

        if dry_run:
            inserted += 1
        else:
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO pricecharting_cards (
                        id, console_name, product_name, release_date,
                        release_year, sales_volume, card_number
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    record['id'],
                    record['console_name'],
                    record['product_name'],
                    record['release_date'] or None,
                    release_year,
                    record['sales_volume'],
                    record['card_number'],
                ))
                if cursor.rowcount > 0:
                    inserted += 1
                else:
                    skipped += 1
            except sqlite3.IntegrityError as e:
                skipped += 1
                print(f"  ⚠ Error inserting pricecharting_card {record['id']}: {e}")

    if not dry_run:
        conn.commit()

    if dry_run:
        print(f"✓ [DRY-RUN] Would populate {inserted} cards into pricecharting_cards")
    else:
        print(f"✓ Populated {inserted} new cards into pricecharting_cards ({skipped} duplicates skipped)")

    return inserted


def main():
    """Main backfill execution."""
    parser = argparse.ArgumentParser(
        description="Backfill CardMint canonical inventory from PriceCharting CSV"
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"Path to CardMint database (default: {DEFAULT_DB.relative_to(WORKSPACE_ROOT)})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Preview changes without writing to database (default: True)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        default=False,
        help="Execute writes to database (overrides --dry-run)",
    )
    args = parser.parse_args()

    cardmint_db = args.db
    dry_run = args.dry_run and not args.confirm

    print("=" * 80)
    print("CardMint Canonical Inventory Backfill")
    print("=" * 80)
    print()

    if dry_run:
        print("⚠ DRY-RUN MODE: No changes will be written to database")
        print("  Run with --confirm to execute writes")
        print()

    # Validate paths
    if not PRICECHARTING_CSV.exists():
        print(f"✗ PriceCharting CSV not found: {PRICECHARTING_CSV}")
        sys.exit(1)

    if not cardmint_db.exists():
        print(f"✗ CardMint database not found: {cardmint_db}")
        sys.exit(1)

    print(f"CSV source:     {PRICECHARTING_CSV}")
    print(f"Synonym map:    {SYNONYM_CSV}")
    print(f"Database:       {cardmint_db}")
    print()

    # Load synonym map
    print("Step 1: Loading set synonym map...")
    synonym_map = load_synonym_map(SYNONYM_CSV)
    print()

    # Parse PriceCharting CSV
    print("Step 2: Parsing PriceCharting CSV...")
    records = parse_pricecharting_csv(PRICECHARTING_CSV)
    print(f"✓ Parsed {len(records)} card records")
    print()

    # Group by sets
    print("Step 3: Grouping cards by set...")
    sets = group_by_sets(records, synonym_map)
    print(f"✓ Identified {len(sets)} unique sets")

    # Report UNKNOWN sets
    unknown_sets = [set_id for set_id in sets.keys() if set_id.startswith('UNKNOWN')]
    if unknown_sets:
        print(f"  ⚠ {len(unknown_sets)} UNKNOWN sets found:")
        for unknown_set_id in unknown_sets[:5]:  # Show first 5
            sample_card = sets[unknown_set_id][0]
            print(f"    - {unknown_set_id}: {sample_card['console_name']}")
        if len(unknown_sets) > 5:
            print(f"    ... and {len(unknown_sets) - 5} more")
    else:
        print(f"  ✓ All sets resolved (no UNKNOWN fallbacks)")
    print()

    # Connect to database
    conn = sqlite3.connect(str(cardmint_db))
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        # Populate pricecharting_cards (reference table)
        print("Step 4: Populating pricecharting_cards reference table...")
        populate_pricecharting_cards(conn, records, dry_run)
        print()

        # Populate cm_sets
        print("Step 5: Populating cm_sets...")
        populate_cm_sets(conn, sets, dry_run)
        print()

        # Populate cm_cards and bridge
        print("Step 6: Populating cm_cards and cm_pricecharting_bridge...")
        cards_count, bridge_count = populate_cm_cards_and_bridge(conn, sets, dry_run)
        print()

        # Update reference_datasets metadata (skip in dry-run)
        if not dry_run:
            cursor = conn.cursor()
            file_stat = os.stat(PRICECHARTING_CSV)
            cursor.execute("""
                INSERT OR REPLACE INTO reference_datasets (
                    dataset_key, source_path, source_mtime, row_count,
                    checksum, ingested_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                'pricecharting_pokemon_cards',
                str(PRICECHARTING_CSV),
                int(file_stat.st_mtime),
                len(records),
                hashlib.md5(open(PRICECHARTING_CSV, 'rb').read()).hexdigest(),
                int(datetime.now().timestamp()),
            ))
            conn.commit()

        # Print summary stats
        print("=" * 80)
        if dry_run:
            print("DRY-RUN Summary (no changes written)")
        else:
            print("Backfill Complete!")
        print("=" * 80)

        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM cm_sets")
        print(f"cm_sets:                    {cursor.fetchone()[0]:,} rows")

        cursor.execute("SELECT COUNT(*) FROM cm_cards")
        print(f"cm_cards:                   {cursor.fetchone()[0]:,} rows")

        cursor.execute("SELECT COUNT(*) FROM cm_pricecharting_bridge")
        print(f"cm_pricecharting_bridge:    {cursor.fetchone()[0]:,} rows")

        cursor.execute("SELECT COUNT(*) FROM pricecharting_cards")
        print(f"pricecharting_cards:        {cursor.fetchone()[0]:,} rows")

        print()

        if dry_run:
            print("✓ Dry-run validation complete")
            print("  Run with --confirm to execute writes to database")
        else:
            print("✓ Backfill complete")
            print("  All canonical inventory tables updated")
        print()

    except Exception as e:
        print(f"✗ Backfill failed: {e}")
        import traceback
        traceback.print_exc()
        conn.rollback()
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
