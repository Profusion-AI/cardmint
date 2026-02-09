#!/usr/bin/env python3
"""
TCGCSV Pokemon corpus scraper + merge + SQLite loader + QA reporter.

Fetches all Pokemon (categoryId=3) groups, products, and prices from
tcgcsv.com, normalizes and merges them, loads into a local SQLite staging
DB, and produces a QA report.

Usage:
    python scripts/tcgcsv_scrape.py
"""

import csv
import io
import json
import logging
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = "https://tcgcsv.com/tcgplayer/3"
REQUEST_TIMEOUT = 30  # seconds
MAX_RETRIES = 4
BACKOFF_BASE = 2  # exponential backoff multiplier
SLEEP_BETWEEN = 0.35  # seconds between group fetches
LOG_EVERY_N = 20  # log progress every N groups

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("tcgcsv_scrape")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
session = requests.Session()
session.headers.update({"Accept": "application/json"})


def fetch_json(url: str) -> dict | None:
    """Fetch JSON with retries and exponential backoff. Returns None on permanent failure."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            wait = BACKOFF_BASE ** attempt
            if attempt < MAX_RETRIES:
                log.warning("Attempt %d/%d failed for %s: %s — retrying in %ds",
                            attempt, MAX_RETRIES, url, exc, wait)
                time.sleep(wait)
            else:
                log.error("All %d attempts failed for %s: %s", MAX_RETRIES, url, exc)
                return None


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def normalize_collector_no(raw: str | None) -> str | None:
    """Normalize collector number per spec."""
    if raw is None or raw.strip() == "":
        return None
    raw = raw.strip()
    # Take numerator before '/' if present
    numerator = raw.split("/")[0].strip()
    # If purely numeric, strip leading zeros but keep at least "0"
    if re.fullmatch(r"\d+", numerator):
        return str(int(numerator))
    # Non-numeric: lowercase
    return numerator.lower()


def extract_ext(product: dict, field_name: str) -> str | None:
    """Pull a value from extendedData by display name."""
    for item in product.get("extendedData", []):
        if item.get("name") == field_name:
            val = item.get("value")
            if val is not None:
                val = str(val).strip()
                return val if val else None
    return None


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------
def scrape(run_dir: Path):
    """Fetch all groups, products, and prices. Write raw JSON."""
    log.info("Fetching groups...")
    groups_data = fetch_json(f"{BASE_URL}/groups")
    if groups_data is None:
        log.critical("Cannot fetch groups — aborting.")
        sys.exit(1)

    groups = groups_data.get("results", [])
    log.info("Got %d groups", len(groups))

    # Save raw groups
    (run_dir / "groups.json").write_text(json.dumps(groups_data, indent=2))

    products_dir = run_dir / "products"
    prices_dir = run_dir / "prices"
    products_dir.mkdir(parents=True, exist_ok=True)
    prices_dir.mkdir(parents=True, exist_ok=True)

    all_products = []
    all_prices = []
    failed_groups = []

    for i, group in enumerate(groups):
        gid = group["groupId"]
        gname = group.get("name", "?")

        if (i + 1) % LOG_EVERY_N == 0:
            log.info("Progress: %d/%d groups fetched (current: %s [%d])",
                     i + 1, len(groups), gname, gid)

        # Products
        prod_data = fetch_json(f"{BASE_URL}/{gid}/products")
        if prod_data is None:
            log.warning("Skipping group %d (%s) — products fetch failed", gid, gname)
            failed_groups.append({"groupId": gid, "name": gname, "reason": "products_fetch_failed"})
            time.sleep(SLEEP_BETWEEN)
            continue

        (products_dir / f"{gid}.json").write_text(json.dumps(prod_data, indent=2))
        prods = prod_data.get("results", [])

        # Tag each product with groupId (may not be present in response)
        for p in prods:
            p.setdefault("groupId", gid)
        all_products.extend(prods)

        time.sleep(SLEEP_BETWEEN)

        # Prices
        price_data = fetch_json(f"{BASE_URL}/{gid}/prices")
        if price_data is None:
            log.warning("Skipping prices for group %d (%s) — fetch failed", gid, gname)
            failed_groups.append({"groupId": gid, "name": gname, "reason": "prices_fetch_failed"})
            time.sleep(SLEEP_BETWEEN)
            continue

        (prices_dir / f"{gid}.json").write_text(json.dumps(price_data, indent=2))
        prs = price_data.get("results", [])
        for pr in prs:
            pr.setdefault("groupId", gid)
        all_prices.extend(prs)

        time.sleep(SLEEP_BETWEEN)

    return groups, all_products, all_prices, failed_groups


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------
def merge(groups, products, prices, run_id, processed_dir):
    """Left-join products to prices, normalize, write CSV + JSONL."""
    group_map = {g["groupId"]: g for g in groups}

    # Build price lookup: (productId, subTypeName) -> price row
    price_map: dict[int, list[dict]] = {}
    for pr in prices:
        pid = pr["productId"]
        price_map.setdefault(pid, []).append(pr)

    merged_rows = []
    orphan_price_pids = set(pr["productId"] for pr in prices)
    product_pids = set()

    for prod in products:
        pid = prod["productId"]
        gid = prod.get("groupId")
        product_pids.add(pid)
        orphan_price_pids.discard(pid)

        set_name = group_map.get(gid, {}).get("name", "")
        card_name = prod.get("cleanName") or prod.get("name", "")
        ext_number = extract_ext(prod, "Number")
        ext_rarity = extract_ext(prod, "Rarity")
        ext_card_type = extract_ext(prod, "CardType") or extract_ext(prod, "Card Type")
        ext_hp = extract_ext(prod, "HP")
        image_url = prod.get("imageUrl")
        modified_on = prod.get("modifiedOn")

        price_rows = price_map.get(pid, [None])
        if not price_rows:
            price_rows = [None]

        for pr in price_rows:
            row = {
                "run_id": run_id,
                "product_id": pid,
                "group_id": gid,
                "set_name": set_name.strip() if set_name else "",
                "card_name": card_name.strip() if card_name else "",
                "collector_no_raw": ext_number,
                "collector_no_norm": normalize_collector_no(ext_number),
                "rarity": ext_rarity,
                "sub_type_name": pr.get("subTypeName") if pr else None,
                "market_price": pr.get("marketPrice") if pr else None,
                "mid_price": pr.get("midPrice") if pr else None,
                "low_price": pr.get("lowPrice") if pr else None,
                "direct_low_price": pr.get("directLowPrice") if pr else None,
                "image_url": image_url,
                "source_label": "reference_aggregate",
                "freshness_ts": datetime.now(timezone.utc).isoformat(),
                # extras for raw tables
                "ext_card_type": ext_card_type,
                "ext_hp": ext_hp,
                "modified_on": modified_on,
                "raw_product_json": json.dumps(prod),
                "raw_price_json": json.dumps(pr) if pr else "{}",
                "raw_group_json": json.dumps(group_map.get(gid, {})),
            }
            merged_rows.append(row)

    orphan_product_pids = product_pids - set(pr["productId"] for pr in prices)

    # Write CSV
    csv_path = processed_dir / "corpus_merged.csv"
    csv_fields = [
        "run_id", "product_id", "group_id", "set_name", "card_name",
        "collector_no_raw", "collector_no_norm", "rarity", "sub_type_name",
        "market_price", "mid_price", "low_price", "direct_low_price",
        "image_url", "source_label", "freshness_ts",
    ]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=csv_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged_rows)
    log.info("Wrote %s (%d rows)", csv_path, len(merged_rows))

    # Write JSONL
    jsonl_path = processed_dir / "corpus_merged.jsonl"
    with open(jsonl_path, "w") as f:
        for row in merged_rows:
            # Only write the corpus fields, not raw JSON blobs
            slim = {k: row[k] for k in csv_fields}
            f.write(json.dumps(slim) + "\n")
    log.info("Wrote %s", jsonl_path)

    return merged_rows, orphan_price_pids, orphan_product_pids


# ---------------------------------------------------------------------------
# SQLite loader
# ---------------------------------------------------------------------------
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tcg_groups (
  run_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  abbreviation TEXT,
  published_on TEXT,
  modified_on TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (run_id, group_id)
);

CREATE TABLE IF NOT EXISTS tcg_products (
  run_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  clean_name TEXT,
  image_url TEXT,
  ext_number TEXT,
  ext_rarity TEXT,
  ext_card_type TEXT,
  ext_hp TEXT,
  modified_on TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (run_id, product_id)
);

CREATE TABLE IF NOT EXISTS tcg_prices (
  run_id TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  sub_type_name TEXT NOT NULL DEFAULT '',
  low_price REAL,
  mid_price REAL,
  high_price REAL,
  market_price REAL,
  direct_low_price REAL,
  modified_on TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (run_id, product_id, sub_type_name)
);

CREATE TABLE IF NOT EXISTS tcg_search_corpus (
  run_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  set_name TEXT NOT NULL,
  card_name TEXT NOT NULL,
  collector_no_raw TEXT,
  collector_no_norm TEXT,
  rarity TEXT,
  sub_type_name TEXT NOT NULL DEFAULT '',
  market_price REAL,
  mid_price REAL,
  low_price REAL,
  direct_low_price REAL,
  image_url TEXT,
  source_label TEXT NOT NULL DEFAULT 'reference_aggregate',
  freshness_ts TEXT,
  PRIMARY KEY (run_id, product_id, sub_type_name)
);

CREATE INDEX IF NOT EXISTS idx_corpus_run ON tcg_search_corpus(run_id);
CREATE INDEX IF NOT EXISTS idx_corpus_product ON tcg_search_corpus(product_id);
CREATE INDEX IF NOT EXISTS idx_corpus_set ON tcg_search_corpus(set_name);
CREATE INDEX IF NOT EXISTS idx_corpus_card ON tcg_search_corpus(card_name);
CREATE INDEX IF NOT EXISTS idx_corpus_collector ON tcg_search_corpus(collector_no_norm);
"""


