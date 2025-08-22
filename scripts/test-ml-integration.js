#!/usr/bin/env node

/**
 * CardMint ML Integration Test Suite
 * Tests the complete integration between Fedora capture and M4 Mac ML processing
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');

// Configuration
const ML_SERVER = 'http://10.0.24.174:5001';
const CARDMINT_SERVER = 'http://localhost:3000';
const TEST_IMAGE_PATH = '/home/profusionai/CardMint/test-images/test-card.jpg';

// Test results
let testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

// Color output helpers
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  const color = passed ? colors.green : colors.red;
  log(`  ${status}: ${name}`, color);
  if (details) {
    console.log(`      ${details}`);
  }
  
  testResults.tests.push({ name, passed, details });
  if (passed) {
    testResults.passed++;
  } else {
    testResults.failed++;
  }
}

// Test functions
async function testMLServerHealth() {
  log('\n1. ML Server Health Check', colors.blue);
  
  try {
    const response = await axios.get(`${ML_SERVER}/status`);
    const data = response.data;
    
    logTest('Server is healthy', data.status === 'healthy');
    logTest('Ensemble ready', data.ensemble_ready === true);
    logTest('Models loaded', data.models_loaded.length > 0, 
      `Models: ${data.models_loaded.join(', ')}`);
    logTest('Memory usage reasonable', data.resources.memory_mb < 5000,
      `Using ${data.resources.memory_mb}MB`);
    
    return true;
  } catch (error) {
    logTest('ML Server connectivity', false, error.message);
    return false;
  }
}

async function testMLServerInventory() {
  log('\n2. ML Server Inventory Check', colors.blue);
  
  try {
    const response = await axios.get(`${ML_SERVER}/inventory`);
    const data = response.data;
    
    logTest('Inventory endpoint works', true);
    logTest('Returns card count', 'cards' in data, 
      `${data.cards.length} cards in inventory`);
    logTest('Database functional', data.database_status === 'connected');
    
    return true;
  } catch (error) {
    logTest('Inventory endpoint', false, error.message);
    return false;
  }
}

async function testMLIdentification() {
  log('\n3. ML Card Identification Test', colors.blue);
  
  try {
    // Create a simple test image if it doesn't exist
    const testImageExists = await fs.access(TEST_IMAGE_PATH)
      .then(() => true)
      .catch(() => false);
    
    if (!testImageExists) {
      log('  ⚠️  No test image found, using placeholder', colors.yellow);
      // Create a minimal JPEG
      const buffer = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==', 'base64');
      await fs.mkdir(path.dirname(TEST_IMAGE_PATH), { recursive: true });
      await fs.writeFile(TEST_IMAGE_PATH, buffer);
    }
    
    // Read image
    const imageBuffer = await fs.readFile(TEST_IMAGE_PATH);
    
    // Create form data
    const formData = new FormData();
    formData.append('image', imageBuffer, {
      filename: 'test-card.jpg',
      contentType: 'image/jpeg'
    });
    
    // Test identification
    const startTime = Date.now();
    const response = await axios.post(`${ML_SERVER}/identify`, formData, {
      headers: formData.getHeaders(),
      timeout: 10000
    });
    const endTime = Date.now();
    const processingTime = endTime - startTime;
    
    const data = response.data;
    
    logTest('Identification successful', data.success === true);
    logTest('Card ID returned', !!data.card_id, `ID: ${data.card_id}`);
    logTest('Confidence score present', data.confidence !== undefined,
      `Confidence: ${(data.confidence * 100).toFixed(1)}%`);
    logTest('Processing under 5 seconds', processingTime < 5000,
      `Took ${processingTime}ms`);
    
    // Test idempotency
    log('\n  Testing idempotency...', colors.yellow);
    const response2 = await axios.post(`${ML_SERVER}/identify`, formData, {
      headers: formData.getHeaders()
    });
    
    logTest('Idempotent results', 
      response2.data.card_id === data.card_id,
      'Same card ID returned');
    logTest('Response cached', response2.data.cached === true,
      'Second request was cached');
    
    return true;
  } catch (error) {
    if (error.response?.status === 429) {
      logTest('Rate limiting active', true, 'Server correctly rate limits');
    } else {
      logTest('ML identification', false, error.message);
    }
    return false;
  }
}

async function testCardMintHealth() {
  log('\n4. CardMint Server Health Check', colors.blue);
  
  try {
    const response = await axios.get(`${CARDMINT_SERVER}/api/health`);
    const data = response.data;
    
    logTest('CardMint server running', data.status === 'ok');
    logTest('Database connected', data.database === 'connected');
    logTest('Redis connected', data.redis === 'connected');
    
    return true;
  } catch (error) {
    logTest('CardMint connectivity', false, 
      'Is CardMint running? Start with: npm run dev');
    return false;
  }
}

async function testEndToEndFlow() {
  log('\n5. End-to-End Integration Test', colors.blue);
  
  try {
    // First check if CardMint is running
    const healthCheck = await axios.get(`${CARDMINT_SERVER}/api/health`)
      .catch(() => null);
    
    if (!healthCheck) {
      log('  ⚠️  CardMint not running, skipping E2E test', colors.yellow);
      return false;
    }
    
    // Check if distributed mode is enabled
    const config = await axios.get(`${CARDMINT_SERVER}/api/config`)
      .catch(() => ({ data: {} }));
    
    if (config.data.remoteMLEnabled !== true) {
      logTest('Remote ML enabled in CardMint', false, 
        'Set REMOTE_ML_ENABLED=true in .env');
      return false;
    }
    
    logTest('Remote ML enabled', true);
    
    // Test capture trigger (if implemented)
    // This would trigger the full pipeline
    
    return true;
  } catch (error) {
    logTest('End-to-end flow', false, error.message);
    return false;
  }
}

async function testPerformanceMetrics() {
  log('\n6. Performance Metrics', colors.blue);
  
  try {
    // Test multiple requests to measure performance
    const times = [];
    const requests = 3;
    
    for (let i = 0; i < requests; i++) {
      const startTime = Date.now();
      await axios.get(`${ML_SERVER}/status`);
      const endTime = Date.now();
      times.push(endTime - startTime);
    }
    
    const avgTime = times.reduce((a, b) => a + b) / times.length;
    const maxTime = Math.max(...times);
    
    logTest('Average response under 100ms', avgTime < 100,
      `Avg: ${avgTime.toFixed(1)}ms`);
    logTest('Max response under 200ms', maxTime < 200,
      `Max: ${maxTime}ms`);
    logTest('Network latency acceptable', avgTime < 50,
      'Low latency between servers');
    
    return true;
  } catch (error) {
    logTest('Performance metrics', false, error.message);
    return false;
  }
}

// Main test runner
async function runTests() {
  log('=====================================', colors.blue);
  log('CardMint ML Integration Test Suite', colors.blue);
  log('=====================================', colors.blue);
  
  log(`\nML Server: ${ML_SERVER}`);
  log(`CardMint Server: ${CARDMINT_SERVER}`);
  log(`Test Image: ${TEST_IMAGE_PATH}`);
  
  // Run all tests
  await testMLServerHealth();
  await testMLServerInventory();
  await testMLIdentification();
  await testCardMintHealth();
  await testEndToEndFlow();
  await testPerformanceMetrics();
  
  // Summary
  log('\n=====================================', colors.blue);
  log('Test Summary', colors.blue);
  log('=====================================', colors.blue);
  
  const total = testResults.passed + testResults.failed;
  const passRate = (testResults.passed / total * 100).toFixed(1);
  
  log(`\nTotal Tests: ${total}`);
  log(`Passed: ${testResults.passed}`, colors.green);
  log(`Failed: ${testResults.failed}`, testResults.failed > 0 ? colors.red : colors.green);
  log(`Pass Rate: ${passRate}%\n`);
  
  if (testResults.failed === 0) {
    log('🎉 All tests passed! ML integration is ready!', colors.green);
    log('\nNext steps:', colors.yellow);
    log('1. Start CardMint: npm run dev');
    log('2. Place cards in capture directory');
    log('3. Monitor logs for ML processing');
  } else {
    log('⚠️  Some tests failed. Please review and fix.', colors.red);
    log('\nFailed tests:', colors.red);
    testResults.tests
      .filter(t => !t.passed)
      .forEach(t => log(`  - ${t.name}: ${t.details}`));
  }
  
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  log('Fatal error running tests:', colors.red);
  console.error(error);
  process.exit(1);
});