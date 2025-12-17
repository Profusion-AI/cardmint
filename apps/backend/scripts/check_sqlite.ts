
import Database from "better-sqlite3";
import path from "path";

const dbPath = path.resolve(process.cwd(), "apps/backend/data/cardmint.db");
const db = new Database(dbPath);

const rows = db.prepare("SELECT card_name, evershop_sync_state, product_uid FROM products WHERE evershop_sync_state = 'evershop_live'").all();

console.log(`Found ${rows.length} products with evershop_sync_state='evershop_live':`);
rows.forEach((row: any) => {
    console.log(`- ${row.card_name} (${row.product_uid})`);
});
