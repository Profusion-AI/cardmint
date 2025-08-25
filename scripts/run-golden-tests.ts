#!/usr/bin/env tsx

import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { validatedConfig, SLO_TARGETS } from '../src/config/validator';
import { createLogger } from '../src/utils/logger';
import { TraceId } from '../src/utils/traceId';

const logger = createLogger('golden-tests');

interface GoldenCard {
  filename: string;
  difficulty: 'easy' | 'medium' | 'hard';
  expected: {
    name: string;
    setName: string;
    cardNumber: string;
    rarity: string;
    type: string;
    language: string;
    variant: string;
  };
  description: string;
}

interface GoldenManifest {
  version: string;
  description: string;
  created: string;
  cards: GoldenCard[];
  sloTargets: {
    accuracy: number;
    processingTimeMs: number;
    errorRate: number;
  };
  testConfiguration: {
    retries: number;
    timeout: number;
    concurrency: number;
  };
}

interface TestResult {
  card: GoldenCard;
  actual: any;
  passed: boolean;
  processingTimeMs: number;
  accuracy: number;
  errors: string[];
  traceId: string;
}

interface TestSummary {
  totalCards: number;
  passed: number;
  failed: number;
  accuracy: number;
  avgProcessingTime: number;
  p95ProcessingTime: number;
  errorRate: number;
  byDifficulty: Record<string, { passed: number; total: number; accuracy: number }>;
  sloCompliance: {
    accuracyMet: boolean;
    timingMet: boolean;
    errorRateMet: boolean;
  };
}

class GoldenTestRunner {
  private manifest: GoldenManifest;
  private results: TestResult[] = [];
  private baseUrl: string;
  
  constructor() {
    const manifestPath = join(__dirname, '../tests/e2e/golden/manifest.json');
    this.manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    this.baseUrl = `http://localhost:${validatedConfig.server.port}`;
  }
  
  async run(): Promise<boolean> {
    console.log('🏆 CardMint Golden Test Suite');
    console.log('============================');
    console.log(`Testing ${this.manifest.cards.length} cards against known ground truth`);
    console.log(`Target accuracy: ${this.manifest.sloTargets.accuracy * 100}%`);
    console.log(`Target processing time: ${this.manifest.sloTargets.processingTimeMs}ms`);
    console.log();
    
    // Check if CardMint is running
    try {
      const health = await axios.get(`${this.baseUrl}/api/health`, { timeout: 2000 });
      if (health.data.status !== 'ok') {
        throw new Error('CardMint not healthy');
      }
      logger.info('CardMint server is healthy');
    } catch (error) {
      console.error('❌ CardMint server not available. Start with: npm run dev');
      return false;
    }
    
    // Run tests
    console.log('🔍 Running tests...\n');
    
    for (let i = 0; i < this.manifest.cards.length; i++) {
      const card = this.manifest.cards[i];
      console.log(`[${i + 1}/${this.manifest.cards.length}] Testing: ${card.filename} (${card.difficulty})`);
      
      const result = await this.testCard(card);
      this.results.push(result);
      
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      const timing = result.processingTimeMs > this.manifest.sloTargets.processingTimeMs ? 
        ` ⚠️ SLOW (${result.processingTimeMs}ms)` : 
        ` (${result.processingTimeMs}ms)`;
      
      console.log(`   ${status} - ${(result.accuracy * 100).toFixed(1)}% accuracy${timing}`);
      
      if (!result.passed && result.errors.length > 0) {
        result.errors.forEach(error => {
          console.log(`   └─ ${error}`);
        });
      }
      console.log();
    }
    
    // Generate summary
    const summary = this.generateSummary();
    this.printSummary(summary);
    
    return summary.sloCompliance.accuracyMet && 
           summary.sloCompliance.timingMet && 
           summary.sloCompliance.errorRateMet;
  }
  