def load_sqlite(db_path: Path, run_id: str, groups, products, prices, merged_rows):
    """Load all data into SQLite staging DB."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA_SQL)

    # Groups
    conn.executemany(
        """INSERT OR REPLACE INTO tcg_groups
           (run_id, group_id, category_id, name, abbreviation, published_on, modified_on, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (run_id, g["groupId"], g.get("categoryId", 3), g["name"],
             g.get("abbreviation"), g.get("publishedOn"), g.get("modifiedOn"),
             json.dumps(g))
            for g in groups
        ]
    )

    # Products
    conn.executemany(
        """INSERT OR REPLACE INTO tcg_products
           (run_id, group_id, product_id, name, clean_name, image_url,
            ext_number, ext_rarity, ext_card_type, ext_hp, modified_on, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (run_id, p.get("groupId"), p["productId"], p.get("name", ""),
             p.get("cleanName"), p.get("imageUrl"),
             extract_ext(p, "Number"), extract_ext(p, "Rarity"),
             extract_ext(p, "CardType") or extract_ext(p, "Card Type"),
             extract_ext(p, "HP"), p.get("modifiedOn"), json.dumps(p))
            for p in products
        ]
    )

    # Prices
    conn.executemany(
        """INSERT OR REPLACE INTO tcg_prices
           (run_id, group_id, product_id, sub_type_name,
            low_price, mid_price, high_price, market_price, direct_low_price,
            modified_on, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (run_id, pr.get("groupId"), pr["productId"], pr.get("subTypeName") or "",
             pr.get("lowPrice"), pr.get("midPrice"), pr.get("highPrice"),
             pr.get("marketPrice"), pr.get("directLowPrice"),
             pr.get("modifiedOn"), json.dumps(pr))
            for pr in prices
        ]
    )

    # Search corpus
    conn.executemany(
        """INSERT OR REPLACE INTO tcg_search_corpus
           (run_id, product_id, group_id, set_name, card_name,
            collector_no_raw, collector_no_norm, rarity, sub_type_name,
            market_price, mid_price, low_price, direct_low_price,
            image_url, source_label, freshness_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (r["run_id"], r["product_id"], r["group_id"], r["set_name"],
             r["card_name"], r["collector_no_raw"], r["collector_no_norm"],
             r["rarity"], r["sub_type_name"] or "",
             r["market_price"], r["mid_price"], r["low_price"], r["direct_low_price"],
             r["image_url"], r["source_label"], r["freshness_ts"])
            for r in merged_rows
        ]
    )

    conn.commit()
    conn.close()
    log.info("Loaded into %s", db_path)


# ---------------------------------------------------------------------------
# QA report
# ---------------------------------------------------------------------------
def generate_qa(run_id, groups, products, prices, merged_rows,
                failed_groups, orphan_price_pids, orphan_product_pids,
                duration, report_path):
    """Generate QA report JSON."""
    unique_pids = len(set(r["product_id"] for r in merged_rows))
    null_market = sum(1 for r in merged_rows if r["market_price"] is None)
    null_collector_raw = sum(1 for r in merged_rows if r["collector_no_raw"] is None)
    null_collector_norm = sum(1 for r in merged_rows if r["collector_no_norm"] is None)
    total = len(merged_rows) or 1  # avoid div by zero

    report = {
        "run_id": run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(duration, 1),
        "group_count": len(groups),
        "groups_failed_count": len(failed_groups),
        "groups_failed": failed_groups,
        "products_row_count": len(products),
        "prices_row_count": len(prices),
        "merged_row_count": len(merged_rows),
        "unique_product_id_count": unique_pids,
        "pct_null_market_price": round(100 * null_market / total, 2),
        "pct_null_collector_no_raw": round(100 * null_collector_raw / total, 2),
        "pct_null_collector_no_norm": round(100 * null_collector_norm / total, 2),
        "orphan_price_rows": len(orphan_price_pids),
        "orphan_product_rows": len(orphan_product_pids),
        "acceptance": {},
    }

    # Acceptance gates
    gates = {
        "groups_failed_zero": len(failed_groups) == 0,
        "group_count_gte_200": len(groups) >= 200,
        "unique_product_id_gte_20000": unique_pids >= 20000,
    }
    all_green = all(gates.values())
    report["acceptance"] = {
        "gates": gates,
        "status": "GREEN" if all_green else ("YELLOW" if len(failed_groups) > 0 and unique_pids >= 20000 else "RED"),
    }

    report_path.write_text(json.dumps(report, indent=2))
    log.info("QA report: %s — status=%s", report_path, report["acceptance"]["status"])
    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    run_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    log.info("Starting TCGCSV scrape run %s", run_id)

    run_dir = DATA_DIR / "raw" / "tcgcsv" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    processed_dir = DATA_DIR / "processed" / run_id
    processed_dir.mkdir(parents=True, exist_ok=True)
    db_path = DATA_DIR / "db" / "tcgcsv_search_staging.db"

    t0 = time.monotonic()

    # 1) Scrape
    groups, products, prices, failed_groups = scrape(run_dir)
    log.info("Scrape complete: %d groups, %d products, %d prices, %d failed",
             len(groups), len(products), len(prices), len(failed_groups))

    # 2) Merge
    merged_rows, orphan_price_pids, orphan_product_pids = merge(
        groups, products, prices, run_id, processed_dir
    )

    # 3) Load SQLite
    load_sqlite(db_path, run_id, groups, products, prices, merged_rows)

    # 4) QA report
    duration = time.monotonic() - t0
    report = generate_qa(
        run_id, groups, products, prices, merged_rows,
        failed_groups, orphan_price_pids, orphan_product_pids,
        duration, processed_dir / "qa_report.json"
    )

    # Summary
    log.info("=" * 60)
    log.info("RUN COMPLETE: %s", run_id)
    log.info("  Groups:        %d", report["group_count"])
    log.info("  Failed groups: %d", report["groups_failed_count"])
    log.info("  Products:      %d", report["products_row_count"])
    log.info("  Prices:        %d", report["prices_row_count"])
    log.info("  Merged rows:   %d", report["merged_row_count"])
    log.info("  Unique PIDs:   %d", report["unique_product_id_count"])
    log.info("  Duration:      %.1fs", duration)
    log.info("  Status:        %s", report["acceptance"]["status"])
    log.info("=" * 60)

    return report


if __name__ == "__main__":
    main()
