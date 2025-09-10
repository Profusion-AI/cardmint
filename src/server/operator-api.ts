/**
 * CardMint Operator API — skeleton server (offline-first)
 *
 * Endpoints (to be implemented by Claude):
 *  - GET /api/health -> { ok: true }
 *  - POST /api/scan  -> shells out to Python runner (SCAN_CMD), returns PRD JSON + base64 crops
 *  - POST /api/accept -> persists to SQLite (WAL) via Python accept subcommand; appends CSV
 *  - GET /api/history -> last 10 accepted rows
 *
 * Notes:
 *  - Keep localhost:3000 only. No external network calls.
 *  - Use child_process.spawn for SCAN_CMD, replacing {input} and {crops} placeholders.
 *  - Write session JSONL (accepted.jsonl) for QA.
 */

import http from 'http';
import { parse } from 'url';
import { promises as fs } from 'fs';
import path from 'path';
import { IncomingForm } from 'formidable';
import { v4 as uuidv4 } from 'uuid';
import { runOperatorScan, runPythonModule } from './python-run.js';

const PORT = Number(process.env.OPERATOR_PORT || 3000);
const TEMP_DIR = path.join(process.cwd(), 'tmp');
const CROPS_DIR = path.join(process.cwd(), 'tmp', 'crops');
const SCAN_CACHE_DIR = path.join(process.cwd(), 'tmp', 'scans');

// In-memory cache for recent scans (scan_id -> result)
const scanCache = new Map<string, any>();

function json(res: http.ServerResponse, code: number, body: any) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function notImplemented(res: http.ServerResponse, hint: string) {
  json(res, 501, { error: 'not_implemented', hint });
}

async function ensureDirectories() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
  await fs.mkdir(CROPS_DIR, { recursive: true });
  await fs.mkdir(SCAN_CACHE_DIR, { recursive: true });
}

