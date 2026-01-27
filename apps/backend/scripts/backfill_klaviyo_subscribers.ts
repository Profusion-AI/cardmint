#!/usr/bin/env tsx
/**
 * Klaviyo Subscriber Backfill Tool
 *
 * Exports historical email_subscribers to Klaviyo profiles.
 * Joins with welcome_coupons table to include CmWelcomeCode (if table exists).
 * Default: dry-run mode. Use --confirm to execute.
 *
 * Usage:
 *   npm run --prefix apps/backend klaviyo:backfill                    # Dry-run
 *   npm run --prefix apps/backend klaviyo:backfill -- --confirm       # Execute backfill
 *   npm run --prefix apps/backend klaviyo:backfill -- --limit 10      # Limit to 10
 *   npm run --prefix apps/backend klaviyo:backfill -- --since 2025-12-01
 *
 * Environment:
 *   KLAVIYO_PRIVATE_API_KEY - Required for backfill
 *   KLAVIYO_SUBSCRIBE_LIST_ID - Required for list subscription
 *   SQLITE_DB - Path to database (default: cardmint_dev.db)
 */

import Database from 'better-sqlite3';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KLAVIYO_PROFILE_IMPORT_URL = 'https://a.klaviyo.com/api/profile-import';
const KLAVIYO_REVISION = '2025-10-15';

interface Subscriber {
  id: number;
  email: string;
  subscribed_at: string;
  source: string | null;
  unsubscribed_at: string | null;
  deleted_at: string | null;
  welcome_code: string | null;
  welcome_code_expires_at: number | null;
}

interface ProfileResult {
  success: boolean;
  statusCode: number;
  profileId: string | null;
  error: string | null;
}

interface ListResult {
  success: boolean;
  statusCode: number;
  error: string | null;
}

