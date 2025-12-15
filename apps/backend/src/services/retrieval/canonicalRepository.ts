import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { ExtractedFields } from "../../domain/job";
import type { PriceChartingCandidate } from "./candidateScorer";

const normalizeSetName = (value?: string | null): string | null => {
  if (!value) return null;
  return value.trim().toLowerCase();
};

const normalizeCardNumber = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const primary = trimmed.split("/")[0];
  if (/^[0-9]+$/.test(primary)) {
    return String(Number.parseInt(primary, 10));
  }
  return primary.toLowerCase();
};

export class CanonicalRepository {
  constructor(private readonly db: Database.Database, private readonly logger: Logger) { }

  private hasTables(): boolean {
    const sets = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_sets'`)
      .get() as { name: string } | undefined;
    const cards = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_cards'`)
      .get() as { name: string } | undefined;
    return Boolean(sets && cards);
  }

  search(extracted: ExtractedFields, limit: number): PriceChartingCandidate[] {
    if (!this.hasTables()) {
      this.logger.warn("canonicalRepository: canonical tables missing, skipping canonical search");
      return [];
    }

    const constraints: string[] = [];
    const params: unknown[] = [];

    const setName = normalizeSetName(extracted.set_name);
    const cardNumber = normalizeCardNumber(extracted.set_number);
    const nameLike =
      extracted.card_name && extracted.card_name.trim().length > 0
        ? `%${extracted.card_name.trim().toLowerCase()}%`
        : null;

    // canonical_cards.card_number is frequently stored as "080/111" (with leading zeros + "/total").
    // extracted.set_number is normalized to "80".
    // Normalize the DB numerator by: take numerator, trim, strip leading zeros, then lower-case.
    const normalizedDbCardNumerator =
      "LOWER(COALESCE(NULLIF(LTRIM(TRIM(CASE WHEN INSTR(cc.card_number, '/') > 0 THEN SUBSTR(cc.card_number, 1, INSTR(cc.card_number, '/') - 1) ELSE cc.card_number END), '0'), ''), '0'))";

    if (setName) {
      constraints.push("LOWER(cs.name) = ?");
      params.push(setName);
    }

    if (cardNumber) {
      constraints.push(`${normalizedDbCardNumerator} = ?`);
      params.push(cardNumber);
    }

    if (nameLike) {
      constraints.push("LOWER(cc.name) LIKE ?");
      params.push(nameLike);
    }

    const whereClause = constraints.length > 0 ? `WHERE ${constraints.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT
           cc.ppt_card_id,
           cc.card_number,
           cc.total_set_number,
           cc.name as card_name,
           cs.name as set_name,
           cs.release_date
         FROM canonical_cards_fts fts
         JOIN canonical_cards cc ON cc.rowid = fts.rowid
         JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
         ${whereClause}
         ORDER BY cs.release_date DESC, cc.name ASC
         LIMIT ?`
      )
      .all(...params, limit) as Array<{
        ppt_card_id: string;
        card_number: string | null;
        total_set_number: string | null;
        card_name: string;
        set_name: string;
        release_date: string | null;
      }>;

    return rows.map((row) => {
      const releaseYear = row.release_date ? Number.parseInt(row.release_date.substring(0, 4), 10) : null;
      const productNameParts = [row.set_name, row.card_name].filter(Boolean);
      if (row.card_number) {
        productNameParts.push(`#${row.card_number}`);
      }
      const productName = productNameParts.join(" ");
      return {
        id: row.ppt_card_id,
        productName,
        consoleName: row.set_name,
        releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
        salesVolume: null,
        cardNumber: normalizeCardNumber(row.card_number),
        totalSetSize: normalizeCardNumber(row.total_set_number),
      };
    });
  }

  getManyByIdsOrdered(ids: string[]): PriceChartingCandidate[] {
    if (!this.hasTables() || ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT
           cc.ppt_card_id,
           cc.card_number,
           cc.total_set_number,
           cc.name as card_name,
           cs.name as set_name,
           cs.release_date
         FROM canonical_cards cc
         JOIN canonical_sets cs ON cs.tcg_player_id = cc.set_tcg_player_id
         WHERE cc.ppt_card_id IN (${placeholders})`
      )
      .all(...ids) as Array<{
        ppt_card_id: string;
        card_number: string | null;
        total_set_number: string | null;
        card_name: string;
        set_name: string;
        release_date: string | null;
      }>;

    const byId = new Map(
      rows.map((row) => {
        const releaseYear = row.release_date ? Number.parseInt(row.release_date.substring(0, 4), 10) : null;
        const productNameParts = [row.set_name, row.card_name].filter(Boolean);
        if (row.card_number) {
          productNameParts.push(`#${row.card_number}`);
        }
        const productName = productNameParts.join(" ");
        const candidate: PriceChartingCandidate = {
          id: row.ppt_card_id,
          productName,
          consoleName: row.set_name,
          releaseYear: Number.isFinite(releaseYear) ? releaseYear : null,
          salesVolume: null,
          cardNumber: normalizeCardNumber(row.card_number),
          totalSetSize: normalizeCardNumber(row.total_set_number),
        };
        return [row.ppt_card_id, candidate];
      })
    );

    return ids.map((id) => byId.get(id)).filter((c): c is PriceChartingCandidate => c !== undefined);
  }
}
