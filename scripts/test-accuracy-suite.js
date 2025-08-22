#!/usr/bin/env node

/**
 * CardMint ML Accuracy Evaluation Suite
 * Tests the accuracy of card recognition against known ground truth data
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');

// Configuration
const ML_SERVER = process.env.REMOTE_ML_HOST ? 
  `http://${process.env.REMOTE_ML_HOST}:${process.env.REMOTE_ML_PORT || 5001}` : 
  'http://10.0.24.174:5001';

// Ground truth data for test cards
const GROUND_TRUTH = {
  'test_clear_blissey.jpg': {
    name: 'Blissey',
    hp: 120,
    stage: 'Stage 1',
    type: 'Colorless',
    set_number: '2/64',
    rarity: 'Rare Holo',
    evolves_from: 'Chansey',
    attacks: [
      { name: 'Double-edge', damage: 80 }
    ]
  },
  'blissey_test.jpg': {
    name: 'Blissey',
    hp: 120,
    stage: 'Stage 1',
    type: 'Colorless',
    variations: ['holo', 'non-holo']
  },
  'test-card.jpg': {
    name: 'Unknown', // Generic test card
    confidence_threshold: 0.5
  }
};

// Accuracy metrics
let metrics = {
  total_tests: 0,
  successful_identifications: 0,
  name_accuracy: { correct: 0, total: 0 },
  hp_accuracy: { correct: 0, total: 0 },
  set_number_accuracy: { correct: 0, total: 0 },
  type_accuracy: { correct: 0, total: 0 },
  confidence_scores: [],
  processing_times: [],
  errors: []
};

// Color output helpers
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

// Helper function to extract number from string
function extractNumber(str) {
  if (!str) return null;
  const match = str.toString().match(/\d+/);
  return match ? parseInt(match[0]) : null;
}

// Helper function to normalize string for comparison
function normalizeString(str) {
  if (!str) return '';
  return str.toString().toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Test a single card image
async function testCardAccuracy(imageName, groundTruth) {
  const imagePath = path.join('/home/profusionai/CardMint/test-images', imageName);
  
  log(`\nTesting: ${imageName}`, colors.cyan);
  log('─'.repeat(50));
  
  try {
    // Check if image exists
    await fs.access(imagePath);
    
    // Read image
    const imageBuffer = await fs.readFile(imagePath);
    
    // Create form data
    const formData = new FormData();
    formData.append('image', imageBuffer, {
      filename: imageName,
      contentType: 'image/jpeg'
    });
    
    // Send to ML server
    const startTime = Date.now();
    const response = await axios.post(`${ML_SERVER}/identify`, formData, {
      headers: formData.getHeaders(),
      timeout: 10000
    });
    const processingTime = Date.now() - startTime;
    
    metrics.total_tests++;
    metrics.processing_times.push(processingTime);
    
    const result = response.data;
    
    // Check if identification was successful
    if (result.success) {
      metrics.successful_identifications++;
      log(`✅ Identification successful`, colors.green);
      
      // Record confidence
      if (result.confidence !== undefined) {
        metrics.confidence_scores.push(result.confidence);
        log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      }
      
      // Extract card data
      const cardData = result.card_data || {};
      
      // Test name accuracy
      if (groundTruth.name && groundTruth.name !== 'Unknown') {
        metrics.name_accuracy.total++;
        const extractedName = cardData.name || result.card_name || '';
        
        if (normalizeString(extractedName) === normalizeString(groundTruth.name)) {
          metrics.name_accuracy.correct++;
          log(`   ✓ Name: ${extractedName} (correct)`, colors.green);
        } else {
          log(`   ✗ Name: ${extractedName} (expected: ${groundTruth.name})`, colors.red);
        }
      }
      
      // Test HP accuracy
      if (groundTruth.hp) {
        metrics.hp_accuracy.total++;
        const extractedHP = extractNumber(cardData.hp);
        
        if (extractedHP === groundTruth.hp) {
          metrics.hp_accuracy.correct++;
          log(`   ✓ HP: ${extractedHP} (correct)`, colors.green);
        } else {
          log(`   ✗ HP: ${extractedHP} (expected: ${groundTruth.hp})`, colors.red);
        }
      }
      
      // Test set number accuracy
      if (groundTruth.set_number) {
        metrics.set_number_accuracy.total++;
        const extractedSetNumber = cardData.set_number || cardData.number || '';
        
        if (extractedSetNumber.includes(groundTruth.set_number) || 
            groundTruth.set_number.includes(extractedSetNumber)) {
          metrics.set_number_accuracy.correct++;
          log(`   ✓ Set #: ${extractedSetNumber} (correct)`, colors.green);
        } else {
          log(`   ✗ Set #: ${extractedSetNumber} (expected: ${groundTruth.set_number})`, colors.red);
        }
      }
      
      // Test type accuracy
      if (groundTruth.type) {
        metrics.type_accuracy.total++;
        const extractedType = cardData.type || cardData.types?.[0] || '';
        
        if (normalizeString(extractedType) === normalizeString(groundTruth.type)) {
          metrics.type_accuracy.correct++;
          log(`   ✓ Type: ${extractedType} (correct)`, colors.green);
        } else {
          log(`   ✗ Type: ${extractedType} (expected: ${groundTruth.type})`, colors.red);
        }
      }
      
      // Check confidence threshold
      if (groundTruth.confidence_threshold && result.confidence < groundTruth.confidence_threshold) {
        log(`   ⚠️  Confidence below threshold (${groundTruth.confidence_threshold})`, colors.yellow);
      }
      
      log(`   Processing time: ${processingTime}ms`);
      
    } else {
      log(`❌ Identification failed`, colors.red);
      if (result.error) {
        log(`   Error: ${result.error}`, colors.red);
        metrics.errors.push({ image: imageName, error: result.error });
      }
    }
    
  } catch (error) {
    metrics.total_tests++;
    log(`❌ Test failed: ${error.message}`, colors.red);
    metrics.errors.push({ image: imageName, error: error.message });
    
    if (error.response?.status === 429) {
      log(`   ℹ️  Rate limiting detected (normal under load)`, colors.yellow);
    }
  }
}

// Test with capture images
async function testCaptureImages() {
  log('\n' + '═'.repeat(50), colors.blue);
  log('Testing Camera Capture Images', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  const captureDir = '/home/profusionai/CardMint/captures';
  
  try {
    const files = await fs.readdir(captureDir);
    const jpgFiles = files.filter(f => f.endsWith('.JPG') || f.endsWith('.jpg')).slice(0, 3); // Test first 3
    
    for (const file of jpgFiles) {
      const imagePath = path.join(captureDir, file);
      
      log(`\nTesting capture: ${file}`, colors.cyan);
      log('─'.repeat(50));
      
      try {
        const imageBuffer = await fs.readFile(imagePath);
        
        const formData = new FormData();
        formData.append('image', imageBuffer, {
          filename: file,
          contentType: 'image/jpeg'
        });
        
        const startTime = Date.now();
        const response = await axios.post(`${ML_SERVER}/identify`, formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });
        const processingTime = Date.now() - startTime;
        
        if (response.data.success) {
          log(`✅ Successfully processed`, colors.green);
          log(`   Card ID: ${response.data.card_id}`);
          log(`   Confidence: ${(response.data.confidence * 100).toFixed(1)}%`);
          log(`   Processing time: ${processingTime}ms`);
          
          const cardData = response.data.card_data || {};
          if (cardData.name) {
            log(`   Card name: ${cardData.name}`);
          }
        } else {
          log(`⚠️  Could not identify card`, colors.yellow);
        }
        
      } catch (error) {
        log(`❌ Error processing capture: ${error.message}`, colors.red);
      }
    }
  } catch (error) {
    log(`⚠️  Could not read capture directory`, colors.yellow);
  }
}

// Calculate accuracy percentages
function calculateAccuracy(metric) {
  if (metric.total === 0) return 'N/A';
  return `${((metric.correct / metric.total) * 100).toFixed(1)}%`;
}

// Main test runner
async function runAccuracyTests() {
  log('═'.repeat(50), colors.blue);
  log('CardMint ML Accuracy Evaluation Suite', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  log(`\nML Server: ${ML_SERVER}`);
  log(`Test Images: ${Object.keys(GROUND_TRUTH).length}`);
  
  // Test each card with ground truth
  for (const [imageName, groundTruth] of Object.entries(GROUND_TRUTH)) {
    await testCardAccuracy(imageName, groundTruth);
    
    // Small delay between tests to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Test with real capture images
  await testCaptureImages();
  
  // Calculate summary statistics
  const avgConfidence = metrics.confidence_scores.length > 0 ?
    metrics.confidence_scores.reduce((a, b) => a + b, 0) / metrics.confidence_scores.length : 0;
  
  const avgProcessingTime = metrics.processing_times.length > 0 ?
    metrics.processing_times.reduce((a, b) => a + b, 0) / metrics.processing_times.length : 0;
  
  // Display results
  log('\n' + '═'.repeat(50), colors.blue);
  log('Accuracy Test Results', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  log('\n📊 Overall Metrics:', colors.cyan);
  log(`   Total tests: ${metrics.total_tests}`);
  log(`   Successful identifications: ${metrics.successful_identifications} (${((metrics.successful_identifications / metrics.total_tests) * 100).toFixed(1)}%)`);
  log(`   Average confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  log(`   Average processing time: ${avgProcessingTime.toFixed(0)}ms`);
  
  log('\n🎯 Field Accuracy:', colors.cyan);
  log(`   Card Name: ${calculateAccuracy(metrics.name_accuracy)} (${metrics.name_accuracy.correct}/${metrics.name_accuracy.total})`);
  log(`   HP Values: ${calculateAccuracy(metrics.hp_accuracy)} (${metrics.hp_accuracy.correct}/${metrics.hp_accuracy.total})`);
  log(`   Set Numbers: ${calculateAccuracy(metrics.set_number_accuracy)} (${metrics.set_number_accuracy.correct}/${metrics.set_number_accuracy.total})`);
  log(`   Card Types: ${calculateAccuracy(metrics.type_accuracy)} (${metrics.type_accuracy.correct}/${metrics.type_accuracy.total})`);
  
  log('\n⚡ Performance Analysis:', colors.cyan);
  if (metrics.processing_times.length > 0) {
    const minTime = Math.min(...metrics.processing_times);
    const maxTime = Math.max(...metrics.processing_times);
    log(`   Min processing time: ${minTime}ms`);
    log(`   Max processing time: ${maxTime}ms`);
    log(`   Avg processing time: ${avgProcessingTime.toFixed(0)}ms`);
    
    const under3s = metrics.processing_times.filter(t => t < 3000).length;
    const under5s = metrics.processing_times.filter(t => t < 5000).length;
    log(`   Under 3 seconds: ${under3s}/${metrics.processing_times.length} (${(under3s / metrics.processing_times.length * 100).toFixed(1)}%)`);
    log(`   Under 5 seconds: ${under5s}/${metrics.processing_times.length} (${(under5s / metrics.processing_times.length * 100).toFixed(1)}%)`);
  }
  
  if (metrics.errors.length > 0) {
    log('\n⚠️  Errors encountered:', colors.yellow);
    metrics.errors.forEach(err => {
      log(`   ${err.image}: ${err.error}`);
    });
  }
  
  // Success criteria evaluation
  log('\n' + '═'.repeat(50), colors.blue);
  log('Success Criteria Evaluation', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  const nameAccuracy = metrics.name_accuracy.total > 0 ? 
    (metrics.name_accuracy.correct / metrics.name_accuracy.total) * 100 : 0;
  const overallAccuracy = (metrics.successful_identifications / metrics.total_tests) * 100;
  
  const criteria = [
    { name: 'Card name recognition > 95%', met: nameAccuracy > 95 },
    { name: 'HP/stats extraction > 90%', met: metrics.hp_accuracy.total > 0 && (metrics.hp_accuracy.correct / metrics.hp_accuracy.total) * 100 > 90 },
    { name: 'Overall confidence > 85%', met: avgConfidence > 0.85 },
    { name: 'Processing time < 5 seconds', met: avgProcessingTime < 5000 }
  ];
  
  criteria.forEach(criterion => {
    if (criterion.met) {
      log(`✅ ${criterion.name}`, colors.green);
    } else {
      log(`❌ ${criterion.name}`, colors.red);
    }
  });
  
  const allCriteriaMet = criteria.every(c => c.met);
  
  log('');
  if (allCriteriaMet) {
    log('🎉 All accuracy targets met!', colors.green);
  } else {
    log('⚠️  Some accuracy targets need improvement', colors.yellow);
  }
}

// Run tests
runAccuracyTests().catch(error => {
  log(`Fatal error: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});