// Parse CLI args
const { values: args } = parseArgs({
  options: {
    confirm: { type: 'boolean', default: false },
    limit: { type: 'string', default: '1000' },
    since: { type: 'string' }, // ISO date string
    db: { type: 'string' },
    'list-id': { type: 'string' },
    'skip-list': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`
Klaviyo Subscriber Backfill Tool

Usage:
  npm run --prefix apps/backend klaviyo:backfill [-- options]

Options:
  --confirm         Execute backfill (default: dry-run)
  --limit <n>       Limit number of subscribers (default: 1000)
  --since <date>    Only subscribers after date (ISO format: 2025-12-01)
  --db <path>       Database path (default: cardmint_dev.db)
  --list-id <id>    Klaviyo list ID (overrides env)
  --skip-list       Skip list subscription (profile upsert only)
  -h, --help        Show this help

Environment:
  KLAVIYO_PRIVATE_API_KEY   - Required for API calls
  KLAVIYO_SUBSCRIBE_LIST_ID - List ID for subscriptions

Examples:
  npm run --prefix apps/backend klaviyo:backfill                        # List subscribers
  npm run --prefix apps/backend klaviyo:backfill -- --confirm           # Backfill all
  npm run --prefix apps/backend klaviyo:backfill -- --since 2025-12-01  # After Dec 1
  npm run --prefix apps/backend klaviyo:backfill -- --limit 5 --confirm # First 5 only
`);
  process.exit(0);
}

const API_KEY = process.env.KLAVIYO_PRIVATE_API_KEY;
const LIST_ID = args['list-id'] || process.env.KLAVIYO_SUBSCRIBE_LIST_ID;
const dbPath = args.db || process.env.SQLITE_DB || path.resolve(__dirname, '../cardmint_dev.db');
const dryRun = !args.confirm;
const skipList = args['skip-list'];

// Validate API key for actual backfill
if (!dryRun && !API_KEY) {
  console.error('Error: KLAVIYO_PRIVATE_API_KEY is required for backfill (--confirm mode)');
  process.exit(1);
}

if (!dryRun && !skipList && !LIST_ID) {
  console.error('Error: KLAVIYO_SUBSCRIBE_LIST_ID is required for list subscription');
  console.error('Use --skip-list to skip list subscription or provide --list-id');
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
 * Check if welcome_coupons table exists
 */
function hasWelcomeCouponsTable(): boolean {
  const result = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='welcome_coupons'
  `).get();
  return !!result;
}

/**
 * Mask email for privacy in logs (shows first 3 chars + domain)
 */
function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 3) {
    return email.slice(0, 1) + '***' + email.slice(atIndex);
  }
  return email.slice(0, 3) + '***' + email.slice(atIndex);
}

/**
 * Send profile to Klaviyo
 */
async function upsertProfile(email: string, properties: Record<string, unknown>): Promise<ProfileResult> {
  const payload = {
    data: {
      type: 'profile',
      attributes: {
        email,
        properties,
      },
    },
  };

  const response = await fetch(KLAVIYO_PROFILE_IMPORT_URL, {
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

  let profileId: string | null = null;
  let error: string | null = null;

  if (success) {
    try {
      const body = await response.json() as { data?: { id?: string } };
      profileId = body?.data?.id || null;
    } catch {
      // Some endpoints return empty body
    }
  } else {
    try {
      error = await response.text();
    } catch {
      error = `HTTP ${statusCode}`;
    }
  }

  return { success, statusCode, profileId, error };
}

/**
 * Subscribe profile to list
 */
async function subscribeToList(profileId: string, listId: string): Promise<ListResult> {
  const url = `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`;
  const payload = {
    data: [
      {
        type: 'profile',
        id: profileId,
      },
    ],
  };

  const response = await fetch(url, {
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
  // 204 No Content is success for relationship endpoints
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
 * Get subscribers to backfill
 */
function getSubscribers(): Subscriber[] {
  const hasWelcomeCoupons = hasWelcomeCouponsTable();

  // Build query - conditionally join welcome_coupons if table exists
  let query: string;
  if (hasWelcomeCoupons) {
    query = `
      SELECT
        s.id,
        s.email,
        s.subscribed_at,
        s.source,
        s.unsubscribed_at,
        w.code as welcome_code,
        w.expires_at as welcome_code_expires_at
      FROM email_subscribers s
      LEFT JOIN welcome_coupons w ON LOWER(s.email) = LOWER(w.email)
      WHERE s.unsubscribed_at IS NULL
        AND (s.deleted_at IS NULL OR s.deleted_at = '')
    `;
  } else {
    query = `
      SELECT
        s.id,
        s.email,
        s.subscribed_at,
        s.source,
        s.unsubscribed_at,
        NULL as welcome_code,
        NULL as welcome_code_expires_at
      FROM email_subscribers s
      WHERE s.unsubscribed_at IS NULL
        AND (s.deleted_at IS NULL OR s.deleted_at = '')
    `;
  }

  const params: (string | number)[] = [];

  if (args.since) {
    query += ' AND s.subscribed_at >= ?';
    params.push(args.since);
  }

  query += ' ORDER BY s.subscribed_at ASC LIMIT ?';
  params.push(parseInt(args.limit || '1000', 10));

  const stmt = db.prepare(query);
  return stmt.all(...params) as Subscriber[];
}

/**
 * Format date for display
 */
function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  return dateStr.slice(0, 19);
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  console.log('Klaviyo Subscriber Backfill Tool');
  console.log('='.repeat(60));
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN (use --confirm to execute)' : 'LIVE BACKFILL'}`);
  console.log(`List ID: ${LIST_ID || '(not set)'}`);
  console.log(`Skip list subscription: ${skipList}`);
  console.log(`Welcome coupons table: ${hasWelcomeCouponsTable() ? 'found' : 'not found'}`);
  if (args.since) console.log(`Since: ${args.since}`);
  console.log('');

  const subscribers = getSubscribers();

  if (subscribers.length === 0) {
    console.log('No subscribers found matching criteria.');
    process.exit(0);
  }

  console.log(`Found ${subscribers.length} subscriber(s) to ${dryRun ? 'review' : 'backfill'}:`);
  console.log('-'.repeat(60));

  // Summary table - MASKED emails in dry-run output to protect PII
  console.log('');
  console.log('ID\tEmail (masked)\t\t\tSubscribed\t\tWelcome Code');
  console.log('-'.repeat(80));
  for (const sub of subscribers) {
    const emailMasked = maskEmail(sub.email).slice(0, 25).padEnd(25);
    const codeDisplay = sub.welcome_code || '-';
    console.log(`${sub.id}\t${emailMasked}\t${formatDate(sub.subscribed_at)}\t${codeDisplay}`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Use --confirm to execute backfill.');
    process.exit(0);
  }

  // Execute backfill
  console.log('Starting backfill...');
  console.log('');

  let successCount = 0;
  let failCount = 0;

  for (const sub of subscribers) {
    const emailMasked = maskEmail(sub.email);
    process.stdout.write(`[${sub.id}] ${emailMasked}... `);

    // Build profile properties
    const properties: Record<string, unknown> = {
      CmSubscribeSource: sub.source || 'backfill',
      CmSubscribeAt: sub.subscribed_at,
      CmBackfilledAt: new Date().toISOString(),
    };

    // Add welcome code if present
    if (sub.welcome_code) {
      properties.CmWelcomeCode = sub.welcome_code;
      if (sub.welcome_code_expires_at) {
        properties.CmWelcomeCodeExpiresAt = new Date(sub.welcome_code_expires_at * 1000).toISOString();
      }
    }

    try {
      // Step 1: Upsert profile
      const profileResult = await upsertProfile(sub.email, properties);

      if (!profileResult.success) {
        console.log(`FAILED (profile upsert ${profileResult.statusCode}): ${profileResult.error?.slice(0, 80)}`);
        failCount++;
        continue;
      }

      const profileId = profileResult.profileId;
      if (!profileId) {
        console.log('FAILED (no profile ID returned)');
        failCount++;
        continue;
      }

      // Step 2: Subscribe to list (unless skipped)
      if (!skipList && LIST_ID) {
        const listResult = await subscribeToList(profileId, LIST_ID);
        if (!listResult.success) {
          console.log(`PARTIAL (profile OK, list failed ${listResult.statusCode}): ${listResult.error?.slice(0, 80)}`);
          // Still count as partial success
        } else {
          console.log('OK (profile + list)');
        }
      } else {
        console.log('OK (profile only)');
      }

      successCount++;
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      failCount++;
    }

    // Rate limiting: 150ms between requests (Klaviyo recommends <10 RPS)
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`Backfill complete: ${successCount} succeeded, ${failCount} failed`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
}).finally(() => {
  if (db) db.close();
});
