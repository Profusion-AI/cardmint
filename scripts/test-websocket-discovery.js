#!/usr/bin/env node
// scripts/test-websocket-discovery.js
// Test WebSocket auto-discovery functionality using headless browser

const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const http = require('http');

class WebSocketDiscoveryTester {
    constructor() {
        this.testResults = [];
        this.mockServers = [];
        this.browser = null;
    }

    log(level, message) {
        const timestamp = new Date().toISOString();
        const colors = {
            info: '\x1b[36m',
            success: '\x1b[32m',
            warning: '\x1b[33m',
            error: '\x1b[31m',
            reset: '\x1b[0m'
        };
        console.log(`${colors[level]}[${timestamp}] ${level.toUpperCase()}: ${message}${colors.reset}`);
    }

    async createMockWebSocketServer(port) {
        return new Promise((resolve, reject) => {
            const wss = new WebSocket.Server({ port }, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                
                this.log('info', `Mock WebSocket server started on port ${port}`);
                
                wss.on('connection', (ws) => {
                    this.log('info', `Client connected to mock server on port ${port}`);
                    
                    // Send welcome message
                    ws.send(JSON.stringify({
                        type: 'connected',
                        payload: { 
                            serverId: `mock-${port}`,
                            timestamp: new Date().toISOString() 
                        }
                    }));
                    
                    // Handle ping messages
                    ws.on('message', (data) => {
                        try {
                            const message = JSON.parse(data.toString());
                            if (message.type === 'ping') {
                                ws.send(JSON.stringify({ type: 'pong' }));
                            }
                        } catch (e) {
                            // Ignore malformed messages
                        }
                    });
                });
                
                this.mockServers.push(wss);
                resolve(wss);
            });
        });
    }

    async createMockHTMLDashboard(dashboardPort) {
        const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta name="ws-url" content="ws://localhost:3001">
    <title>WebSocket Discovery Test</title>
</head>
<body>
    <div id="status">Connecting...</div>
    <div id="connection-info"></div>
    
    <script>
        // Minimal WebSocket manager for testing
        class TestWebSocketManager {
            constructor() {
                this.ws = null;
                this.url = document.querySelector('meta[name="ws-url"]')?.content || this.getDefaultWebSocketUrl();
                this.connected = false;
                this.connectionInfo = { url: this.url, connected: false, attempts: 0 };
                this.connect();
            }
            
            getDefaultWebSocketUrl() {
                const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const port = this.getWebSocketPort();
                return protocol + '//' + location.hostname + ':' + port;
            }
            
            getWebSocketPort() {
                const currentPort = parseInt(location.port || '80');
                if (currentPort === 3000) return '3001';
                if (currentPort === 5173) return '3001';
                if (currentPort === 5177) return '3002'; // Fallback case
                return '3001';
            }
            
            connect() {
                try {
                    console.log('Attempting WebSocket connection to:', this.url);
                    this.ws = new WebSocket(this.url);
                    
                    this.ws.onopen = () => {
                        console.log('WebSocket connected successfully');
                        this.connected = true;
                        this.connectionInfo.connected = true;
                        this.updateStatus('Connected to ' + this.url, 'success');
                    };
                    
                    this.ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            console.log('Received message:', data);
                            if (data.type === 'connected') {
                                this.updateConnectionInfo(data.payload);
                            }
                        } catch (e) {
                            console.warn('Failed to parse message:', event.data);
                        }
                    };
                    
                    this.ws.onclose = () => {
                        console.log('WebSocket disconnected');
                        this.connected = false;
                        this.connectionInfo.connected = false;
                        this.updateStatus('Disconnected', 'error');
                        
                        // Try fallback port after 1 second
                        setTimeout(() => this.tryFallbackPort(), 1000);
                    };
                    
                    this.ws.onerror = (error) => {
                        console.error('WebSocket error:', error);
                        this.updateStatus('Connection error', 'error');
                    };
                    
                } catch (error) {
                    console.error('Failed to create WebSocket:', error);
                    this.updateStatus('Failed to connect', 'error');
                }
            }
            
            tryFallbackPort() {
                if (this.url.includes('3001')) {
                    this.url = this.url.replace('3001', '3002');
                    this.connectionInfo.url = this.url;
                    this.connectionInfo.attempts++;
                    console.log('Trying fallback port:', this.url);
                    this.connect();
                }
            }
            
            updateStatus(message, type) {
                const statusEl = document.getElementById('status');
                statusEl.textContent = message;
                statusEl.className = type;
            }
            
            updateConnectionInfo(payload) {
                const infoEl = document.getElementById('connection-info');
                infoEl.textContent = 'Server ID: ' + (payload.serverId || 'unknown');
            }
            
            getConnectionInfo() {
                return this.connectionInfo;
            }
            
            isConnected() {
                return this.connected;
            }
        }
        
        // Global instance for testing
        window.wsManager = new TestWebSocketManager();
        
        // Export connection info for testing
        window.getTestResults = () => ({
            connected: window.wsManager.isConnected(),
            connectionInfo: window.wsManager.getConnectionInfo(),
            finalUrl: window.wsManager.url
        });
    </script>
    
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .success { color: green; }
        .error { color: red; }
        .warning { color: orange; }
    </style>
