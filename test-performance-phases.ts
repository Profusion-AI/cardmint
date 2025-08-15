#!/usr/bin/env npx tsx

/**
 * Performance Testing Framework for CardMint OCR Optimization
 * Tests each phase of optimization to validate predicted outcomes
 */

import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

interface PerformanceTest {
    phase: string;
    description: string;
    target_time_ms: number;
    target_accuracy: number;
    implementation: string;
}

interface TestResult {
    phase: string;
    test_name: string;
    processing_time_ms: number;
    accuracy_score: number;
    card_name: string | null;
    overall_confidence: number;
    success: boolean;
    meets_time_target: boolean;
    meets_accuracy_target: boolean;
}

interface PhaseReport {
    phase: string;
    description: string;
    target_time_ms: number;
    target_accuracy: number;
    average_time_ms: number;
    average_accuracy: number;
    tests_passed: number;
    total_tests: number;
    performance_improvement: string;
    accuracy_maintained: boolean;
    phase_passed: boolean;
}

class PerformanceTester {
    private testImages: string[] = [];
    private phases: PerformanceTest[] = [
        {
            phase: "Phase 0 - Baseline",
            description: "Current subprocess-based OCR performance",
            target_time_ms: 25000, // Current baseline
            target_accuracy: 85,
            implementation: "subprocess"
        },
        {
            phase: "Phase 1 - Persistent Service",
            description: "FastAPI microservice with singleton OCR instance",
            target_time_ms: 5000, // 80% improvement target
            target_accuracy: 85,
            implementation: "fastapi"
        },
        {
            phase: "Phase 2 - HPI + Optimization",
            description: "High-performance inference with preprocessing optimization",
            target_time_ms: 3000, // Final target
            target_accuracy: 85,
            implementation: "fastapi_optimized"
        }
    ];

    constructor() {
        this.loadTestImages();
    }

    private async loadTestImages() {
        const imageDir = './official_images';
        try {
            const files = await fs.readdir(imageDir);
            this.testImages = files
                .filter(f => f.endsWith('.jpg') && f.includes('large') && !f.startsWith('._'))
                .slice(0, 3) // Test with 3 representative images for faster testing
                .map(f => path.join(imageDir, f));
            
            console.log(`📋 Loaded ${this.testImages.length} test images for performance testing`);
            console.log(`    Images: ${this.testImages.map(p => path.basename(p)).join(', ')}`);
        } catch (error) {
            console.error('Failed to load test images:', error);
            process.exit(1);
        }
    }

    /**
     * Test Phase 0: Current Subprocess Implementation
     */
    private async testSubprocessImplementation(imagePath: string): Promise<TestResult> {
        const { OCRService } = await import('./src/ocr/OCRService');
        
        const startTime = performance.now();
        const ocrService = new OCRService(true, 0.85);
        
        try {
            const result = await ocrService.processImage(imagePath);
            const processingTime = performance.now() - startTime;
            
            return {
                phase: "Phase 0 - Baseline",
                test_name: path.basename(imagePath),
                processing_time_ms: processingTime,
                accuracy_score: result.avg_confidence || 0,
                card_name: result.extracted_card_info?.card_name || null,
                overall_confidence: (result.avg_confidence || 0) * 100,
                success: result.success || false,
                meets_time_target: processingTime <= 25000,
                meets_accuracy_target: (result.avg_confidence || 0) >= 0.85
            };
        } catch (error) {
            return {
                phase: "Phase 0 - Baseline",
                test_name: path.basename(imagePath),
                processing_time_ms: performance.now() - startTime,
                accuracy_score: 0,
                card_name: null,
                overall_confidence: 0,
                success: false,
                meets_time_target: false,
                meets_accuracy_target: false
            };
        }
    }

    /**
     * Test Phase 1: FastAPI Service Implementation
     */
    private async testFastAPIImplementation(imagePath: string): Promise<TestResult> {
        const FormData = require('form-data');
        const fs = require('fs');
        
        const startTime = performance.now();
        
        try {
            // Check if FastAPI service is running
            const healthResponse = await fetch('http://localhost:8000/health');
            if (!healthResponse.ok) {
                throw new Error('FastAPI service not running');
            }

            // Prepare form data
            const form = new FormData();
            form.append('file', fs.createReadStream(imagePath));
            form.append('high_accuracy', 'true');

            // Send OCR request
            const response = await fetch('http://localhost:8000/ocr', {
                method: 'POST',
                body: form
            });

            if (!response.ok) {
                throw new Error(`OCR request failed: ${response.status}`);
            }

            const result = await response.json();
            const processingTime = performance.now() - startTime;

            return {
                phase: "Phase 1 - Persistent Service",
                test_name: path.basename(imagePath),
                processing_time_ms: processingTime,
                accuracy_score: result.avg_confidence || 0,
                card_name: result.extracted_card_info?.card_name || null,
                overall_confidence: (result.avg_confidence || 0) * 100,
                success: result.success || false,
                meets_time_target: processingTime <= 5000,
                meets_accuracy_target: (result.avg_confidence || 0) >= 0.85
            };
        } catch (error) {
            return {
                phase: "Phase 1 - Persistent Service",
                test_name: path.basename(imagePath),
                processing_time_ms: performance.now() - startTime,
                accuracy_score: 0,
                card_name: null,
                overall_confidence: 0,
                success: false,
                meets_time_target: false,
                meets_accuracy_target: false
            };
        }
    }

