#!/usr/bin/env tsx
/**
 * SQLite Migration Runner (Phase 3.1)
 *
 * Usage:
 *   tsx scripts/migrate.ts status
 *   tsx scripts/migrate.ts migrate [--dry-run]
 *   tsx scripts/migrate.ts validate
 *
 * Defaults to DB at ./data/cardmint.db. Set DB_PATH to override.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'cardmint.db');
const MIGRATIONS: string[] = [
  path.join(process.cwd(), 'src', 'storage', 'migrations', '006_inventory_layer.sql')
];

function backupDatabase(dbPath: string): string {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath, path.extname(dbPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${base}.${stamp}.bak.db`);

  fs.copyFileSync(dbPath, backupPath);

  // Best effort WAL checkpoint (if exists)
  const wal = `${dbPath}-wal`;
  if (fs.existsSync(wal)) {
    try { fs.copyFileSync(wal, `${backupPath}-wal`); } catch {}
  }
  return backupPath;
}

function readSQL(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
}

function execMigration(db: Database.Database, sqlStatements: string[], dryRun = false) {
  if (dryRun) {
    console.log(`-- Dry run: ${sqlStatements.length} statements`);
    sqlStatements.forEach((s, i) => {
      console.log(`-- [${i + 1}] ${s.slice(0, 200)}${s.length > 200 ? '…' : ''}`);
    });
    return;
  }

  const tx = db.transaction(() => {
    for (const s of sqlStatements) {
      try {
        db.prepare(s).run();
      } catch (e) {
        // Allow idempotent re-runs; surface only critical errors
        console.warn(`Skipped/failed: ${s.slice(0, 120)}… -> ${String(e)}`);
      }
    }
  });
  tx();
}

function showStatus(db: Database.Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const views  = db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all();
  console.log('Tables:', tables.map((t: any) => t.name).join(', '));
  console.log('Views: ', views.map((v: any) => v.name).join(', '));
}

function validate(db: Database.Database) {
  const requiredTables = [
    'condition_scale', 'vendor_condition_map', 'inventory_items', 'market_price_samples'
  ];
  const requiredViews = ['prints', 'latest_market_prices'];

  const tableSet = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
  );
  const viewSet = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((r: any) => r.name)
  );

  const missingTables = requiredTables.filter(t => !tableSet.has(t));
  const missingViews  = requiredViews.filter(v => !viewSet.has(v));
  if (missingTables.length || missingViews.length) {
    console.error('Validation failed: missing artifacts');
    if (missingTables.length) console.error('  Tables:', missingTables.join(', '));
    if (missingViews.length)  console.error('  Views: ', missingViews.join(', '));
    process.exit(2);
  }

  // Basic integrity checks
  const pragmaFK = db.prepare('PRAGMA foreign_keys').get();
  console.log('PRAGMA foreign_keys =', pragmaFK?.foreign_keys);

  // Sample queries
  const csCount = db.prepare('SELECT COUNT(*) as c FROM condition_scale').get() as any;
  console.log('condition_scale rows:', csCount.c);
  console.log('Validation OK');
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run the app once or create './data/cardmint.db'.`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    if (cmd === 'status') {
      showStatus(db);
      process.exit(0);
    }

    if (cmd === 'migrate') {
      const backup = backupDatabase(DB_PATH);
      console.log('Backup created:', backup);
      for (const file of MIGRATIONS) {
        if (!fs.existsSync(file)) {
          console.warn('Migration file missing:', file);
          continue;
        }
        const stmts = readSQL(file);
        console.log(`Applying migration: ${path.basename(file)} (${stmts.length} statements)`);
        execMigration(db, stmts, dryRun);
      }
      console.log('Migrations applied');
      if (!dryRun) validate(db);
      process.exit(0);
    }

    if (cmd === 'validate') {
      validate(db);
      process.exit(0);
    }

    console.error('Unknown command. Use: status | migrate [--dry-run] | validate');
    process.exit(1);
  } catch (e) {
    console.error('Migration runner failed:', e);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();

