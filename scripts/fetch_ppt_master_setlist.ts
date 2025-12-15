/**
 * Fetch PPT Master Set List
 *
 * One-off script to fetch all English Pokemon sets from PokéPrice Tracker API
 * and save to mastersetlist.csv for reference and future updates.
 *
 * Usage:
 *   npx tsx scripts/fetch_ppt_master_setlist.ts
 *
 * Prerequisites:
 *   - POKEMONPRICETRACKER_API_KEY must be set in apps/backend/.env
 *   - Requires active PPT paid tier key (rate limit: 60 calls/min, 20k credits/day)
 *
 * Output:
 *   - data/mastersetlist.csv: Complete set list sorted by release date
 *   - Logs quota consumption to console
 *
 * Future Updates:
 *   Run this script quarterly or when major set releases occur to refresh the master list.
 *   Compare new CSV with existing to identify additions/changes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PPT_API_BASE = "https://www.pokemonpricetracker.com";
const API_KEY = process.env.POKEMONPRICETRACKER_API_KEY;
const OUTPUT_PATH = path.resolve(__dirname, "../data/mastersetlist.csv");
const FETCH_LIMIT = 50; // Fetch 50 sets per request (stay under minute rate limit)
const DELAY_MS = 1000; // 1 second delay between requests to respect rate limits

interface PPTSet {
  id: string;
  tcgPlayerId: string;
  name: string;
  series: string;
  releaseDate: string;
  cardCount: number;
  priceGuideUrl: string;
  hasPriceGuide: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PPTResponse {
  data: PPTSet[];
  metadata: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    language: string;
  };
}

interface RateLimitHeaders {
  callsConsumed?: number;
  dailyRemaining?: number;
  minuteRemaining?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch sets from PPT API with pagination
 */
async function fetchSets(offset: number = 0, limit: number = FETCH_LIMIT): Promise<PPTResponse> {
  if (!API_KEY) {
    throw new Error("POKEMONPRICETRACKER_API_KEY not set in environment");
  }

  const url = `${PPT_API_BASE}/api/v2/sets?sortBy=releaseDate&sortOrder=desc&limit=${limit}&offset=${offset}`;

  console.log(`Fetching sets: offset=${offset}, limit=${limit}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PPT API error: ${response.status} ${response.statusText}\n${body}`);
  }

  // Parse rate limit headers
  const rateLimits: RateLimitHeaders = {
    callsConsumed: response.headers.get("x-api-calls-consumed")
      ? parseInt(response.headers.get("x-api-calls-consumed")!, 10)
      : undefined,
    dailyRemaining: response.headers.get("x-ratelimit-daily-remaining")
      ? parseInt(response.headers.get("x-ratelimit-daily-remaining")!, 10)
      : undefined,
    minuteRemaining: response.headers.get("x-ratelimit-minute-remaining")
      ? parseInt(response.headers.get("x-ratelimit-minute-remaining")!, 10)
      : undefined,
  };

  console.log(`  Rate limits: daily=${rateLimits.dailyRemaining}, minute=${rateLimits.minuteRemaining}, consumed=${rateLimits.callsConsumed}`);

  return response.json();
}

/**
 * Fetch all sets with pagination
 */
async function fetchAllSets(): Promise<PPTSet[]> {
  const allSets: PPTSet[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchSets(offset, FETCH_LIMIT);

    allSets.push(...response.data);

    console.log(`  Fetched ${response.data.length} sets (total: ${allSets.length}/${response.metadata.total})`);

    hasMore = response.metadata.hasMore;
    offset += FETCH_LIMIT;

    // Respect rate limits with delay between requests
    if (hasMore) {
      console.log(`  Waiting ${DELAY_MS}ms before next request...`);
      await sleep(DELAY_MS);
    }
  }

  return allSets;
}

/**
 * Convert sets to CSV format
 */
function setsToCSV(sets: PPTSet[]): string {
  // CSV Header
  const headers = [
    "ppt_id",
    "tcgplayer_id",
    "set_name",
    "series",
    "release_date",
    "card_count",
    "has_price_guide",
    "price_guide_url",
    "created_at",
    "updated_at",
  ];

  // CSV Rows
  const rows = sets.map((set) => {
    return [
      escapeCSV(set.id),
      escapeCSV(set.tcgPlayerId),
      escapeCSV(set.name),
      escapeCSV(set.series),
      escapeCSV(new Date(set.releaseDate).toISOString().split("T")[0]), // YYYY-MM-DD
      set.cardCount.toString(),
      set.hasPriceGuide ? "true" : "false",
      escapeCSV(set.priceGuideUrl),
      escapeCSV(new Date(set.createdAt).toISOString()),
      escapeCSV(new Date(set.updatedAt).toISOString()),
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Escape CSV field (handle commas, quotes, newlines)
 */
function escapeCSV(value: string): string {
  if (!value) return "";

  // If value contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

/**
 * Main execution
 */
async function main() {
  console.log("=== PPT Master Set List Fetcher ===\n");

  if (!API_KEY) {
    console.error("ERROR: POKEMONPRICETRACKER_API_KEY not found in environment");
    console.error("Set it in apps/backend/.env or export it before running this script");
    process.exit(1);
  }

  console.log(`API Key: ${API_KEY.substring(0, 20)}...`);
  console.log(`Output: ${OUTPUT_PATH}\n`);

  try {
    // Fetch all sets
    console.log("Fetching all sets from PPT API...\n");
    const sets = await fetchAllSets();

    console.log(`\nFetched ${sets.length} total sets`);

    // Sort by release date (newest first, as returned by API with desc order)
    console.log("Sorting sets by release date (newest first)...");

    // Convert to CSV
    console.log("Converting to CSV format...");
    const csv = setsToCSV(sets);

    // Ensure data directory exists
    const dataDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`Created directory: ${dataDir}`);
    }

    // Write to file
    fs.writeFileSync(OUTPUT_PATH, csv, "utf-8");
    console.log(`\n✓ Wrote ${sets.length} sets to ${OUTPUT_PATH}`);

    // Summary statistics
    const seriesCounts = sets.reduce((acc, set) => {
      acc[set.series] = (acc[set.series] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log("\n=== Summary ===");
    console.log(`Total sets: ${sets.length}`);
    console.log(`Series breakdown:`);
    Object.entries(seriesCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([series, count]) => {
        console.log(`  ${series}: ${count}`);
      });

    console.log("\n✓ Done! Master set list saved successfully.");
    console.log("\nTo update in the future, run:");
    console.log("  npx tsx scripts/fetch_ppt_master_setlist.ts");

  } catch (error) {
    console.error("\n✗ Error fetching sets:", error);
    process.exit(1);
  }
}

main();
