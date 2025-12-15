CREATE TABLE IF NOT EXISTS reference_datasets (
  dataset_key TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_mtime INTEGER NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  ingested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pricecharting_cards (
  id TEXT PRIMARY KEY,
  console_name TEXT,
  product_name TEXT NOT NULL,
  release_date TEXT,
  release_year INTEGER,
  sales_volume INTEGER DEFAULT 0,
  card_number TEXT,
  total_set_size TEXT,
  loose_price REAL,
  graded_price REAL
);

CREATE INDEX IF NOT EXISTS idx_pricecharting_cards_release_year
  ON pricecharting_cards(release_year);
CREATE INDEX IF NOT EXISTS idx_pricecharting_cards_card_number
  ON pricecharting_cards(card_number);

CREATE VIRTUAL TABLE IF NOT EXISTS pricecharting_cards_fts
  USING fts5(product_name, content='pricecharting_cards', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS pricecharting_cards_ai
AFTER INSERT ON pricecharting_cards BEGIN
  INSERT INTO pricecharting_cards_fts(rowid, product_name)
    VALUES (new.rowid, new.product_name);
END;

CREATE TRIGGER IF NOT EXISTS pricecharting_cards_ad
AFTER DELETE ON pricecharting_cards BEGIN
  INSERT INTO pricecharting_cards_fts(pricecharting_cards_fts, rowid, product_name)
    VALUES('delete', old.rowid, old.product_name);
END;

CREATE TRIGGER IF NOT EXISTS pricecharting_cards_au
AFTER UPDATE ON pricecharting_cards BEGIN
  INSERT INTO pricecharting_cards_fts(pricecharting_cards_fts, rowid, product_name)
    VALUES('delete', old.rowid, old.product_name);
  INSERT INTO pricecharting_cards_fts(rowid, product_name)
    VALUES (new.rowid, new.product_name);
END;
