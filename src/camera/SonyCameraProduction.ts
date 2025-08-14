import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';

const SDK_PATH = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC';
const BUILD_PATH = path.join(SDK_PATH, 'build');
const CLI_PATH = path.join(BUILD_PATH, 'sony-cli');

export interface CameraDevice {
    index: number;
    model: string;
    id: string;
}

export interface CaptureResult {
    path: string;
    timestamp: number;
}

export class SonyCameraProduction extends EventEmitter {
    private session: ChildProcess | null = null;
    private connected: boolean = false;
    private captureCallbacks: Map<number, (result: CaptureResult) => void> = new Map();
    private captureCounter: number = 0;

    constructor() {
        super();
    }

    private runCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(CLI_PATH, [command], {
                cwd: BUILD_PATH,
                env: {
                    ...process.env,
                    LD_LIBRARY_PATH: [
                        path.join(SDK_PATH, 'external/crsdk'),
                        path.join(SDK_PATH, 'external/crsdk/CrAdapter'),
                        BUILD_PATH,
                        path.join(BUILD_PATH, 'CrAdapter')
                    ].join(':')
                }
            });

            let output = '';
            let error = '';

            proc.stdout.on('data', (data) => {
                output += data.toString();
            });

            proc.stderr.on('data', (data) => {
                error += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(output);
                } else {
                    reject(new Error(`Command failed: ${error || output}`));
                }
            });
        });
    }

    async listDevices(): Promise<CameraDevice[]> {
        const output = await this.runCommand('list');
        const devices: CameraDevice[] = [];
        
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.startsWith('DEVICE:')) {
                const parts = line.substring(7).split(':');
                if (parts.length >= 3) {
                    devices.push({
                        index: parseInt(parts[0]),
                        model: parts[1],
                        id: parts[2]
                    });
                }
            }
        }
        
        return devices;
    }

    async connect(): Promise<boolean> {
        if (this.connected) {
            return true;
        }

        // Start a session process
        this.session = spawn(CLI_PATH, ['session'], {
            cwd: BUILD_PATH,
            env: {
                ...process.env,
                LD_LIBRARY_PATH: [
                    path.join(SDK_PATH, 'external/crsdk'),
                    path.join(SDK_PATH, 'external/crsdk/CrAdapter'),
                    BUILD_PATH,
                    path.join(BUILD_PATH, 'CrAdapter')
                ].join(':')
            }
        });

        // Handle session output
        this.session.stdout?.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('SESSION:ready')) {
                    this.connected = true;
                    this.emit('connected');
                }
                else if (line.startsWith('CAPTURE:')) {
                    const path = line.substring(8);
                    const timestamp = Date.now();
                    
                    // Find and call the oldest callback
                    const minKey = Math.min(...Array.from(this.captureCallbacks.keys()));
                    const callback = this.captureCallbacks.get(minKey);
                    if (callback) {
                        this.captureCallbacks.delete(minKey);
                        callback({ path, timestamp });
                    }
                }
            }
        });

        this.session.stderr?.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.startsWith('EVENT:')) {
                    this.emit('event', line.substring(6));
                }
            }
        });

        this.session.on('close', () => {
            this.connected = false;
            this.session = null;
            this.emit('disconnected');
        });

        // Wait for connection
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(false);
            }, 5000);

            this.once('connected', () => {
                clearTimeout(timeout);
                resolve(true);
            });
        });
    }

    async disconnect(): Promise<boolean> {
        if (!this.connected || !this.session) {
            return false;
        }

        this.session.stdin?.write('quit\n');
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (this.session) {
                    this.session.kill();
                }
                resolve(true);
            }, 1000);

            this.once('disconnected', () => {
                clearTimeout(timeout);
                resolve(true);
            });
        });
    }

    async captureImage(): Promise<string> {
        if (!this.connected || !this.session) {
            throw new Error('Camera not connected');
        }

        return new Promise((resolve, reject) => {
            const id = this.captureCounter++;
            const timeout = setTimeout(() => {
                this.captureCallbacks.delete(id);
                reject(new Error('Capture timeout'));
            }, 5000);

            this.captureCallbacks.set(id, (result) => {
                clearTimeout(timeout);
                resolve(result.path);
            });

            this.session?.stdin?.write('capture\n');
        });
    }

    getDeviceInfo(): { model: string; connected: boolean } {
        return {
            model: 'Sony Camera',
            connected: this.connected
        };
    }

    isConnected(): boolean {
        return this.connected;
    }
}

// Factory function
export function createProductionCamera(): SonyCameraProduction {
    return new SonyCameraProduction();
}