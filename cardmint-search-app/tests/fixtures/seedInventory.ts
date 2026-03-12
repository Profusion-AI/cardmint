import Database from "better-sqlite3";
import { normalizeCollectorNo } from "../../src/normalize/collectorNo.js";

/**
 * Create an in-memory SQLite DB mimicking cardmint_dev.db inventory schema.
 * Registers normalize_cno UDF and seeds test data.
 */
export function seedInventoryDb(): Database.Database {
  const db = new Database(":memory:");

  // Register UDF
  db.function("normalize_cno", { deterministic: true, varargs: false }, (raw: unknown) => {
    if (raw == null) return null;
    return normalizeCollectorNo(String(raw));
  });

  db.exec(`
    CREATE TABLE cm_sets (
      cm_set_id TEXT PRIMARY KEY,
      set_name TEXT NOT NULL,
      release_date TEXT,
      release_year INTEGER,
      total_cards INTEGER,
      series TEXT,
      ptcgo_code TEXT,
      notes TEXT,
      ppt_id TEXT,
      tcgplayer_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE cm_cards (
      cm_card_id TEXT PRIMARY KEY,
      cm_set_id TEXT NOT NULL,
      collector_no TEXT NOT NULL,
      card_name TEXT NOT NULL,
      hp_value INTEGER,
      card_type TEXT,
      rarity TEXT,
      variant_bits TEXT,
      lang TEXT NOT NULL DEFAULT 'EN',
      artist TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (cm_set_id) REFERENCES cm_sets(cm_set_id)
    );

    CREATE VIRTUAL TABLE cm_cards_fts USING fts5(
      card_name,
      content='cm_cards',
      content_rowid='rowid'
    );

    CREATE TABLE products (
      product_uid TEXT PRIMARY KEY,
      cm_card_id TEXT NOT NULL,
      condition_bucket TEXT NOT NULL DEFAULT 'UNKNOWN',
      product_sku TEXT NOT NULL UNIQUE,
      listing_sku TEXT NOT NULL,
      card_name TEXT NOT NULL,
      set_name TEXT NOT NULL,
      collector_no TEXT NOT NULL,
      hp_value INTEGER,
      rarity TEXT,
      market_price REAL,
      launch_price REAL,
      pricing_channel TEXT,
      total_quantity INTEGER NOT NULL DEFAULT 0,
      cdn_image_url TEXT,
      evershop_sync_state TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (cm_card_id) REFERENCES cm_cards(cm_card_id)
    );
  `);

  const now = Date.now();

  // Seed sets
  const insertSet = db.prepare(`
    INSERT INTO cm_sets (cm_set_id, set_name, release_year, total_cards, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertSet.run("set-base", "Base Set", 1999, 102, now, now);
  insertSet.run("set-base-shadowless", "Base Set (Shadowless)", 1999, 102, now, now);
  insertSet.run("set-jungle", "Jungle", 1999, 64, now, now);
  insertSet.run("set-evolutions", "Evolutions", 2016, 108, now, now);
  insertSet.run("set-teamrocket", "Team Rocket", 2000, 82, now, now);
  insertSet.run("set-sv", "Scarlet & Violet", 2023, 198, now, now);

  // Seed cards
  const insertCard = db.prepare(`
    INSERT INTO cm_cards (cm_card_id, cm_set_id, collector_no, card_name, rarity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertCard.run("card-charizard-base", "set-base", "4/102", "Charizard", "Rare Holo", now, now);
  insertCard.run("card-pikachu-base", "set-base", "58/102", "Pikachu", "Common", now, now);
  insertCard.run("card-blastoise-base", "set-base", "2/102", "Blastoise", "Rare Holo", now, now);
  insertCard.run("card-sandshrew-shadowless", "set-base-shadowless", "62/102", "Sandshrew", "Common", now, now);
  insertCard.run("card-charizard-evo", "set-evolutions", "011/108", "Charizard", "Rare Holo", now, now);
  insertCard.run("card-flareon-jungle", "set-jungle", "003/064", "Flareon", "Rare Holo", now, now);
  insertCard.run("card-dark-gyarados", "set-teamrocket", "008/082", "Dark Gyarados", "Rare Holo", now, now);
  insertCard.run("card-dark-flareon-tr", "set-teamrocket", "019/082", "Dark Flareon", "Uncommon", now, now);
  insertCard.run("card-charizard-ex-sv", "set-sv", "TG05/TG30", "Charizard ex", "Ultra Rare", now, now);

  // Populate FTS
  db.exec(`INSERT INTO cm_cards_fts(cm_cards_fts) VALUES('rebuild')`);

  // Seed products (some in stock, some sold out)
  const insertProduct = db.prepare(`
    INSERT INTO products (product_uid, cm_card_id, condition_bucket, product_sku, listing_sku,
      card_name, set_name, collector_no, rarity, market_price, total_quantity, cdn_image_url,
      evershop_sync_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertProduct.run("prod-charizard-nm", "card-charizard-base", "NM", "SKU-CHAR-NM", "LSK-CHAR",
    "Charizard", "Base Set", "4/102", "Rare Holo", 350.00, 1, "https://cdn.example.com/charizard.jpg",
    "synced", now, now);

  insertProduct.run("prod-charizard-lp", "card-charizard-base", "LP", "SKU-CHAR-LP", "LSK-CHAR",
    "Charizard", "Base Set", "4/102", "Rare Holo", 280.00, 2, "https://cdn.example.com/charizard-lp.jpg",
    "synced", now, now);

  insertProduct.run("prod-pikachu-nm", "card-pikachu-base", "NM", "SKU-PIKA-NM", "LSK-PIKA",
    "Pikachu", "Base Set", "58/102", "Common", 15.00, 3, "https://cdn.example.com/pikachu.jpg",
    "synced", now, now);

  insertProduct.run("prod-blastoise-nm", "card-blastoise-base", "NM", "SKU-BLAST-NM", "LSK-BLAST",
    "Blastoise", "Base Set", "2/102", "Rare Holo", 120.00, 0, null,  // sold out
    "synced", now, now);

  insertProduct.run("prod-charizard-evo", "card-charizard-evo", "NM", "SKU-CHAR-EVO", "LSK-CHAR-EVO",
    "Charizard", "Evolutions", "011/108", "Rare Holo", 45.00, 1, "https://cdn.example.com/charizard-evo.jpg",
    "synced", now, now);

  insertProduct.run("prod-flareon-nm", "card-flareon-jungle", "NM", "SKU-FLAR-NM", "LSK-FLAR",
    "Flareon", "Jungle", "003/064", "Rare Holo", 30.00, 2, "https://cdn.example.com/flareon.jpg",
    "synced", now, now);

  insertProduct.run("prod-dark-gyarados-nm", "card-dark-gyarados", "NM", "SKU-DGYAR-NM", "LSK-DGYAR",
    "Dark Gyarados", "Team Rocket", "008/082", "Rare Holo", 22.00, 1, "https://cdn.example.com/dark-gyarados.jpg",
    "synced", now, now);

  insertProduct.run("prod-dark-flareon-nm", "card-dark-flareon-tr", "NM", "SKU-DFLAR-NM", "LSK-DFLAR",
    "Dark Flareon", "Team Rocket", "019/082", "Uncommon", 8.00, 1, "https://cdn.example.com/dark-flareon.jpg",
    "synced", now, now);

  insertProduct.run("prod-sandshrew-shadowless-nm", "card-sandshrew-shadowless", "NM", "SKU-SAND-SL-NM", "LSK-SAND-SL",
    "Sandshrew", "Base Set (Shadowless)", "62/102", "Common", 5.00, 1, null,
    "synced", now, now);

  insertProduct.run("prod-charizard-ex-sv", "card-charizard-ex-sv", "NM", "SKU-CHAR-EX-SV", "LSK-CHAR-EX-SV",
    "Charizard ex", "Scarlet & Violet", "TG05/TG30", "Ultra Rare", 110.00, 1, "https://cdn.example.com/charizard-ex-sv.jpg",
    "synced", now, now);

  // Duplicate product rows (same card+condition, different physical copies) for dedup testing
  insertProduct.run("prod-charizard-nm-dup1", "card-charizard-base", "NM", "SKU-CHAR-NM-D1", "LSK-CHAR-D1",
    "Charizard", "Base Set", "4/102", "Rare Holo", 340.00, 1, "https://cdn.example.com/charizard-d1.jpg",
    "synced", now, now);

  insertProduct.run("prod-charizard-nm-dup2", "card-charizard-base", "NM", "SKU-CHAR-NM-D2", "LSK-CHAR-D2",
    "Charizard", "Base Set", "4/102", "Rare Holo", 330.00, 1, "https://cdn.example.com/charizard-d2.jpg",
    "synced", now, now);

  insertProduct.run("prod-pikachu-nm-dup", "card-pikachu-base", "NM", "SKU-PIKA-NM-D1", "LSK-PIKA-D1",
    "Pikachu", "Base Set", "58/102", "Common", 14.00, 1, "https://cdn.example.com/pikachu-d1.jpg",
    "synced", now, now);

  return db;
}
