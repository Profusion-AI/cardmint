/**
 * Wrapper to run reconciliation CSV exporter from backend context
 */
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const dbPath = process.env.SQLITE_DB || join(process.cwd(), "cardmint_dev.db");
const outDir = join(process.cwd(), "../../exports");
const timestamp = new Date();
const pad = (n: number) => n.toString().padStart(2, "0");
const fileName = `reconciliation-${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}-${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}.csv`;

mkdirSync(outDir, { recursive: true });

const db = new Database(dbPath);

const rows = db
  .prepare(
    `
    SELECT
      s.id as scan_id,
      s.status,
      s.canonical_locked,
      s.reconciliation_status,
      s.accepted_name AS card_name,
      s.accepted_collector_no AS collector_no,
      s.accepted_set_name AS set_name,
      s.accepted_hp AS hp_value,
      s.product_sku,
      s.listing_sku,
      s.cm_card_id,
      s.capture_uid,
      s.updated_at,
      p.condition_bucket
    FROM scans s
    LEFT JOIN items i ON s.item_uid = i.item_uid
    LEFT JOIN products p ON i.product_uid = p.product_uid
    WHERE
      s.canonical_locked = 1
      AND (s.cm_card_id IS NULL OR s.cm_card_id LIKE 'UNKNOWN_%')
      AND (s.reconciliation_status IS NULL OR s.reconciliation_status = 'pending')
    ORDER BY s.updated_at DESC
    `
  )
  .all();

const header = [
  "scan_id",
  "status",
  "canonical_locked",
  "reconciliation_status",
  "card_name",
  "collector_no",
  "set_name",
  "hp_value",
  "condition_bucket",
  "cm_card_id",
  "product_sku",
  "listing_sku",
  "capture_uid",
  "updated_at",
];

const toCsv = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const lines = [header.join(",")];
for (const row of rows) {
  lines.push(header.map((h) => toCsv((row as any)[h])).join(","));
}

const outPath = join(outDir, fileName);
writeFileSync(outPath, lines.join("\n"), "utf8");

console.log(`Exported ${rows.length} rows to ${outPath}`);
