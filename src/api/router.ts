import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { createLogger } from '../utils/logger';
import { QueueManager } from '../queue/QueueManager';
import { MetricsCollector } from '../utils/metrics';
import { CardRepository } from '../storage/CardRepository';
import { CardStatus } from '../types';
import { integratedScanner, type IntegratedScanOptions } from '../services/IntegratedScannerService';
import path from 'path';

const logger = createLogger('api-router');

export function createAPIRouter(
  queueManager: QueueManager,
  metrics: MetricsCollector
) {
  const cardRepository = new CardRepository();
  
  return async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, query } = parse(req.url || '', true);
    const method = req.method || 'GET';
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    
    try {
      // Route handling
      if (pathname === '/api/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        }));
        
      } else if (pathname === '/api/cards' && method === 'GET') {
        const cards = await cardRepository.listCards({
          limit: Number(query.limit) || 100,
          offset: Number(query.offset) || 0,
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cards));
        
      } else if (pathname?.startsWith('/api/cards/') && method === 'GET') {
        const cardId = pathname.split('/')[3];
        const card = await cardRepository.getCard(cardId);
        
        if (card) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(card));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Card not found' }));
        }
        
      } else if (pathname === '/api/capture' && method === 'POST') {
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        // Create card record
        const card = await cardRepository.createCard({
          imageUrl: data.imageUrl || '/tmp/capture.jpg',
          status: CardStatus.QUEUED,
        });
        
        // Add to processing queue
        await queueManager.addProcessingJob({
          cardId: card.id,
          imageData: data.imageData,
          type: 'capture',
        });
        
        metrics.recordCapture(Date.now() - new Date(card.capturedAt).getTime());
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        
      } else if (pathname === '/api/queue/status' && method === 'GET') {
        const status = await queueManager.getQueueStatus();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        
      } else if (pathname === '/api/metrics' && method === 'GET') {
        const performanceMetrics = metrics.getPerformanceMetrics();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(performanceMetrics));
        
      } else if (pathname === '/api/scanner/health' && method === 'GET') {
        // Enhanced health check for dual-verification system
        const healthStatus = await integratedScanner.healthCheck();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthStatus));
        
      } else if (pathname === '/api/scanner/stats' && method === 'GET') {
        // Comprehensive scanner statistics
        const stats = integratedScanner.getStatistics();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        
      } else if (pathname === '/api/scanner/process' && method === 'POST') {
        // Process single card with dual-verification
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        if (!data.imagePath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'imagePath is required' }));
          return;
        }
        
        // Parse processing options
        const options: IntegratedScanOptions = {
          useVerification: data.useVerification ?? true,
          fallbackToPython: data.fallbackToPython ?? true,
          skipDatabaseVerification: data.skipDatabaseVerification ?? false,
          forceVerification: data.forceVerification ?? false,
          primaryTimeout: data.primaryTimeout ?? 30000,
          verifierTimeout: data.verifierTimeout ?? 10000,
          updateInventory: data.updateInventory ?? true,
          moveToProcessed: data.moveToProcessed ?? false
        };
        
        logger.info(`Processing card via API: ${path.basename(data.imagePath)}`);
        
        const result = await integratedScanner.processCard(data.imagePath, options);
        
        if (result) {
          // Update metrics
          metrics.recordCapture(result.processing_time_ms || 0);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            result: result,
            processing_method: result.verification_used ? 'dual_verification' : 'python_fallback',
            performance: {
              processing_time_ms: result.processing_time_ms,
              verification_path: result.verification_path,
              confidence: result.final_confidence,
              flagged_for_review: result.flagged_for_review
            }
          }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: false,
            error: 'Card processing failed' 
          }));
        }
        
      } else if (pathname === '/api/scanner/batch' && method === 'POST') {
        // Batch processing endpoint
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        if (!Array.isArray(data.imagePaths)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'imagePaths array is required' }));
          return;
        }
        
        const options: IntegratedScanOptions = {
          useVerification: data.useVerification ?? true,
          fallbackToPython: data.fallbackToPython ?? true,
          ...data.options
        };
        
        logger.info(`Processing batch of ${data.imagePaths.length} cards via API`);
        
        const results = [];
        const batchStart = Date.now();
        
        // Process sequentially for now (can be parallelized later)
        for (const imagePath of data.imagePaths) {
          try {
            const result = await integratedScanner.processCard(imagePath, options);
            if (result) {
              results.push({
                success: true,
                imagePath: imagePath,
                result: result
              });
            } else {
              results.push({
                success: false,
                imagePath: imagePath,
                error: 'Processing failed'
              });
            }
          } catch (error) {
            results.push({
              success: false,
              imagePath: imagePath,
              error: String(error)
            });
          }
        }
        
        const batchTime = Date.now() - batchStart;
        const successCount = results.filter(r => r.success).length;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          batch_completed: true,
          total_cards: data.imagePaths.length,
          successful_cards: successCount,
          failed_cards: data.imagePaths.length - successCount,
          batch_time_ms: batchTime,
          average_time_per_card_ms: batchTime / data.imagePaths.length,
          results: results
        }));
        
      } else if (pathname === '/api/scanner/inventory' && method === 'GET') {
        // Get scanner inventory (legacy compatibility)
        const inventory = await integratedScanner.getInventory();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          inventory: inventory,
          total_cards: inventory.length,
          last_updated: new Date().toISOString()
        }));
        
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      
    } catch (error) {
      logger.error('API error:', error);
      metrics.recordError('api');
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };
}

function getRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      resolve(body);
    });
    
    req.on('error', reject);
  });
}