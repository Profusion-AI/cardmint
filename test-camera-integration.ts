#!/usr/bin/env tsx

import { SonyCamera } from './src/camera/SonyCamera';

async function testCameraIntegration() {
    console.log('Testing Sony Camera Integration...\n');
    
    const camera = new SonyCamera({
        type: 'USB',
        deviceId: '054c:0ee9',
        autoReconnect: false
    });
    
    try {
        // List available devices
        const devices = await SonyCamera.listAvailableDevices();
        console.log('Available devices:', devices);
        
        // Connect to camera
        console.log('\nConnecting to camera...');
        const connected = await camera.connect();
        console.log('Connected:', connected);
        
        if (connected) {
            // Get device info
            const info = camera.getDeviceInfo();
            console.log('Device info:', info);
            
            // Get properties
            console.log('\nCamera properties:');
            const model = await camera.getProperty('model');
            console.log('  Model:', model);
            
            const iso = await camera.getProperty('iso');
            console.log('  ISO:', iso);
            
            // Capture image
            console.log('\nCapturing image...');
            const imagePath = await camera.captureImage();
            console.log('Image captured:', imagePath);
            
            // Disconnect
            await camera.disconnect();
            console.log('\n✅ Test completed successfully!');
        }
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testCameraIntegration();