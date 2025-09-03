#!/usr/bin/env ts-node

/**
 * Golden 10 Evaluation Harness - Local-First Recognition Validation
 * Tests against verified ground truth for production accuracy validation
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger';
import { LocalFirstPipeline } from '../worker/verification/LocalFirstPipeline';
import { recordLocalMatch, getLocalMatchingSummary } from '../utils/localMatchingMetrics';

const logger = createLogger('Golden10Evaluator');

interface Golden10Manifest {
  version: string;
  description: string;
  cards: Array<{
    index: number;
    filename: string;
    card_title: string;
    identifier: { number: string; set_size: string };
    set_name: string;
    first_edition?: boolean;
    raw_price_usd: number;
    difficulty: 'easy' | 'medium' | 'hard';
    hints: {
      expected_set_icon?: string;
      roi_template?: string;
      orientation_deg?: number;
      number_format?: string;
      layout_hint?: string;
      canonical_key: string;
    };
  }>;
}

interface EvaluationResult {
  card_index: number;
  filename: string;
  expected_key: string;
  predicted_key?: string;
  confidence: number;
  success: boolean;
  processing_time_ms: number;
  strategy_chain: string[];
  confidence_scores: Record<string, number>;
  decision: string;
  ml_fallback_needed: boolean;
  error?: string;
}

interface EvaluationSummary {
  total_cards: number;
  successful_matches: number;
  accuracy_percentage: number;
  avg_confidence: number;
  avg_processing_time_ms: number;
  performance_targets: {
    accuracy_target: number;
    confidence_target: number;
    latency_target_ms: number;
    accuracy_met: boolean;
    confidence_met: boolean;
    latency_met: boolean;
  };
  difficulty_breakdown: Record<string, {
    total: number;
    successful: number;
    accuracy: number;
  }>;
  strategy_performance: Record<string, {
    usage_count: number;
    success_rate: number;
    avg_confidence: number;
  }>;
  failure_analysis: Array<{
    filename: string;
    expected: string;
    predicted?: string;
    confidence: number;
    reason: string;
  }>;
}

class Golden10Evaluator {
  private pipeline: LocalFirstPipeline;
  private manifest: Golden10Manifest;
  private results: EvaluationResult[] = [];
  
  constructor() {
    this.pipeline = new LocalFirstPipeline();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Golden 10 Evaluator...');
    
    // Initialize Local-First pipeline
    await this.pipeline.initialize();
    
    // Load Golden 10 manifest
    const manifestPath = path.join(process.env.DATA_ROOT || './data', '../tests/e2e/golden/manifest.json');
    const manifestData = await fs.readFile(manifestPath, 'utf-8');
    this.manifest = JSON.parse(manifestData) as Golden10Manifest;
    
    logger.info(`Loaded Golden 10 manifest with ${this.manifest.cards.length} test cards`);
  }

  async evaluateAll(): Promise<EvaluationSummary> {
    logger.info('Starting Golden 10 evaluation...');
    
    const startTime = Date.now();
    this.results = [];
    
    // Evaluate each card in the Golden 10 dataset
    for (const card of this.manifest.cards) {
      try {
        const result = await this.evaluateCard(card);
        this.results.push(result);
        
        // Log progress
        logger.info(`Evaluated ${card.filename}: ${result.success ? 'SUCCESS' : 'FAILURE'} (confidence: ${result.confidence.toFixed(3)})`);
        
      } catch (error) {
        logger.error(`Failed to evaluate ${card.filename}:`, error);
        
        const errorResult: EvaluationResult = {
          card_index: card.index,
          filename: card.filename,
          expected_key: card.hints.canonical_key,
          confidence: 0,
          success: false,
          processing_time_ms: 0,
          strategy_chain: [],
          confidence_scores: {},
          decision: 'error',
          ml_fallback_needed: false,
          error: String(error)
        };
        
        this.results.push(errorResult);
      }
    }
    
    const totalTime = Date.now() - startTime;
    
    // Generate comprehensive summary
    const summary = this.generateSummary(totalTime);
    
    logger.info(`Golden 10 evaluation completed in ${totalTime}ms`);
    logger.info(`Overall accuracy: ${summary.accuracy_percentage.toFixed(1)}% (${summary.successful_matches}/${summary.total_cards})`);
    
    return summary;
  }

  private async evaluateCard(card: Golden10Manifest['cards'][0]): Promise<EvaluationResult> {
    const imagePath = path.join(process.env.DATA_ROOT || './data', '../tests/e2e/golden', card.filename);
    
    // Check if image exists
    try {
      await fs.access(imagePath);
    } catch (error) {
      throw new Error(`Test image not found: ${imagePath}`);
    }
    
    const cardStartTime = Date.now();
    
    // Run Local-First pipeline with hints
    const pipelineResult = await this.pipeline.process(imagePath, undefined, `golden10_${card.index}`);
    
    const processingTime = Date.now() - cardStartTime;
    
    // Extract predicted canonical key from best candidate
    const predictedKey = pipelineResult.local_match.best_candidate?.canonical_key;
    
    // Determine success (supports strict mode via env)
    const strictMode = this.isStrictMode();
    const success = strictMode
      ? (this.compareCanonicalKeysStrict(card.hints.canonical_key, predictedKey) &&
          this.enforceStrictGates(pipelineResult.local_match.conf_scores))
      : this.compareCanonicalKeys(card.hints.canonical_key, predictedKey);
    
    // Record metrics for this evaluation
    const evaluationMetrics = {
      scan_id: `golden10_${card.index}`,
      local_confidence: pipelineResult.local_match.confidence,
      ml_used: pipelineResult.needs_ml_fallback,
      match_method: pipelineResult.local_match.strategy_chain.join('+'),
      latency_ms: processingTime,
      decision: pipelineResult.local_match.decision,
      strategy_chain: pipelineResult.local_match.strategy_chain,
      conf_scores: pipelineResult.local_match.conf_scores,
      mode: pipelineResult.mode
    };
    
    recordLocalMatch(evaluationMetrics);
    
    return {
      card_index: card.index,
      filename: card.filename,
      expected_key: card.hints.canonical_key,
      predicted_key: predictedKey,
      confidence: pipelineResult.local_match.confidence,
      success,
      processing_time_ms: processingTime,
      strategy_chain: pipelineResult.local_match.strategy_chain,
      confidence_scores: pipelineResult.local_match.conf_scores,
      decision: pipelineResult.recommended_action,
      ml_fallback_needed: pipelineResult.needs_ml_fallback
    };
  }

  private isStrictMode(): boolean {
    const v = String(process.env.EVAL_STRICT || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  private compareCanonicalKeys(expected: string, predicted?: string): boolean {
    if (!predicted) return false;
    
    // Normalize keys for comparison
    const normalizeKey = (key: string) => key.toLowerCase().replace(/\s+/g, '-');
    
    const expectedNorm = normalizeKey(expected);
    const predictedNorm = normalizeKey(predicted);
    
    // Exact match is ideal
    if (expectedNorm === predictedNorm) return true;
    
    // Partial matching for different component matches
    const expectedParts = expectedNorm.split('|');
    const predictedParts = predictedNorm.split('|');
    
    if (expectedParts.length !== 4 || predictedParts.length !== 4) return false;
    
    // Count matching parts (allowing wildcards)
    let matches = 0;
    for (let i = 0; i < 4; i++) {
      if (expectedParts[i] === predictedParts[i] || 
          expectedParts[i] === '*' || 
          predictedParts[i] === '*') {
        matches++;
      }
    }
    
    // Require at least 2/4 components to match for partial success
    return matches >= 2;
  }

  private compareCanonicalKeysStrict(expected: string, predicted?: string): boolean {
    if (!predicted) return false;

    const normalizeKey = (key: string) => key.toLowerCase().replace(/\s+/g, '-');
    const expectedNorm = normalizeKey(expected);
    const predictedNorm = normalizeKey(predicted);

    if (expectedNorm === predictedNorm) return true;

    const expectedParts = expectedNorm.split('|');
    const predictedParts = predictedNorm.split('|');
    if (expectedParts.length !== 4 || predictedParts.length !== 4) return false;

    // Count only concrete matches (wildcards do not match)
    let matches = 0;
    for (let i = 0; i < 4; i++) {
      if (predictedParts[i] !== '*' && expectedParts[i] !== '*' && predictedParts[i] === expectedParts[i]) {
        matches++;
      }
    }

    return matches >= 3; // tighten to 3/4
  }

  private enforceStrictGates(confScores: Record<string, number>): boolean {
    const minOcr = parseFloat(process.env.EVAL_MIN_OCR_CONF || '0.6');
    const minIcon = parseFloat(process.env.SET_ICON_NCC_THRESH || '0.78');

    if (typeof confScores !== 'object' || confScores === null) return true;

    // If a strategy participated, require its confidence gate
    if (typeof confScores['number'] === 'number' && confScores['number'] > 0) {
      if (confScores['number'] < minOcr) return false;
    }
    if (typeof confScores['set_icon'] === 'number' && confScores['set_icon'] > 0) {
      if (confScores['set_icon'] < minIcon) return false;
    }
    // phash gating by Hamming not available here; rely on fusion/conf thresholds upstream

    return true;
  }

  private generateSummary(totalEvaluationTime: number): EvaluationSummary {
    const totalCards = this.results.length;
    const successfulMatches = this.results.filter(r => r.success).length;
    const accuracyPercentage = (successfulMatches / totalCards) * 100;
    
    // Calculate averages
    const avgConfidence = this.results.reduce((sum, r) => sum + r.confidence, 0) / totalCards;
    const avgProcessingTime = this.results.reduce((sum, r) => sum + r.processing_time_ms, 0) / totalCards;
    
    // Performance targets (from CTO guidance)
    const performanceTargets = {
      accuracy_target: 90, // ≥90% accuracy
      confidence_target: 0.85, // ≥0.85 confidence
      latency_target_ms: 100, // ≤100ms p95 latency
      accuracy_met: accuracyPercentage >= 90,
      confidence_met: avgConfidence >= 0.85,
      latency_met: this.calculateP95Latency() <= 100
    };
    
    // Difficulty breakdown
    const difficultyBreakdown = this.analyzeDifficultyBreakdown();
    
    // Strategy performance analysis
    const strategyPerformance = this.analyzeStrategyPerformance();
    
    // Failure analysis
    const failureAnalysis = this.analyzeFailures();
    
    return {
      total_cards: totalCards,
      successful_matches: successfulMatches,
      accuracy_percentage: accuracyPercentage,
      avg_confidence: avgConfidence,
      avg_processing_time_ms: avgProcessingTime,
      performance_targets: performanceTargets,
      difficulty_breakdown: difficultyBreakdown,
      strategy_performance: strategyPerformance,
      failure_analysis: failureAnalysis
    };
  }

  private calculateP95Latency(): number {
    const latencies = this.results.map(r => r.processing_time_ms).sort((a, b) => a - b);
    const p95Index = Math.ceil(latencies.length * 0.95) - 1;
    return latencies[p95Index] || 0;
  }

  private analyzeDifficultyBreakdown(): Record<string, any> {
    const breakdown: Record<string, { total: number; successful: number; accuracy: number }> = {};
    
    // Group results by difficulty from manifest
    for (const result of this.results) {
      const card = this.manifest.cards.find(c => c.index === result.card_index);
      const difficulty = card?.difficulty || 'unknown';
      
      if (!breakdown[difficulty]) {
        breakdown[difficulty] = { total: 0, successful: 0, accuracy: 0 };
      }
      
      breakdown[difficulty].total++;
      if (result.success) {
        breakdown[difficulty].successful++;
      }
    }
    
    // Calculate accuracy percentages
    for (const difficulty in breakdown) {
      const stats = breakdown[difficulty];
      stats.accuracy = (stats.successful / stats.total) * 100;
    }
    
    return breakdown;
  }

  private analyzeStrategyPerformance(): Record<string, any> {
    const strategyStats: Record<string, { usage_count: number; successes: number; confidences: number[] }> = {};
    
    // Collect strategy usage statistics
    for (const result of this.results) {
      for (const strategy of result.strategy_chain) {
        if (!strategyStats[strategy]) {
          strategyStats[strategy] = { usage_count: 0, successes: 0, confidences: [] };
        }
        
        strategyStats[strategy].usage_count++;
        if (result.success) {
          strategyStats[strategy].successes++;
        }
        strategyStats[strategy].confidences.push(result.confidence);
      }
    }
    
    // Calculate performance metrics
    const performance: Record<string, any> = {};
    for (const strategy in strategyStats) {
      const stats = strategyStats[strategy];
      performance[strategy] = {
        usage_count: stats.usage_count,
        success_rate: (stats.successes / stats.usage_count) * 100,
        avg_confidence: stats.confidences.reduce((sum, c) => sum + c, 0) / stats.confidences.length
      };
    }
    
    return performance;
  }

  private analyzeFailures(): Array<any> {
    return this.results
      .filter(r => !r.success)
      .map(r => ({
        filename: r.filename,
        expected: r.expected_key,
        predicted: r.predicted_key || 'none',
        confidence: r.confidence,
        reason: r.error || (r.confidence < 0.85 ? 'low_confidence' : 'key_mismatch')
      }));
  }

  async generateReport(): Promise<void> {
    const summary = this.generateSummary(0); // We already calculated total time
    
    const report = {
      evaluation_timestamp: new Date().toISOString(),
      manifest_version: this.manifest.version,
      pipeline_config: this.pipeline.getConfig(),
      summary,
      detailed_results: this.results,
      system_metrics: getLocalMatchingSummary()
    };
    
    // Write report to file
    const dataRoot = process.env.DATA_ROOT || './data';
    const reportPath = path.join(dataRoot, 'logs', 'golden-10-evaluation.json');
    
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    
    logger.info(`Detailed evaluation report written to: ${reportPath}`);
  }

  getResults(): EvaluationResult[] {
    return [...this.results];
  }
}

// CLI interface
async function main() {
  try {
    const evaluator = new Golden10Evaluator();
    await evaluator.initialize();
    
    // Run evaluation
    const summary = await evaluator.evaluateAll();
    
    // Generate detailed report
    await evaluator.generateReport();
    
    // Print summary to console
    console.log('\n📊 Golden 10 Evaluation Summary');
    console.log('================================');
    console.log(`Total Cards Evaluated: ${summary.total_cards}`);
    console.log(`Successful Matches: ${summary.successful_matches}`);
    console.log(`Accuracy: ${summary.accuracy_percentage.toFixed(1)}% ${summary.performance_targets.accuracy_met ? '✅' : '❌'} (target: ≥90%)`);
    console.log(`Average Confidence: ${summary.avg_confidence.toFixed(3)} ${summary.performance_targets.confidence_met ? '✅' : '❌'} (target: ≥0.85)`);
    console.log(`Average Processing Time: ${summary.avg_processing_time_ms.toFixed(1)}ms`);
    console.log(`P95 Latency: ${evaluator.calculateP95Latency()}ms ${summary.performance_targets.latency_met ? '✅' : '❌'} (target: ≤100ms)`);
    
    console.log('\n🎯 Performance Targets:');
    console.log(`Accuracy Target: ${summary.performance_targets.accuracy_met ? 'MET' : 'FAILED'}`);
    console.log(`Confidence Target: ${summary.performance_targets.confidence_met ? 'MET' : 'FAILED'}`);
    console.log(`Latency Target: ${summary.performance_targets.latency_met ? 'MET' : 'FAILED'}`);
    
    if (summary.failure_analysis.length > 0) {
      console.log('\n❌ Failures:');
      for (const failure of summary.failure_analysis.slice(0, 5)) {
        console.log(`  ${failure.filename}: ${failure.reason} (confidence: ${failure.confidence.toFixed(3)})`);
      }
      if (summary.failure_analysis.length > 5) {
        console.log(`  ... and ${summary.failure_analysis.length - 5} more failures`);
      }
    }
    
    // Exit with appropriate code
    const allTargetsMet = summary.performance_targets.accuracy_met && 
                         summary.performance_targets.confidence_met && 
                         summary.performance_targets.latency_met;
    
    if (allTargetsMet) {
      console.log('\n🎉 All performance targets met! Golden 10 validation PASSED.');
      process.exit(0);
    } else {
      console.log('\n⚠️  Some performance targets not met. Review detailed report for improvements.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Golden 10 evaluation failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