async function handleScanRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    await ensureDirectories();
    
    const form = new IncomingForm({
      uploadDir: TEMP_DIR,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB limit
    });
    
    form.parse(req, async (err, fields, files) => {
      if (err) {
        return json(res, 400, { error: 'upload_failed', message: err.message });
      }
      
      const imageFile = Array.isArray(files.image) ? files.image[0] : files.image;
      if (!imageFile) {
        return json(res, 400, { error: 'no_image', message: 'No image file provided' });
      }
      
      // Create a temporary crops directory; will be renamed to match Python's scan_id after scan
      const tempId = uuidv4();
      const cropsDir = path.join(CROPS_DIR, tempId);
      await fs.mkdir(cropsDir, { recursive: true });
      
      // Use Python helper with proper environment (final attempt)
      const configPath = process.env.CARDMINT_CONFIG || 'cardmint/configs/dev_cpu.yaml';
      
      try {
        console.log(`Running scan: ${imageFile.filepath} -> ${cropsDir}`);
        console.log(`Config: ${configPath}`);
        
        const { code, stdout, stderr } = await runOperatorScan(
          imageFile.filepath, 
          cropsDir, 
          ['--config', configPath], 
          { timeoutMs: 15000 }
        );
        
        if (code !== 0) {
          console.error('Scan failed:', stderr);
          return json(res, 500, { 
            error: 'scan_failed', 
            message: `Scanner failed: ${stderr.substring(0, 200)}...`,
            emissions: [{ level: 'error', code: 'OCR_FAILED', message: 'Scanner execution failed' }]
          });
        }
        
        // Parse JSON from stdout
        let scanResult: any;
        try {
          // Try parsing the entire stdout first
          scanResult = JSON.parse(stdout.trim());
        } catch (parseError) {
          // If that fails, look for JSON line in output
          const lines = stdout.split('\n');
          const jsonLine = lines.find(line => {
            const trimmed = line.trim();
            return trimmed.startsWith('{') && trimmed.includes('"scan_id"');
          });
          
          if (!jsonLine) {
            console.error('No JSON found in stdout:', stdout.substring(0, 200));
            return json(res, 500, { 
              error: 'parse_failed', 
              message: 'No valid JSON in scanner output'
            });
          }
          
          try {
            scanResult = JSON.parse(jsonLine.trim());
          } catch (secondParseError) {
            console.error('JSON parse failed:', secondParseError.message);
            return json(res, 500, { 
              error: 'parse_failed', 
              message: `JSON parse failed: ${secondParseError.message}`
            });
          }
        }
        
        // Unify IDs: rename/move crops directory to match Python's scan_id when different
        let finalCropsDir = cropsDir;
        try {
          const pyScanId: string | undefined = scanResult?.scan_id;
          if (pyScanId && pyScanId !== tempId) {
            const targetDir = path.join(CROPS_DIR, pyScanId);
            try {
              await fs.rename(cropsDir, targetDir);
              finalCropsDir = targetDir;
            } catch (renameErr: any) {
              // Cross-device or other rename issues: fallback to copy + remove
              try {
                // @ts-ignore Node 20 has fs.cp
                await (fs as any).cp(cropsDir, targetDir, { recursive: true, force: true });
                await fs.rm(cropsDir, { recursive: true, force: true });
                finalCropsDir = targetDir;
              } catch (cpErr: any) {
                console.warn('Crops directory move failed; keeping temp dir:', cpErr?.message || cpErr);
              }
            }
          }
        } catch (e) {
          console.warn('Crops directory ID unification failed:', e);
        }

        const processedResult = await processScanResult(scanResult, finalCropsDir, imageFile.filepath);

        // Cache result in-memory and on disk for /api/accept
        try {
          scanCache.set(processedResult.scan_id, processedResult);
          const cachePath = path.join(SCAN_CACHE_DIR, `${processedResult.scan_id}.json`);
          await fs.writeFile(cachePath, JSON.stringify(processedResult));
        } catch (cacheErr) {
          console.warn('Failed to cache scan result:', cacheErr);
        }

        json(res, 200, processedResult);
      } catch (error) {
        console.error('Scan execution failed:', error);
        json(res, 500, { 
          error: 'scan_failed', 
          message: error.message,
          emissions: [{ level: 'error', code: 'OCR_TIMEOUT', message: 'Scanner timed out or crashed' }]
        });
      }
    });
    
  } catch (error) {
    console.error('Scan request handling failed:', error);
    json(res, 500, { error: 'internal_error', message: error.message });
  }
}


async function processScanResult(scanResult: any, cropsDir: string, originalImagePath: string): Promise<any> {
  // Attach crop data URLs
  const crops: any = {};
  
  try {
    const cropFiles = await fs.readdir(cropsDir);
    
    for (const cropFile of cropFiles) {
      const fieldName = path.parse(cropFile).name; // Remove .png extension
      const cropPath = path.join(cropsDir, cropFile);
      
      try {
        const cropData = await fs.readFile(cropPath);
        const base64Data = cropData.toString('base64');
        crops[fieldName] = `data:image/png;base64,${base64Data}`;
      } catch (readError) {
        console.warn(`Failed to read crop ${cropFile}:`, readError);
      }
    }
  } catch (dirError) {
    console.warn('Failed to read crops directory:', dirError);
  }
  
  // Add crops and image URL to scan result
  return {
    ...scanResult,
    crops,
    image_url: `file://${originalImagePath}` // For local display
  };
}

