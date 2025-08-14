#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// First, test with the SDK CLI to verify camera is accessible
console.log('Testing Sony SDK connection...\n');

const sdkPath = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC';
const env = {
    ...process.env,
    LD_LIBRARY_PATH: [
        path.join(sdkPath, 'external/crsdk'),
        path.join(sdkPath, 'external/crsdk/CrAdapter'),
        process.env.LD_LIBRARY_PATH || ''
    ].join(':')
};

// Test SDK enumeration first
const remoteCli = spawn(path.join(sdkPath, 'build/RemoteCli'), [], {
    env,
    cwd: path.join(sdkPath, 'build')
});

let output = '';
let cameraFound = false;

remoteCli.stdout.on('data', (data) => {
    output += data.toString();
    process.stdout.write(data);
    
    if (data.toString().includes('ZV-E10M2')) {
        cameraFound = true;
    }
    
    // Auto-respond to prompts
    if (data.toString().includes('input>')) {
        if (!cameraFound) {
            // Exit if no camera found
            remoteCli.stdin.write('x\n');
        } else if (data.toString().includes('Connect to camera')) {
            // Select camera 1
            remoteCli.stdin.write('1\n');
        } else {
            // Exit from menu
            remoteCli.stdin.write('x\n');
        }
    }
});

remoteCli.on('close', (code) => {
    console.log(`\nSDK test completed with code ${code}`);
    
    if (cameraFound) {
        console.log('✅ Camera detected by SDK');
        
        // Now test our binding
        console.log('\nTesting Node.js binding...\n');
        
        // Load with proper environment
        process.env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH;
        
        try {
            const { SonyCamera } = require('./src/camera/build/Release/sony_camera_binding.node');
            const camera = new SonyCamera();
            
            console.log('Listing devices from binding:');
            const devices = camera.listDevices();
            console.log('Devices found:', devices);
            
            if (devices.length > 0) {
                console.log('\n✅ Camera accessible from Node.js binding!');
            } else {
                console.log('\n❌ Camera not accessible from binding');
                console.log('This might be a permission or initialization issue.');
            }
            
        } catch (error) {
            console.error('Error loading binding:', error);
        }
    } else {
        console.log('❌ Camera not detected by SDK');
    }
});

// Handle errors
remoteCli.on('error', (error) => {
    console.error('Failed to start SDK test:', error);
});