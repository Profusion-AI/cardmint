#!/usr/bin/env node

// Set up library path for Sony SDK
process.env.LD_LIBRARY_PATH = [
    '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk',
    '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/external/crsdk/CrAdapter',
    process.env.LD_LIBRARY_PATH || ''
].join(':');

const { SonyCamera } = require('./src/camera/build/Release/sony_camera_binding.node');

async function testCamera() {
    console.log('=== Sony Camera Integration Test ===\n');
    
    const camera = new SonyCamera();
    
    try {
        // List available devices
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
            return;
        }
        
        // Connect to camera
        console.log('\n2. Connecting to camera...');
        const connected = camera.connect();
        
        if (!connected) {
            console.log('   ❌ Failed to connect to camera');
            return;
        }
        
        console.log('   ✅ Connected successfully!');
        
        // Get device info
        console.log('\n3. Getting device info...');
        const info = camera.getDeviceInfo();
        console.log(`   Model: ${info.model}`);
        console.log(`   Connected: ${info.connected}`);
        
        // Test capture
        console.log('\n4. Testing capture...');
        console.log('   Triggering capture...');
        
        const startTime = Date.now();
        const imagePath = await camera.captureImage();
        const captureTime = Date.now() - startTime;
        
        console.log(`   ✅ Capture completed in ${captureTime}ms`);
        console.log(`   Image path: ${imagePath}`);
        
        // Test multiple captures
        console.log('\n5. Testing burst capture (3 shots)...');
        for (let i = 0; i < 3; i++) {
            const burstStart = Date.now();
            const path = await camera.captureImage();
            const burstTime = Date.now() - burstStart;
            console.log(`   Shot ${i + 1}: ${burstTime}ms`);
            
            // Small delay between shots
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        // Disconnect
        console.log('\n6. Disconnecting...');
        const disconnected = camera.disconnect();
        console.log(`   ${disconnected ? '✅' : '❌'} Disconnected`);
        
        console.log('\n=== Test Complete ===');
        console.log('✅ All tests passed successfully!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        
        // Try to disconnect on error
        try {
            camera.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
    }
}

// Run the test
testCamera().catch(console.error);