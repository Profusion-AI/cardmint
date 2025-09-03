import { IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { promises as fs } from 'fs';
import { createLogger } from '../utils/logger';
import { MetricsCollector } from '../utils/metrics';
import { CardStatus } from '../types';
// Lazy-load IntegratedScannerService only when used, to avoid dragging heavy deps
type IntegratedScanOptions = any;
import path from 'path';
import sharp from 'sharp';
import { hybridOCREngine } from '../services/local-matching/ocr/HybridOCREngine';
import { setIconMatcher } from '../services/local-matching/matchers/SetIconMatcher';
import { createProxyHandler, isViteServerAvailable } from '../utils/devProxy';
import { validateTelemetryEvent, TELEMETRY_CSV_HEADER } from '../schemas/input';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

const logger = createLogger('api-router');

// MIME type mapping for static files
const MIME_TYPES: { [key: string]: string } = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'text/plain';
}

async function serveStaticFile(filePath: string, res: ServerResponse): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return false;
    }

    const content = await fs.readFile(filePath);
    const mimeType = getMimeType(filePath);
    
    res.writeHead(200, { 
      'Content-Type': mimeType,
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=3600', // 1 hour cache
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
    return true;
  } catch (error) {
    return false;
  }
}

// Minimal queue interface to avoid importing full QueueManager
type QueueLike = {
  addProcessingJob?: (data: any, priority?: number) => Promise<any>;
  getQueueStatus?: () => Promise<any>;
} | any;

