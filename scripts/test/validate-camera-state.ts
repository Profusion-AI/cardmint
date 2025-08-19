#!/usr/bin/env npx tsx

import { createProductionCamera, CameraDiagnostic } from '../src/camera/SonyCameraProduction';
import * as readline from 'readline';
import chalk from 'chalk';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
};

async function validateCameraState() {
    console.log(chalk.bold.cyan('\n🔍 Sony Camera State Validator\n'));
    console.log('This tool will check your camera configuration and identify issues.\n');
    
    const camera = createProductionCamera();
    
    try {
        // Step 1: List devices
        console.log(chalk.yellow('Step 1: Detecting cameras...'));
        const devices = await camera.listDevices();
        
        if (devices.length === 0) {
            console.log(chalk.red('❌ No cameras detected!'));
            console.log('\nTroubleshooting:');
            console.log('1. Connect camera via USB');
            console.log('2. Turn camera ON');
            console.log('3. Set USB Connection Mode to "PC Remote" (not Mass Storage)');
            console.log('   Menu → Setup → USB → USB Connection Mode → PC Remote');
            return;
        }
        
        console.log(chalk.green(`✅ Found camera: ${devices[0].model}`));
        
        // Step 2: Connect
        console.log(chalk.yellow('\nStep 2: Connecting to camera...'));
        const connected = await camera.connect();
        
        if (!connected) {
            console.log(chalk.red('❌ Failed to connect!'));
            console.log('\nTroubleshooting:');
            console.log('1. Close any other camera software');
            console.log('2. Restart camera');
            console.log('3. Reconnect USB cable');
            return;
        }
        
        console.log(chalk.green('✅ Connected successfully'));
        
        // Wait for diagnostic data
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Step 3: Check diagnostic
        console.log(chalk.yellow('\nStep 3: Analyzing camera state...'));
        const diagnostic = camera.getDiagnostic();
        
        if (!diagnostic) {
            console.log(chalk.red('❌ No diagnostic data received'));
            await camera.disconnect();
            return;
        }
        
        // Display current state
        console.log(chalk.cyan('\n📊 Current Camera State:'));
        console.log('─'.repeat(50));
        
        // Critical settings
        const saveDestOK = diagnostic.save_dest === 'PC_ONLY' || diagnostic.save_dest === 'PC_PLUS_CAMERA';
        const modeOK = ['P', 'A', 'S', 'M'].includes(diagnostic.mode);
        const driveOK = diagnostic.drive === 'SINGLE';
        const liveViewOK = diagnostic.live_view_ok;
        const cardNeeded = diagnostic.save_dest === 'PC_PLUS_CAMERA' && !diagnostic.card_present;
        
        // Save Destination
        console.log(`  Save Destination: ${saveDestOK ? chalk.green('✅') : chalk.red('❌')} ${diagnostic.save_dest}`);
        if (!saveDestOK) {
            console.log(chalk.red(`    ⚠️  Must be PC_ONLY or PC_PLUS_CAMERA`));
            console.log(chalk.yellow(`    📝 Fix: Menu → Network → PC Remote → Still Img. Save Dest. → PC Only`));
        }
        
        // Card presence
        console.log(`  SD Card Present: ${diagnostic.card_present ? chalk.green('✅ YES') : chalk.yellow('⚠️  NO')}`);
        if (cardNeeded) {
            console.log(chalk.red(`    ❌ PC+Camera mode requires SD card!`));
            console.log(chalk.yellow(`    📝 Fix: Insert SD card OR change to PC Only mode`));
        }
        
        // Exposure mode
        console.log(`  Exposure Mode: ${modeOK ? chalk.green('✅') : chalk.red('❌')} ${diagnostic.mode}`);
        if (!modeOK) {
            console.log(chalk.red(`    ⚠️  Must be in P/A/S/M mode for stills`));
            console.log(chalk.yellow(`    📝 Fix: Turn mode dial to P, A, S, or M`));
        }
        
        // Drive mode
        console.log(`  Drive Mode: ${driveOK ? chalk.green('✅') : chalk.yellow('⚠️')} ${diagnostic.drive}`);
        if (!driveOK) {
            console.log(chalk.yellow(`    📝 Recommended: Set to Single for testing`));
        }
        
        // Focus mode
        const focusManual = diagnostic.focus_mode === 'MF';
        console.log(`  Focus Mode: ${focusManual ? chalk.green('✅') : chalk.yellow('⚠️')} ${diagnostic.focus_mode}`);
        if (!focusManual) {
            console.log(chalk.yellow(`    📝 Recommended: Use MF for fastest performance`));
        }
        
        // Live view
        console.log(`  Live View: ${liveViewOK ? chalk.green('✅') : chalk.red('❌')} ${diagnostic.live_view_frames} frames`);
        if (!liveViewOK) {
            console.log(chalk.red(`    ⚠️  Camera not ready - waiting for live view`));
        }
        
        console.log('─'.repeat(50));
        
        // Overall status
        const shootable = camera.isShootable();
        if (shootable) {
            console.log(chalk.bold.green('\n✅ Camera is READY for capture!\n'));
        } else {
            console.log(chalk.bold.red('\n❌ Camera is NOT ready for capture\n'));
            
            if (diagnostic.error) {
                console.log(chalk.red(`Error: ${diagnostic.error}`));
            }
            
            console.log(chalk.yellow('\n📋 Required fixes:'));
            let fixNum = 1;
            
            if (!saveDestOK) {
                console.log(`${fixNum++}. Change Save Destination to PC Only`);
                console.log(`   Menu → Network → PC Remote → Still Img. Save Dest. → PC Only`);
            }
            
            if (cardNeeded) {
                console.log(`${fixNum++}. Insert SD card OR change to PC Only mode`);
            }
            
            if (!modeOK) {
                console.log(`${fixNum++}. Switch camera to P/A/S/M mode (turn mode dial)`);
            }
            
            if (!liveViewOK) {
                console.log(`${fixNum++}. Exit any menus or playback screens`);
                console.log(`   Press shutter button halfway to return to shooting mode`);
            }
        }
        
        // Test capture
        if (shootable) {
            const answer = await question('\nWould you like to test capture? (y/n): ');
            if (answer.toLowerCase() === 'y') {
                console.log(chalk.yellow('\n🎯 Testing capture...'));
                
                try {
                    const imagePath = await camera.captureImage();
                    console.log(chalk.green(`✅ Capture successful!`));
                    console.log(`   Image saved to: ${imagePath}`);
                    
                    // Check final diagnostic
                    const finalDiag = camera.getDiagnostic();
                    if (finalDiag && finalDiag.status === 'success') {
                        console.log(chalk.green(`   Capture latency: ${finalDiag.connected_ms}ms`));
                    }
                } catch (error) {
                    console.log(chalk.red(`❌ Capture failed: ${error}`));
                    
                    const errorDiag = camera.getDiagnostic();
                    if (errorDiag && errorDiag.status === 'error_8402') {
                        console.log(chalk.red('\n🔴 ERROR 0x8402: Operation invalid in current state'));
                        console.log('Common causes:');
                        console.log('  1. Camera showing playback screen');
                        console.log('  2. Save destination is Camera Only');
                        console.log('  3. PC+Camera mode without SD card');
                        console.log('  4. Camera in movie mode');
                    }
                }
            }
        }
        
        // Disconnect
        console.log(chalk.yellow('\nDisconnecting...'));
        await camera.disconnect();
        console.log(chalk.green('✅ Disconnected'));
        
        // Summary
        console.log(chalk.cyan('\n' + '='.repeat(50)));
        console.log(chalk.bold('📋 Summary:'));
        
        if (shootable) {
            console.log(chalk.green('Your camera is properly configured for CardMint!'));
            console.log('\nOptimization tips:');
            console.log('• Use PC Only mode for fastest transfers');
            console.log('• Set focus to Manual (MF) to reduce latency');
            console.log('• Use JPEG (not RAW) for faster processing');
        } else {
            console.log(chalk.yellow('Please fix the issues above and run this validator again.'));
            console.log('\nKey settings to check:');
            console.log('1. Menu → Network → PC Remote → Still Img. Save Dest. → PC Only');
            console.log('2. Mode dial set to P, A, S, or M');
            console.log('3. Exit any menus or playback screens');
        }
        
    } catch (error) {
        console.log(chalk.red(`\n❌ Error: ${error}`));
    } finally {
        rl.close();
        await camera.disconnect().catch(() => {});
    }
}

// Run validator
if (require.main === module) {
    validateCameraState()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(chalk.red(`Fatal error: ${error}`));
            process.exit(1);
        });
}

export { validateCameraState };