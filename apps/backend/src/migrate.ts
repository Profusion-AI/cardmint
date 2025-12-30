import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDatabase } from "./db/connection";

const MIGRATIONS_TABLE = "schema_migrations";

const ensureMigrationsTable = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
};

const migrationIdFromFile = (fileName: string): string => {
  const ext = path.extname(fileName);
  return fileName.replace(ext, "");
};

const loadSql = (fullPath: string): string => fs.readFileSync(fullPath, "utf8");

const computeChecksum = (contents: string): string =>
  createHash("sha256").update(contents).digest("hex");

const isApplied = (db: Database.Database, id: string): { checksum: string } | undefined => {
  const row = db
    .prepare(`SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE id = ?`)
    .get(id) as { checksum: string } | undefined;
  return row;
};

const markApplied = (db: Database.Database, id: string, checksum: string) => {
  db
    .prepare(
      `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, applied_at)
       VALUES (@id, @checksum, @applied_at)
       ON CONFLICT(id) DO UPDATE SET checksum = excluded.checksum, applied_at = excluded.applied_at`
    )
    .run({ id, checksum, applied_at: Date.now() });
};

const shouldTreatAsAlreadyApplied = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    message.includes("duplicate column name") ||
    message.includes("already exists")
  );
};

const applyMigration = (
  db: Database.Database,
  id: string,
  sql: string,
  checksum: string,
) => {
  const trimmed = sql.trim();
  if (!trimmed) {
    markApplied(db, id, checksum);
    return;
  }
  db.exec(trimmed);
  markApplied(db, id, checksum);
};

const markSkipped = (db: Database.Database, id: string, checksum: string) => {
  db
    .prepare(
      `INSERT INTO ${MIGRATIONS_TABLE} (id, checksum, applied_at)
       VALUES (@id, @checksum, @applied_at)
       ON CONFLICT(id) DO UPDATE SET checksum = excluded.checksum, applied_at = excluded.applied_at`
    )
    .run({ id, checksum, applied_at: Date.now() });
};

const runMigrations = () => {
  const db = openDatabase();
  ensureMigrationsTable(db);

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(currentDir, "db/migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => !file.endsWith("_down.sql") && !file.endsWith(".down.sql"))
    .sort();

  for (const file of files) {
    const id = migrationIdFromFile(file);
    const fullPath = path.join(migrationsDir, file);
    const sql = loadSql(fullPath);
    const checksum = computeChecksum(sql);

    const existing = isApplied(db, id);
    if (existing) {
      if (existing.checksum !== checksum) {
        console.warn(
          `[migrate] checksum mismatch for ${id}. existing=${existing.checksum} new=${checksum}`,
        );
      }
      continue;
    }

    try {
      applyMigration(db, id, sql, checksum);
      console.log(`[migrate] applied ${id}`);
    } catch (error) {
      if (shouldTreatAsAlreadyApplied(error)) {
        console.warn(`[migrate] skipping ${id}: ${String((error as Error).message ?? error)}`);
        markSkipped(db, id, checksum);
        continue;
      }
      throw error;
    }
  }

  db.close();
};

runMigrations();

console.log("Migrations applied.");
