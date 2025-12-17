import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const dbPath = process.env.SQLITE_DB;

if (!dbPath) {
  console.error("SQLITE_DB not set in .env");
  process.exit(1);
}

console.log(`Using DB: ${dbPath}`);
const db = new Database(dbPath);

function runPhase1() {
  console.log("Starting Phase 1: Canonical-first catalog...");

  // 1. Create canonical_cards_fts
  console.log("Creating canonical_cards_fts...");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS canonical_cards_fts USING fts5(
      name,
      set_name,
      card_number,
      content='canonical_cards',
      content_rowid='rowid'
    );
  `);

  // 2. Populate FTS
  console.log("Populating canonical_cards_fts...");
  // Clear existing to avoid duplicates if re-running
  db.exec("DELETE FROM canonical_cards_fts;");
  db.exec(`
    INSERT INTO canonical_cards_fts(rowid, name, set_name, card_number)
    SELECT cc.rowid, cc.name, cs.name, cc.card_number
    FROM canonical_cards cc
    JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id;
  `);

  // 3. Create cm_cards view
  console.log("Creating cm_cards view...");
  // Drop if exists (to update definition)
  db.exec("DROP VIEW IF EXISTS cm_cards;");
  // If it was a table, we might want to back it up or drop it. 
  // For now, assuming we replace it with a view as per plan.
  // Check if it's a table first
  const cmCardsType = db.prepare("SELECT type FROM sqlite_master WHERE name = 'cm_cards'").get() as { type: string } | undefined;
  if (cmCardsType && cmCardsType.type === 'table') {
    console.warn("WARNING: cm_cards is a TABLE. Renaming to cm_cards_legacy_backup.");
    db.exec("ALTER TABLE cm_cards RENAME TO cm_cards_legacy_backup;");
  }

  db.exec(`
    CREATE VIEW cm_cards AS
    SELECT
      cc.ppt_card_id as id,
      cc.name,
      cs.name as set_name,
      cc.card_number,
      cc.image_url,
      cs.release_date
    FROM canonical_cards cc
    JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id;
  `);

  // 4. Create Triggers to keep FTS in sync (Optional but good for SSoT)
  console.log("Creating triggers for FTS sync...");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS canonical_cards_ai AFTER INSERT ON canonical_cards BEGIN
      INSERT INTO canonical_cards_fts(rowid, name, set_name, card_number)
      SELECT new.rowid, new.name, cs.name, new.card_number
      FROM canonical_sets cs WHERE cs.tcg_player_id = new.set_tcg_player_id;
    END;
  `);
  // (Add DELETE/UPDATE triggers if needed, skipping for brevity/safety for now)

  console.log("Phase 1 complete.");
}

try {
  runPhase1();
} catch (error) {
  console.error("Error running Phase 1:", error);
  process.exit(1);
}