    /**
     * Run tests for a specific phase
     */
    private async runPhaseTests(phase: PerformanceTest): Promise<TestResult[]> {
        console.log(`\n🧪 Testing ${phase.phase}: ${phase.description}`);
        console.log(`   Target: <${phase.target_time_ms}ms, >${phase.target_accuracy}% accuracy`);
        
        const results: TestResult[] = [];
        
        for (const imagePath of this.testImages) {
            console.log(`   📸 Testing: ${path.basename(imagePath)}`);
            
            let result: TestResult;
            
            switch (phase.implementation) {
                case 'subprocess':
                    result = await this.testSubprocessImplementation(imagePath);
                    break;
                case 'fastapi':
                    result = await this.testFastAPIImplementation(imagePath);
                    break;
                default:
                    throw new Error(`Unknown implementation: ${phase.implementation}`);
            }
            
            results.push(result);
            
            const timeStatus = result.meets_time_target ? '✅' : '❌';
            const accuracyStatus = result.meets_accuracy_target ? '✅' : '❌';
            
            console.log(`      ${timeStatus} Time: ${result.processing_time_ms.toFixed(0)}ms`);
            console.log(`      ${accuracyStatus} Accuracy: ${result.overall_confidence.toFixed(1)}%`);
            console.log(`      🏷️  Card: ${result.card_name || 'Not detected'}`);
        }
        
        return results;
    }

    /**
     * Generate phase report from test results
     */
    private generatePhaseReport(phase: PerformanceTest, results: TestResult[]): PhaseReport {
        const validResults = results.filter(r => r.success);
        const averageTime = validResults.reduce((sum, r) => sum + r.processing_time_ms, 0) / validResults.length;
        const averageAccuracy = validResults.reduce((sum, r) => sum + r.accuracy_score, 0) / validResults.length;
        
        const timeTargetMet = results.filter(r => r.meets_time_target).length;
        const accuracyTargetMet = results.filter(r => r.meets_accuracy_target).length;
        
        return {
            phase: phase.phase,
            description: phase.description,
            target_time_ms: phase.target_time_ms,
            target_accuracy: phase.target_accuracy,
            average_time_ms: averageTime,
            average_accuracy: averageAccuracy * 100,
            tests_passed: Math.min(timeTargetMet, accuracyTargetMet),
            total_tests: results.length,
            performance_improvement: "TBD", // Will be calculated when comparing phases
            accuracy_maintained: averageAccuracy >= (phase.target_accuracy / 100),
            phase_passed: (timeTargetMet >= results.length * 0.8) && (accuracyTargetMet >= results.length * 0.8)
        };
    }

    /**
     * Run all performance tests
     */
    async runAllTests(): Promise<void> {
        console.log('🚀 CardMint OCR Performance Testing Framework');
        console.log('===============================================\n');
        
        const allResults: TestResult[] = [];
        const phaseReports: PhaseReport[] = [];
        
        // Test only available phases (skip FastAPI if service not running)
        const availablePhases = [this.phases[0]]; // Start with baseline
        
        // Check if FastAPI service is available
        try {
            const healthResponse = await fetch('http://localhost:8000/health');
            if (healthResponse.ok) {
                availablePhases.push(this.phases[1]); // Add FastAPI phase
            }
        } catch (error) {
            console.log('⚠️  FastAPI service not available - skipping Phase 1 tests');
        }
        
        for (const phase of availablePhases) {
            const results = await this.runPhaseTests(phase);
            allResults.push(...results);
            
            const report = this.generatePhaseReport(phase, results);
            phaseReports.push(report);
        }
        
        // Generate summary report
        this.printSummaryReport(phaseReports);
        
        // Save detailed results
        await this.saveResults(allResults, phaseReports);
    }

    /**
     * Print summary report to console
     */
    private printSummaryReport(reports: PhaseReport[]): void {
        console.log('\n📊 PERFORMANCE TEST SUMMARY');
        console.log('============================\n');
        
        for (let i = 0; i < reports.length; i++) {
            const report = reports[i];
            const status = report.phase_passed ? '✅ PASSED' : '❌ FAILED';
            
            console.log(`${status} ${report.phase}`);
            console.log(`   Target: <${report.target_time_ms}ms, >${report.target_accuracy}% accuracy`);
            console.log(`   Actual: ${report.average_time_ms.toFixed(0)}ms, ${report.average_accuracy.toFixed(1)}% accuracy`);
            console.log(`   Tests: ${report.tests_passed}/${report.total_tests} passed`);
            
            if (i > 0) {
                const baseline = reports[0];
                const improvement = ((baseline.average_time_ms - report.average_time_ms) / baseline.average_time_ms) * 100;
                console.log(`   Performance: ${improvement.toFixed(1)}% faster than baseline`);
            }
            
            console.log('');
        }
        
        // Overall assessment
        const allPassed = reports.every(r => r.phase_passed);
        if (allPassed) {
            console.log('🎉 ALL PHASES PASSED - Ready for next optimization phase!');
        } else {
            console.log('⚠️  Some phases failed - Review implementation before proceeding');
        }
    }

    /**
     * Save test results to file
     */
    private async saveResults(results: TestResult[], reports: PhaseReport[]): Promise<void> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `performance-test-${timestamp}.json`;
        
        const data = {
            timestamp: new Date().toISOString(),
            summary: reports,
            detailed_results: results
        };
        
        await fs.writeFile(filename, JSON.stringify(data, null, 2));
        console.log(`📁 Detailed results saved to: ${filename}`);
    }
}

// Run the tests
async function main() {
    const tester = new PerformanceTester();
    await tester.runAllTests();
}

main().catch(console.error);