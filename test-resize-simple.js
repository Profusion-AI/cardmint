#!/usr/bin/env node

/**
 * Simple test for image resize performance
 * Tests optimal resolution for Qwen VLM processing
 */

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

// Test configuration
const TEST_SIZES = [640, 800, 1024, 1280, 1600, 1920];
const CAPTURES_DIR = path.join(__dirname, 'captures');
const RESULTS_DIR = path.join(__dirname, 'resize-tests');

async function findTestImage() {
    try {
        const files = await fs.readdir(CAPTURES_DIR);
        const jpgFiles = files.filter(f => f.endsWith('.JPG')).sort();
        
        if (jpgFiles.length === 0) {
            throw new Error('No JPG files found in captures directory');
        }
        
        // Use the most recent capture
        return path.join(CAPTURES_DIR, jpgFiles[jpgFiles.length - 1]);
    } catch (error) {
        throw new Error(`Cannot find test image: ${error.message}`);
    }
}

async function testResize(inputPath, width) {
    const filename = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(RESULTS_DIR, `${filename}_${width}.jpg`);
    
    const startTime = Date.now();
    
    // Get original file size
    const originalStats = await fs.stat(inputPath);
    const originalSize = originalStats.size;
    
    // Process with Sharp
    const info = await sharp(inputPath)
        .resize(width, null, {
            withoutEnlargement: true,
            fit: 'inside',
            kernel: sharp.kernel.lanczos3
        })
        .jpeg({
            quality: 90,
            progressive: true,
            mozjpeg: true
        })
        .toFile(outputPath);
    
    const processingTime = Date.now() - startTime;
    const resizedStats = await fs.stat(outputPath);
    const compressionRatio = (1 - (resizedStats.size / originalSize)) * 100;
    
    return {
        width,
        height: info.height,
        originalSize,
        resizedSize: resizedStats.size,
        compressionRatio,
        processingTime,
        path: outputPath
    };
}

async function runTest() {
    console.log('🖼️  CardMint Image Resize Performance Test');
    console.log('='.repeat(50));
    
    try {
        // Find test image
        const testImage = await findTestImage();
        console.log(`✅ Using test image: ${path.basename(testImage)}`);
        
        // Create results directory
        await fs.mkdir(RESULTS_DIR, { recursive: true });
        
        // Get original image info
        const metadata = await sharp(testImage).metadata();
        const originalStats = await fs.stat(testImage);
        
        console.log(`📊 Original: ${metadata.width}x${metadata.height} (${(originalStats.size / 1024 / 1024).toFixed(1)}MB)`);
        console.log('');
        
        console.log('Testing resolutions...');
        console.log('-'.repeat(70));
        console.log(`${'Size'.padEnd(8)} | ${'Dimensions'.padEnd(12)} | ${'File Size'.padEnd(12)} | ${'Savings'.padEnd(8)} | ${'Time'.padEnd(8)}`);
        console.log('-'.repeat(70));
        
        const results = [];
        
        for (const size of TEST_SIZES) {
            try {
                const result = await testResize(testImage, size);
                const fileSizeMB = (result.resizedSize / 1024 / 1024).toFixed(2);
                const dimensions = `${result.width}x${result.height}`;
                
                console.log(
                    `${size.toString().padEnd(8)} | ` +
                    `${dimensions.padEnd(12)} | ` +
                    `${fileSizeMB.padEnd(10)}MB | ` +
                    `${result.compressionRatio.toFixed(1).padEnd(6)}% | ` +
                    `${result.processingTime.toString().padEnd(6)}ms`
                );
                
                results.push(result);
            } catch (error) {
                console.log(`${size.toString().padEnd(8)} | ERROR: ${error.message}`);
            }
        }
        
        console.log('-'.repeat(70));
        
        // Find optimal size
        let bestScore = 0;
        let optimalSize = 1280;
        
        const maxFileSize = Math.max(...results.map(r => r.resizedSize));
        const maxProcessingTime = Math.max(...results.map(r => r.processingTime));
        
        console.log('\n🎯 Optimization Analysis:');
        
        for (const result of results) {
            // Score: compression (30%), file size efficiency (40%), speed (30%)
            const compressionScore = result.compressionRatio / 100;
            const fileSizeScore = 1 - (result.resizedSize / maxFileSize);
            const speedScore = 1 - (result.processingTime / maxProcessingTime);
            
            const totalScore = (compressionScore * 0.3) + (fileSizeScore * 0.4) + (speedScore * 0.3);
            
            if (totalScore > bestScore) {
                bestScore = totalScore;
                optimalSize = result.width;
            }
            
            console.log(`${result.width}px: Score ${(totalScore * 100).toFixed(1)} (compression: ${(compressionScore * 100).toFixed(1)}, efficiency: ${(fileSizeScore * 100).toFixed(1)}, speed: ${(speedScore * 100).toFixed(1)})`);
        }
        
        console.log(`\n🏆 Recommended optimal size for Qwen VLM: ${optimalSize}px`);
        
        // Storage analysis
        const optimalResult = results.find(r => r.width === optimalSize);
        if (optimalResult) {
            const avgFileSize = optimalResult.resizedSize;
            const thousandCards = (avgFileSize * 1000) / 1024 / 1024; // MB
            
            console.log('\n💾 Storage Capacity Analysis:');
            console.log(`• Optimal file size: ${(avgFileSize / 1024).toFixed(0)}KB`);
            console.log(`• 1,000 cards: ${thousandCards.toFixed(1)}MB`);
            console.log(`• 10,000 cards: ${(thousandCards * 10 / 1024).toFixed(1)}GB`);
            console.log(`• 100,000 cards: ${(thousandCards * 100 / 1024).toFixed(1)}GB`);
            console.log(`• 4TB capacity: ~${Math.floor(4000 / (thousandCards * 100 / 1024))}00,000 optimized cards`);
        }
        
        // Performance recommendations
        console.log('\n💡 Recommendations for CardMint Production:');
        console.log(`• Use ${optimalSize}px for Qwen VLM processing (optimal accuracy/speed)`);
        console.log('• Use 800px JPEG for dashboard thumbnails');
        console.log('• Use 200px thumbnails for grid views');
        console.log('• Store originals in 4TB archive after processing');
        
        // Save results
        const resultsFile = path.join(RESULTS_DIR, 'performance_results.json');
        await fs.writeFile(resultsFile, JSON.stringify({
            timestamp: new Date().toISOString(),
            testImage: path.basename(testImage),
            originalSize: originalStats.size,
            originalDimensions: `${metadata.width}x${metadata.height}`,
            recommendedSize: optimalSize,
            results
        }, null, 2));
        
        console.log(`\n📝 Results saved to: ${resultsFile}`);
        console.log('\n✅ Performance test completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    runTest();
}

module.exports = { runTest };