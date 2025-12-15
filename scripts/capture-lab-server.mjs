#!/usr/bin/env node
/**
 * Pi5 Capture Lab Web UI Server
 *
 * Lightweight HTTP server that wraps pi5_capture_lab.sh for browser-based testing.
 * Serves static HTML UI and proxies commands to the bash script.
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const LAB_SCRIPT = join(ROOT_DIR, 'scripts', 'pi5_capture_lab.sh');
const UI_HTML = join(ROOT_DIR, 'scripts', 'capture-lab-ui.html');
const PORT = 3333;
const MIN_STABILIZE_MS = Number.parseInt(process.env.CAPTURE_LAB_STABILIZE_MS || '800', 10);
let lastSetAt = 0; // timestamp of last successful `/set`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Execute capture lab command
function execLabCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(LAB_SCRIPT, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, PATH: process.env.PATH }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        resolve({ success: false, stdout, stderr, exitCode: code });
      }
    });

    proc.on('error', (err) => {
      reject({ success: false, error: err.message });
    });
  });
}

// Parse POST body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve UI
  if (req.method === 'GET' && req.url === '/') {
    try {
      const html = readFileSync(UI_HTML, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load UI', details: err.message }));
    }
    return;
  }

  // Serve captured images
  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    try {
      const imagePath = decodeURIComponent(req.url.replace('/images/', ''));
      const fullPath = join(ROOT_DIR, imagePath);

      // Security: ensure path is within results/capture-lab/
      const resultsDir = join(ROOT_DIR, 'results', 'capture-lab');
      if (!fullPath.startsWith(resultsDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }

      if (!existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image not found' }));
        return;
      }

      const image = readFileSync(fullPath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(image);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to serve image', details: err.message }));
    }
    return;
  }

  // API: Execute lab command
  if (req.method === 'POST' && req.url === '/api/exec') {
    try {
      const body = await parseBody(req);
      const { command, args = [] } = body;

      if (!command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing command' }));
        return;
      }

      // Stabilization: if a `set` just ran, wait before `capture`
      let prelude = '';
      if (command === 'capture' && lastSetAt > 0) {
        const since = Date.now() - lastSetAt;
        const waitMs = Math.max(0, MIN_STABILIZE_MS - since);
        if (waitMs > 0) {
          prelude += `[stabilize] Waiting ${waitMs}ms after /set\n`;
          await sleep(waitMs);
        }
      }

      console.log(`[capture-lab] Executing: ${command} ${args.join(' ')}`);
      const result = await execLabCommand([command, ...args]);
      if (prelude) {
        result.stdout = prelude + (result.stdout || '');
      }

      // If `/set` succeeded, record timestamp for subsequent stabilization
      if (command === 'set' && result.success) {
        lastSetAt = Date.now();
      }

      // Extract image path from output if present (robust detection)
      // Primary marker: `IMAGE_PATH:<relative path>`
      // Fallback marker: `Image saved: <relative path>`
      let imagePath = null;
      if (result && typeof result.stdout === 'string') {
        // Prefer explicit IMAGE_PATH marker
        const m1 = result.stdout.match(/^IMAGE_PATH:\s*(.+)$/m);
        if (m1 && m1[1]) {
          imagePath = m1[1].trim();
        } else {
          const m2 = result.stdout.match(/^Image saved:\s*(.+\.(?:jpg|jpeg|png))$/mi);
          if (m2 && m2[1]) imagePath = m2[1].trim();
        }
      }
      if (imagePath) {
        result.imagePath = imagePath;
        console.log(`[capture-lab] Detected imagePath: ${imagePath}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Execution failed', details: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`\n🔬 Pi5 Capture Lab UI running at http://localhost:${PORT}\n`);
  console.log(`   Script: ${LAB_SCRIPT}`);
  console.log(`   UI: ${UI_HTML}`);
  console.log(`\n   Press Ctrl+C to stop\n`);
});
