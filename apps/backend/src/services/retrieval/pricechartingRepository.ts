import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "csv-parse";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ExtractedFields } from "../../domain/job";
import type { PriceChartingCandidate } from "./candidateScorer";

const DATASET_KEY = "pricecharting_pokemon";
const MIN_RESULTS = 5;

export class CorpusUnavailableError extends Error {
  constructor(message = "PriceCharting corpus not available") {
    super(message);
    this.name = "CorpusUnavailableError";
  }
}

interface PriceChartingRow {
  id: string;
  console_name: string | null;
  product_name: string;
  release_date: string | null;
  release_year: number | null;
  sales_volume: number | null;
  card_number: string | null;
  total_set_size: string | null;
  loose_price: number | null;
  graded_price: number | null;
}

interface DatasetRegistryRow {
  source_mtime: number;
  checksum: string;
}

const resolvePath = (csvPath: string): string => {
  if (path.isAbsolute(csvPath)) return csvPath;
  const primary = path.resolve(process.cwd(), csvPath);
  if (fs.existsSync(primary)) {
    return primary;
  }
  // Fallback: resolve relative to repo root one directory up (when running from apps/backend).
  const fallback = path.resolve(process.cwd(), "..", csvPath);
  return fallback;
};

const parseIntSafe = (value: string | undefined): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePriceSafe = (value: string | undefined): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "") return null;
  // Remove dollar sign and commas, then parse as float
  const cleaned = trimmed.replace(/[$,]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const deriveReleaseYear = (value: string | undefined | null): number | null => {
  if (!value) return null;
  const match = value.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  if (!Number.isFinite(year)) return null;
  return year;
};

const deriveCardDetails = (productName: string): Pick<PriceChartingRow, "card_number" | "total_set_size"> => {
  const fractionMatch = productName.match(/(?<card>[0-9A-Za-z-]+)\s*\/\s*(?<total>[0-9A-Za-z-]+)/);
  if (fractionMatch?.groups) {
    return {
      card_number: fractionMatch.groups.card ?? null,
      total_set_size: fractionMatch.groups.total ?? null,
    };
  }

  const hashMatch = productName.match(/#\s*(?<card>[0-9A-Za-z-]+)/);
  if (hashMatch?.groups) {
    return {
      card_number: hashMatch.groups.card ?? null,
      total_set_size: null,
    };
  }

  return { card_number: null, total_set_size: null };
};

const computeFileChecksum = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const parseCsv = async (filePath: string, logger: Logger): Promise<PriceChartingRow[]> => {
  const rows: PriceChartingRow[] = [];
  const parser = fs
    .createReadStream(filePath)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
      }),
    );

  for await (const record of parser) {
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    const productName =
      typeof record["product-name"] === "string" ? record["product-name"].trim() : "";
    if (!id || !productName) {
      continue;
    }

    const consoleName =
      typeof record["console-name"] === "string" && record["console-name"].trim().length > 0
        ? record["console-name"].trim()
        : null;

    const releaseDate =
      typeof record["release-date"] === "string" && record["release-date"].trim().length > 0
        ? record["release-date"].trim()
        : null;

    const salesVolume = parseIntSafe(record["sales-volume"] ?? undefined);
    const { card_number, total_set_size } = deriveCardDetails(productName);
    const loosePrice = parsePriceSafe(record["loose-price"] ?? undefined);
    const gradedPrice = parsePriceSafe(record["graded-price"] ?? undefined);

    rows.push({
      id,
      console_name: consoleName,
      product_name: productName,
      release_date: releaseDate,
      release_year: deriveReleaseYear(releaseDate),
      sales_volume: salesVolume,
      card_number,
      total_set_size,
      loose_price: loosePrice,
      graded_price: gradedPrice,
    });
  }

  logger.info({ datasetKey: DATASET_KEY, rows: rows.length }, "Parsed PriceCharting CSV");
  return rows;
};

const tokenise = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
};

