// src/lib/db/migrateToWal.ts

export type WalResult = {
  alreadyWal: boolean;
  changed: boolean;
  before: string;
  after: string;
};

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ensure a SQLite DB is in WAL mode.
 * - Idempotent: only changes mode if not already WAL
 * - Safe defaults for dev & hot-reload flows
 * - Works with better-sqlite3 (preferred) or sqlite (fallback)
 */
export async function migrateToWal(dbPath: string, options?: { busyTimeoutMs?: number; retryMs?: number }): Promise<WalResult> {
  const busyTimeoutMs = options?.busyTimeoutMs ?? 5000;
  const retryMs = options?.retryMs ?? 300;

  // Try better-sqlite3 first (sync, stable under hot reload)
  try {
    // @ts-ignore – optional dep
    const Database = (await import('better-sqlite3')).default as any;
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      const before = db.pragma('journal_mode', { simple: true }) as string;
      if (before.toUpperCase() === 'WAL') {
        return { alreadyWal: true, changed: false, before, after: 'WAL' };
      }

      let after = '';
      try {
        // Switch to WAL and set dev-friendly sync for WAL
        after = db.pragma('journal_mode = WAL', { simple: true }) as string;
        db.pragma('synchronous = NORMAL');
      } catch (err: any) {
        if (BUSY_CODES.has(err?.code)) {
          await sleep(retryMs);
          after = db.pragma('journal_mode = WAL', { simple: true }) as string;
          db.pragma('synchronous = NORMAL');
        } else {
          throw err;
        }
      }
      return { alreadyWal: false, changed: true, before, after };
    } finally {
      db.close();
    }
  } catch (e) {
    // Fall back to async 'sqlite' (or 'sqlite3' style API behind the scenes)
    // This path is slower; prefer better-sqlite3 in package.json when possible.
    try {
      // @ts-ignore – optional dep
      const sqlite = await import('sqlite');
      // @ts-ignore – optional dep
      const sqlite3 = await import('sqlite3');
      const db = await sqlite.open({ filename: dbPath, driver: sqlite3.Database });

      try {
        await db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        const beforeRow: any = await db.get(`PRAGMA journal_mode`);
        const before = String(beforeRow?.journal_mode ?? '').toUpperCase();
        if (before === 'WAL') {
          await db.close();
          return { alreadyWal: true, changed: false, before, after: 'WAL' };
        }

        let after = '';
        try {
          const row: any = await db.get(`PRAGMA journal_mode = WAL`);
          after = String(row?.journal_mode ?? '').toUpperCase();
          await db.run(`PRAGMA synchronous = NORMAL`);
        } catch (err: any) {
          if (BUSY_CODES.has(err?.code)) {
            await sleep(retryMs);
            const row: any = await db.get(`PRAGMA journal_mode = WAL`);
            after = String(row?.journal_mode ?? '').toUpperCase();
            await db.run(`PRAGMA synchronous = NORMAL`);
          } else {
            throw err;
          }
        }
        await db.close();
        return { alreadyWal: false, changed: true, before, after };
      } catch (inner) {
        await db.close();
        throw inner;
      }
    } catch (fallbackErr) {
      // If both imports fail, surface a clear error so we know to add better-sqlite3
      throw new Error(
        `migrateToWal: could not load 'better-sqlite3' or 'sqlite' packages. ` +
          `Install one of them (prefer better-sqlite3) to enable WAL migration. Original: ${String(fallbackErr)}`
      );
    }
  }
}

/** Convenience wrapper that logs but never throws (good for startup). */
export async function migrateToWalOrLog(dbPath: string) {
  try {
    const r = await migrateToWal(dbPath);
    if (r.changed) {
      console.log(`[DB] journal_mode: ${r.before} → ${r.after} (WAL enabled)`);
    } else {
      console.log(`[DB] journal_mode already ${r.after}`);
    }
    return r;
  } catch (err) {
    console.warn(`[DB] WAL migration skipped: ${String(err)}`);
    return null;
  }
}
