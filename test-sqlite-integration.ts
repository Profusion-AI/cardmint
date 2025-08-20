#!/usr/bin/env tsx

import { initializeDatabase, closeDatabase, insertCard, getAllCards, getCardCount } from './src/storage/sqlite-database';
import { createLogger } from './src/utils/logger';

const logger = createLogger('test-sqlite');

async function testSQLiteIntegration() {
  try {
    logger.info('Starting SQLite integration test...');
    
    // Initialize database
    logger.info('Initializing SQLite database...');
    await initializeDatabase();
    
    // Test inserting a card
    logger.info('Inserting test card...');
    const testCard = await insertCard({
      image_url: '/test/path/DSC00001.JPG',
      status: 'captured',
      name: 'Pikachu',
      set_name: 'Base Set',
      card_number: '58/102',
      rarity: 'Common',
      type: 'Electric',
      confidence_score: 0.95
    });
    
    logger.info('Created card:', testCard);
    
    // Test getting all cards
    logger.info('Fetching all cards...');
    const allCards = await getAllCards();
    logger.info(`Found ${allCards.length} cards`);
    
    // Test card count
    const count = await getCardCount();
    logger.info(`Total cards in database: ${count}`);
    
    // Display first card details
    if (allCards.length > 0) {
      logger.info('First card details:', {
        id: allCards[0].id,
        name: allCards[0].name,
        status: allCards[0].status,
        captured_at: allCards[0].captured_at
      });
    }
    
    logger.info('✅ SQLite integration test completed successfully!');
    logger.info('Database location: ./data/cardmint.db');
    
  } catch (error) {
    logger.error('Test failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

// Run the test
testSQLiteIntegration();