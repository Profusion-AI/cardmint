#!/usr/bin/env node

/**
 * Test script for Qwen2.5-VL Scanner Integration
 * Tests the complete pipeline from capture to recognition
 */

const path = require('path');
const fs = require('fs').promises;

// Add TypeScript support
require('ts-node/register');

async function main() {
  console.log('🧪 Testing Qwen Scanner Integration\n');
  console.log('=====================================\n');

  try {
    // Import the services
    const { qwenScanner } = require('../src/services/QwenScannerService');
    const { RemoteMLClient } = require('../src/services/RemoteMLClient');
    
    // Test 1: Check Qwen scanner availability
    console.log('1️⃣  Testing Qwen Scanner Availability...');
    const isAvailable = await qwenScanner.isAvailable();
    if (isAvailable) {
      console.log('   ✅ Qwen scanner is available\n');
    } else {
      console.log('   ❌ Qwen scanner is NOT available\n');
      process.exit(1);
    }

    // Test 2: Process a test card directly
    console.log('2️⃣  Testing Direct Scanner Processing...');
    const testImage = '/home/profusionai/CardMint/blissey_simple.jpg';
    
    // Check if test image exists
    try {
      await fs.access(testImage);
      console.log(`   📷 Using test image: ${testImage}`);
    } catch {
      console.log('   ❌ Test image not found\n');
      process.exit(1);
    }

    const startTime = Date.now();
    const result = await qwenScanner.processCard(testImage);
    const processingTime = Date.now() - startTime;

    if (result) {
      console.log('   ✅ Card processed successfully');
      console.log(`   📋 Card: ${result.name}`);
      console.log(`   🎯 Confidence: ${result.confidence}%`);
      console.log(`   ⏱️  Processing time: ${processingTime}ms\n`);
    } else {
      console.log('   ❌ Failed to process card\n');
      process.exit(1);
    }

    // Test 3: Test RemoteMLClient with Qwen integration
    console.log('3️⃣  Testing RemoteMLClient Integration...');
    
    // Set environment to use Qwen
    process.env.USE_QWEN_SCANNER = 'true';
    process.env.REMOTE_ML_ENABLED = 'true';
    process.env.REMOTE_ML_HOST = '10.0.24.174';
    
    const client = new RemoteMLClient();
    
    const request = {
      id: 'test-001',
      imagePath: testImage,
    };

    const mlResult = await client.recognizeCard(request);
    
    if (mlResult) {
      console.log('   ✅ RemoteMLClient integration successful');
      console.log(`   📋 Card: ${mlResult.card_name}`);
      console.log(`   🎯 Confidence: ${(mlResult.confidence * 100).toFixed(1)}%`);
      console.log(`   🖥️  Processing node: ${mlResult.processingNode}`);
      console.log(`   ⏱️  Total latency: ${mlResult.totalLatencyMs}ms\n`);
    } else {
      console.log('   ❌ RemoteMLClient integration failed\n');
      process.exit(1);
    }

    // Test 4: Check inventory
    console.log('4️⃣  Testing Inventory Management...');
    const inventory = await qwenScanner.getInventory();
    console.log(`   📦 Total cards in inventory: ${inventory.length}`);
    
    if (inventory.length > 0) {
      const latest = inventory[inventory.length - 1];
      console.log(`   📋 Latest card: ${latest.name}`);
      console.log(`   📅 Processed at: ${latest.processed_at}\n`);
    }

    // Test 5: Test stats
    console.log('5️⃣  Testing Statistics...');
    const stats = await qwenScanner.getStats();
    if (stats) {
      console.log('   ✅ Statistics retrieved successfully\n');
    } else {
      console.log('   ⚠️  No statistics available yet\n');
    }

    console.log('=====================================');
    console.log('✅ All tests passed successfully!');
    console.log('\n🎉 Qwen Scanner Integration is WORKING!\n');

    // Performance summary
    console.log('📊 Performance Summary:');
    console.log(`   • Scanner available: ✅`);
    console.log(`   • Processing time: ${processingTime}ms`);
    console.log(`   • Confidence level: ${result.confidence}%`);
    console.log(`   • Integration mode: Qwen2.5-VL`);
    console.log(`   • Mac server: 10.0.24.174:1234`);

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

// Run the tests
main().catch(console.error);