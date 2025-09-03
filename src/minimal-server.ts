#!/usr/bin/env node

// Minimal CardMint Server for E2E Testing
// Focuses only on input-bus, telemetry API, and dashboard serving

import http from 'http';
import { WebSocketServer } from 'ws';
import { createLogger } from './utils/logger';
import { createAPIRouter } from './api/router';
import { config } from './config';
import { initializeDatabase } from './storage/sqlite-database';

const logger = createLogger('minimal-server');

// Minimal queue manager that just accepts tasks but doesn't process them
class MinimalQueueManager {
  enqueue = async () => ({ id: 'mock', status: 'pending' });
  close = async () => {};
}

// Minimal metrics collector 
class MinimalMetricsCollector {
  recordCounter = () => {};
  recordHistogram = () => {};
  recordError = () => {};
  recordTelemetry = () => {};
  recordCapture = () => {};
  getStats = () => ({ counters: {}, histograms: {} });
  getPerformanceMetrics = () => ({ captures: 0, processing: 0, errors: 0 });
}

async function startMinimalServer() {
  try {
    logger.info('🚀 Starting minimal CardMint server for E2E testing...');
    
    // Initialize database first
    await initializeDatabase();
    logger.info('✅ Database initialized');
    
    // Create minimal dependencies
    const queueManager = new MinimalQueueManager();
    const metrics = new MinimalMetricsCollector();
    
    // Create API router
    const router = createAPIRouter(queueManager as any, metrics as any);
    
    // Create HTTP server
    const server = http.createServer(router);
    
    // Create WebSocket server
    const wss = new WebSocketServer({ 
      server,
      path: '/ws' 
    });
    
    wss.on('connection', (ws) => {
      logger.info('WebSocket client connected');
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          logger.debug('WebSocket message:', data);
          
          // Echo back for testing
          ws.send(JSON.stringify({ 
            type: 'echo', 
            data,
            timestamp: Date.now() 
          }));
        } catch (error) {
          logger.error('WebSocket message error:', error);
        }
      });
      
      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
      });
    });
    
    // Start server
    const port = config.server.port;
    server.listen(port, () => {
      logger.info(`✅ Minimal server running on port ${port}`);
      logger.info(`📊 API: http://${config.server.host}:${port}`);
      logger.info(`🔌 WebSocket: ws://${config.server.host}:${port}/ws`);
      logger.info(`📱 Dashboard: http://${config.server.host}:${port}/dashboard/verification.html`);
      logger.info(`📝 Telemetry: ${process.env.INPUT_TELEMETRY_PATH || './data/input-telemetry.csv'}`);
    });
    
    // Graceful shutdown
    const shutdown = () => {
      logger.info('⏹️  Shutting down minimal server...');
      wss.close(() => {
        server.close(() => {
          logger.info('✅ Server stopped');
          process.exit(0);
        });
      });
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
  } catch (error) {
    logger.error('❌ Failed to start minimal server:', error);
    process.exit(1);
  }
}

// Start if called directly
if (require.main === module) {
  startMinimalServer();
}

export { startMinimalServer };