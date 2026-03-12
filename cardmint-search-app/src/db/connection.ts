import Database from "better-sqlite3";
import { normalizeCollectorNo } from "../normalize/collectorNo.js";

export interface DbPool {
  inventory: Database.Database | null;
  reference: Database.Database | null;
}

function registerUdf(db: Database.Database): void {
  db.function("normalize_cno", {
    deterministic: true,
    varargs: false,
  }, (raw: unknown) => {
    if (raw == null) return null;
    return normalizeCollectorNo(String(raw));
  });
}

export function openDbPool(
  inventoryPath: string | null,
  referencePath: string | null,
): DbPool {
  let inventory: Database.Database | null = null;
  let reference: Database.Database | null = null;

  if (inventoryPath) {
    try {
      inventory = new Database(inventoryPath, { readonly: true });
      inventory.pragma("journal_mode = WAL");
      registerUdf(inventory);
    } catch (err) {
      console.warn("[cardmint-search-app] inventory DB failed to open:", err);
      inventory = null;
    }
  }

  if (referencePath) {
    try {
      reference = new Database(referencePath, { readonly: true });
      reference.pragma("journal_mode = WAL");
      registerUdf(reference);
    } catch (err) {
      console.warn("[cardmint-search-app] reference DB failed to open:", err);
      reference = null;
    }
  }

  return { inventory, reference };
}

export function closeDbPool(pool: DbPool): void {
  pool.inventory?.close();
  pool.reference?.close();
}

export function getDbStatus(pool: DbPool): {
  inventory: { connected: boolean; productCount?: number };
  reference: { connected: boolean; corpusCount?: number };
} {
  let productCount: number | undefined;
  let corpusCount: number | undefined;

  if (pool.inventory) {
    try {
      const row = pool.inventory.prepare(
        "SELECT COUNT(*) as cnt FROM products WHERE total_quantity > 0"
      ).get() as { cnt: number } | undefined;
      productCount = row?.cnt;
    } catch {
      // table might not exist
    }
  }

  let referenceConnected = pool.reference !== null;
  if (pool.reference) {
    try {
      // Phase 1: count rows in latest complete snapshot.
      // corpusCount = 0 is valid (no snapshot uploaded yet), not an error.
      const row = pool.reference.prepare(
        `SELECT COUNT(*) AS cnt FROM tcg_rows
         WHERE snapshot_id = (SELECT MAX(id) FROM tcg_snapshots WHERE status = 'complete')`
      ).get() as { cnt: number } | undefined;
      corpusCount = row?.cnt ?? 0;
    } catch {
      // tcg_rows / tcg_snapshots absent — wrong DB file or schema not yet applied.
      // Degrade to connected=false so the UI shows the amber "corpus not loaded" warning.
      referenceConnected = false;
    }
  }

  return {
    inventory: { connected: pool.inventory !== null, productCount },
    reference: { connected: referenceConnected, corpusCount },
  };
}
