/**
 * EverShop Event Queue Health Check
 *
 * Checks for backlog in the event table and alerts if events are piling up.
 * This indicates the event-manager worker may not be processing events correctly.
 *
 * Usage:
 *   docker compose exec app node /app/extensions/cardmint_sync/health/checkEventQueue.js
 *
 * Exit codes:
 *   0 - Healthy (queue empty or below threshold)
 *   1 - Warning (queue has items but below critical)
 *   2 - Critical (queue backlog exceeds critical threshold)
 */

import { pool } from "@evershop/evershop/lib/postgres";

const WARNING_THRESHOLD = 5;   // Events in queue
const CRITICAL_THRESHOLD = 20; // Events in queue
const STALE_MINUTES = 5;       // Events older than this are concerning

async function checkEventQueue() {
  try {
    // Count all pending events
    const countResult = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE name = 'product_updated') as product_updated_count
      FROM event
    `);

    const total = parseInt(countResult.rows[0].total, 10);
    const productUpdatedCount = parseInt(countResult.rows[0].product_updated_count, 10);

    // Check for stale events (events older than threshold)
    const staleResult = await pool.query(`
      SELECT name, created_at, uuid
      FROM event
      WHERE created_at < NOW() - INTERVAL '${STALE_MINUTES} minutes'
      ORDER BY created_at ASC
      LIMIT 5
    `);

    const staleEvents = staleResult.rows;

    // Build status report
    console.log('[cardmint_sync:health] Event Queue Status');
    console.log('─'.repeat(50));
    console.log(`Total events in queue:        ${total}`);
    console.log(`product_updated events:       ${productUpdatedCount}`);
    console.log(`Stale events (>${STALE_MINUTES}min):       ${staleEvents.length}`);
    console.log('─'.repeat(50));

    if (staleEvents.length > 0) {
      console.log('\nStale events (oldest first):');
      staleEvents.forEach(e => {
        console.log(`  - [${e.name}] ${e.uuid} (created: ${e.created_at})`);
      });
    }

    // Determine health status
    let exitCode = 0;
    let status = 'HEALTHY';

    if (total >= CRITICAL_THRESHOLD || staleEvents.length > 0) {
      status = 'CRITICAL';
      exitCode = 2;
      console.log(`\n❌ ${status}: Event queue needs attention!`);
      console.log('   Possible causes:');
      console.log('   - Event manager not running');
      console.log('   - Subscriber failing silently');
      console.log('   - Database connection issues');
      console.log('   Action: Check docker logs and consider container restart');
    } else if (total >= WARNING_THRESHOLD) {
      status = 'WARNING';
      exitCode = 1;
      console.log(`\n⚠️  ${status}: Event queue has ${total} pending events`);
    } else {
      console.log(`\n✅ ${status}: Event queue is healthy`);
    }

    // Close pool and exit
    await pool.end();
    process.exit(exitCode);

  } catch (error) {
    console.error('[cardmint_sync:health] Error checking event queue:', error.message);
    process.exit(2);
  }
}

checkEventQueue();
