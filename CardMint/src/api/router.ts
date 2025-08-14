import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { createLogger } from '../utils/logger';
import { QueueManager } from '../queue/QueueManager';
import { MetricsCollector } from '../utils/metrics';
import { CardRepository } from '../storage/CardRepository';
import { CardStatus } from '../types';

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