const buildFtsQuery = (name: string | undefined): string | null => {
  const tokens = tokenise(name);
  if (tokens.length === 0) return null;
  const queryTokens = tokens
    .map((token) => token.replace(/"/g, ""))
    .map((token) => `${token}*`);
  return queryTokens.join(" ");
};

export class PriceChartingRepository {
  private ingestionPromise: Promise<void> | null = null;
  private corpusLoaded = false;

  private getCorpusRowCount(): number {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM pricecharting_cards`).get() as
      | { count: number }
      | undefined;
    return result?.count ?? 0;
  }

  constructor(
    private readonly db: Database.Database,
    private readonly csvPath: string,
    private readonly logger: Logger,
  ) {}

  ensureIngested(): Promise<void> {
    if (this.corpusLoaded) {
      return Promise.resolve();
    }

    if (!this.ingestionPromise) {
      const pending = this.ingestIfNeeded().finally(() => {
        this.ingestionPromise = null;
      });
      this.ingestionPromise = pending;
    }
    return this.ingestionPromise;
  }

  search(extracted: ExtractedFields, limit = 10): PriceChartingCandidate[] {
    if (!this.corpusLoaded) {
      return [];
    }

    const query = buildFtsQuery(extracted.card_name);
    const desiredLimit = Math.max(limit, MIN_RESULTS);
    const bufferLimit = desiredLimit * 5;

    let rows: PriceChartingRow[] = [];

    if (query) {
      rows = this.db
        .prepare(
          `SELECT id, console_name, product_name, release_date, release_year, sales_volume, card_number, total_set_size, loose_price, graded_price
           FROM pricecharting_cards
           WHERE rowid IN (
             SELECT rowid FROM pricecharting_cards_fts WHERE pricecharting_cards_fts MATCH @query
           )
           LIMIT @limit`
        )
        .all({ query, limit: bufferLimit }) as PriceChartingRow[];
    }

    if (rows.length === 0 && extracted.card_name) {
      // Fallback to LIKE search when FTS returns nothing (e.g., dataset missing index entries).
      rows = this.db
        .prepare(
          `SELECT id, console_name, product_name, release_date, release_year, sales_volume, card_number, total_set_size, loose_price, graded_price
           FROM pricecharting_cards
           WHERE LOWER(product_name) LIKE '%' || LOWER(@name) || '%'
           LIMIT @limit`
        )
        .all({ name: extracted.card_name, limit: bufferLimit }) as PriceChartingRow[];
    }

    return rows.slice(0, bufferLimit).map((row) => ({
      id: row.id,
      productName: row.product_name,
      consoleName: row.console_name,
      releaseYear: row.release_year,
      salesVolume: row.sales_volume,
      cardNumber: row.card_number,
      totalSetSize: row.total_set_size,
    }));
  }

  async getManyByIdsOrdered(ids: string[]): Promise<PriceChartingCandidate[]> {
    // Ensure corpus is loaded, warming on cold start
    await this.ensureIngested();

    // After ingestion attempt, check if corpus is available
    if (!this.corpusLoaded) {
      throw new CorpusUnavailableError("Corpus ingestion failed or CSV not found");
    }

    if (ids.length === 0) {
      return [];
    }

    // Strip pricecharting:: prefix if present
    const cleanedIds = ids.map((id) => id.replace(/^pricecharting::/, ""));

    // Filter out fallback IDs
    const pcIds = cleanedIds.filter((id) => !id.startsWith("fallback::"));

    if (pcIds.length === 0) {
      return [];
    }

    const placeholders = pcIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, console_name, product_name, release_date, release_year, sales_volume, card_number, total_set_size, loose_price, graded_price
         FROM pricecharting_cards
         WHERE id IN (${placeholders})`
      )
      .all(...pcIds) as PriceChartingRow[];

    // Create ID-to-candidate map
    const candidateMap = new Map<string, PriceChartingCandidate>();
    for (const row of rows) {
      candidateMap.set(row.id, {
        id: row.id,
        productName: row.product_name,
        consoleName: row.console_name,
        releaseYear: row.release_year,
        salesVolume: row.sales_volume,
        cardNumber: row.card_number,
        totalSetSize: row.total_set_size,
      });
    }

    // Preserve input order
    const orderedResults: PriceChartingCandidate[] = [];
    for (const id of pcIds) {
      const candidate = candidateMap.get(id);
      if (candidate) {
        orderedResults.push(candidate);
      }
    }

    return orderedResults;
  }

  getCorpusHash(): string | null {
    const result = this.db
      .prepare(`SELECT checksum FROM reference_datasets WHERE dataset_key = ?`)
      .get(DATASET_KEY) as { checksum: string } | undefined;
    return result?.checksum ?? null;
  }

  /**
   * Get price from CSV corpus for a given card (CSV fallback pricing).
   * Used when PPT API is unavailable or quota exhausted.
   *
   * @param cardId - PriceCharting card ID from top3 candidates
   * @param condition - Condition bucket (NM, LP, MP, HP, UNKNOWN)
   * @returns Price data with pricing_source='csv' or null if not found
   */
  getPriceFromCSV(
    cardId: string,
    condition: string
  ): { market_price: number; pricing_source: 'csv'; pricing_status: 'fresh' } | null {
    if (!this.corpusLoaded) {
      this.logger.warn({ cardId }, "CSV corpus not loaded; cannot fetch price");
      return null;
    }

    const row = this.db
      .prepare(
        `SELECT loose_price, graded_price
         FROM pricecharting_cards
         WHERE id = ?`
      )
      .get(cardId) as { loose_price: number | null; graded_price: number | null } | undefined;

    if (!row) {
      this.logger.debug({ cardId }, "Card not found in CSV corpus");
      return null;
    }

    // Price selection strategy:
    // - NM/LP: prefer graded_price (represents higher quality), fallback to loose_price
    // - MP/HP/UNKNOWN: use loose_price (raw/played condition)
    let market_price: number | null = null;

    if (condition === "NM" || condition === "LP") {
      market_price = row.graded_price ?? row.loose_price;
    } else {
      market_price = row.loose_price ?? row.graded_price;
    }

    if (!market_price) {
      this.logger.debug({ cardId, condition, row }, "No price available in CSV for this condition");
      return null;
    }

    this.logger.info(
      { cardId, condition, market_price, source: "csv" },
      "Fetched price from CSV corpus"
    );

    return {
      market_price,
      pricing_source: "csv",
      pricing_status: "fresh",
    };
  }

  /**
   * Get sibling variants by family grouping (HT-001).
   * Groups candidates by: normalized base name + console + card number.
   * Optional totalSetSize refinement to prevent cross-set contamination.
   *
   * @param referenceCandidate - The chosen candidate from top3 to use as family anchor
   * @param limit - Maximum number of siblings to return (default 20)
   * @returns Array of sibling candidates, sorted by sales volume descending
   */
  getSiblingsByFamily(
    referenceCandidate: PriceChartingCandidate,
    limit = 20
  ): PriceChartingCandidate[] {
    if (!this.corpusLoaded) {
      return [];
    }

    // Normalize the reference product name to extract base card name
    // Remove variant suffixes and special markers for family grouping
    const normalizeForFamily = (productName: string): string => {
      return productName
        .toLowerCase()
        .replace(/\b(1st|first)\s+edition\b/gi, "")
        .replace(/\bshadowless\b/gi, "")
        .replace(/\breverse\s*(holo|foil)\b/gi, "")
        .replace(/\b(holo|holographic|foil)\b/gi, "")
        .replace(/\bunlimited\s+edition\b/gi, "")
        .replace(/\bunlimited\b/gi, "") // Strip plain "unlimited" for [Unlimited] variants
        .replace(/\bnon[\s-]?holo\b/gi, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };

    const referenceBaseName = normalizeForFamily(referenceCandidate.productName);
    const referenceConsole = referenceCandidate.consoleName?.toLowerCase() ?? null;
    const referenceCardNumber = referenceCandidate.cardNumber?.toLowerCase() ?? null;
    const referenceTotalSetSize = referenceCandidate.totalSetSize?.toLowerCase() ?? null;

    // Build query conditions
    // Family = same base name + same console + same card number
    // Optionally constrain by totalSetSize to prevent cross-set bleed (e.g., Base Set vs Base Set 2)
    const conditions: string[] = [];
    const params: Record<string, any> = { limit };

    // Card number is the strongest anchor - require it to exist
    if (!referenceCardNumber) {
      this.logger.warn(
        { candidateId: referenceCandidate.id },
        "Reference candidate missing card_number; cannot build family query"
      );
      return [];
    }

    conditions.push("card_number = @cardNumber");
    params.cardNumber = referenceCardNumber;

    // Console name constraint (handle null case)
    if (referenceConsole) {
      conditions.push("LOWER(console_name) = @console");
      params.console = referenceConsole;
    } else {
      conditions.push("console_name IS NULL");
    }

    // Total set size constraint (optional - only apply if reference has it)
    // This prevents "Base Set" from mixing with "Base Set 2" when both have #4/102
    if (referenceTotalSetSize) {
      conditions.push("total_set_size = @totalSetSize");
      params.totalSetSize = referenceTotalSetSize;
    }

    const whereClause = conditions.join(" AND ");

    const rows = this.db
      .prepare(
        `SELECT id, console_name, product_name, release_date, release_year, sales_volume, card_number, total_set_size, loose_price, graded_price
         FROM pricecharting_cards
         WHERE ${whereClause}
         ORDER BY sales_volume DESC NULLS LAST
         LIMIT @limit`
      )
      .all(params) as PriceChartingRow[];

    // Post-filter by normalized base name to ensure family consistency
    // This catches cases where card number matches but the Pokemon name differs
    const siblings = rows
      .filter((row) => {
        const candidateBaseName = normalizeForFamily(row.product_name);
        return candidateBaseName === referenceBaseName;
      })
      .map((row) => ({
        id: row.id,
        productName: row.product_name,
        consoleName: row.console_name,
        releaseYear: row.release_year,
        salesVolume: row.sales_volume,
        cardNumber: row.card_number,
        totalSetSize: row.total_set_size,
      }));

    this.logger.info(
      {
        referenceId: referenceCandidate.id,
        referenceBaseName,
        referenceCardNumber,
        siblingsFound: siblings.length,
      },
      "Family variant query completed"
    );

    return siblings;
  }

  private async ingestIfNeeded(): Promise<void> {
    const absoluteCsvPath = resolvePath(this.csvPath);
    this.logger.info({ csvPath: this.csvPath, absoluteCsvPath }, "DEBUG: Starting ingestIfNeeded");
    if (!fs.existsSync(absoluteCsvPath)) {
      this.logger.warn({ datasetKey: DATASET_KEY, path: absoluteCsvPath }, "PriceCharting CSV not found; retrieval will fallback to heuristics");
      this.corpusLoaded = false;
      return;
    }

    const stats = fs.statSync(absoluteCsvPath);
    const sourceMtime = Math.floor(stats.mtimeMs);
    const existing = this.db
      .prepare(
        `SELECT source_mtime, checksum FROM reference_datasets WHERE dataset_key = ?`
      )
      .get(DATASET_KEY) as DatasetRegistryRow | undefined;

    this.logger.info({ existing, sourceMtime }, "DEBUG: Checking existing record");

    const checksum = await computeFileChecksum(absoluteCsvPath);
    this.logger.info({ checksum, existingChecksum: existing?.checksum }, "DEBUG: Checksum comparison");

    if (existing && existing.source_mtime === sourceMtime && existing.checksum === checksum) {
      const rowCount = this.getCorpusRowCount();
      if (rowCount > 0) {
        this.logger.info({ datasetKey: DATASET_KEY, rowCount }, "PriceCharting corpus already ingested");
        this.corpusLoaded = true;
        return;
      }

      this.logger.warn(
        { datasetKey: DATASET_KEY, rowCount },
        "Reference metadata present but corpus table empty; forcing reingestion",
      );
    }

    this.logger.info({ datasetKey: DATASET_KEY }, "DEBUG: Starting fresh ingestion");

    const rows = await parseCsv(absoluteCsvPath, this.logger);

    const insertStmt = this.db.prepare(
      `INSERT INTO pricecharting_cards (
         id, console_name, product_name, release_date, release_year, sales_volume, card_number, total_set_size, loose_price, graded_price
       ) VALUES (@id, @console_name, @product_name, @release_date, @release_year, @sales_volume, @card_number, @total_set_size, @loose_price, @graded_price)
       ON CONFLICT(id) DO UPDATE SET
         console_name = excluded.console_name,
         product_name = excluded.product_name,
         release_date = excluded.release_date,
         release_year = excluded.release_year,
         sales_volume = excluded.sales_volume,
         card_number = excluded.card_number,
         total_set_size = excluded.total_set_size,
         loose_price = excluded.loose_price,
         graded_price = excluded.graded_price`
    );

    const registryStmt = this.db.prepare(
      `INSERT INTO reference_datasets (dataset_key, source_path, source_mtime, row_count, checksum, ingested_at)
       VALUES (@dataset_key, @source_path, @source_mtime, @row_count, @checksum, @ingested_at)
       ON CONFLICT(dataset_key) DO UPDATE SET
         source_path = excluded.source_path,
         source_mtime = excluded.source_mtime,
         row_count = excluded.row_count,
         checksum = excluded.checksum,
         ingested_at = excluded.ingested_at`
    );

    const ingestTransaction = this.db.transaction((records: PriceChartingRow[]) => {
      this.db.exec("DELETE FROM pricecharting_cards");
      for (const record of records) {
        insertStmt.run(record);
      }
      registryStmt.run({
        dataset_key: DATASET_KEY,
        source_path: absoluteCsvPath,
        source_mtime: sourceMtime,
        row_count: records.length,
        checksum,
        ingested_at: Date.now(),
      });
    });

    ingestTransaction(rows);
    const rowCount = this.getCorpusRowCount();
    this.logger.info({ datasetKey: DATASET_KEY, rows: rows.length, rowCount }, "PriceCharting corpus ingested into SQLite");
    this.corpusLoaded = rowCount > 0;
    if (!this.corpusLoaded) {
      this.logger.error(
        { datasetKey: DATASET_KEY },
        "Ingestion completed but no records persisted; will require manual follow-up",
      );
    }
  }
}

export function productUrl(id: string): string {
  return `https://www.pricecharting.com/offers?s=${encodeURIComponent(id)}`;
}

export function guessVariantSuffix(name: string): string {
  const match = name.match(/\s+(v|ex|gx|vmax|vstar)\b/i);
  return match ? match[1].toUpperCase() : "";
}

export function guessRarity(name: string): string | null {
  const lower = name.toLowerCase();
  if (/\b(full art|alt art|alternate art)\b/i.test(name)) return "Full/Alt Art";
  if (lower.includes("rainbow")) return "Rainbow";
  if (lower.includes("reverse")) return "Reverse Holo";
  if (lower.includes("holo")) return "Holo";
  return null;
}