export function createAPIRouter(
  queueManager: QueueLike,
  metrics: MetricsCollector
) {
  let _cardRepository: any;
  async function getCardRepository() {
    if (!_cardRepository) {
      const modPath = '../storage/' + 'CardRepository';
      const mod: any = await import(modPath);
      _cardRepository = new mod.CardRepository();
    }
    return _cardRepository;
  }
  
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
      // Dashboard routing
      if (pathname === '/' && method === 'GET') {
        // Redirect root to dashboard
        res.writeHead(302, { 'Location': '/dashboard/' });
        res.end();
        return;
        
      } else if (pathname?.startsWith('/dashboard') && method === 'GET') {
        // In development mode, proxy dashboard requests to Vite dev server
        if (process.env.NODE_ENV === 'development') {
          // Try to discover Vite dev port dynamically
          const preferred = Number(process.env.VITE_DEV_PORT) || 5173;
          const candidates = [preferred, 5174, 5175, 5176, 5177, 5178, 5179, 5180];
          let targetPort: number | null = null;
          for (const p of candidates) {
            try {
              // Lightweight HEAD/GET via isViteServerAvailable helper
              const ok = await (async () => {
                try { return await (await import('../utils/devProxy')).isViteServerAvailable(p); } catch { return false; }
              })();
              if (ok) { targetPort = p; break; }
            } catch {}
          }
          if (targetPort) {
            const viteProxy = createProxyHandler({
              target: `http://localhost:${targetPort}`,
              changeOrigin: true,
              pathRewrite: {
                '^/dashboard': ''
              }
            });
            const proxySuccess = await viteProxy(req, res);
            if (proxySuccess) {
              logger.debug(`Proxied dashboard request to Vite on :${targetPort} for ${pathname}`);
              return;
            }
            logger.warn(`Vite proxy to :${targetPort} failed, falling back to static serving`);
          } else {
            logger.warn('No Vite dev server detected; serving static dashboard');
          }
        }
        
        // Static file serving for production or when Vite is unavailable
        if (pathname === '/dashboard' || pathname === '/dashboard/') {
          // Serve dashboard navigation hub
          const navigationPath = path.join(process.cwd(), 'src', 'dashboard', 'navigation.html');
          if (await serveStaticFile(navigationPath, res)) {
            logger.debug('Served dashboard navigation hub');
            return;
          }
        } else if (pathname === '/dashboard/index.html') {
          // Serve main status dashboard
          const dashboardPath = path.join(process.cwd(), 'src', 'dashboard', 'index.html');
          if (await serveStaticFile(dashboardPath, res)) {
            logger.debug('Served main status dashboard');
            return;
          }
        } else if (pathname === '/dashboard/verification.html') {
          // Serve verification/review dashboard
          const verificationPath = path.join(process.cwd(), 'src', 'dashboard', 'verification.html');
          if (await serveStaticFile(verificationPath, res)) {
            logger.debug('Served verification dashboard');
            return;
          }
        } else if (pathname === '/dashboard/roi-calibration.html') {
          // DEPRECATION: Legacy ROI Calibration Tool
          logger.warn('⚠️ DEPRECATED: Legacy ROI calibration tool accessed');
          logger.warn('📍 Consider migrating to Enhanced ROI Tool: /public/dashboard/roi-calibration-enhanced.html');
          
          const roiPath = path.join(process.cwd(), 'src', 'dashboard', 'roi-calibration.html');
          
          // Add deprecation headers before serving
          res.setHeader('X-CardMint-Deprecation-Warning', 'This tool will be removed in v3.0');
          res.setHeader('X-CardMint-Migration-Path', '/public/dashboard/roi-calibration-enhanced.html');
          
          if (await serveStaticFile(roiPath, res)) {
            logger.debug('Served legacy ROI calibration tool (deprecated)');
            return;
          }
        } else if (pathname === '/dashboard/ensemble.html') {
          // Serve ensemble/batch results dashboard
          const ensemblePath = path.join(process.cwd(), 'src', 'dashboard', 'ensemble-dashboard.html');
          if (await serveStaticFile(ensemblePath, res)) {
            logger.debug('Served ensemble dashboard');
            return;
          }
        } else if (pathname === '/dashboard/performance.html') {
          // Serve performance monitoring dashboard
          const performancePath = path.join(process.cwd(), 'src', 'dashboard', 'performance.html');
          if (await serveStaticFile(performancePath, res)) {
            logger.debug('Served performance dashboard');
            return;
          }
        } else if (pathname === '/dashboard/health.html') {
          // Serve system health dashboard
          const healthPath = path.join(process.cwd(), 'src', 'dashboard', 'health.html');
          if (await serveStaticFile(healthPath, res)) {
            logger.debug('Served health dashboard');
            return;
          }
        }
      
      // Static library files (input-bus browser assets)
      } else if (pathname?.startsWith('/lib/') && method === 'GET') {
        const libFile = pathname.substring(5); // Remove '/lib/' prefix
        
        // Security: only allow specific files we need
        const allowedFiles = ['input-bus-browser.js', 'input-integration.js'];
        if (allowedFiles.includes(libFile)) {
          const libPath = path.join(process.cwd(), 'src', 'dashboard', 'lib', libFile);
          if (await serveStaticFile(libPath, res)) {
            logger.debug(`Served library file: /lib/${libFile}`);
            return;
          }
        }
        
        // File not found or not allowed
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Library file not found');
        return;
      }
      
      // API Route handling
      if (pathname === '/api/health' && method === 'GET') {
        const memUsage = process.memoryUsage();
        const healthData = {
          status: 'healthy',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024), // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
            external: Math.round(memUsage.external / 1024 / 1024), // MB
          },
          services: {
            database: 'healthy', // Would check SQLite connection
            queue: queueManager ? 'healthy' : 'unavailable',
            macML: 'unknown', // Would ping Mac M4 server
            websocket: 'healthy',
          },
          version: '2.0.0',
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthData));
        
      } else if (pathname === '/api/roi/manifest' && method === 'GET') {
        // Serve the ROI manifest from DATA_ROOT
        try {
          const dataRoot = process.env.DATA_ROOT || './data';
          const manifestPath = path.join(dataRoot, 'roi_templates.json');
          const content = await fs.readFile(manifestPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(content);
        } catch (error) {
          logger.error('Failed to read ROI manifest:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read ROI manifest' }));
        }

      } else if (pathname === '/api/roi/ocr-test' && method === 'POST') {
        // Quick OCR on a client-provided ROI crop
        try {
          const body = await getRequestBody(req);
          const data = JSON.parse(body);
          const { imageData, roi, text_type } = data as { imageData: string; roi: {x:number;y:number;width:number;height:number}; text_type?: string };
          if (!imageData || !roi) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'imageData and roi required' }));
            return;
          }
          const buffer = Buffer.from(imageData.replace(/^data:[^,]+,/, ''), 'base64');
          const crop = await sharp(buffer)
            .extract({
              left: Math.max(0, Math.round(roi.x)),
              top: Math.max(0, Math.round(roi.y)),
              width: Math.max(1, Math.round(roi.width)),
              height: Math.max(1, Math.round(roi.height)),
            })
            .png()
            .toBuffer();
          await hybridOCREngine.initialize();
          const ocr = await hybridOCREngine.recognizeROI(crop, (text_type || 'text') as any, {
            whitelist: data.whitelist,
            max_length: data.max_length
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: ocr.text, confidence: ocr.confidence, engine: ocr.engine }));
        } catch (error) {
          logger.error('OCR test failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OCR test failed' }));
        }

      } else if (pathname === '/api/roi/zncc-test' && method === 'POST') {
        // Quick ZNCC test on set_icon within a client-provided ROI
        try {
          const body = await getRequestBody(req);
          const data = JSON.parse(body);
          const { imageData, roi } = data as { imageData: string; roi: {x:number;y:number;width:number;height:number} };
          if (!imageData || !roi) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'imageData and roi required' }));
            return;
          }
          const buffer = Buffer.from(imageData.replace(/^data:[^,]+,/, ''), 'base64');
          await setIconMatcher.initialize();
          const result = await setIconMatcher.matchWithinROI('uploaded', buffer, roi);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          logger.error('ZNCC test failed:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ZNCC test failed' }));
        }

      } else if (pathname === '/api/cards' && method === 'GET') {
        const cardRepository = await getCardRepository();
        const cards = await cardRepository.listCards({
          limit: Number(query.limit) || 100,
          offset: Number(query.offset) || 0,
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cards));
        
      } else if (pathname?.startsWith('/api/cards/') && method === 'GET') {
        const cardId = pathname.split('/')[3];
        const cardRepository = await getCardRepository();
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
        const cardRepository = await getCardRepository();
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
        
      } else if (pathname === '/api/capture/simulate' && method === 'POST') {
        // Simulate capture from local file path for E2E testing
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        if (!data.filePath && !data.imageData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'filePath or imageData required' }));
          return;
        }
        
        // Read image from file if filePath provided
        let imageData = data.imageData;
        if (data.filePath && !imageData) {
          try {
            const fileBuffer = await fs.readFile(data.filePath);
            imageData = fileBuffer.toString('base64');
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Cannot read file: ${data.filePath}` }));
            return;
          }
        }
        
        // Create card record for simulation
        const cardRepository = await getCardRepository();
        const card = await cardRepository.createCard({
          imageUrl: data.filePath || 'simulated_capture.jpg',
          status: CardStatus.QUEUED,
        });
        
        // For E2E testing, skip queue and just log the simulation
        logger.info(`Simulated capture created: ${card.id} (${data.filePath})`);
        metrics.recordCapture(0); // Simulation has no capture latency
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          ...card, 
          simulated: true,
          originalPath: data.filePath,
          status: 'simulated_queued',
          message: 'Capture simulation successful - ready for E2E testing'
        }));
        
      } else if (pathname === '/api/batch/enqueue' && method === 'POST') {
        // Batch enqueue multiple files for testing
        const body = await getRequestBody(req);
        const data = JSON.parse(body);
        
        if (!data.filePaths || !Array.isArray(data.filePaths)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'filePaths array required' }));
          return;
        }
        
        const results = [];
        const cycleId = data.cycleId || `batch_${Date.now()}`;
        const delayMs = data.delayMs || 100; // Default 100ms between enqueues
        
        for (const filePath of data.filePaths) {
          try {
            // Check file exists
            await fs.stat(filePath);
            
            // Create card record
            const cardRepository = await getCardRepository();
            const card = await cardRepository.createCard({
              imageUrl: filePath,
              status: CardStatus.QUEUED,
            });
            
            // For E2E testing, skip queue and just log
            results.push({ 
              cardId: card.id, 
              filePath, 
              status: 'simulated_queued',
              message: 'Ready for E2E processing'
            });
            
            logger.info(`Batch simulation created: ${card.id} (${filePath})`);
            
            // Add delay to prevent overwhelming the queue
            if (delayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            
          } catch (error: any) {
            results.push({ 
              filePath, 
              status: 'error', 
              error: error.message 
            });
            logger.error(`Batch enqueue failed: ${filePath} - ${error.message}`);
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          cycleId,
          totalFiles: data.filePaths.length,
          successful: results.filter(r => r.status === 'simulated_queued').length,
          failed: results.filter(r => r.status === 'error').length,
          results
        }));
        
      } else if (pathname === '/api/queue/status' && method === 'GET') {
        const status = await queueManager.getQueueStatus();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        
      } else if (pathname === '/api/metrics' && method === 'GET') {
        const performanceMetrics = metrics.getPerformanceMetrics();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(performanceMetrics));
        
      } else if (pathname === '/api/scanner/health' && method === 'GET') {
        // Health check disabled in fast-build path (service loaded on demand elsewhere)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, disabled: true }));
        
      } else if (pathname === '/api/scanner/stats' && method === 'GET') {
        // Stats disabled in fast-build path
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false }));
        
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
        
        const modPath = '../services/' + 'IntegratedScannerService';
        const mod: any = await import(modPath);
        const result = await mod.integratedScanner.processCard(data.imagePath, options);
        
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
            const modPath = '../services/' + 'IntegratedScannerService';
            const mod: any = await import(modPath);
            const result = await mod.integratedScanner.processCard(imagePath, options);
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
        const modPath = '../services/' + 'IntegratedScannerService';
        const mod: any = await import(modPath);
        const inventory = await mod.integratedScanner.getInventory();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          inventory: inventory,
          total_cards: inventory.length,
          last_updated: new Date().toISOString()
        }));
        
      } else if (pathname === '/api/telemetry/input' && method === 'POST') {
        // Record input telemetry for A/B testing
        const body = await getRequestBody(req);
        
        try {
          const rawTelemetry = JSON.parse(body);
          
          // Validate using shared schema
          const telemetry = validateTelemetryEvent(rawTelemetry);
          
          // Ensure data directory exists
          const csvPath = process.env.INPUT_TELEMETRY_PATH || './data/input-telemetry.csv';
          const dir = dirname(csvPath);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          
          // Ensure CSV has header
          if (!existsSync(csvPath)) {
            await fs.writeFile(csvPath, TELEMETRY_CSV_HEADER + '\n', 'utf8');
          }
          
          // Append telemetry data
          const csvRow = `${telemetry.ts},${telemetry.source},${telemetry.action},${telemetry.cardId},${telemetry.cycleId},${telemetry.latencyMs},"${telemetry.error}"\n`;
          
          await fs.appendFile(csvPath, csvRow, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          
        } catch (error) {
          // Check if it's a validation error first
          if (error && typeof error === 'object' && 'issues' in error) {
            logger.error('Invalid telemetry data:', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'Invalid telemetry data',
              details: error instanceof Error ? error.message : 'Validation failed'
            }));
          } else {
            logger.error('Failed to write telemetry:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to record telemetry' }));
          }
        }
        
      } else if (pathname === '/api/status' && method === 'GET') {
        // System status endpoint for dashboard
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          uptime: process.uptime(),
          environment: process.env.NODE_ENV || 'development',
          timestamp: new Date().toISOString(),
          camera: {
            available: true,
            connected: false // Will be updated when camera integration is available
          },
          controller: {
            available: true,
            connected: false // Will be updated when controller is available
          }
        }));
        return;
        
      } else if (pathname === '/dashboard/status' && method === 'GET') {
        // Dashboard-specific status endpoint
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          dashboard: 'operational',
          timestamp: new Date().toISOString(),
          features: {
            verification: true,
            ensemble: true,
            performance: true,
            health: true
          }
        }));
        return;
        
      } else if (pathname === '/api/telemetry/input/summary' && method === 'GET') {
        // Get telemetry summary for A/B testing analysis
        const csvPath = process.env.INPUT_TELEMETRY_PATH || './data/input-telemetry.csv';
        const cycleId = query.cycle as string;
        
        try {
          const csvData = await fs.readFile(csvPath, 'utf8');
          const rows = csvData.split('\n').slice(1).filter(row => row.trim());
          
          let filteredRows = rows;
          if (cycleId) {
            filteredRows = rows.filter(row => row.includes(cycleId));
          }
          
          const events = filteredRows.map(row => {
            const [ts, source, action, cardId, cycle, latencyMs] = row.split(',');
            return {
              ts: parseInt(ts),
              source: source as 'keyboard' | 'controller',
              action,
              latencyMs: parseFloat(latencyMs),
            };
          });
          
          const keyboardInputs = events.filter(e => e.source === 'keyboard').length;
          const controllerInputs = events.filter(e => e.source === 'controller').length;
          const totalInputs = events.length;
          const avgLatencyMs = totalInputs > 0 
            ? events.reduce((sum, e) => sum + e.latencyMs, 0) / totalInputs 
            : 0;
          
          const summary = {
            totalInputs,
            keyboardInputs,
            controllerInputs,
            avgLatencyMs,
            cycleId: cycleId || 'all',
            timestamp: new Date().toISOString()
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(summary));
          
        } catch (error) {
          logger.error('Failed to read telemetry:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read telemetry' }));
        }
        
      } else if (pathname === '/api/valuation/compare' && method === 'POST') {
        // ValuationService API endpoint
        try {
          const { getValuationTool, isValuationEnabled } = await import('../services/ValuationServiceFactory');
          
          if (!isValuationEnabled()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Valuation service disabled' }));
            return;
          }
          
          const body = await getRequestBody(req);
          const input = JSON.parse(body);
          
          const valuationTool = getValuationTool();
          const result = await valuationTool.compareResale(input);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          
        } catch (error) {
          logger.error('Valuation API error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Valuation service error',
            message: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
        
      } else if (pathname === '/api/valuation/health' && method === 'GET') {
        // ValuationService health check
        try {
          const { getHealthStatus } = await import('../services/ValuationServiceFactory');
          const health = await getHealthStatus();
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
          
        } catch (error) {
          logger.error('Valuation health check error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Health check failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
        
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      
    } catch (error) {
      logger.error('API error:', { url: req.url, error: String(error) });
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
