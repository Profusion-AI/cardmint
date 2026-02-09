import Database from "better-sqlite3";
import { normalizeCollectorNo } from "../../src/normalize/collectorNo.js";

/**
 * Create an in-memory SQLite DB mimicking tcgcsv_search_staging.db schema.
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
    CREATE TABLE tcg_search_corpus (
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

    CREATE INDEX idx_corpus_run ON tcg_search_corpus(run_id);
    CREATE INDEX idx_corpus_product ON tcg_search_corpus(product_id);
    CREATE INDEX idx_corpus_set ON tcg_search_corpus(set_name);
    CREATE INDEX idx_corpus_card ON tcg_search_corpus(card_name);
    CREATE INDEX idx_corpus_collector ON tcg_search_corpus(collector_no_norm);
  `);

  const runId = "20260206-171418";
  const ts = "2026-02-06T17:17:00Z";

  const insert = db.prepare(`
    INSERT INTO tcg_search_corpus
      (run_id, product_id, group_id, set_name, card_name, collector_no_raw, collector_no_norm,
       rarity, sub_type_name, market_price, image_url, freshness_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Cards NOT in inventory (reference-only)
  insert.run(runId, 1001, 1, "Base Set", "Venusaur", "015/102", "15", "Rare Holo", "Normal", 95.00,
    "https://tcg.example.com/venusaur.jpg", ts);
  insert.run(runId, 1002, 1, "Base Set", "Alakazam", "001/102", "1", "Rare Holo", "Normal", 45.00,
    "https://tcg.example.com/alakazam.jpg", ts);

  // Cards that ARE also in inventory (should NOT appear if inventory returns results)
  insert.run(runId, 2001, 1, "Base Set", "Charizard", "004/102", "4", "Rare Holo", "Normal", 400.00,
    "https://tcg.example.com/charizard.jpg", ts);
  insert.run(runId, 2002, 1, "Base Set", "Pikachu", "058/102", "58", "Common", "Normal", 18.00,
    "https://tcg.example.com/pikachu.jpg", ts);

  // Card with null collector_no
  insert.run(runId, 3001, 5, "Promo", "Pikachu", null, null, "Promo", "Normal", 10.00,
    "https://tcg.example.com/pikachu-promo.jpg", ts);

  // Card from different set for disambiguation
  insert.run(runId, 4001, 10, "Evolutions", "Charizard", "011/108", "11", "Rare Holo", "Normal", 50.00,
    "https://tcg.example.com/charizard-evo.jpg", ts);

  // -- Additional reference rows for eval coverage --

  // Fossil set
  insert.run(runId, 5001, 3, "Fossil", "Gengar", "005/062", "5", "Rare Holo", "Normal", 55.00,
    "https://tcg.example.com/gengar-fossil.jpg", ts);
  insert.run(runId, 5002, 3, "Fossil", "Dragonite", "004/062", "4", "Rare Holo", "Normal", 70.00,
    "https://tcg.example.com/dragonite-fossil.jpg", ts);

  // Team Rocket
  insert.run(runId, 5003, 4, "Team Rocket", "Dark Gyarados", "008/082", "8", "Rare Holo", "Normal", 25.00,
    "https://tcg.example.com/dark-gyarados.jpg", ts);

  // Scarlet & Violet — prefixed collector#
  insert.run(runId, 5004, 20, "Scarlet & Violet", "Charizard ex", "TG05/TG30", "TG05", "Ultra Rare", "Normal", 120.00,
    "https://tcg.example.com/charizard-ex-sv.jpg", ts);

  // Promo — null collector# (another null case)
  insert.run(runId, 5005, 5, "Promo", "Mew", null, null, "Promo", "Normal", 35.00,
    "https://tcg.example.com/mew-promo.jpg", ts);

  // Jungle
  insert.run(runId, 5006, 2, "Jungle", "Vaporeon", "012/064", "12", "Rare Holo", "Normal", 28.00,
    "https://tcg.example.com/vaporeon-jungle.jpg", ts);

  // Crown Zenith — GG-prefix collector#
  insert.run(runId, 5007, 30, "Crown Zenith", "Giratina V", "GG69/GG70", "GG69", "Ultra Rare", "Normal", 15.00,
    "https://tcg.example.com/giratina-cz.jpg", ts);

  // Paldea Evolved
  insert.run(runId, 5008, 21, "Paldea Evolved", "Ting-Lu ex", "105/193", "105", "Ultra Rare", "Normal", 8.00,
    "https://tcg.example.com/ting-lu-pe.jpg", ts);

  // Older run (should not be picked up by latest-run queries)
  insert.run("20260205-000000", 9999, 1, "Base Set", "Mewtwo", "010/102", "10", "Rare Holo", "Normal", 60.00,
    "https://tcg.example.com/mewtwo-old.jpg", ts);

  return db;
}
