#!/usr/bin/env node

/**
 * CardMint Throughput Benchmarking Suite
 * Tests single card, batch, and sustained load performance
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const FormData = require('form-data');
const { performance } = require('perf_hooks');

// Configuration
const ML_SERVER = process.env.REMOTE_ML_HOST ? 
  `http://${process.env.REMOTE_ML_HOST}:${process.env.REMOTE_ML_PORT || 5001}` : 
  'http://10.0.24.174:5001';
const CARDMINT_SERVER = 'http://localhost:3000';

// Test configurations
const TESTS = {
  single: { cards: 1, concurrent: 1, iterations: 5 },
  batch: { cards: 9, concurrent: 2, iterations: 3 },
  sustained: { cards: 50, concurrent: 2, duration: 60000 } // 1 minute
};

// Metrics storage
let benchmarks = {
  single: [],
  batch: [],
  sustained: [],
  memory: [],
  errors: []
};

// Color output helpers
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

// Get system metrics
async function getSystemMetrics() {
  try {
    const memUsage = process.memoryUsage();
    const response = await axios.get(`${ML_SERVER}/status`, { timeout: 1000 });
    
    return {
      node_memory_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      ml_memory_mb: response.data.resources?.memory_mb || 0,
      ml_cpu_percent: response.data.resources?.cpu_percent || 0,
      ml_queue_depth: response.data.queue?.depth || 0,
      timestamp: Date.now()
    };
  } catch (error) {
    return null;
  }
}

// Process a single card
async function processCard(imagePath, requestId = null) {
  const imageBuffer = await fs.readFile(imagePath);
  
  const formData = new FormData();
  formData.append('image', imageBuffer, {
    filename: path.basename(imagePath),
    contentType: 'image/jpeg'
  });
  
  if (requestId) {
    formData.append('request_id', requestId);
  }
  
  const startTime = performance.now();
  
  try {
    const response = await axios.post(`${ML_SERVER}/identify`, formData, {
      headers: formData.getHeaders(),
      timeout: 10000
    });
    
    const endTime = performance.now();
    const processingTime = endTime - startTime;
    
    return {
      success: response.data.success,
      processingTime,
      cached: response.data.cached || false,
      confidence: response.data.confidence,
      requestId
    };
  } catch (error) {
    const endTime = performance.now();
    const processingTime = endTime - startTime;
    
    if (error.response?.status === 429) {
      return {
        success: false,
        processingTime,
        error: 'rate_limited',
        requestId
      };
    }
    
    return {
      success: false,
      processingTime,
      error: error.message,
      requestId
    };
  }
}

// Benchmark single card processing
async function benchmarkSingleCard() {
  log('\n' + '═'.repeat(50), colors.blue);
  log('Single Card Processing Benchmark', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  const testImage = '/home/profusionai/CardMint/test-images/test_clear_blissey.jpg';
  const results = [];
  
  log(`\nRunning ${TESTS.single.iterations} iterations...`);
  
  for (let i = 0; i < TESTS.single.iterations; i++) {
    log(`\n[Iteration ${i + 1}/${TESTS.single.iterations}]`, colors.cyan);
    
    const startMetrics = await getSystemMetrics();
    const result = await processCard(testImage, `single-${i}`);
    const endMetrics = await getSystemMetrics();
    
    results.push(result);
    
    if (result.success) {
      log(`✅ Success in ${result.processingTime.toFixed(0)}ms${result.cached ? ' (cached)' : ''}`, colors.green);
    } else {
      log(`❌ Failed: ${result.error} (${result.processingTime.toFixed(0)}ms)`, colors.red);
    }
    
    if (startMetrics && endMetrics) {
      log(`   Memory: ${endMetrics.ml_memory_mb}MB | CPU: ${endMetrics.ml_cpu_percent}%`);
    }
    
    // Wait between iterations to avoid cache effects
    if (i < TESTS.single.iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Calculate statistics
  const successfulResults = results.filter(r => r.success);
  const times = successfulResults.map(r => r.processingTime);
  const nonCachedTimes = successfulResults.filter(r => !r.cached).map(r => r.processingTime);
  
  if (times.length > 0) {
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    
    log('\n📊 Single Card Results:', colors.cyan);
    log(`   Success rate: ${(successfulResults.length / results.length * 100).toFixed(1)}%`);
    log(`   Average time: ${avgTime.toFixed(0)}ms`);
    log(`   Min time: ${minTime.toFixed(0)}ms`);
    log(`   Max time: ${maxTime.toFixed(0)}ms`);
    
    if (nonCachedTimes.length > 0) {
      const avgNonCached = nonCachedTimes.reduce((a, b) => a + b, 0) / nonCachedTimes.length;
      log(`   Avg non-cached: ${avgNonCached.toFixed(0)}ms`);
    }
    
    benchmarks.single = results;
    
    // Performance assessment
    if (avgTime < 3000) {
      log('⚡ Excellent single card performance!', colors.green);
    } else if (avgTime < 5000) {
      log('✓ Good single card performance', colors.green);
    } else {
      log('⚠️  Single card performance needs improvement', colors.yellow);
    }
  }
}

// Benchmark batch processing
async function benchmarkBatchProcessing() {
  log('\n' + '═'.repeat(50), colors.blue);
  log('Batch Processing Benchmark', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  // Get all test images
  const testDir = '/home/profusionai/CardMint/test-images';
  const captureDir = '/home/profusionai/CardMint/captures';
  
  let testImages = [];
  
  try {
    const testFiles = await fs.readdir(testDir);
    testImages = testFiles
      .filter(f => f.endsWith('.jpg'))
      .map(f => path.join(testDir, f));
  } catch (error) {
    log('⚠️  Could not read test images', colors.yellow);
  }
  
  try {
    const captureFiles = await fs.readdir(captureDir);
    const captureImages = captureFiles
      .filter(f => f.endsWith('.JPG') || f.endsWith('.jpg'))
      .slice(0, 6)
      .map(f => path.join(captureDir, f));
    testImages = [...testImages, ...captureImages];
  } catch (error) {
    log('⚠️  Could not read capture images', colors.yellow);
  }
  
  if (testImages.length === 0) {
    log('❌ No test images found', colors.red);
    return;
  }
  
  log(`\nTesting with ${testImages.length} images, ${TESTS.batch.concurrent} concurrent requests`);
  
  for (let iteration = 0; iteration < TESTS.batch.iterations; iteration++) {
    log(`\n[Batch ${iteration + 1}/${TESTS.batch.iterations}]`, colors.cyan);
    
    const batchStartTime = performance.now();
    const startMetrics = await getSystemMetrics();
    
    // Process batch with concurrency limit
    const batchPromises = [];
    for (let i = 0; i < Math.min(testImages.length, TESTS.batch.cards); i++) {
      if (batchPromises.length >= TESTS.batch.concurrent) {
        // Wait for one to complete before starting next
        await Promise.race(batchPromises);
        batchPromises.splice(batchPromises.findIndex(p => p), 1);
      }
      
      const promise = processCard(testImages[i % testImages.length], `batch-${iteration}-${i}`);
      batchPromises.push(promise);
    }
    
    // Wait for all remaining
    const results = await Promise.all(batchPromises);
    
    const batchEndTime = performance.now();
    const batchTime = batchEndTime - batchStartTime;
    const endMetrics = await getSystemMetrics();
    
    const successful = results.filter(r => r.success).length;
    const rateLimited = results.filter(r => r.error === 'rate_limited').length;
    
    log(`   Completed: ${successful}/${results.length} successful`);
    log(`   Total time: ${batchTime.toFixed(0)}ms`);
    log(`   Throughput: ${(results.length / (batchTime / 1000)).toFixed(1)} cards/sec`);
    
    if (rateLimited > 0) {
      log(`   ⚠️  Rate limited: ${rateLimited} requests`, colors.yellow);
    }
    
    if (startMetrics && endMetrics) {
      log(`   Peak memory: ${Math.max(startMetrics.ml_memory_mb, endMetrics.ml_memory_mb)}MB`);
      log(`   Peak queue: ${Math.max(startMetrics.ml_queue_depth, endMetrics.ml_queue_depth)}`);
    }
    
    benchmarks.batch.push({
      cards: results.length,
      successful,
      totalTime: batchTime,
      throughput: results.length / (batchTime / 1000),
      rateLimited
    });
    
    // Wait between batches
    if (iteration < TESTS.batch.iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  // Calculate batch statistics
  if (benchmarks.batch.length > 0) {
    const avgThroughput = benchmarks.batch.reduce((a, b) => a + b.throughput, 0) / benchmarks.batch.length;
    const successRate = benchmarks.batch.reduce((a, b) => a + (b.successful / b.cards), 0) / benchmarks.batch.length * 100;
    
    log('\n📊 Batch Processing Results:', colors.cyan);
    log(`   Average throughput: ${avgThroughput.toFixed(1)} cards/sec`);
    log(`   Success rate: ${successRate.toFixed(1)}%`);
    log(`   Cards per minute: ${(avgThroughput * 60).toFixed(0)}`);
    
    // Performance assessment
    if (avgThroughput > 3) {
      log('⚡ Excellent batch throughput!', colors.green);
    } else if (avgThroughput > 2) {
      log('✓ Good batch throughput', colors.green);
    } else {
      log('⚠️  Batch throughput could be improved', colors.yellow);
    }
  }
}

// Benchmark sustained load
async function benchmarkSustainedLoad() {
  log('\n' + '═'.repeat(50), colors.blue);
  log('Sustained Load Benchmark', colors.blue);
  log('═'.repeat(50), colors.blue);
  
  const testImage = '/home/profusionai/CardMint/test-images/test_clear_blissey.jpg';
  
  log(`\nRunning sustained load test for ${TESTS.sustained.duration / 1000} seconds...`);
  log(`Target: ${TESTS.sustained.cards} cards with ${TESTS.sustained.concurrent} concurrent requests`);
  
  const startTime = performance.now();
  const endTime = startTime + TESTS.sustained.duration;
  
  let cardsProcessed = 0;
  let successCount = 0;
  let errorCount = 0;
  let rateLimitCount = 0;
  let totalProcessingTime = 0;
  let maxMemory = 0;
  let maxQueueDepth = 0;
  
  const activeRequests = [];
  let requestId = 0;
  
  // Start monitoring memory
  const memoryMonitor = setInterval(async () => {
    const metrics = await getSystemMetrics();
    if (metrics) {
      maxMemory = Math.max(maxMemory, metrics.ml_memory_mb);
      maxQueueDepth = Math.max(maxQueueDepth, metrics.ml_queue_depth);
      benchmarks.memory.push(metrics);
    }
  }, 2000);
  
  while (performance.now() < endTime && cardsProcessed < TESTS.sustained.cards) {
    // Maintain concurrent requests
    while (activeRequests.length < TESTS.sustained.concurrent && cardsProcessed < TESTS.sustained.cards) {
      const id = `sustained-${requestId++}`;
      const promise = processCard(testImage, id).then(result => {
        if (result.success) {
          successCount++;
        } else if (result.error === 'rate_limited') {
          rateLimitCount++;
        } else {
          errorCount++;
        }
        totalProcessingTime += result.processingTime;
        
        // Remove from active requests
        const index = activeRequests.indexOf(promise);
        if (index > -1) {
          activeRequests.splice(index, 1);
        }
        
        return result;
      });
      
      activeRequests.push(promise);
      cardsProcessed++;
    }
    
    // Wait for at least one to complete
    if (activeRequests.length > 0) {
      await Promise.race(activeRequests);
    }
    
    // Progress update
    if (cardsProcessed % 10 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      const rate = successCount / elapsed;
      process.stdout.write(`\r   Progress: ${cardsProcessed}/${TESTS.sustained.cards} cards | ${rate.toFixed(1)} cards/sec | ${successCount} successful`);
    }
  }
  
  // Wait for remaining requests
  await Promise.all(activeRequests);
  
  clearInterval(memoryMonitor);
  
  const totalTime = performance.now() - startTime;
  const throughput = successCount / (totalTime / 1000);
  
  console.log(''); // New line after progress
  
  log('\n📊 Sustained Load Results:', colors.cyan);
  log(`   Total cards processed: ${cardsProcessed}`);
  log(`   Successful: ${successCount} (${(successCount / cardsProcessed * 100).toFixed(1)}%)`);
  log(`   Errors: ${errorCount}`);
  log(`   Rate limited: ${rateLimitCount}`);
  log(`   Total time: ${(totalTime / 1000).toFixed(1)}s`);
  log(`   Average throughput: ${throughput.toFixed(1)} cards/sec`);
  log(`   Cards per minute: ${(throughput * 60).toFixed(0)}`);
  log(`   Average latency: ${(totalProcessingTime / cardsProcessed).toFixed(0)}ms`);
  log(`   Peak memory: ${maxMemory}MB`);
  log(`   Peak queue depth: ${maxQueueDepth}`);
  
  benchmarks.sustained = {
    cardsProcessed,
    successCount,
    errorCount,
    rateLimitCount,
    totalTime,
    throughput,
    avgLatency: totalProcessingTime / cardsProcessed,
    peakMemory: maxMemory,
    peakQueue: maxQueueDepth
  };
  
  // Check for memory leaks
  const memoryPoints = benchmarks.memory;
  if (memoryPoints.length > 5) {
    const firstQuarter = memoryPoints.slice(0, Math.floor(memoryPoints.length / 4));
    const lastQuarter = memoryPoints.slice(-Math.floor(memoryPoints.length / 4));
    
    const avgFirst = firstQuarter.reduce((a, b) => a + b.ml_memory_mb, 0) / firstQuarter.length;
    const avgLast = lastQuarter.reduce((a, b) => a + b.ml_memory_mb, 0) / lastQuarter.length;
    
    const memoryGrowth = ((avgLast - avgFirst) / avgFirst) * 100;
    
    if (memoryGrowth > 20) {
      log(`⚠️  Potential memory leak detected (${memoryGrowth.toFixed(1)}% growth)`, colors.yellow);
    } else {
      log('✅ No memory leaks detected', colors.green);
    }
  }
  
  // Performance assessment
  if (throughput > 3 && successCount / cardsProcessed > 0.95) {
    log('⚡ Excellent sustained performance!', colors.green);
  } else if (throughput > 2 && successCount / cardsProcessed > 0.90) {
    log('✓ Good sustained performance', colors.green);
  } else {
    log('⚠️  Sustained performance needs improvement', colors.yellow);
  }
}

// Main benchmark runner
async function runBenchmarks() {
  log('═'.repeat(50), colors.magenta);
  log('CardMint Throughput Benchmarking Suite', colors.magenta);
  log('═'.repeat(50), colors.magenta);
  
  log(`\nML Server: ${ML_SERVER}`);
  log(`CardMint Server: ${CARDMINT_SERVER}`);
  
  // Check server health first
  try {
    const health = await axios.get(`${ML_SERVER}/status`, { timeout: 2000 });
    if (health.data.status !== 'healthy') {
      log('❌ ML server not healthy', colors.red);
      process.exit(1);
    }
    log('✅ ML server is healthy', colors.green);
  } catch (error) {
    log('❌ Cannot connect to ML server', colors.red);
    process.exit(1);
  }
  
  // Run benchmarks
  await benchmarkSingleCard();
  await benchmarkBatchProcessing();
  await benchmarkSustainedLoad();
  
  // Final summary
  log('\n' + '═'.repeat(50), colors.magenta);
  log('Benchmark Summary', colors.magenta);
  log('═'.repeat(50), colors.magenta);
  
  // Single card summary
  if (benchmarks.single.length > 0) {
    const avgSingle = benchmarks.single
      .filter(r => r.success)
      .reduce((a, b) => a + b.processingTime, 0) / benchmarks.single.filter(r => r.success).length;
    log(`\n📌 Single Card: ${avgSingle.toFixed(0)}ms average`);
  }
  
  // Batch summary
  if (benchmarks.batch.length > 0) {
    const avgBatchThroughput = benchmarks.batch.reduce((a, b) => a + b.throughput, 0) / benchmarks.batch.length;
    log(`📌 Batch Processing: ${avgBatchThroughput.toFixed(1)} cards/sec`);
  }
  
  // Sustained summary
  if (benchmarks.sustained.throughput) {
    log(`📌 Sustained Load: ${benchmarks.sustained.throughput.toFixed(1)} cards/sec`);
    log(`📌 Cards per minute: ${(benchmarks.sustained.throughput * 60).toFixed(0)}`);
  }
  
  // Performance targets
  log('\n🎯 Performance vs Targets:', colors.cyan);
  
  const targets = [
    { 
      name: 'Single card < 5 seconds', 
      met: benchmarks.single.filter(r => r.success && r.processingTime < 5000).length / benchmarks.single.length > 0.9 
    },
    { 
      name: 'Throughput > 12 cards/minute', 
      met: benchmarks.sustained.throughput * 60 > 12 
    },
    { 
      name: 'Memory usage < 5GB', 
      met: benchmarks.sustained.peakMemory < 5000 
    },
    { 
      name: 'Success rate > 95%', 
      met: benchmarks.sustained.successCount / benchmarks.sustained.cardsProcessed > 0.95 
    }
  ];
  
  targets.forEach(target => {
    if (target.met) {
      log(`  ✅ ${target.name}`, colors.green);
    } else {
      log(`  ❌ ${target.name}`, colors.red);
    }
  });
  
  const allTargetsMet = targets.every(t => t.met);
  
  log('');
  if (allTargetsMet) {
    log('🎉 All performance targets achieved!', colors.green);
  } else {
    log('⚠️  Some performance targets need work', colors.yellow);
  }
}

// Run benchmarks
runBenchmarks().catch(error => {
  log(`Fatal error: ${error.message}`, colors.red);
  console.error(error);
  process.exit(1);
});