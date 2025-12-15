import { Database } from "better-sqlite3";
import { openDatabase } from "../db/connection";

const db: Database = openDatabase();

console.log("Running migration: add_master_image_columns");

try {
    // Add master columns to scans table
    db.exec(`
    ALTER TABLE scans ADD COLUMN master_image_path TEXT;
    ALTER TABLE scans ADD COLUMN master_cdn_url TEXT;
  `);
    console.log("Added columns to scans table");
} catch (error: any) {
    if (error.message.includes("duplicate column name")) {
        console.log("Columns already exist in scans table");
    } else {
        console.error("Failed to alter scans table:", error);
    }
}

try {
    // Add master columns to products table (denormalized)
    db.exec(`
    ALTER TABLE products ADD COLUMN master_cdn_url TEXT;
    ALTER TABLE products ADD COLUMN master_back_cdn_url TEXT;
  `);
    console.log("Added columns to products table");
} catch (error: any) {
    if (error.message.includes("duplicate column name")) {
        console.log("Columns already exist in products table");
    } else {
        console.error("Failed to alter products table:", error);
    }
}

console.log("Migration complete");
