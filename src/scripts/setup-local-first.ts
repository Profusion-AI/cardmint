#!/usr/bin/env ts-node

/**
 * Local-First Recognition Setup Script
 * Initializes the complete Local-First recognition system
 */

import * as path from 'path';
import { createLogger } from '../utils/logger';
import { runPrecomputeHashes } from '../worker/jobs/precompute-hashes';
import { DatabaseQueryService } from '../services/db/DatabaseQueryService';
import { PriceChartingLookupService } from '../services/valuation/PriceChartingLookupService';
import { LocalFirstPipeline } from '../worker/verification/LocalFirstPipeline';

const logger = createLogger('SetupLocalFirst');

async function setupLocalFirst(): Promise<void> {
  logger.info('🚀 Starting Local-First Recognition System Setup...');
  
  try {
    // Step 1: Validate environment
    logger.info('📋 Step 1: Validating environment...');
    await validateEnvironment();
    
    // Step 2: Initialize database connections
    logger.info('🗄️ Step 2: Initializing database connections...');
    const dbService = new DatabaseQueryService();
    await dbService.initialize();
    logger.info('Database connections established');
    
    // Step 3: Load pricing data
    logger.info('💰 Step 3: Loading pricing data...');
    const priceService = new PriceChartingLookupService();
    await priceService.initialize();
    const priceStats = priceService.getStats();
    logger.info(`Pricing service initialized: ${priceStats.totalRecords} records`);
    
    // Step 4: Precompute perceptual hashes
    logger.info('🔍 Step 4: Precomputing perceptual hashes...');
    const hashStats = await runPrecomputeHashes();
    logger.info(`Hash precomputation completed:`, hashStats);
    
    // Step 5: Initialize Local-First pipeline
    logger.info('🔄 Step 5: Initializing Local-First pipeline...');
    const pipeline = new LocalFirstPipeline();
    await pipeline.initialize();
    
    const validation = await pipeline.validateConfiguration();
    if (!validation.valid) {
      throw new Error(`Pipeline validation failed: ${validation.issues.join(', ')}`);
    }
    
    logger.info('Local-First pipeline initialized successfully');
    
    // Step 6: Run quick validation test
    logger.info('✅ Step 6: Running validation test...');
    await runValidationTest(pipeline);
    
    logger.info('🎉 Local-First Recognition System setup completed successfully!');
    
    // Print configuration summary
    const stats = pipeline.getStats();
    logger.info('📊 System Status:', {
      enabled: stats.enabled,
      mode: stats.mode,
      database: stats.services.database,
      pricing: stats.services.pricing,
      matching_initialized: stats.services.matching.initialized,
      matching_strategies: stats.services.matching.matchers
    });
    
  } catch (error) {
    logger.error('❌ Setup failed:', error);
    process.exit(1);
  }
}

async function validateEnvironment(): Promise<void> {
  const dataRoot = process.env.DATA_ROOT || './data';
  
  // Check required environment variables
  const requiredEnvVars = [
    'LOCAL_FIRST_MATCH',
    'LOCAL_MATCH_MIN_CONF', 
    'LOCAL_MODE',
    'DATA_ROOT'
  ];
  
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // Log configuration
  logger.info('Environment configuration:', {
    DATA_ROOT: dataRoot,
    LOCAL_FIRST_MATCH: process.env.LOCAL_FIRST_MATCH,
    LOCAL_MODE: process.env.LOCAL_MODE,
    LOCAL_MATCH_MIN_CONF: process.env.LOCAL_MATCH_MIN_CONF,
    LOCAL_CACHE_DIR: process.env.LOCAL_CACHE_DIR || path.join(dataRoot, 'cache', 'local')
  });
  
  // Check if Local-First is enabled
  if (process.env.LOCAL_FIRST_MATCH !== 'true') {
    logger.warn('⚠️ LOCAL_FIRST_MATCH is not enabled. Set to "true" to activate Local-First recognition.');
  }
}

async function runValidationTest(pipeline: LocalFirstPipeline): Promise<void> {
  try {
    const dataRoot = process.env.DATA_ROOT || './data';
    const imagesDir = path.join(dataRoot, 'pokemon_dataset', 'images');
    
    const fs = await import('fs/promises');
    const imageFiles = await fs.readdir(imagesDir);
    
    if (imageFiles.length === 0) {
      logger.warn('⚠️ No test images found. Skipping validation test.');
      return;
    }
    
    // Test with first available image
    const testImage = path.join(imagesDir, imageFiles[0]);
    logger.info(`Testing with image: ${imageFiles[0]}`);
    
    const startTime = Date.now();
    const result = await pipeline.process(testImage);
    const latency = Date.now() - startTime;
    
    logger.info('✅ Validation test completed:', {
      latency_ms: latency,
      confidence: result.local_match.confidence,
      decision: result.local_match.decision,
      strategies_used: result.local_match.strategy_chain.length,
      needs_ml_fallback: result.needs_ml_fallback
    });
    
    if (latency > 1000) {
      logger.warn(`⚠️ High latency detected: ${latency}ms. Consider optimization.`);
    }
    
  } catch (error) {
    logger.warn('⚠️ Validation test failed:', error);
    // Don't fail setup for test issues
  }
}

// CLI interface
async function main() {
  if (process.argv.includes('--help')) {
    console.log(`
CardMint Local-First Recognition Setup

Usage:
  npm run setup:local-first
  ts-node src/scripts/setup-local-first.ts

Environment Variables:
  LOCAL_FIRST_MATCH=true       Enable Local-First recognition
  LOCAL_MODE=hybrid            Mode: hybrid|local-only|ml-only  
  LOCAL_MATCH_MIN_CONF=0.85    Confidence threshold
  DATA_ROOT=./data             Data directory path
  LOCAL_CACHE_DIR=./data/cache/local  Cache directory

The setup will:
1. Validate environment configuration
2. Initialize database connections  
3. Load pricing data from CSV
4. Precompute perceptual hashes
5. Initialize Local-First pipeline
6. Run validation test
    `);
    process.exit(0);
  }
  
  await setupLocalFirst();
}

if (require.main === module) {
  main();
}