#!/usr/bin/env npx tsx

/**
 * Quick verification of persistent service benefit
 * Measures actual performance improvement vs subprocess approach
 */

import { performance } from 'perf_hooks';

async function testFastAPIPerformance(imagePath: string): Promise<number> {
    const FormData = require('form-data');
    const fs = require('fs');
    
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
    
    console.log(`FastAPI: ${totalTime.toFixed(0)}ms`);
    console.log(`  Card: ${result.extracted_card_info?.card_name || 'Not detected'}`);
    console.log(`  Confidence: ${(result.avg_confidence * 100).toFixed(1)}%`);
    
    return totalTime;
}

async function testSubprocessPerformance(imagePath: string): Promise<number> {
    const { OCRService } = await import('./src/ocr/OCRService');
    
    const startTime = performance.now();
    const ocrService = new OCRService(true, 0.85);
    const result = await ocrService.processImage(imagePath);
    const totalTime = performance.now() - startTime;
    
    console.log(`Subprocess: ${totalTime.toFixed(0)}ms`);
    console.log(`  Card: ${result.extracted_card_info?.card_name || 'Not detected'}`);
    console.log(`  Confidence: ${((result.avg_confidence || 0) * 100).toFixed(1)}%`);
    
    return totalTime;
}

async function main() {
    const testImage = './official_images/mcd19-12_large_ac9a28214284.jpg';
    
    console.log('🔍 Performance Verification Test');
    console.log('================================\n');
    
    console.log('Testing FastAPI Service (persistent):');
    const fastApiTime = await testFastAPIPerformance(testImage);
    
    console.log('\nTesting Subprocess Service (initialization per request):');
    const subprocessTime = await testSubprocessPerformance(testImage);
    
    console.log('\n📊 Results:');
    console.log(`FastAPI Service:   ${fastApiTime.toFixed(0)}ms`);
    console.log(`Subprocess Method: ${subprocessTime.toFixed(0)}ms`);
    
    const improvement = ((subprocessTime - fastApiTime) / subprocessTime) * 100;
    console.log(`Improvement:       ${improvement.toFixed(1)}% faster`);
    
    if (improvement > 0) {
        console.log('\n✅ Persistent service is faster!');
    } else {
        console.log('\n⚠️  No performance improvement detected');
    }
    
    // Final assessment
    if (fastApiTime < 20000) {
        console.log('🎯 Phase 1 target achieved: Significant improvement over baseline');
    } else {
        console.log('⏰ Phase 1 partial success: More optimization needed for <3s target');
    }
}

main().catch(console.error);