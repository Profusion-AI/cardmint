#!/usr/bin/env tsx
/**
 * Klaviyo Event Replay Tool
 *
 * Replays failed/pending Klaviyo events from the klaviyo_event_log table.
 * Default: dry-run mode. Use --confirm to execute replays.
 *
 * Usage:
 *   npm run --prefix apps/backend klaviyo:replay                      # Dry-run list all
 *   npm run --prefix apps/backend klaviyo:replay -- --confirm         # Replay all
 *   npm run --prefix apps/backend klaviyo:replay -- --id 123          # Specific event
 *   npm run --prefix apps/backend klaviyo:replay -- --status failed   # Only failed
 *
 * Environment:
 *   KLAVIYO_PRIVATE_API_KEY - Required for replay
 *   SQLITE_DB - Path to database (default: cardmint_dev.db)
 */

import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KLAVIYO_API_URL = 'https://a.klaviyo.com/api/events';
const KLAVIYO_REVISION = '2025-10-15';

interface KlaviyoEvent {
  id: number;
  stripe_event_id: string;
  event_type: string;
  payload: string;
  status: string;
  response_code: number | null;
  error_message: string | null;
  created_at: number;
  sent_at: number | null;
}

interface SendResult {
  success: boolean;
  statusCode: number;
  error: string | null;
}

