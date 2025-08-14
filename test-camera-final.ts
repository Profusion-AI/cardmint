#!/usr/bin/env npx tsx

import { createSonyCamera } from './src/camera/SonyCameraBinding';
import * as fs from 'fs';
import * as path from 'path';

async function testCameraIntegration() {
    console.log('=== Sony Camera Final Integration Test ===\n');
    
    const camera = createSonyCamera();
    
    try {
        // Step 1: List devices
        console.log('1. Listing available cameras...');
        const devices = camera.listDevices();
        console.log(`   Found ${devices.length} camera(s):`);
        devices.forEach((device, i) => {
            console.log(`   [${i}] ${device.model} (${device.id})`);
        });
        
        if (devices.length === 0) {
            console.log('\n❌ No cameras detected. Please check:');
            console.log('   - Camera is connected via USB');
            console.log('   - Camera is turned on');
            console.log('   - Camera is in PC Remote mode');
            console.log('   - USB permissions are set correctly');
            return;
        }
        
        // Step 2: Connect
        console.log('\n2. Connecting to camera...');
        const connected = camera.connect();
        
        if (!connected) {
            console.log('   ❌ Failed to connect to camera');
            return;
        }
        
        console.log('   ✅ Connected successfully!');
        
        // Step 3: Get device info
        console.log('\n3. Getting device info...');
        const info = camera.getDeviceInfo();
        console.log(`   Model: ${info.model}`);
        console.log(`   Connected: ${info.connected}`);
        
        // Step 4: Test single capture
        console.log('\n4. Testing single capture...');
        console.log('   Triggering capture...');
        
        const startTime = Date.now();
        const imagePath = await camera.captureImage();
        const captureTime = Date.now() - startTime;
        
        console.log(`   ✅ Capture completed in ${captureTime}ms`);
        console.log(`   Image path: ${imagePath}`);
        
        // Step 5: Performance test
        console.log('\n5. Performance test (5 rapid captures)...');
        const times: number[] = [];
        
        for (let i = 0; i < 5; i++) {
            const perfStart = Date.now();
            await camera.captureImage();
            const perfTime = Date.now() - perfStart;
            times.push(perfTime);
            console.log(`   Shot ${i + 1}: ${perfTime}ms`);
            
            // Small delay between shots
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        
        console.log(`\n   Statistics:`);
        console.log(`   - Average: ${avgTime.toFixed(1)}ms`);
        console.log(`   - Min: ${minTime}ms`);
        console.log(`   - Max: ${maxTime}ms`);
        console.log(`   - Throughput: ${(60000 / avgTime).toFixed(1)} cards/minute`);
        
        // Check performance targets
        if (avgTime < 500) {
            console.log('   ✅ Meets <500ms target!');
        } else {
            console.log('   ⚠️ Does not meet <500ms target');
        }
        
        if (60000 / avgTime > 60) {
            console.log('   ✅ Meets 60+ cards/minute target!');
        } else {
            console.log('   ⚠️ Does not meet 60+ cards/minute target');
        }
        
        // Step 6: Disconnect
        console.log('\n6. Disconnecting...');
        const disconnected = camera.disconnect();
        console.log(`   ${disconnected ? '✅' : '❌'} Disconnected`);
        
        // Summary
        console.log('\n' + '='.repeat(50));
        console.log('Test Summary:');
        console.log('✅ Camera connection established');
        console.log('✅ Capture functionality working');
        console.log(`${avgTime < 500 ? '✅' : '❌'} Performance target (<500ms): ${avgTime.toFixed(1)}ms`);
        console.log(`${60000 / avgTime > 60 ? '✅' : '❌'} Throughput target (60+ cards/min): ${(60000 / avgTime).toFixed(1)}`);
        console.log('='.repeat(50));
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        
        // Try to disconnect on error
        try {
            camera.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
    }
}

// Run the test
testCameraIntegration().catch(console.error);