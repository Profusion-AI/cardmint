import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { getDbStatus } from "../../src/db/connection.js";
import type { DbPool } from "../../src/db/connection.js";

const SCHEMA = `
  CREATE TABLE tcg_snapshots (
    id INTEGER PRIMARY KEY,
    status TEXT,
    snapshot_date TEXT,
    file_name TEXT,
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
`;

describe("getDbStatus — reference health probe", () => {
  it("returns connected=true and corpusCount when schema is correct with data", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO tcg_snapshots VALUES (1, 'complete', '2026-02-06', 'x.csv', 0)").run();
    db.prepare(
      "INSERT INTO tcg_rows (snapshot_id, product_name, set_name, condition_bucket) VALUES (1, 'Charizard', 'Base Set', 'NM')"
    ).run();

    const status = getDbStatus({ inventory: null, reference: db });
    expect(status.reference.connected).toBe(true);
    expect(status.reference.corpusCount).toBe(1);
    db.close();
  });

  it("returns connected=true and corpusCount=0 when no complete snapshot exists", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO tcg_snapshots VALUES (1, 'pending', '2026-02-06', 'x.csv', 0)").run();

    const status = getDbStatus({ inventory: null, reference: db });
    expect(status.reference.connected).toBe(true);
    expect(status.reference.corpusCount).toBe(0);
    db.close();
  });

  it("returns connected=false when tcg_rows table is absent (wrong-schema DB)", () => {
    const db = new Database(":memory:");
    // Intentionally no tcg_rows / tcg_snapshots tables

    const status = getDbStatus({ inventory: null, reference: db });
    expect(status.reference.connected).toBe(false);
    expect(status.reference.corpusCount).toBeUndefined();
    db.close();
  });

  it("returns connected=false and corpusCount undefined when reference pool is null", () => {
    const pool: DbPool = { inventory: null, reference: null };
    const status = getDbStatus(pool);
    expect(status.reference.connected).toBe(false);
    expect(status.reference.corpusCount).toBeUndefined();
  });

  it("counts only rows from the latest complete snapshot (not older ones)", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO tcg_snapshots VALUES (1, 'complete', '2026-02-05', 'old.csv', 0)").run();
    db.prepare("INSERT INTO tcg_snapshots VALUES (2, 'complete', '2026-02-06', 'new.csv', 1)").run();
    db.prepare(
      "INSERT INTO tcg_rows (snapshot_id, product_name, set_name, condition_bucket) VALUES (1, 'OldCard', 'Old Set', 'NM')"
    ).run();
    db.prepare(
      "INSERT INTO tcg_rows (snapshot_id, product_name, set_name, condition_bucket) VALUES (2, 'NewCard', 'New Set', 'NM')"
    ).run();

    const status = getDbStatus({ inventory: null, reference: db });
    expect(status.reference.connected).toBe(true);
    // MAX(id) picks snapshot 2, so corpusCount should be 1 (only NewCard)
    expect(status.reference.corpusCount).toBe(1);
    db.close();
  });
});
