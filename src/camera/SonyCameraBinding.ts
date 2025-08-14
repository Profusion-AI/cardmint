import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// SDK paths
const SDK_PATH = '/home/profusionai/CardMint/CrSDK_v2.00.00_20250805a_Linux64PC';
const BUILD_PATH = path.join(SDK_PATH, 'build');
const BINDING_PATH = path.join(__dirname, 'build/Release/sony_camera_binding.node');

// Ensure SDK libraries are accessible
process.env.LD_LIBRARY_PATH = [
    path.join(SDK_PATH, 'external/crsdk'),
    path.join(SDK_PATH, 'external/crsdk/CrAdapter'),
    path.join(BUILD_PATH),  // For built libraries
    path.join(BUILD_PATH, 'CrAdapter'),  // For adapter libraries
    process.env.LD_LIBRARY_PATH || ''
].join(':');

// CRITICAL: SDK needs to run from its build directory
const originalCwd = process.cwd();
process.chdir(BUILD_PATH);

// Load the native binding
let SonyCamera: any;
try {
    const binding = require(BINDING_PATH);
    SonyCamera = binding.SonyCamera;
} finally {
    // Restore original working directory
    process.chdir(originalCwd);
}

export interface CameraDevice {
    model: string;
    id: string;
    index: number;
}

export interface DeviceInfo {
    model: string;
    connected: boolean;
}

export class SonyCameraWrapper {
    private camera: any;
    private workingDirectory: string;

    constructor() {
        this.workingDirectory = BUILD_PATH;
        
        // Change to SDK directory for initialization
        const currentDir = process.cwd();
        process.chdir(this.workingDirectory);
        
        try {
            this.camera = new SonyCamera();
        } finally {
            process.chdir(currentDir);
        }
    }

    private runInSdkDirectory<T>(fn: () => T): T {
        const currentDir = process.cwd();
        process.chdir(this.workingDirectory);
        try {
            return fn();
        } finally {
            process.chdir(currentDir);
        }
    }

    listDevices(): CameraDevice[] {
        return this.runInSdkDirectory(() => this.camera.listDevices());
    }

    connect(): boolean {
        return this.runInSdkDirectory(() => this.camera.connect());
    }

    disconnect(): boolean {
        return this.runInSdkDirectory(() => this.camera.disconnect());
    }

    async captureImage(): Promise<string> {
        return this.runInSdkDirectory(() => this.camera.captureImage());
    }

    getDeviceInfo(): DeviceInfo {
        return this.runInSdkDirectory(() => this.camera.getDeviceInfo());
    }

    getProperty(name: string): any {
        return this.runInSdkDirectory(() => this.camera.getProperty(name));
    }

    setProperty(name: string, value: any): boolean {
        return this.runInSdkDirectory(() => this.camera.setProperty(name, value));
    }

    startLiveView(): boolean {
        return this.runInSdkDirectory(() => this.camera.startLiveView());
    }

    stopLiveView(): boolean {
        return this.runInSdkDirectory(() => this.camera.stopLiveView());
    }
}

// Export factory function
export function createSonyCamera(): SonyCameraWrapper {
    return new SonyCameraWrapper();
}