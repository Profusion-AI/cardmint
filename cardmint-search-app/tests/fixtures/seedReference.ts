import Database from "better-sqlite3";
import { normalizeCollectorNo } from "../../src/normalize/collectorNo.js";

/**
 * Create an in-memory SQLite DB mimicking the tcg_snapshots + tcg_rows schema.
 * Registers normalize_cno UDF and seeds test data.
 */
export function seedReferenceDb(): Database.Database {
  const db = new Database(":memory:");

  // Register UDF
  db.function("normalize_cno", { deterministic: true, varargs: false }, (raw: unknown) => {
    if (raw == null) return null;
    return normalizeCollectorNo(String(raw));
  });

  db.exec(`
    CREATE TABLE tcg_snapshots (
      id INTEGER PRIMARY KEY,
      file_name TEXT,
      snapshot_date TEXT,
      status TEXT DEFAULT 'complete',
      uploaded_at INTEGER
    );

    CREATE TABLE tcg_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      tcgplayer_id INTEGER,
      product_name TEXT NOT NULL,
      set_name TEXT NOT NULL,
      card_number TEXT,
      rarity TEXT,
      condition_bucket TEXT NOT NULL,
      finish TEXT,
      market_price_cents INTEGER,
      photo_url TEXT
    );
  `);

  // Snapshot 1 — older, should not be returned by latest-only queries
  db.prepare(`INSERT INTO tcg_snapshots (id, file_name, snapshot_date, status, uploaded_at)
    VALUES (1, 'old.csv', '2026-02-05', 'complete', 1738800000)`).run();

  // Snapshot 2 — latest complete snapshot (used by all current tests)
  db.prepare(`INSERT INTO tcg_snapshots (id, file_name, snapshot_date, status, uploaded_at)
    VALUES (2, 'current.csv', '2026-02-06', 'complete', 1738886400)`).run();

  const insert = db.prepare(`
    INSERT INTO tcg_rows
      (snapshot_id, tcgplayer_id, product_name, set_name, card_number,
       rarity, condition_bucket, market_price_cents, photo_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ── Venusaur (Base Set) — single condition for basic LIKE test ───────────────
  insert.run(2, 1001, "Venusaur", "Base Set", "015/102", "Rare Holo", "NM", 9500,
    "https://tcg.example.com/venusaur.jpg");

  // ── Alakazam (Base Set) ──────────────────────────────────────────────────────
  insert.run(2, 1002, "Alakazam", "Base Set", "001/102", "Rare Holo", "NM", 4500,
    "https://tcg.example.com/alakazam.jpg");

  // ── Charizard (Base Set) — multiple conditions: NM + LP + MP ────────────────
  // Tests: dedup, LP-preferred pricing, UNK conditionBucket
  insert.run(2, 2001, "Charizard", "Base Set", "004/102", "Rare Holo", "NM", 40000,
    "https://tcg.example.com/charizard.jpg");
  insert.run(2, 2001, "Charizard", "Base Set", "004/102", "Rare Holo", "LP", 32000,
    "https://tcg.example.com/charizard.jpg");
  insert.run(2, 2001, "Charizard", "Base Set", "004/102", "Rare Holo", "MP", 22000,
    "https://tcg.example.com/charizard.jpg");

  // ── Pikachu (Base Set) — card shared across sets ─────────────────────────────
  insert.run(2, 2002, "Pikachu", "Base Set", "058/102", "Common", "NM", 1800,
    "https://tcg.example.com/pikachu.jpg");

  // ── Pikachu (Promo) — null card_number ──────────────────────────────────────
  insert.run(2, 3001, "Pikachu", "Promo", null, "Promo", "NM", 1000,
    "https://tcg.example.com/pikachu-promo.jpg");

  // ── Charizard (Evolutions) — different set, same name ───────────────────────
  insert.run(2, 4001, "Charizard", "Evolutions", "011/108", "Rare Holo", "NM", 5000,
    "https://tcg.example.com/charizard-evo.jpg");

  // ── Charizard ex (Scarlet & Violet) — prefixed collector# ───────────────────
  insert.run(2, 5004, "Charizard ex", "Scarlet & Violet", "TG05/TG30", "Ultra Rare", "NM", 12000,
    "https://tcg.example.com/charizard-ex-sv.jpg");

  // ── Flareon (Jungle) — for set-constrained likeSearch test ──────────────────
  insert.run(2, 5010, "Flareon", "Jungle", "019/064", "Rare Holo", "NM", 3500,
    "https://tcg.example.com/flareon-jungle.jpg");

  // ── Flareon (Evolutions) — same name, different set (should be excluded when setName=Jungle) ─
  insert.run(2, 5011, "Flareon", "Evolutions", "019/108", "Rare Holo", "NM", 1200,
    "https://tcg.example.com/flareon-evo.jpg");

  // ── Fossil set ───────────────────────────────────────────────────────────────
  insert.run(2, 5001, "Gengar", "Fossil", "005/062", "Rare Holo", "NM", 5500,
    "https://tcg.example.com/gengar-fossil.jpg");
  insert.run(2, 5002, "Dragonite", "Fossil", "004/062", "Rare Holo", "NM", 7000,
    "https://tcg.example.com/dragonite-fossil.jpg");

  // ── Team Rocket ──────────────────────────────────────────────────────────────
  insert.run(2, 5003, "Dark Gyarados", "Team Rocket", "008/082", "Rare Holo", "NM", 2500,
    "https://tcg.example.com/dark-gyarados.jpg");

  // ── Crown Zenith — GG-prefix collector# ─────────────────────────────────────
  insert.run(2, 5007, "Giratina V", "Crown Zenith", "GG69/GG70", "Ultra Rare", "NM", 1500,
    "https://tcg.example.com/giratina-cz.jpg");

  // ── Paldea Evolved ───────────────────────────────────────────────────────────
  insert.run(2, 5008, "Ting-Lu ex", "Paldea Evolved", "105/193", "Ultra Rare", "NM", 800,
    "https://tcg.example.com/ting-lu-pe.jpg");

  // ── Vaporeon (Jungle) — LP price only (no NM row) ───────────────────────────
  // Tests: LP price used when NM absent
  insert.run(2, 5006, "Vaporeon", "Jungle", "012/064", "Rare Holo", "LP", 2800,
    "https://tcg.example.com/vaporeon-jungle.jpg");

  // ── Mew (Promo) — null card_number ──────────────────────────────────────────
  insert.run(2, 5005, "Mew", "Promo", null, "Promo", "NM", 3500,
    "https://tcg.example.com/mew-promo.jpg");

  // ── Mewtwo — ONLY in older snapshot (should never appear in latest-only queries) ──
  insert.run(1, 9999, "Mewtwo", "Base Set", "010/102", "Rare Holo", "NM", 6000,
    "https://tcg.example.com/mewtwo-old.jpg");

  return db;
}

/**
 * Creates a reference DB with NO complete snapshots.
 * Used to test graceful empty-state handling.
 */
export function seedEmptyReferenceDb(): Database.Database {
  const db = new Database(":memory:");

  db.function("normalize_cno", { deterministic: true, varargs: false }, (raw: unknown) => {
    if (raw == null) return null;
    return normalizeCollectorNo(String(raw));
  });

  db.exec(`
    CREATE TABLE tcg_snapshots (
      id INTEGER PRIMARY KEY,
      file_name TEXT,
      snapshot_date TEXT,
      status TEXT DEFAULT 'complete',
      uploaded_at INTEGER
    );

    CREATE TABLE tcg_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      tcgplayer_id INTEGER,
      product_name TEXT NOT NULL,
      set_name TEXT NOT NULL,
      card_number TEXT,
      rarity TEXT,
      condition_bucket TEXT NOT NULL,
      finish TEXT,
      market_price_cents INTEGER,
      photo_url TEXT
    );
  `);

  // Insert a pending (not complete) snapshot — should be ignored
  db.prepare(`INSERT INTO tcg_snapshots (id, file_name, snapshot_date, status, uploaded_at)
    VALUES (1, 'pending.csv', '2026-02-06', 'pending', 1738886400)`).run();

  return db;
}
