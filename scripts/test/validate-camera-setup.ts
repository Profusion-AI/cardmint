#!/usr/bin/env node

/**
 * Camera Setup Validation Script
 * Verifies Sony camera is properly configured for CardMint
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('camera-validator');

interface ValidationResult {
    step: string;
    success: boolean;
    message: string;
    details?: any;
}

class CameraValidator {
    private results: ValidationResult[] = [];
    private sonyCliPath: string;

    constructor() {
        // Find the sony-cli binary
        const possiblePaths = [
            path.resolve(__dirname, '../sony-sdk/build/sony-cli'),
            '/home/profusionai/CardMint/sony-sdk/build/sony-cli',
            './sony-sdk/build/sony-cli',
            '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC/build/sony-cli',
            './CrSDK_v2.00.00_20250805a_Linux64PC/build/sony-cli'
        ];
        
        const found = possiblePaths.find(p => fs.existsSync(p));
        if (!found) {
            throw new Error('Sony CLI binary not found. Please build it first.');
        }
        
        this.sonyCliPath = found;
    }

    private addResult(step: string, success: boolean, message: string, details?: any) {
        this.results.push({ step, success, message, details });
        
        const icon = success ? '✅' : '❌';
        console.log(`${icon} ${step}: ${message}`);
        if (details) {
            console.log(`   Details: ${JSON.stringify(details, null, 2)}`);
        }
    }

    async validateConnection(): Promise<boolean> {
        try {
            // List devices
            const listOutput = execSync(`${this.sonyCliPath} list`, { encoding: 'utf8' });
            const deviceMatch = listOutput.match(/DEVICES:(\d+)/);
            
            if (!deviceMatch || deviceMatch[1] === '0') {
                this.addResult('Camera Detection', false, 'No camera found. Check USB connection.');
                return false;
            }

            // Extract device info
            const deviceInfo = listOutput.match(/DEVICE:0:([^:]+):([^\n]+)/);
            const model = deviceInfo ? deviceInfo[1] : 'Unknown';
            
            this.addResult('Camera Detection', true, `Found ${model}`);

            // Try to connect
            const connectOutput = execSync(`${this.sonyCliPath} connect`, { encoding: 'utf8' });
            const connected = connectOutput.includes('CONNECTED:true');
            
            if (!connected) {
                this.addResult('Camera Connection', false, 'Failed to connect. Check camera is in PC Remote mode.');
                return false;
            }

            this.addResult('Camera Connection', true, 'Connected successfully');
            return true;

        } catch (error) {
            this.addResult('Camera Detection', false, `Error: ${error}`);
            return false;
        }
    }

    async validateCapture(): Promise<boolean> {
        try {
            console.log('\n📸 Testing image capture and transfer...');
            
            const startTime = Date.now();
            const output = execSync(`${this.sonyCliPath} capture`, { encoding: 'utf8' });
            const captureTime = Date.now() - startTime;
            
            // Check if we got a file path
            const fileMatch = output.match(/CAPTURE:(.+)/);
            if (!fileMatch) {
                this.addResult('Image Capture', false, 'No capture path returned');
                return false;
            }

            const filePath = fileMatch[1].trim();
            
            // Check if file exists (for real SDK callback)
            const fileExists = fs.existsSync(filePath);
            
            if (fileExists) {
                const stats = fs.statSync(filePath);
                this.addResult('Image Capture', true, 
                    `Image saved to PC: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
                    { captureTime: `${captureTime}ms`, saveLocation: path.dirname(filePath) }
                );
                
                // Clean up test file
                fs.unlinkSync(filePath);
                return true;
            } else {
                // File doesn't exist - likely camera is saving to SD card only
                this.addResult('Image Capture', false, 
                    'Image NOT saved to PC - Camera is likely set to "Camera Only" mode',
                    { 
                        solution: 'Set camera menu: PC Remote → Still Img. Save Dest. → "PC Only"',
                        fakePath: filePath 
                    }
                );
                return false;
            }

        } catch (error) {
            this.addResult('Image Capture', false, `Capture failed: ${error}`);
            return false;
        }
    }

    async validatePerformance(): Promise<void> {
        console.log('\n⚡ Performance Testing (5 captures)...');
        
        const times: number[] = [];
        
        for (let i = 0; i < 5; i++) {
            try {
                const start = Date.now();
                execSync(`${this.sonyCliPath} capture`, { encoding: 'utf8' });
                const elapsed = Date.now() - start;
                times.push(elapsed);
                process.stdout.write(`   Capture ${i + 1}: ${elapsed}ms\n`);
            } catch (error) {
                console.error(`   Capture ${i + 1} failed`);
            }
        }

        if (times.length > 0) {
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const min = Math.min(...times);
            const max = Math.max(...times);
            
            const meetsTarget = avg < 1000; // 1 second target
            
            this.addResult('Performance', meetsTarget,
                meetsTarget ? 'Meets performance target' : 'Below performance target',
                {
                    average: `${avg.toFixed(0)}ms`,
                    min: `${min}ms`,
                    max: `${max}ms`,
                    target: '< 1000ms'
                }
            );
        }
    }

    async disconnectCamera(): Promise<void> {
        try {
            execSync(`${this.sonyCliPath} disconnect`, { encoding: 'utf8' });
            console.log('\n🔌 Camera disconnected');
        } catch (error) {
            // Ignore disconnect errors
        }
    }

    printSummary(): void {
        console.log('\n' + '='.repeat(60));
        console.log('VALIDATION SUMMARY');
        console.log('='.repeat(60));
        
        const passed = this.results.filter(r => r.success).length;
        const total = this.results.length;
        const allPassed = passed === total;
        
        console.log(`\nResults: ${passed}/${total} checks passed\n`);
        
        if (!allPassed) {
            console.log('❌ CAMERA SETUP INCOMPLETE\n');
            console.log('Required Actions:');
            
            const failures = this.results.filter(r => !r.success);
            failures.forEach(f => {
                console.log(`\n• ${f.step}:`);
                console.log(`  Problem: ${f.message}`);
                if (f.details?.solution) {
                    console.log(`  Solution: ${f.details.solution}`);
                }
            });
            
            console.log('\n📖 See docs/CAMERA_SETUP.md for detailed instructions');
        } else {
            console.log('✅ CAMERA READY FOR CARDMINT!\n');
            console.log('You can now run:');
            console.log('  ./scan-card.ts        # Scan a single card');
            console.log('  ./test-end-to-end.ts  # Run full pipeline test');
        }
    }
}

async function main() {
    console.log('🔍 CardMint Camera Setup Validator\n');
    console.log('This tool verifies your Sony camera is properly configured.\n');
    
    const validator = new CameraValidator();
    
    try {
        // Step 1: Check connection
        const connected = await validator.validateConnection();
        if (!connected) {
            validator.printSummary();
            process.exit(1);
        }
        
        // Step 2: Test capture
        const captureWorks = await validator.validateCapture();
        
        // Step 3: Performance test (only if capture works)
        if (captureWorks) {
            await validator.validatePerformance();
        }
        
        // Cleanup
        await validator.disconnectCamera();
        
    } catch (error) {
        console.error('\n❌ Validation failed:', error);
    }
    
    validator.printSummary();
    process.exit(validator.results.every(r => r.success) ? 0 : 1);
}

if (require.main === module) {
    main().catch(console.error);
}