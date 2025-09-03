/**
 * DeterministicResolver: Lightning-fast exact matching engine
 * 
 * Performance targets:
 * - Exact matches: <1ms (index lookups)
 * - Prepared statements: compiled once, reused thousands of times
 * - Composite covering indexes: triplet queries never touch main table
 * - Evidence generation: explainable confidence routing
 */

import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger';

const log = createLogger('deterministic-resolver');

export interface Card {
  id: string;
  name: string;
  set_name: string;
  card_number: string;
  normalized_name: string;
  normalized_set: string;
  normalized_number: string;
}

export type Verdict = 'CERTAIN' | 'LIKELY' | 'MULTIPLE' | 'UNCERTAIN';

export interface ResolutionResult {
  verdict: Verdict;
  chosen_card?: Card;
  confidence: number;
  evidence: string[];
  alternatives?: Card[];
}

export interface QueryInput {
  name?: string;
  set?: string;
  number?: string;
  raw?: string;
}

export class DeterministicResolver {
  private db: Database.Database;

  // Prepared statements - compiled once, blazing fast reuse
  private stmtByTriplet: Database.Statement<[string, string, string]>;
  private stmtByNameSet: Database.Statement<[string, string]>;
  private stmtByNameNumber: Database.Statement<[string, string]>;
  private stmtByNameUnique: Database.Statement<[string]>;
  private stmtAliasCard: Database.Statement<[string]>;
  private stmtAliasName: Database.Statement<[string]>;
  private stmtGetById: Database.Statement<[string]>;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000'); // Better concurrency handling

    // Compile prepared statements once for maximum performance
    this.stmtByTriplet = this.db.prepare(`
      SELECT id, name, set_name, card_number, normalized_name, normalized_set, normalized_number
      FROM cards
      WHERE normalized_name = ? AND normalized_set = ? AND normalized_number = ?
      LIMIT 2
    `);

    this.stmtByNameSet = this.db.prepare(`
      SELECT id, name, set_name, card_number, normalized_name, normalized_set, normalized_number
      FROM cards
      WHERE normalized_name = ? AND normalized_set = ?
      LIMIT 2
    `);

    this.stmtByNameNumber = this.db.prepare(`
      SELECT id, name, set_name, card_number, normalized_name, normalized_set, normalized_number
      FROM cards
      WHERE normalized_name = ? AND normalized_number = ?
      LIMIT 2
    `);

    this.stmtByNameUnique = this.db.prepare(`
      SELECT id, name, set_name, card_number, normalized_name, normalized_set, normalized_number
      FROM cards
      WHERE normalized_name = ?
      LIMIT 2
    `);

    this.stmtAliasCard = this.db.prepare(`
      SELECT canonical_id FROM card_aliases
      WHERE alias = ? AND alias_type = 'card'
    `);

    this.stmtAliasName = this.db.prepare(`
      SELECT canonical_id FROM card_aliases
      WHERE alias = ? AND alias_type = 'name'
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT id, name, set_name, card_number, normalized_name, normalized_set, normalized_number
      FROM cards WHERE id = ?
    `);

