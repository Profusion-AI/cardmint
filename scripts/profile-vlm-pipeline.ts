#!/usr/bin/env tsx
/**
 * VLM Pipeline Profiling Script
 * 
 * Runs test cards through the pipeline to identify bottlenecks
 * and measure detailed timing for each stage.
 */

import path from 'path';
import { LmStudioInference } from '../src/adapters/lmstudio/LmStudioInference';
import { QwenScannerService } from '../src/services/QwenScannerService';
import { startGlobalProfiler, endGlobalProfiler } from '../src/utils/performanceProfiler';
import { Logger } from '../src/utils/logger';

const logger = new Logger('VLM-Profiler');

// Configuration
const TEST_CARDS = [
  '/home/profusionai/CardMint/test_cards/pikachu.jpg',
  '/home/profusionai/CardMint/test_cards/charizard.jpg',
  '/home/profusionai/CardMint/test_cards/mewtwo.jpg'
];

const LM_STUDIO_URL = 'http://10.0.24.174:1234';
const MODEL_NAME = 'qwen2.5-vl-7b-instruct';

async function profileLmStudioDirect() {
  console.log('\n========================================');
  console.log('PROFILING: Direct LM Studio Inference');
  console.log('========================================\n');
  
  const adapter = new LmStudioInference(LM_STUDIO_URL, MODEL_NAME);
  
  // Test each card
  for (const cardPath of TEST_CARDS) {
    const fileName = path.basename(cardPath);
    console.log(`\n📸 Testing: ${fileName}`);
    console.log('----------------------------------------');
    
    // Start profiler for this card
    const profiler = startGlobalProfiler(`direct_${fileName}`);
    
    try {
      // Check if file exists
      const fs = await import('fs/promises');
      const stats = await fs.stat(cardPath);
      profiler.setCardInfo(fileName, stats.size);
      
      // Run inference
      profiler.startStage('total');
      const result = await adapter.classify(cardPath, { timeout: 30000 });
      profiler.endStage('total');
      
      // Display results
      console.log('\n📊 Results:');
      console.log(`  Card: ${result.card_title}`);
      console.log(`  Set: ${result.set_name}`);
      console.log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`  Model: ${result.model_used}`);
      
    } catch (error) {
      console.error('❌ Error:', error);
    }
    
    // Get profiling report
    const report = endGlobalProfiler({ log: true });
    
    // Analyze stages
    if (report) {
      console.log('\n🔬 Stage Analysis:');
      const stages = report.stages.sort((a, b) => (b.duration || 0) - (a.duration || 0));
      
      for (const stage of stages.slice(0, 3)) {
        const pct = ((stage.duration! / report.totalDuration) * 100).toFixed(1);
        console.log(`  ${stage.name}: ${stage.duration!.toFixed(0)}ms (${pct}%)`);
      }
    }
  }
  
  // Get adapter status
  const status = await adapter.getStatus();
  console.log('\n📈 Adapter Statistics:');
  console.log(`  Total Requests: ${status.total_requests}`);
  console.log(`  Average Latency: ${status.average_latency_ms}ms`);
  console.log(`  Error Rate: ${(status.error_rate * 100).toFixed(1)}%`);
}

async function profileQwenScanner() {
  console.log('\n========================================');
  console.log('PROFILING: Qwen Scanner Service');
  console.log('========================================\n');
  
  const scanner = new QwenScannerService();
  
  // Check availability
  const available = await scanner.isAvailable();
  if (!available) {
    console.error('❌ Qwen scanner not available. Check Mac server connection.');
    return;
  }
  
  console.log('✅ Scanner available\n');
  
  // Test each card
  for (const cardPath of TEST_CARDS) {
    const fileName = path.basename(cardPath);
    console.log(`\n📸 Testing: ${fileName}`);
    console.log('----------------------------------------');
    
    try {
      const result = await scanner.processCard(cardPath);
      
      if (result) {
        console.log('\n📊 Results:');
        console.log(`  Card: ${result.name}`);
        console.log(`  Set: ${result.set_name}`);
        console.log(`  Number: ${result.number}`);
        console.log(`  Rarity: ${result.rarity}`);
        console.log(`  Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        console.log(`  Processing Time: ${result.processing_time_ms}ms`);
        
        // Display profiling data if available
        if ((result as any).profiling) {
          console.log('\n🔬 Stage Breakdown:');
          const profiling = (result as any).profiling;
          for (const stage of profiling.stages) {
            console.log(`  ${stage.name}: ${stage.duration_ms.toFixed(0)}ms`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error:', error);
    }
  }
}

async function compareApproaches() {
  console.log('\n========================================');
  console.log('PERFORMANCE COMPARISON');
  console.log('========================================\n');
  
  const testCard = TEST_CARDS[0];
  const results: any[] = [];
  
  // Test direct LM Studio
  console.log('Testing Direct LM Studio...');
  const directStart = Date.now();
  const directProfiler = startGlobalProfiler('comparison_direct');
  
  const adapter = new LmStudioInference(LM_STUDIO_URL, MODEL_NAME);
  await adapter.classify(testCard, { timeout: 30000 });
  
  const directReport = endGlobalProfiler();
  const directTime = Date.now() - directStart;
  results.push({
    method: 'Direct LM Studio',
    time: directTime,
    stages: directReport?.stages || []
  });
  
  // Test Qwen Scanner
  console.log('Testing Qwen Scanner Service...');
  const scannerStart = Date.now();
  
  const scanner = new QwenScannerService();
  if (await scanner.isAvailable()) {
    await scanner.processCard(testCard);
    const scannerTime = Date.now() - scannerStart;
    results.push({
      method: 'Qwen Scanner',
      time: scannerTime,
      stages: []
    });
  }
  
  // Display comparison
  console.log('\n📊 Comparison Results:');
  console.log('----------------------------------------');
  for (const result of results) {
    console.log(`${result.method}: ${result.time}ms`);
    if (result.stages.length > 0) {
      const bottleneck = result.stages.reduce((a: any, b: any) => 
        (a.duration > b.duration ? a : b)
      );
      console.log(`  Bottleneck: ${bottleneck.name} (${bottleneck.duration.toFixed(0)}ms)`);
    }
  }
  
  // Recommendations
  console.log('\n💡 Optimization Recommendations:');
  const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
  const cardsPerHour = Math.round(3600000 / avgTime);
  
  console.log(`  Current throughput: ${cardsPerHour} cards/hour`);
  console.log(`  Time to 1000 cards: ${(1000 / cardsPerHour).toFixed(1)} hours`);
  
  if (avgTime > 5000) {
    console.log('  ⚠️  Processing time exceeds 5s target');
    console.log('  Suggested optimizations:');
    console.log('    1. Enable concurrent VLM requests (2-4 parallel)');
    console.log('    2. Implement image preprocessing cache');
    console.log('    3. Optimize network transfer with compression');
    console.log('    4. Consider batch processing for multiple cards');
  } else {
    console.log('  ✅ Processing time within target range');
  }
}

async function main() {
  console.log('🚀 CardMint VLM Pipeline Profiler');
  console.log('==================================\n');
  
  const mode = process.argv[2] || 'all';
  
  try {
    switch (mode) {
      case 'direct':
        await profileLmStudioDirect();
        break;
      
      case 'scanner':
        await profileQwenScanner();
        break;
      
      case 'compare':
        await compareApproaches();
        break;
      
      case 'all':
      default:
        await profileLmStudioDirect();
        await profileQwenScanner();
        await compareApproaches();
        break;
    }
    
    console.log('\n✅ Profiling complete!');
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run profiler
main().catch(console.error);