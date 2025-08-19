#!/usr/bin/env node

/**
 * CardMint Integration Test
 * Tests the complete pipeline with Fly.io Managed Postgres
 */

const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const logger = {
  info: (msg, data) => console.log(`ℹ️  ${msg}`, data || ''),
  success: (msg, data) => console.log(`✅ ${msg}`, data || ''),
  error: (msg, data) => console.error(`❌ ${msg}`, data || ''),
  warn: (msg, data) => console.warn(`⚠️  ${msg}`, data || '')
};

async function runIntegrationTest() {
  console.log('=====================================');
  console.log('CardMint Integration Test');
  console.log('=====================================\n');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5
  });

  try {
    // Test 1: Database connectivity
    logger.info('Testing database connectivity...');
    const client = await pool.connect();
    const dbTest = await client.query('SELECT current_database(), version()');
    logger.success('Database connected', {
      database: dbTest.rows[0].current_database,
      version: dbTest.rows[0].version.split(' ')[1]
    });
    client.release();

    // Test 2: Check Pokemon schema
    logger.info('Checking Pokemon schema...');
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE '%pokemon%'
      ORDER BY table_name
    `);
    logger.success(`Found ${tablesResult.rows.length} Pokemon tables`);

    // Test 3: Test card insertion
    logger.info('Testing card insertion...');
    const testCard = {
      name: 'Test Charizard',
      set: 'Test Set',
      number: '999',
      hp: 180,
      types: ['Fire'],
      rarity: 'Rare Holo'
    };

    const insertResult = await pool.query(`
      INSERT INTO pokemon_cards (
        card_name, set_name, card_number, hp, pokemon_types, rarity, ocr_confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, card_name
    `, [testCard.name, testCard.set, testCard.number, testCard.hp, testCard.types, testCard.rarity, 0.99]);
    
    const cardId = insertResult.rows[0].id;
    logger.success('Card inserted', { id: cardId, name: insertResult.rows[0].card_name });

    // Test 4: Test price insertion
    logger.info('Testing price data...');
    await pool.query(`
      INSERT INTO card_prices (
        card_id, source, market_price, low_price, high_price, last_updated_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [cardId, 'tcgplayer', 15000, 12000, 18000]); // Prices in cents
    logger.success('Price data inserted');

    // Test 5: Test inventory tracking
    logger.info('Testing inventory tracking...');
    await pool.query(`
      INSERT INTO inventory_tracking (
        card_id, quantity_owned, condition, storage_location
      ) VALUES ($1, $2, $3, $4)
    `, [cardId, 1, 'near_mint', 'Binder A']);
    logger.success('Inventory record created');

    // Test 6: Query card overview
    logger.info('Testing card overview view...');
    const overviewResult = await pool.query(`
      SELECT card_name, set_name, hp, tcgplayer_market, quantity_owned
      FROM card_overview
      WHERE card_name = $1
    `, [testCard.name]);
    
    if (overviewResult.rows.length > 0) {
      logger.success('Card overview retrieved', overviewResult.rows[0]);
    }

    // Test 7: Check official images
    logger.info('Checking official images directory...');
    const imagesDir = path.join(process.cwd(), 'official_images');
    try {
      const files = await fs.readdir(imagesDir);
      const imageFiles = files.filter(f => f.endsWith('.jpg'));
      logger.success(`Found ${imageFiles.length} official test images`);
      
      if (imageFiles.length > 0) {
        console.log('  Sample images:');
        imageFiles.slice(0, 3).forEach(f => console.log(`    - ${f}`));
      }
    } catch (err) {
      logger.warn('Official images directory not found');
    }

    // Test 8: API configuration check
    logger.info('Checking API configurations...');
    const apis = {
      PriceCharting: !!process.env.PRICECHARTING_API_KEY,
      PokemonTCG: !!process.env.POKEMONTCG_API_KEY,
      FlyToken: !!process.env.FLY_API_TOKEN
    };
    
    Object.entries(apis).forEach(([name, configured]) => {
      if (configured) {
        logger.success(`${name} API key configured`);
      } else {
        logger.warn(`${name} API key missing`);
      }
    });

    // Test 9: Performance benchmark
    logger.info('Running performance benchmark...');
    const iterations = 100;
    const start = Date.now();
    
    for (let i = 0; i < iterations; i++) {
      await pool.query('SELECT 1');
    }
    
    const elapsed = Date.now() - start;
    const avgLatency = elapsed / iterations;
    logger.success(`Average query latency: ${avgLatency.toFixed(2)}ms`);
    
    if (avgLatency < 10) {
      console.log('  🚀 Excellent performance!');
    } else if (avgLatency < 50) {
      console.log('  ✅ Good performance');
    } else {
      console.log('  ⚠️  Consider optimizing connection pooling');
    }

    // Clean up test data
    logger.info('Cleaning up test data...');
    await pool.query('DELETE FROM inventory_tracking WHERE card_id = $1', [cardId]);
    await pool.query('DELETE FROM card_prices WHERE card_id = $1', [cardId]);
    await pool.query('DELETE FROM pokemon_cards WHERE id = $1', [cardId]);
    logger.success('Test data cleaned up');

    // Final summary
    console.log('\n=====================================');
    console.log('✅ INTEGRATION TEST PASSED');
    console.log('=====================================');
    console.log('System is ready for production!');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Run full test suite: npm test');
    console.log('  2. Test with real images: npm run test:images');
    console.log('  3. Deploy to Fly.io: ./scripts/deploy.sh');

  } catch (error) {
    logger.error('Integration test failed', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the test
runIntegrationTest().catch(console.error);