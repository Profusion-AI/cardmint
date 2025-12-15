import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runtimeConfig } from "../config";

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export const openDatabase = () => {
  const absolutePath = path.resolve(process.cwd(), runtimeConfig.sqlitePath);
  ensureDir(absolutePath);
  const db = new Database(absolutePath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // Enable foreign key constraints (enforces cm_card_id references in products/scans)
  db.pragma("foreign_keys = ON");

  return db;
};
