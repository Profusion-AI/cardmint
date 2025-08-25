#!/usr/bin/env node

/**
 * Test script for image resize performance and optimization
 * Tests different resolutions to find optimal settings for Qwen VLM
 */

const path = require('path');
const { ImageResizeService } = require('../dist/services/ImageResizeService');
const fs = require('fs').promises;

// Test configuration
const TEST_SIZES = [640, 800, 1024, 1280, 1600, 1920, 2560];
const TEST_IMAGE = path.join(__dirname, '..', 'captures', 'DSC00007.JPG'); // Use newest capture
const RESULTS_DIR = path.join(__dirname, '..', 'resize-tests');

async function runPerformanceTest() {
    console.log('🖼️  CardMint Image Resize Performance Test');
    console.log('=' * 50);
    
    // Check if test image exists
    try {
        await fs.access(TEST_IMAGE);
        console.log(`✅ Test image found: ${TEST_IMAGE}`);
    } catch (error) {
        console.error(`❌ Test image not found: ${TEST_IMAGE}`);
        console.log('Please capture a card first or specify a different test image');
        process.exit(1);
    }

    // Initialize resize service
    const resizer = new ImageResizeService();
    
    console.log('\n🧪 Testing different resolutions for ML processing...');
    console.log('Testing sizes:', TEST_SIZES.join(', ') + ' pixels');
    
    const testStart = Date.now();
    
    try {
        const results = await resizer.testResolutions(TEST_IMAGE, TEST_SIZES);
        
        console.log('\n📊 Results Summary:');
        console.log('-'.repeat(80));
        console.log(`${'Size'.padEnd(8)} | ${'Dimensions'.padEnd(12)} | ${'File Size'.padEnd(12)} | ${'Savings'.padEnd(8)} | ${'Time'.padEnd(8)}`);
        console.log('-'.repeat(80));
        
        const resultData = [];
        
        for (const [size, result] of results) {
            const fileSizeMB = (result.resizedSize / 1024 / 1024).toFixed(2);
            const savings = result.compressionRatio.toFixed(1);
            const dimensions = `${result.width}x${result.height}`;
            
            console.log(
                `${size.toString().padEnd(8)} | ` +
                `${dimensions.padEnd(12)} | ` +
                `${fileSizeMB.padEnd(10)}MB | ` +
                `${savings.padEnd(6)}% | ` +
                `${result.processingTimeMs.toString().padEnd(6)}ms`
            );
            
            resultData.push({
                size,
                width: result.width,
                height: result.height,
                fileSizeMB: parseFloat(fileSizeMB),
                savingsPercent: parseFloat(savings),
                processingTimeMs: result.processingTimeMs,
                path: result.path
            });
        }
        
        const totalTime = Date.now() - testStart;
        console.log('-'.repeat(80));
        console.log(`Total processing time: ${totalTime}ms`);
        
        // Find optimal size for ML processing
        console.log('\n🎯 Optimization Analysis:');
        
        // Score based on: good compression (30%), reasonable file size (40%), fast processing (30%)
        let bestScore = 0;
        let optimalSize = 1280; // Default
        
        for (const data of resultData) {
            // Normalize metrics (lower is better for file size and processing time)
            const maxFileSize = Math.max(...resultData.map(d => d.fileSizeMB));
            const maxProcessingTime = Math.max(...resultData.map(d => d.processingTimeMs));
            
            const compressionScore = data.savingsPercent / 100; // 0-1, higher is better
            const fileSizeScore = 1 - (data.fileSizeMB / maxFileSize); // 0-1, lower file size is better
            const speedScore = 1 - (data.processingTimeMs / maxProcessingTime); // 0-1, faster is better
            
            const totalScore = (compressionScore * 0.3) + (fileSizeScore * 0.4) + (speedScore * 0.3);
            
            if (totalScore > bestScore) {
                bestScore = totalScore;
                optimalSize = data.size;
            }
            
            console.log(`${data.size}px: Score ${(totalScore * 100).toFixed(1)} (compression: ${(compressionScore * 100).toFixed(1)}, size: ${(fileSizeScore * 100).toFixed(1)}, speed: ${(speedScore * 100).toFixed(1)})`);
        }
        
        console.log(`\n🏆 Recommended optimal size for Qwen VLM: ${optimalSize}px`);
        
        // Test web dashboard thumbnails
        console.log('\n🌐 Testing web dashboard thumbnails...');
        const webResults = await resizer.createWebThumbnails(TEST_IMAGE);
        
        console.log('Web thumbnail results:');
        for (const [name, result] of webResults) {
            const fileSizeKB = (result.resizedSize / 1024).toFixed(0);
            console.log(`  ${name}: ${result.width}x${result.height} ${fileSizeKB}KB (${result.compressionRatio.toFixed(1)}% savings)`);
        }
        
        // Save detailed results
        const resultsFile = path.join(RESULTS_DIR, 'test_results.json');
        const detailedResults = {
            timestamp: new Date().toISOString(),
            testImage: TEST_IMAGE,
            recommendedSize: optimalSize,
            testResults: resultData,
            webResults: Array.from(webResults.entries()).map(([name, result]) => ({
                name,
                ...result
            }))
        };
        
        await fs.writeFile(resultsFile, JSON.stringify(detailedResults, null, 2));
        console.log(`\n📝 Detailed results saved to: ${resultsFile}`);
        
        // Performance recommendations
        console.log('\n💡 Performance Recommendations:');
        console.log(`• Use ${optimalSize}px for Qwen VLM processing (best balance of accuracy vs speed)`);
        console.log('• Use 800px JPEG for dashboard thumbnails (fast loading)');
        console.log('• Use 200px thumbnails for grid views');
        console.log('• Consider WebP format for 20-30% additional compression');
        
        // Storage capacity analysis
        const optimalResult = results.get(optimalSize);
        if (optimalResult) {
            const avgFileSize = optimalResult.resizedSize;
            const thousandCards = (avgFileSize * 1000) / 1024 / 1024; // MB
            const tenThousandCards = thousandCards * 10; // GB
            
            console.log('\n💾 Storage Capacity Analysis:');
            console.log(`• Average resized file size: ${(avgFileSize / 1024).toFixed(0)}KB`);
            console.log(`• 1,000 cards: ${thousandCards.toFixed(1)}MB`);
            console.log(`• 10,000 cards: ${(tenThousandCards / 1024).toFixed(1)}GB`);
            console.log(`• 4TB drive capacity: ~${Math.floor(4000 / (tenThousandCards / 1024))}0,000 resized cards`);
        }
        
        console.log('\n✅ Performance test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

// Helper to create test capture if none exists
async function createTestCapture() {
    const { spawn } = require('child_process');
    
    console.log('📸 Creating test capture...');
    
    return new Promise((resolve, reject) => {
        const captureProcess = spawn('./capture-card', {
            cwd: path.join(__dirname, '..')
        });
        
        captureProcess.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Test capture created');
                resolve();
            } else {
                reject(new Error(`Capture failed with code ${code}`));
            }
        });
        
        captureProcess.on('error', reject);
    });
}

// Main execution
async function main() {
    // Check if we need to create a test capture
    try {
        await fs.access(TEST_IMAGE);
    } catch {
        console.log('No test image found, creating one...');
        await createTestCapture();
    }
    
    await runPerformanceTest();
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { runPerformanceTest };