#!/usr/bin/env tsx
/**
 * Check Database Data Status
 * Analyze current card data and PriceCharting integration
 */

import Database from 'better-sqlite3';
import { createLogger } from '../src/utils/logger';

const log = createLogger('check-database-data');

async function main() {
  const dbPath = process.env.DB_PATH || './data/cardmint.db';
  
  log.info(`🔍 Analyzing database data: ${dbPath}`);

  let db: Database.Database | null = null;
  
  try {
    db = new Database(dbPath, { readonly: true });

    // Basic card statistics
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_cards,
        COUNT(DISTINCT name) as unique_names,
        COUNT(DISTINCT set_name) as unique_sets,
        COUNT(DISTINCT card_number) as unique_numbers,
        COUNT(price_charting_id) as has_pricecharting_id,
        COUNT(price_usd) as has_price_data,
        COUNT(normalized_name) as normalized_cards
      FROM cards
    `).get() as any;

    log.info('📊 DATABASE STATISTICS:');
    log.info(`   Total cards: ${stats.total_cards}`);
    log.info(`   Unique names: ${stats.unique_names}`);
    log.info(`   Unique sets: ${stats.unique_sets}`);
    log.info(`   Cards with PriceCharting ID: ${stats.has_pricecharting_id}`);
    log.info(`   Cards with price data: ${stats.has_price_data}`);
    log.info(`   Normalized cards: ${stats.normalized_cards}`);

    // Sample data
    const sampleCards = db.prepare(`
      SELECT id, name, set_name, card_number, price_usd, price_charting_id, tcg_player_id
      FROM cards 
      LIMIT 10
    `).all();

    log.info('');
    log.info('🃏 SAMPLE CARDS:');
    sampleCards.forEach((card: any) => {
      log.info(`   ${card.name} | ${card.set_name || 'No Set'} | ${card.card_number || 'No Number'}`);
      log.info(`     Price: $${card.price_usd || 'N/A'} | PC ID: ${card.price_charting_id || 'None'} | TCG ID: ${card.tcg_player_id || 'None'}`);
    });

    // Check if we have PriceCharting data
    const priceChartingCards = db.prepare(`
      SELECT COUNT(*) as count FROM cards WHERE price_charting_id IS NOT NULL
    `).get() as { count: number };

    // Set distribution
    const setDistribution = db.prepare(`
      SELECT set_name, COUNT(*) as count 
      FROM cards 
      WHERE set_name IS NOT NULL AND set_name != ''
      GROUP BY set_name 
      ORDER BY count DESC
      LIMIT 10
    `).all();

    if (setDistribution.length > 0) {
      log.info('');
      log.info('📈 TOP SETS BY CARD COUNT:');
      setDistribution.forEach((set: any) => {
        log.info(`   ${set.set_name}: ${set.count} cards`);
      });
    }

    // Data quality assessment
    const dataQuality = db.prepare(`
      SELECT 
        COUNT(CASE WHEN name IS NULL OR name = '' THEN 1 END) as missing_names,
        COUNT(CASE WHEN set_name IS NULL OR set_name = '' THEN 1 END) as missing_sets,
        COUNT(CASE WHEN card_number IS NULL OR card_number = '' THEN 1 END) as missing_numbers
      FROM cards
    `).get() as any;

    log.info('');
    log.info('🔍 DATA QUALITY:');
    log.info(`   Missing names: ${dataQuality.missing_names}`);
    log.info(`   Missing sets: ${dataQuality.missing_sets}`);
    log.info(`   Missing card numbers: ${dataQuality.missing_numbers}`);

    log.info('');
    if (priceChartingCards.count > 0) {
      log.info(`✅ PriceCharting integration: ${priceChartingCards.count} cards have PC IDs`);
    } else {
      log.info('❌ No PriceCharting data found - ready for bulk import!');
    }

    log.info('🎉 Database analysis completed!');
    
  } catch (error) {
    log.error('💥 Analysis failed:', error);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Analysis failed:', error);
    process.exit(1);
  });
}