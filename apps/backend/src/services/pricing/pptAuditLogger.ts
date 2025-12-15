import * as fs from "fs";
import * as path from "path";
import type { PPTParseMatch, PPTParseTitleMetadata, PPTRateLimitHeaders } from "./types";

const AUDIT_DIR = path.join(process.cwd(), "data", "ppt-audit");
const AUDIT_FILE_PREFIX = "ppt-enrichment-audit";

interface AuditLogEntry {
  timestamp: string; // ISO 8601 format
  unix_timestamp: number;
  operation: "parseTitle" | "getPrice";
  request_title?: string; // For parseTitle
  request_card_name?: string; // For getPrice
  request_hp?: number; // For getPrice
  listing_sku: string;
  condition: string;
  // Quota headers
  calls_consumed: number | null;
  daily_remaining: number | null;
  minute_remaining: number | null;
  // Response metadata
  total_matches: number;
  metadata_total: number | null;
  metadata_count: number | null;
  metadata_has_more: boolean | null;
  // Best match data
  ppt_card_id: string | null;
  card_name: string | null;
  set_name: string | null;
  card_number: string | null;
  hp: number | null;
  rarity: string | null;
  card_type: string | null;
  market_price: number | null;
  confidence: number | null;
  // Match position (0 = first/best match)
  match_index: number;
  // Full response JSON (for complete auditability)
  full_response_json: string;
}

export class PPTAuditLogger {
  constructor() {
    // Ensure audit directory exists
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
    }

    // Write header if file doesn't exist (for current day)
    const currentFile = this.getCurrentFilePath();
    if (!fs.existsSync(currentFile)) {
      this.writeHeader();
    }
  }

  /**
   * Get the current day's audit file path (recalculated on each call for midnight rotation)
   */
  private getCurrentFilePath(): string {
    const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(AUDIT_DIR, `${AUDIT_FILE_PREFIX}-${dateStr}.csv`);
  }

  private writeHeader(): void {
    const header = [
      "timestamp",
      "unix_timestamp",
      "operation",
      "request_title",
      "request_card_name",
      "request_hp",
      "listing_sku",
      "condition",
      "calls_consumed",
      "daily_remaining",
      "minute_remaining",
      "total_matches",
      "metadata_total",
      "metadata_count",
      "metadata_has_more",
      "ppt_card_id",
      "card_name",
      "set_name",
      "card_number",
      "hp",
      "rarity",
      "card_type",
      "market_price",
      "confidence",
      "match_index",
      "full_response_json",
    ].join(",");

    const currentFile = this.getCurrentFilePath();
    fs.writeFileSync(currentFile, header + "\n", { encoding: "utf8" });
  }

  private escapeCSV(value: any): string {
    if (value === null || value === undefined) {
      return "";
    }

    const str = String(value);

    // Escape quotes and wrap in quotes if contains comma, newline, or quote
    if (str.includes(",") || str.includes("\n") || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Log a parse-title enrichment call with all matches
   */
  logParseTitleEnrichment(params: {
    listingSku: string;
    condition: string;
    requestTitle: string;
    rateLimits: PPTRateLimitHeaders;
    matches: PPTParseMatch[];
    metadata: PPTParseTitleMetadata;
    fullResponse: any;
  }): void {
    const now = new Date();
    const timestamp = now.toISOString();
    const unixTimestamp = Math.floor(now.getTime() / 1000);

    const { listingSku, condition, requestTitle, rateLimits, matches, metadata, fullResponse } = params;

    // Log each match as a separate row (for operator analysis)
    matches.forEach((match, index) => {
      const entry: AuditLogEntry = {
        timestamp,
        unix_timestamp: unixTimestamp,
        operation: "parseTitle",
        request_title: requestTitle,
        request_card_name: undefined,
        request_hp: undefined,
        listing_sku: listingSku,
        condition,
        calls_consumed: rateLimits.callsConsumed ?? null,
        daily_remaining: rateLimits.dailyRemaining ?? null,
        minute_remaining: rateLimits.minuteRemaining ?? null,
        total_matches: matches.length,
        metadata_total: metadata.total,
        metadata_count: metadata.count,
        metadata_has_more: metadata.hasMore,
        ppt_card_id: match.id,
        card_name: match.name,
        set_name: match.setName,
        card_number: match.cardNumber ?? null,
        hp: match.hp ?? null,
        rarity: match.rarity ?? null,
        card_type: match.cardType ?? null,
        market_price: match.prices?.market ?? null,
        confidence: match.confidence ?? null,
        match_index: index,
        full_response_json: JSON.stringify(fullResponse),
      };

      this.writeEntry(entry);
    });

    // If no matches, write a single row indicating failure
    if (matches.length === 0) {
      const entry: AuditLogEntry = {
        timestamp,
        unix_timestamp: unixTimestamp,
        operation: "parseTitle",
        request_title: requestTitle,
        request_card_name: undefined,
        request_hp: undefined,
        listing_sku: listingSku,
        condition,
        calls_consumed: rateLimits.callsConsumed ?? null,
        daily_remaining: rateLimits.dailyRemaining ?? null,
        minute_remaining: rateLimits.minuteRemaining ?? null,
        total_matches: 0,
        metadata_total: metadata.total,
        metadata_count: metadata.count,
        metadata_has_more: metadata.hasMore,
        ppt_card_id: null,
        card_name: null,
        set_name: null,
        card_number: null,
        hp: null,
        rarity: null,
        card_type: null,
        market_price: null,
        confidence: null,
        match_index: -1,
        full_response_json: JSON.stringify(fullResponse),
      };

      this.writeEntry(entry);
    }
  }

  private writeEntry(entry: AuditLogEntry): void {
    const row = [
      this.escapeCSV(entry.timestamp),
      this.escapeCSV(entry.unix_timestamp),
      this.escapeCSV(entry.operation),
      this.escapeCSV(entry.request_title),
      this.escapeCSV(entry.request_card_name),
      this.escapeCSV(entry.request_hp),
      this.escapeCSV(entry.listing_sku),
      this.escapeCSV(entry.condition),
      this.escapeCSV(entry.calls_consumed),
      this.escapeCSV(entry.daily_remaining),
      this.escapeCSV(entry.minute_remaining),
      this.escapeCSV(entry.total_matches),
      this.escapeCSV(entry.metadata_total),
      this.escapeCSV(entry.metadata_count),
      this.escapeCSV(entry.metadata_has_more),
      this.escapeCSV(entry.ppt_card_id),
      this.escapeCSV(entry.card_name),
      this.escapeCSV(entry.set_name),
      this.escapeCSV(entry.card_number),
      this.escapeCSV(entry.hp),
      this.escapeCSV(entry.rarity),
      this.escapeCSV(entry.card_type),
      this.escapeCSV(entry.market_price),
      this.escapeCSV(entry.confidence),
      this.escapeCSV(entry.match_index),
      this.escapeCSV(entry.full_response_json),
    ].join(",");

    try {
      const currentFile = this.getCurrentFilePath();

      // Write header if this is a new day's file
      if (!fs.existsSync(currentFile)) {
        this.writeHeader();
      }

      fs.appendFileSync(currentFile, row + "\n", { encoding: "utf8" });
    } catch (error) {
      console.error("Failed to write PPT audit log entry:", error);
      // Don't throw - audit logging should not break the main flow
    }
  }
}
