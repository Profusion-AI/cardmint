/**
 * Manual Event Queue Drain Script
 *
 * Emergency recovery tool that bypasses the event-manager and processes
 * pending product_updated events directly by calling the notifyCardmint subscriber.
 *
 * Usage:
 *   docker compose exec app node /app/extensions/cardmint_sync/scripts/drainEvents.js
 *
 * Options:
 *   --dry-run   Show what would be processed without sending webhooks
 *   --limit N   Process at most N events (default: all)
 *
 * This script:
 * 1. Queries pending product_updated events from PostgreSQL
 * 2. Calls notifyCardmint() directly for each event
 * 3. Deletes processed events from the queue
 * 4. Reports results
 */

import { pool } from "@evershop/evershop/lib/postgres";
import notifyCardmint from "../subscribers/product_updated/notifyCardmint.js";

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit'));
const limit = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf('--limit') + 1], 10) : null;

async function drainEvents() {
  console.log('[cardmint_sync:drain] Manual Event Drain Script');
  console.log('─'.repeat(50));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  if (limit) console.log(`Limit: ${limit} events`);
  console.log('─'.repeat(50));

  try {
    // Query pending product_updated events
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const eventsResult = await pool.query(`
      SELECT uuid, data, created_at
      FROM event
      WHERE name = 'product_updated'
      ORDER BY created_at ASC
      ${limitClause}
    `);

    const events = eventsResult.rows;
    console.log(`\nFound ${events.length} pending product_updated events\n`);

    if (events.length === 0) {
      console.log('✅ No events to process');
      await pool.end();
      process.exit(0);
    }

    let processed = 0;
    let failed = 0;

    for (const event of events) {
      const eventData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      console.log(`Processing event ${event.uuid}:`);
      console.log(`  SKU: ${eventData.sku || 'N/A'}`);
      console.log(`  Status: ${eventData.status}`);
      console.log(`  Created: ${event.created_at}`);

      if (dryRun) {
        console.log('  → SKIPPED (dry run)\n');
        processed++;
        continue;
      }

      try {
        // Call the subscriber directly
        await notifyCardmint(eventData);
        console.log('  → Webhook sent successfully');

        // Delete the event from the queue
        await pool.query('DELETE FROM event WHERE uuid = $1', [event.uuid]);
        console.log('  → Event removed from queue\n');
        processed++;

      } catch (err) {
        console.error(`  → FAILED: ${err.message}\n`);
        failed++;
      }
    }

    console.log('─'.repeat(50));
    console.log(`Results: ${processed} processed, ${failed} failed`);

    if (failed > 0) {
      console.log('\n⚠️  Some events failed - check logs for details');
    } else if (dryRun) {
      console.log('\n✅ Dry run complete - no changes made');
    } else {
      console.log('\n✅ All events processed successfully');
    }

    await pool.end();
    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('[cardmint_sync:drain] Fatal error:', error.message);
    await pool.end();
    process.exit(2);
  }
}

drainEvents();