    log.info('🏗️ DeterministicResolver initialized with prepared statements');
  }

  /**
   * Normalize input exactly matching migration logic
   * CRITICAL: Must match the normalization used in safe-qa-migration.ts
   */
  private normalize = (s: any): string => {
    if (s == null) return '';
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' '); // Collapse multiple spaces
  };

  /**
   * Normalize card number with Pokemon TCG conventions
   * "25/102" → "25", "025" → "25"
   */
  private normalizeCardNumber = (s: any): string => {
    const base = this.normalize(s);
    if (!base) return '';
    
    const left = base.split('/')[0]; // Take left side if fraction-like
    return left.replace(/^0+/, '') || '0'; // Strip leading zeros, but keep single "0"
  };

  /**
   * Parse raw OCR query into structured components
   * Pokemon TCG specific heuristics for name/set/number extraction
   */
  private parseQuery(rawQuery: string): { name: string; set: string; number: string } {
    const raw = String(rawQuery).trim();
    if (!raw) return { name: '', set: '', number: '' };

    // Known Pokemon TCG set patterns (common abbreviations and full names)
    const knownSets = [
      'base set', 'base', 'jungle', 'fossil', 'team rocket', 'gym heroes', 'gym challenge',
      'neo genesis', 'neo discovery', 'neo destiny', 'neo revelation',
      'wizards black star promos', 'promo', 'promos',
      'base set 2', 'legendary collection'
    ];

    // Split on common delimiters but preserve structure
    const tokens = raw.split(/[\s\-_,:]+/).filter(Boolean);
    
    // Find card number (rightmost token with digit, could be "25/102" or "25")
    let numberLike = '';
    let numberIndex = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (/\d/.test(tokens[i])) {
        numberLike = tokens[i];
        numberIndex = i;
        break;
      }
    }
    const number = this.normalizeCardNumber(numberLike);

    // Remove number token for cleaner set/name parsing
    const remainingTokens = numberIndex >= 0 
      ? [...tokens.slice(0, numberIndex), ...tokens.slice(numberIndex + 1)]
      : tokens;

    // Set detection: look for known set patterns
    let set = '';
    let setTokens: string[] = [];
    const lowerTokens = remainingTokens.map(t => t.toLowerCase());
    
    for (const knownSet of knownSets) {
      const setWords = knownSet.split(' ');
      const setPattern = setWords.join('.*'); // Allow gaps between words
      const regex = new RegExp(setPattern, 'i');
      
      if (regex.test(lowerTokens.join(' '))) {
        set = knownSet;
        // Mark tokens that are part of the set name
        setTokens = remainingTokens.filter(token => 
          setWords.some(setWord => token.toLowerCase().includes(setWord.toLowerCase()))
        );
        break;
      }
    }

    // Name extraction: remaining tokens after removing set tokens
    const nameTokens = remainingTokens.filter(token => 
      !setTokens.some(setToken => setToken.toLowerCase() === token.toLowerCase())
    );
    
    const name = this.normalize(nameTokens.join(' '));
    
    return { 
      name, 
      set: this.normalize(set), 
      number 
    };
  }

  /**
   * Evidence helper for clean logging
   */
  private e = (s: string): string => s;

  /**
   * Core exact matching engine with surgical prepared statement routing
   * Conservative approach: any ambiguity (2+ matches) → MULTIPLE verdict
   */
  public exactMatch(query: QueryInput): ResolutionResult {
    const startTime = process.hrtime.bigint();
    
    const name = this.normalize(query.name ?? '');
    const set = this.normalize(query.set ?? '');
    const number = this.normalizeCardNumber(query.number ?? '');

    try {
      // 0) Card-level alias: direct jump to canonical card
      if (query.raw) {
        const aliasCard = this.stmtAliasCard.get(this.normalize(query.raw)) as { canonical_id: string } | undefined;
        if (aliasCard?.canonical_id) {
          const card = this.stmtGetById.get(aliasCard.canonical_id) as Card | undefined;
          if (card) {
            this.logTiming('alias-card', startTime);
            return {
              verdict: 'CERTAIN',
              chosen_card: card,
              confidence: 1.0,
              evidence: [this.e(`Alias match → card_id=${card.id}`)]
            };
          }
        }
      }

      // 1) Exact triplet: name + set + number (highest confidence)
      if (name && set && number) {
        const rows = this.stmtByTriplet.all(name, set, number) as Card[];
        if (rows.length === 1) {
          this.logTiming('triplet-unique', startTime);
          return {
            verdict: 'CERTAIN',
            chosen_card: rows[0],
            confidence: 1.0,
            evidence: [this.e(`Exact triplet match: "${name}" | "${set}" | "${number}"`)]
          };
        }
        if (rows.length > 1) {
          this.logTiming('triplet-collision', startTime);
          return {
            verdict: 'MULTIPLE',
            confidence: 0.7,
            alternatives: rows,
            evidence: [this.e('Multiple exact triplet matches (data collision)')]
          };
        }
      }

      // 2) Name alias → canonical name lookup
      if (name) {
        const aliasName = this.stmtAliasName.get(name) as { canonical_id: string } | undefined;
        if (aliasName?.canonical_id) {
          const card = this.stmtGetById.get(aliasName.canonical_id) as Card | undefined;
          if (card) {
            this.logTiming('alias-name', startTime);
            return {
              verdict: 'CERTAIN',
              chosen_card: card,
              confidence: 0.98,
              evidence: [this.e(`Alias match on name "${name}" → card_id=${card.id}`)]
            };
          }
        }
      }

      // 3) Name + Set (high confidence for TCG context)
      if (name && set) {
        const rows = this.stmtByNameSet.all(name, set) as Card[];
        if (rows.length === 1) {
          this.logTiming('name-set-unique', startTime);
          return {
            verdict: 'LIKELY',
            chosen_card: rows[0],
            confidence: 0.98,
            evidence: [this.e(`Exact match on normalized_name+set: "${name}" | "${set}"`)]
          };
        }
        if (rows.length > 1) {
          this.logTiming('name-set-collision', startTime);
          return {
            verdict: 'MULTIPLE',
            confidence: 0.75,
            alternatives: rows,
            evidence: [this.e('Multiple matches for name+set')]
          };
        }
      }

      // 4) Name + Number (common in TCG collections)
      if (name && number) {
        const rows = this.stmtByNameNumber.all(name, number) as Card[];
        if (rows.length === 1) {
          this.logTiming('name-number-unique', startTime);
          return {
            verdict: 'LIKELY',
            chosen_card: rows[0],
            confidence: 0.96,
            evidence: [this.e(`Exact match on normalized_name+number: "${name}" | "${number}"`)]
          };
        }
        if (rows.length > 1) {
          this.logTiming('name-number-collision', startTime);
          return {
            verdict: 'MULTIPLE',
            confidence: 0.72,
            alternatives: rows,
            evidence: [this.e('Multiple matches for name+number')]
          };
        }
      }

      // 5) Name only, must be unique
      if (name) {
        const rows = this.stmtByNameUnique.all(name) as Card[];
        if (rows.length === 1) {
          this.logTiming('name-unique', startTime);
          return {
            verdict: 'LIKELY',
            chosen_card: rows[0],
            confidence: 0.9,
            evidence: [this.e(`Unique exact match on normalized_name: "${name}"`)]
          };
        }
        if (rows.length > 1) {
          this.logTiming('name-ambiguous', startTime);
          return {
            verdict: 'MULTIPLE',
            confidence: 0.6,
            alternatives: rows.slice(0, 5), // Limit alternatives for sanity
            evidence: [this.e(`Name-only ambiguous: ${rows.length} matches for "${name}"`)]
          };
        }
      }

      // 6) No match found
      this.logTiming('no-match', startTime);
      return {
        verdict: 'UNCERTAIN',
        confidence: 0.0,
        evidence: [this.e('No exact match found')]
      };

    } catch (error) {
      log.error('❌ Exact match failed:', error);
      this.logTiming('error', startTime);
      return {
        verdict: 'UNCERTAIN',
        confidence: 0.0,
        evidence: [this.e(`Database error: ${error instanceof Error ? error.message : String(error)}`)]
      };
    }
  }

  /**
   * Public resolve API: exact matching with structured input parsing
   * Later: fuzzy matching will be bolted under this same interface
   */
  public resolve(rawQuery: string, hints?: { set?: string; number?: string }): ResolutionResult {
    const parsed = this.parseQuery(rawQuery);
    
    // Merge explicit hints with parsed components
    const query: QueryInput = {
      raw: rawQuery,
      name: parsed.name,
      set: hints?.set || parsed.set,
      number: hints?.number || parsed.number
    };

    const exact = this.exactMatch(query);

    // Early exit for high-confidence matches
    if (exact.verdict === 'CERTAIN') return exact;
    if (exact.verdict === 'LIKELY' && exact.confidence >= 0.95) return exact;

    // TODO: Fuzzy stage will be plugged in here
    // if (exact.verdict === 'UNCERTAIN' || exact.verdict === 'MULTIPLE') {
    //   return this.fuzzyMatch(query, exact);
    // }

    return exact;
  }

  /**
   * Performance monitoring helper
   */
  private logTiming(operation: string, startTime: bigint): void {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;
    
    if (durationMs > 1.0) { // Only log slow queries
      log.debug(`🐌 ${operation}: ${durationMs.toFixed(2)}ms`);
    }
  }

  /**
   * Health check and performance diagnostics
   */
  public async healthCheck(): Promise<{
    status: 'healthy' | 'degraded';
    indexStatus: any;
    sampleQueryMs: number;
  }> {
    try {
      // Verify composite indexes exist
      const indexes = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='index' AND name IN (
          'idx_cards_norm_triplet',
          'idx_cards_norm_name_set', 
          'idx_cards_norm_name_number'
        )
      `).all();

      // Performance test with sample query
      const startTime = process.hrtime.bigint();
      this.stmtByTriplet.all('pikachu', 'base set', '25');
      const endTime = process.hrtime.bigint();
      const sampleQueryMs = Number(endTime - startTime) / 1_000_000;

      return {
        status: indexes.length >= 3 && sampleQueryMs < 2.0 ? 'healthy' : 'degraded',
        indexStatus: indexes,
        sampleQueryMs: Math.round(sampleQueryMs * 100) / 100
      };

    } catch (error) {
      log.error('❌ Health check failed:', error);
      return {
        status: 'degraded',
        indexStatus: [],
        sampleQueryMs: -1
      };
    }
  }
}