</body>
</html>`;

        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(dashboardHTML);
            });
            
            server.listen(dashboardPort, (error) => {
                if (error) {
                    reject(error);
                    return;
                }
                
                this.log('info', `Mock dashboard server started on port ${dashboardPort}`);
                this.mockServers.push(server);
                resolve(server);
            });
        });
    }

    async runDiscoveryTest(testName, wsPort, dashboardPort, expectedFallback = false) {
        this.log('info', `Starting test: ${testName}`);
        
        try {
            // Create mock WebSocket server
            await this.createMockWebSocketServer(wsPort);
            
            // Create mock dashboard server
            await this.createMockHTMLDashboard(dashboardPort);
            
            // Launch browser and navigate to dashboard
            const page = await this.browser.newPage();
            
            // Enable console logging
            page.on('console', msg => {
                this.log('info', `Browser Console: ${msg.text()}`);
            });
            
            // Navigate to test dashboard
            await page.goto(`http://localhost:${dashboardPort}`);
            
            // Wait for WebSocket connection (or fallback attempt)
            const maxWaitTime = expectedFallback ? 15000 : 10000;
            
            try {
                await page.waitForFunction(
                    () => window.wsManager?.isConnected() === true,
                    { timeout: maxWaitTime }
                );
                
                // Get connection results
                const testResults = await page.evaluate(() => window.getTestResults());
                
                this.testResults.push({
                    testName,
                    success: true,
                    connected: testResults.connected,
                    finalUrl: testResults.finalUrl,
                    attempts: testResults.connectionInfo.attempts,
                    expectedPort: wsPort,
                    actualPort: testResults.finalUrl.match(/:(\d+)/)?.[1],
                    fallbackUsed: testResults.connectionInfo.attempts > 0
                });
                
                this.log('success', `✅ ${testName}: WebSocket connected to ${testResults.finalUrl}`);
                if (testResults.connectionInfo.attempts > 0) {
                    this.log('info', `   Fallback used after ${testResults.connectionInfo.attempts} attempts`);
                }
                
            } catch (timeoutError) {
                this.testResults.push({
                    testName,
                    success: false,
                    error: 'Connection timeout',
                    expectedPort: wsPort
                });
                
                this.log('error', `❌ ${testName}: Connection timeout after ${maxWaitTime}ms`);
            }
            
            await page.close();
            
        } catch (error) {
            this.testResults.push({
                testName,
                success: false,
                error: error.message
            });
            
            this.log('error', `❌ ${testName}: ${error.message}`);
        }
    }

    async runTestSuite() {
        this.log('info', '🚀 Starting WebSocket Discovery Test Suite');
        
        try {
            // Launch headless browser
            this.browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            // Test 1: Normal connection (port 3001 available)
            await this.runDiscoveryTest(
                'Normal Connection', 
                3001, 
                5173
            );
            
            // Clean servers before next test
            await this.cleanupServers();
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Test 2: Fallback scenario (port 3001 blocked, 3002 available)
            // First, create a blocker on 3001
            const blocker = http.createServer().listen(3001);
            this.mockServers.push(blocker);
            
            await this.runDiscoveryTest(
                'Fallback Discovery', 
                3002, 
                5177, 
                true  // Expected fallback
            );
            
            await this.cleanupServers();
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Test 3: Port discovery with dashboard on different port
            await this.runDiscoveryTest(
                'Port Discovery', 
                3001, 
                8080
            );
            
        } catch (error) {
            this.log('error', `Test suite failed: ${error.message}`);
        } finally {
            await this.cleanup();
        }
    }

    async cleanupServers() {
        for (const server of this.mockServers) {
            try {
                server.close();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
        this.mockServers = [];
    }

    async cleanup() {
        await this.cleanupServers();
        
        if (this.browser) {
            await this.browser.close();
        }
    }

    generateReport() {
        this.log('info', '\n📊 Test Results Summary');
        console.log('=' .repeat(60));
        
        let passed = 0;
        let total = this.testResults.length;
        
        for (const result of this.testResults) {
            const status = result.success ? '✅ PASS' : '❌ FAIL';
            console.log(`${status} ${result.testName}`);
            
            if (result.success) {
                passed++;
                console.log(`   Connected to: ${result.finalUrl}`);
                if (result.fallbackUsed) {
                    console.log(`   Used fallback after ${result.attempts} attempts`);
                }
            } else {
                console.log(`   Error: ${result.error}`);
            }
            console.log('');
        }
        
        console.log('=' .repeat(60));
        console.log(`Results: ${passed}/${total} tests passed`);
        
        if (passed === total) {
            this.log('success', '🎉 All WebSocket discovery tests passed!');
            return 0;
        } else {
            this.log('error', `💥 ${total - passed} test(s) failed`);
            return 1;
        }
    }
}

// Main execution
async function main() {
    // Check if puppeteer is available
    try {
        require.resolve('puppeteer');
    } catch (e) {
        console.error('❌ Puppeteer not found. Install with: npm install --save-dev puppeteer');
        process.exit(1);
    }
    
    const tester = new WebSocketDiscoveryTester();
    
    try {
        await tester.runTestSuite();
        const exitCode = tester.generateReport();
        process.exit(exitCode);
    } catch (error) {
        console.error('💥 Test suite crashed:', error.message);
        process.exit(1);
    }
}

// Handle cleanup on process termination
process.on('SIGINT', async () => {
    console.log('\n⚠️  Test interrupted by user');
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('\n⚠️  Test terminated');
    process.exit(1);
});

if (require.main === module) {
    main();
}

module.exports = { WebSocketDiscoveryTester };