#!/usr/bin/env node

// Test script for Sony camera binding
const path = require('path');

console.log('Testing Sony Camera Native Binding...\n');

try {
    // Load the native binding
    const binding = require('./build/Release/sony_camera_binding.node');
    console.log('✓ Native binding loaded successfully');
    
    // Create camera instance
    const camera = new binding.SonyCamera();
    console.log('✓ Camera instance created');
    
    // List available devices
    const devices = camera.listDevices();
    console.log(`✓ Found ${devices.length} device(s):`, devices);
    
    // Get device info (disconnected state)
    const info = camera.getDeviceInfo();
    console.log('✓ Device info:', info);
    
    // Test connection
    console.log('\nAttempting to connect to camera...');
    const connected = camera.connect({ type: 'USB', deviceId: '054c:0ee9' });
    console.log(connected ? '✓ Connected successfully!' : '✗ Connection failed');
    
    if (connected) {
        // Get properties
        console.log('\nTesting property access:');
        const model = camera.getProperty('model');
        console.log('  Model:', model);
        
        const iso = camera.getProperty('iso');
        console.log('  ISO:', iso);
        
        // Set property
        const setProp = camera.setProperty('iso', '200');
        console.log('  Set ISO to 200:', setProp ? '✓' : '✗');
        
        // Test capture (async)
        console.log('\nTesting image capture...');
        camera.captureImage()
            .then(path => {
                console.log(`✓ Image captured: ${path}`);
            })
            .catch(error => {
                console.log('✗ Capture failed:', error);
            })
            .finally(() => {
                // Disconnect
                console.log('\nDisconnecting...');
                const disconnected = camera.disconnect();
                console.log(disconnected ? '✓ Disconnected' : '✗ Disconnect failed');
                
                console.log('\n✅ All tests completed!');
            });
    }
    
} catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
}