async function handleAcceptRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const acceptData = JSON.parse(body);
        
        if (!acceptData.scan_id) {
          return json(res, 400, { error: 'missing_scan_id', message: 'scan_id is required' });
        }
        
        // Resolve full scan payload: prefer request body, else lookup cache (memory → disk)
        let fullPayload = acceptData;
        const hasFields = acceptData.fields && acceptData.conf && acceptData.timings_ms;
        if (!hasFields) {
          const sid: string = acceptData.scan_id;
          fullPayload = scanCache.get(sid);
          if (!fullPayload) {
            try {
              const cachePath = path.join(SCAN_CACHE_DIR, `${sid}.json`);
              const cached = await fs.readFile(cachePath, 'utf8');
              fullPayload = JSON.parse(cached);
            } catch {
              // no-op
            }
          }
        }

        if (!fullPayload || !fullPayload.fields) {
          return json(res, 404, { error: 'not_found', message: 'Cached scan payload not found for scan_id' });
        }

        // Call Python accept subcommand using helper
        console.log(`Accepting scan_id: ${acceptData.scan_id}`);

        const { code, stdout, stderr } = await runPythonModule(
          ['-m', 'cardmint.runners.accept', '--stdin'],
          {
            timeoutMs: 8000,
            stdinData: JSON.stringify(fullPayload)
          }
        );
        if (code !== 0) {
          console.error('Accept failed:', stderr);
          return json(res, 500, { 
            error: 'accept_failed', 
            message: `Accept command failed: ${stderr}` 
          });
        }
        
        let acceptResult;
        try {
          acceptResult = JSON.parse(stdout);
        } catch (parseError) {
          console.error('Accept JSON parse failed:', parseError);
          return json(res, 500, { 
            error: 'parse_failed', 
            message: `Invalid JSON from accept command: ${parseError.message}` 
          });
        }
        
        json(res, 200, acceptResult);
      } catch (parseError) {
        json(res, 400, { error: 'invalid_json', message: parseError.message });
      }
    });
  } catch (error) {
    console.error('Accept request handling failed:', error);
    json(res, 500, { error: 'internal_error', message: error.message });
  }
}


async function handleHistoryRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    // Read last 10 accepted scans from SQLite
    const { code, stdout, stderr } = await runPythonModule(
      ['-c', `
import sqlite3
import json
from pathlib import Path

try:
    db_path = Path("data/cardmint.db")
    if not db_path.exists():
        print(json.dumps({"history": [], "count": 0}))
        exit(0)
    
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    
    cursor = conn.execute("""
        SELECT * FROM accepted_scans 
        ORDER BY accepted_at DESC 
        LIMIT 10
    """)
    
    rows = cursor.fetchall()
    history = []
    
    for row in rows:
        history.append({
            "id": row["id"],
            "scan_id": row["scan_id"],
            "accepted_at": row["accepted_at"],
            "name": row["name"],
            "hp": row["hp"],
            "set_number": row["set_number"],
            "card_number": row["card_number"],
            "name_conf": row["name_conf"],
            "hp_conf": row["hp_conf"],
            "set_conf": row["set_conf"],
            "decision": row["decision"],
            "total_ms": row["total_ms"]
        })
    
    conn.close()
    print(json.dumps({"history": history, "count": len(history)}))
    
except Exception as e:
    print(json.dumps({"error": str(e), "history": [], "count": 0}))
`], 
      { timeoutMs: 5000 }
    );

    if (code !== 0) {
      console.error('History query failed:', stderr);
      return json(res, 200, { history: [], count: 0, error: 'db_query_failed' });
    }

    let historyResult;
    try {
      historyResult = JSON.parse(stdout);
    } catch (parseError) {
      console.error('History JSON parse failed:', parseError);
      return json(res, 200, { history: [], count: 0, error: 'parse_failed' });
    }

    json(res, 200, historyResult);
  } catch (error) {
    console.error('History request handling failed:', error);
    json(res, 500, { error: 'internal_error', message: error.message });
  }
}

export function startOperatorApi() {
  const server = http.createServer((req, res) => {
    const url = parse(req.url || '/', true);
    
    // Add CORS headers for localhost development (operator UI uses 5174)
    const origin = (req.headers.origin as string) || '';
    const allowed = new Set([
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    if (allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, timestamp: new Date().toISOString() });
    }
    
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      return handleScanRequest(req, res);
    }
    
    if (req.method === 'POST' && url.pathname === '/api/accept') {
      return handleAcceptRequest(req, res);
    }
    
    if (req.method === 'GET' && url.pathname === '/api/history') {
      return handleHistoryRequest(req, res);
    }
    
    json(res, 404, { error: 'not_found' });
  });
  server.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`Operator API listening on http://localhost:${PORT}`);
  });
  return server;
}

// Start server if this file is run directly
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (import.meta.url === `file://${process.argv[1]}`) {
  startOperatorApi();
}
