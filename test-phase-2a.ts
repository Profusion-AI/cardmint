#!/usr/bin/env npx tsx

/**
 * Phase 2A Testing: Smart Preprocessing Intelligence
 * Validates performance improvements and accuracy maintenance
 */

import { performance } from 'perf_hooks';
import fs from 'fs';

interface Phase2AResult {
    processing_time_ms: number;
    success: boolean;
    avg_confidence: number;
    card_name: string | null;
    preprocessing_used?: {
        preprocessing_level: string;
        quality_assessment: {
            quality_score: number;
        };
        operations_applied: string[];
    };
    phase: string;
}

async function testPhase2APerformance(imagePath: string): Promise<Phase2AResult> {
    const FormData = require('form-data');
    
    const startTime = performance.now();
    
    const form = new FormData();
    form.append('file', fs.createReadStream(imagePath));
    form.append('high_accuracy', 'true');

    const response = await fetch('http://localhost:8000/ocr', {
        method: 'POST',
        body: form
    });

    if (!response.ok) {
        throw new Error(`OCR request failed: ${response.status}`);
    }

    const result = await response.json();
    const totalTime = performance.now() - startTime;
    
    return {
        processing_time_ms: result.processing_time_ms || totalTime,
        success: result.success || false,
        avg_confidence: result.avg_confidence || 0,
        card_name: result.extracted_card_info?.card_name || null,
        preprocessing_used: result.preprocessing_used,
        phase: result.phase || 'unknown'
    };
}

async function main() {
    console.log('🧪 Phase 2A: Smart Preprocessing Intelligence Test');
    console.log('==================================================\n');
    
    const testImages = [
        './official_images/mcd19-12_large_ac9a28214284.jpg',
        './official_images/neo3-2_large_f945368ae38f.jpg'
    ];
    
    const results: Phase2AResult[] = [];
    
    for (const imagePath of testImages) {
        if (!fs.existsSync(imagePath)) {
            console.log(`⚠️  Image not found: ${imagePath}`);
            continue;
        }
        
        console.log(`📸 Testing: ${imagePath.split('/').pop()}`);
        
        try {
            const result = await testPhase2APerformance(imagePath);
            results.push(result);
            
            const timeStatus = result.processing_time_ms < 20000 ? '✅' : '⚠️';
            const accuracyStatus = result.avg_confidence > 0.85 ? '✅' : '❌';
            
            console.log(`   ${timeStatus} Processing: ${(result.processing_time_ms / 1000).toFixed(1)}s`);
            console.log(`   ${accuracyStatus} Accuracy: ${(result.avg_confidence * 100).toFixed(1)}%`);
            console.log(`   🏷️  Card: ${result.card_name || 'Not detected'}`);
            console.log(`   🔧 Phase: ${result.phase}`);
            
            if (result.preprocessing_used) {
                const preprocessing = result.preprocessing_used;
                console.log(`   📊 Quality: ${preprocessing.quality_assessment.quality_score.toFixed(2)}`);
                console.log(`   ⚙️  Level: ${preprocessing.preprocessing_level}`);
                console.log(`   🛠️  Ops: ${preprocessing.operations_applied.join(', ')}`);
            }
            
            console.log('');
            
        } catch (error) {
            console.log(`   ❌ Error: ${error.message}\n`);
        }
    }
    
    // Calculate summary statistics
    if (results.length > 0) {
        const avgTime = results.reduce((sum, r) => sum + r.processing_time_ms, 0) / results.length;
        const avgAccuracy = results.reduce((sum, r) => sum + r.avg_confidence, 0) / results.length;
        const successCount = results.filter(r => r.success).length;
        
        console.log('📊 Phase 2A Summary Results:');
        console.log('============================');
        console.log(`Average Processing Time: ${(avgTime / 1000).toFixed(1)}s`);
        console.log(`Average Accuracy: ${(avgAccuracy * 100).toFixed(1)}%`);
        console.log(`Success Rate: ${successCount}/${results.length} (${(successCount/results.length*100).toFixed(1)}%)`);
        
        // Compare to Phase 1 baseline (17.7s)
        const phase1Baseline = 17700; // ms
        const improvement = ((phase1Baseline - avgTime) / phase1Baseline) * 100;
        
        console.log(`\n🎯 Phase 2A Assessment:`);
        if (improvement > 0) {
            console.log(`✅ Performance: ${improvement.toFixed(1)}% faster than Phase 1 baseline`);
        } else {
            console.log(`⚠️  Performance: ${Math.abs(improvement).toFixed(1)}% slower than Phase 1 baseline`);
        }
        
        if (avgAccuracy >= 0.85) {
            console.log(`✅ Accuracy: Target maintained (${(avgAccuracy * 100).toFixed(1)}% >= 85%)`);
        } else {
            console.log(`❌ Accuracy: Below target (${(avgAccuracy * 100).toFixed(1)}% < 85%)`);
        }
        
        // Phase 2A specific validation
        const targetTime = 15000; // 15 seconds target for Phase 2A
        if (avgTime < targetTime) {
            console.log(`🎉 Phase 2A Success: Processing time under ${targetTime/1000}s target!`);
        } else {
            console.log(`⏰ Phase 2A Partial: ${(avgTime/1000).toFixed(1)}s > ${targetTime/1000}s target, but progress made`);
        }
    }
}

main().catch(console.error);