// Parse CLI args
const { values: args } = parseArgs({
  options: {
    confirm: { type: 'boolean', default: false },
    id: { type: 'string' },
    status: { type: 'string', default: 'all' }, // 'pending', 'failed', 'all'
    limit: { type: 'string', default: '100' },
    db: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`
Klaviyo Event Replay Tool

Usage:
  npm run --prefix apps/backend klaviyo:replay [-- options]

Options:
  --confirm         Execute replays (default: dry-run)
  --id <id>         Replay specific event ID
  --status <s>      Filter by status: pending, failed, all (default: all)
  --limit <n>       Limit number of events (default: 100)
  --db <path>       Database path (default: cardmint_dev.db)
  -h, --help        Show this help

Examples:
  npm run --prefix apps/backend klaviyo:replay                      # List pending/failed events
  npm run --prefix apps/backend klaviyo:replay -- --confirm         # Replay all
  npm run --prefix apps/backend klaviyo:replay -- --id 42 --confirm # Replay event #42
  npm run --prefix apps/backend klaviyo:replay -- --status failed   # List only failed events
`);
  process.exit(0);
}

const API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const dbPath = args.db || process.env.SQLITE_DB || path.resolve(__dirname, '../cardmint_dev.db');
const dryRun = !args.confirm;

// Validate API key for actual replays
if (!dryRun && !API_KEY) {
  console.error('Error: KLAVIYO_PRIVATE_API_KEY is required for replay (--confirm mode)');
  console.error('Set the environment variable or use dry-run mode (no --confirm)');
  process.exit(1);
}

// Open database
let db: Database.Database;
try {
  db = new Database(path.resolve(process.cwd(), dbPath), { fileMustExist: true });
} catch (err) {
  console.error(`Error: Could not open database at ${dbPath}`);
  console.error((err as Error).message);
  process.exit(1);
}

/**
 * Check if klaviyo_event_log table exists
 */
function hasEventLogTable(): boolean {
  const result = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='klaviyo_event_log'
  `).get();
  return !!result;
}

/**
 * Send event to Klaviyo
 */
async function sendToKlaviyo(payload: unknown): Promise<SendResult> {
  const response = await fetch(KLAVIYO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.api+json',
      'content-type': 'application/vnd.api+json',
      revision: KLAVIYO_REVISION,
      Authorization: `Klaviyo-API-Key ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const statusCode = response.status;
  const success = statusCode >= 200 && statusCode < 300;

  let error: string | null = null;
  if (!success) {
    try {
      error = await response.text();
    } catch {
      error = `HTTP ${statusCode}`;
    }
  }

  return { success, statusCode, error };
}

/**
 * Update event status in database
 */
function updateEventStatus(
  id: number,
  status: string,
  responseCode: number | null,
  errorMessage: string | null
): void {
  const now = Math.floor(Date.now() / 1000);
  const sentAt = status === 'sent' ? now : null;
  const stmt = db.prepare(`
    UPDATE klaviyo_event_log
    SET status = ?, response_code = ?, error_message = ?, sent_at = ?
    WHERE id = ?
  `);
  stmt.run(status, responseCode, errorMessage, sentAt, id);
}

/**
 * Get events to replay
 */
function getEventsToReplay(): KlaviyoEvent[] {
  let query = `
    SELECT id, stripe_event_id, event_type, payload, status, response_code, error_message, created_at, sent_at
    FROM klaviyo_event_log
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (args.id) {
    query += ' AND id = ?';
    params.push(parseInt(args.id, 10));
  } else {
    if (args.status === 'pending') {
      query += " AND status = 'pending'";
    } else if (args.status === 'failed') {
      query += " AND status = 'failed'";
    } else {
      query += " AND status IN ('pending', 'failed')";
    }
  }

  query += ' ORDER BY created_at ASC LIMIT ?';
  params.push(parseInt(args.limit || '100', 10));

  const stmt = db.prepare(query);
  return stmt.all(...params) as KlaviyoEvent[];
}

/**
 * Format timestamp for display
 */
function formatTs(unixTs: number | null): string {
  if (!unixTs) return '-';
  return new Date(unixTs * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log('Klaviyo Event Replay Tool');
  console.log('='.repeat(60));
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (use --confirm to execute)' : 'LIVE REPLAY'}`);
  console.log(`Filter: ${args.status === 'all' ? 'pending + failed' : args.status}`);
  if (args.id) console.log(`Event ID: ${args.id}`);
  console.log('');

  // Check if table exists
  if (!hasEventLogTable()) {
    console.log('No klaviyo_event_log table found in database.');
    console.log('This table is created when Klaviyo events are logged by the backend.');
    process.exit(0);
  }

  const events = getEventsToReplay();

  if (events.length === 0) {
    console.log('No events found matching criteria.');
    process.exit(0);
  }

  console.log(`Found ${events.length} event(s) to ${dryRun ? 'review' : 'replay'}:`);
  console.log('-'.repeat(60));

  // Summary table
  console.log('');
  console.log('ID\tStatus\t\tType\t\t\tCreated\t\t\tStripe Event');
  console.log('-'.repeat(100));
  for (const evt of events) {
    const eventType = evt.event_type.padEnd(16);
    console.log(`${evt.id}\t${evt.status.padEnd(8)}\t${eventType}\t${formatTs(evt.created_at)}\t${evt.stripe_event_id.slice(0, 30)}...`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Use --confirm to execute replays.');
    process.exit(0);
  }

  // Execute replays
  console.log('Starting replays...');
  console.log('');

  let successCount = 0;
  let failCount = 0;

  for (const evt of events) {
    process.stdout.write(`[${evt.id}] ${evt.event_type}... `);

    let payload: unknown;
    try {
      payload = JSON.parse(evt.payload);
    } catch (err) {
      console.log(`SKIP (invalid JSON: ${(err as Error).message})`);
      failCount++;
      continue;
    }

    try {
      const result = await sendToKlaviyo(payload);
      updateEventStatus(evt.id, result.success ? 'sent' : 'failed', result.statusCode, result.error);

      if (result.success) {
        console.log(`OK (${result.statusCode})`);
        successCount++;
      } else {
        console.log(`FAILED (${result.statusCode}): ${result.error?.slice(0, 100)}`);
        failCount++;
      }
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      updateEventStatus(evt.id, 'failed', null, errorMsg);
      console.log(`ERROR: ${errorMsg}`);
      failCount++;
    }

    // Rate limiting: 100ms between requests
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`Replay complete: ${successCount} succeeded, ${failCount} failed`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
}).finally(() => {
  if (db) db.close();
});
