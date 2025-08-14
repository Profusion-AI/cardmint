#!/usr/bin/env npx tsx

import { createProductionCamera } from './src/camera/SonyCameraProduction';

async function testProductionCamera() {
    console.log('=== Sony Camera Production Test ===\n');
    
    const camera = createProductionCamera();
    
    try {
        // Step 1: List devices
        console.log('1. Listing available cameras...');
        const devices = await camera.listDevices();
        console.log(`   Found ${devices.length} camera(s):`);
        devices.forEach(device => {
            console.log(`   [${device.index}] ${device.model} (${device.id})`);
        });
        
        if (devices.length === 0) {
            console.log('\n❌ No cameras detected');
            return;
        }
        
        // Step 2: Connect
        console.log('\n2. Connecting to camera...');
        const connected = await camera.connect();
        
        if (!connected) {
            console.log('   ❌ Failed to connect');
            return;
        }
        
        console.log('   ✅ Connected successfully!');
        
        // Step 3: Performance test
        console.log('\n3. Performance test (10 captures)...');
        const times: number[] = [];
        
        for (let i = 0; i < 10; i++) {
            const start = Date.now();
            const path = await camera.captureImage();
            const elapsed = Date.now() - start;
            times.push(elapsed);
            console.log(`   Shot ${i + 1}: ${elapsed}ms - ${path}`);
            
            // Small delay between shots
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        const throughput = 60000 / avgTime;
        
        console.log(`\n   Performance Statistics:`);
        console.log(`   - Average: ${avgTime.toFixed(1)}ms`);
        console.log(`   - Min: ${minTime}ms`);
        console.log(`   - Max: ${maxTime}ms`);
        console.log(`   - Throughput: ${throughput.toFixed(1)} cards/minute`);
        
        // Step 4: Verify targets
        console.log('\n4. Target Verification:');
        
        const meetsResponseTime = avgTime < 500;
        const meetsThroughput = throughput > 60;
        
        console.log(`   ${meetsResponseTime ? '✅' : '❌'} Response time (<500ms): ${avgTime.toFixed(1)}ms`);
        console.log(`   ${meetsThroughput ? '✅' : '❌'} Throughput (60+ cards/min): ${throughput.toFixed(1)}`);
        
        // Step 5: Disconnect
        console.log('\n5. Disconnecting...');
        await camera.disconnect();
        console.log('   ✅ Disconnected');
        
        // Summary
        console.log('\n' + '='.repeat(50));
        console.log('🎯 PRODUCTION TEST SUMMARY');
        console.log('='.repeat(50));
        
        if (meetsResponseTime && meetsThroughput) {
            console.log('✅ ALL PERFORMANCE TARGETS MET!');
            console.log('   System is production-ready.');
        } else {
            console.log('⚠️ Performance targets not fully met');
            if (!meetsResponseTime) {
                console.log(`   - Response time: ${avgTime.toFixed(1)}ms (target: <500ms)`);
            }
            if (!meetsThroughput) {
                console.log(`   - Throughput: ${throughput.toFixed(1)} cards/min (target: 60+)`);
            }
        }
        
        console.log('\n✅ Camera integration: WORKING');
        console.log('✅ Native SDK binding: WORKING');
        console.log('✅ Capture functionality: WORKING');
        console.log(`${meetsResponseTime ? '✅' : '⚠️'} Response time target: ${meetsResponseTime ? 'MET' : 'NOT MET'}`);
        console.log(`${meetsThroughput ? '✅' : '⚠️'} Throughput target: ${meetsThroughput ? 'MET' : 'NOT MET'}`);
        console.log('='.repeat(50));
        
        const readinessScore = (
            (devices.length > 0 ? 20 : 0) +
            (connected ? 20 : 0) +
            (times.length === 10 ? 20 : 0) +
            (meetsResponseTime ? 20 : 0) +
            (meetsThroughput ? 20 : 0)
        );
        
        console.log(`\n🏁 Production Readiness: ${readinessScore}%`);
        
        if (readinessScore >= 99) {
            console.log('   ✅ System is 99%+ production-ready!');
        }
        
    } catch (error: any) {
        console.error('\n❌ Test failed:', error.message);
        await camera.disconnect().catch(() => {});
    }
}

// Run the test
testProductionCamera().catch(console.error);