  private async testCard(card: GoldenCard): Promise<TestResult> {
    const traceId = TraceId.generate();
    const imagePath = join(__dirname, '../tests/e2e/golden', card.filename);
    const startTime = Date.now();
    
    let retries = 0;
    let lastError: any;
    
    while (retries < this.manifest.testConfiguration.retries) {
      try {
        // Simulate card processing by posting to capture endpoint
        const response = await axios.post(`${this.baseUrl}/api/capture`, {
          imageUrl: imagePath,
          traceId: traceId
        }, {
          timeout: this.manifest.testConfiguration.timeout
        });
        
        if (response.status === 200 && response.data.status === 'queued') {
          // Wait for processing to complete
          const result = await this.waitForProcessing(traceId);
          const processingTime = Date.now() - startTime;
          
          if (result) {
            return {
              card,
              actual: result,
              passed: this.compareResults(card.expected, result),
              processingTimeMs: processingTime,
              accuracy: this.calculateAccuracy(card.expected, result),
              errors: this.findErrors(card.expected, result),
              traceId
            };
          }
        }
        
        throw new Error(`Unexpected response: ${response.status}`);
        
      } catch (error: any) {
        lastError = error;
        retries++;
        
        if (retries < this.manifest.testConfiguration.retries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    // All retries failed
    return {
      card,
      actual: null,
      passed: false,
      processingTimeMs: Date.now() - startTime,
      accuracy: 0,
      errors: [`Failed after ${this.manifest.testConfiguration.retries} retries: ${lastError.message}`],
      traceId
    };
  }
  
  private async waitForProcessing(traceId: string): Promise<any> {
    const maxWait = this.manifest.testConfiguration.timeout;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      try {
        // Check cards endpoint for our processed card
        const response = await axios.get(`${this.baseUrl}/api/cards`);
        const cards = response.data;
        
        // Find card with our trace ID (simplified - in real system would use proper API)
        const recentCard = cards
          .sort((a: any, b: any) => new Date(b.created_at || b.capturedAt).getTime() - new Date(a.created_at || a.capturedAt).getTime())[0];
        
        if (recentCard && (recentCard.status === 'processed' || recentCard.status === 'failed')) {
          return recentCard;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        // Continue waiting
      }
    }
    
    return null;
  }
  
  private compareResults(expected: any, actual: any): boolean {
    if (!actual) return false;
    
    const nameMatch = this.fuzzyMatch(expected.name, actual.name || actual.card_name);
    const setMatch = this.fuzzyMatch(expected.setName, actual.setName || actual.set_name);
    const numberMatch = expected.cardNumber === (actual.cardNumber || actual.card_number);
    
    // Pass if at least 2 out of 3 critical fields match
    return [nameMatch, setMatch, numberMatch].filter(Boolean).length >= 2;
  }
  
  private calculateAccuracy(expected: any, actual: any): number {
    if (!actual) return 0;
    
    const fields = ['name', 'setName', 'cardNumber', 'rarity', 'type'];
    let matches = 0;
    
    for (const field of fields) {
      const expectedValue = expected[field];
      const actualValue = actual[field] || actual[field.toLowerCase()] || actual[field.replace(/([A-Z])/g, '_$1').toLowerCase()];
      
      if (this.fuzzyMatch(expectedValue, actualValue)) {
        matches++;
      }
    }
    
    return matches / fields.length;
  }
  
  private findErrors(expected: any, actual: any): string[] {
    if (!actual) return ['No result returned'];
    
    const errors: string[] = [];
    const fields: { key: string; label: string }[] = [
      { key: 'name', label: 'Name' },
      { key: 'setName', label: 'Set' },
      { key: 'cardNumber', label: 'Number' },
      { key: 'rarity', label: 'Rarity' },
      { key: 'type', label: 'Type' }
    ];
    
    for (const { key, label } of fields) {
      const expectedValue = expected[key];
      const actualValue = actual[key] || actual[key.toLowerCase()] || actual[key.replace(/([A-Z])/g, '_$1').toLowerCase()];
      
      if (!this.fuzzyMatch(expectedValue, actualValue)) {
        errors.push(`${label}: expected "${expectedValue}", got "${actualValue || 'null'}"`);
      }
    }
    
    return errors;
  }
  
  private fuzzyMatch(expected: string, actual: string): boolean {
    if (!expected || !actual) return false;
    
    const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalize(expected) === normalize(actual);
  }
  
  private generateSummary(): TestSummary {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    const failed = total - passed;
    
    const accuracies = this.results.map(r => r.accuracy);
    const processingTimes = this.results.map(r => r.processingTimeMs);
    
    // Calculate p95 processing time
    const sortedTimes = processingTimes.sort((a, b) => a - b);
    const p95Index = Math.floor(sortedTimes.length * 0.95);
    const p95Time = sortedTimes[p95Index] || 0;
    
    // Group by difficulty
    const byDifficulty: Record<string, { passed: number; total: number; accuracy: number }> = {};
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const difficultyResults = this.results.filter(r => r.card.difficulty === difficulty);
      const difficultyPassed = difficultyResults.filter(r => r.passed).length;
      const difficultyAccuracy = difficultyResults.reduce((sum, r) => sum + r.accuracy, 0) / difficultyResults.length;
      
      byDifficulty[difficulty] = {
        passed: difficultyPassed,
        total: difficultyResults.length,
        accuracy: difficultyAccuracy
      };
    }
    
    const overallAccuracy = accuracies.reduce((sum, acc) => sum + acc, 0) / total;
    const avgProcessingTime = processingTimes.reduce((sum, time) => sum + time, 0) / total;
    const errorRate = failed / total;
    
    return {
      totalCards: total,
      passed,
      failed,
      accuracy: overallAccuracy,
      avgProcessingTime,
      p95ProcessingTime: p95Time,
      errorRate,
      byDifficulty,
      sloCompliance: {
        accuracyMet: overallAccuracy >= this.manifest.sloTargets.accuracy,
        timingMet: p95Time <= this.manifest.sloTargets.processingTimeMs,
        errorRateMet: errorRate <= (1 - this.manifest.sloTargets.accuracy)
      }
    };
  }
  
  private printSummary(summary: TestSummary): void {
    console.log('📊 Test Summary');
    console.log('==============');
    console.log(`Total cards: ${summary.totalCards}`);
    console.log(`Passed: ${summary.passed}`);
    console.log(`Failed: ${summary.failed}`);
    console.log(`Overall accuracy: ${(summary.accuracy * 100).toFixed(1)}%`);
    console.log(`Average processing time: ${summary.avgProcessingTime.toFixed(0)}ms`);
    console.log(`P95 processing time: ${summary.p95ProcessingTime.toFixed(0)}ms`);
    console.log(`Error rate: ${(summary.errorRate * 100).toFixed(1)}%`);
    console.log();
    
    console.log('📈 By Difficulty');
    console.log('================');
    for (const [difficulty, stats] of Object.entries(summary.byDifficulty)) {
      const passRate = stats.total > 0 ? (stats.passed / stats.total * 100).toFixed(1) : '0.0';
      const accuracy = stats.total > 0 ? (stats.accuracy * 100).toFixed(1) : '0.0';
      console.log(`${difficulty.padEnd(6)}: ${stats.passed}/${stats.total} (${passRate}%) - ${accuracy}% accuracy`);
    }
    console.log();
    
    console.log('🎯 SLO Compliance');
    console.log('=================');
    const accuracyIcon = summary.sloCompliance.accuracyMet ? '✅' : '❌';
    const timingIcon = summary.sloCompliance.timingMet ? '✅' : '❌';
    const errorIcon = summary.sloCompliance.errorRateMet ? '✅' : '❌';
    
    console.log(`${accuracyIcon} Accuracy: ${(summary.accuracy * 100).toFixed(1)}% (target: ${this.manifest.sloTargets.accuracy * 100}%)`);
    console.log(`${timingIcon} P95 Timing: ${summary.p95ProcessingTime.toFixed(0)}ms (target: ≤${this.manifest.sloTargets.processingTimeMs}ms)`);
    console.log(`${errorIcon} Error Rate: ${(summary.errorRate * 100).toFixed(1)}% (target: ≤${((1 - this.manifest.sloTargets.accuracy) * 100).toFixed(1)}%)`);
    console.log();
    
    const overallCompliance = summary.sloCompliance.accuracyMet && 
                             summary.sloCompliance.timingMet && 
                             summary.sloCompliance.errorRateMet;
    
    if (overallCompliance) {
      console.log('🎉 ALL SLOs MET - System ready for production!');
    } else {
      console.log('⚠️  SLO violations detected - review performance before production');
    }
  }
}

// Run if called directly
if (require.main === module) {
  const runner = new GoldenTestRunner();
  runner.run().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    logger.error('Golden test runner failed:', { error: error.message });
    process.exit(1);
  });
}

export { GoldenTestRunner };