#!/usr/bin/env python3
"""
PaddleOCR Daemon - Prewarmed OCR service for CardMint

Keeps a PaddleOCR instance loaded in memory to avoid expensive re-initialization.
Provides HTTP API for fast OCR processing.

Usage:
    python scripts/ocr_daemon.py [--port 8765] [--config configs/ocr.yaml]
    
API:
    POST /ocr {"image_path": "/path/to/image.png"}
    GET /health
    GET /status
"""
import argparse
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Lock
from typing import Any, Dict, Optional
from urllib.parse import urlparse, parse_qs

import multiprocessing as mp

# Add project root to path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Apply guards before importing pipeline
from ocr.system_guard import apply_cpu_threading_defaults, neuter_paddlex_calls, env_truth, ensure_native_backend_or_die, collect_host_facts
apply_cpu_threading_defaults()
if env_truth("OCR_FORCE_NATIVE", False):
    neuter_paddlex_calls()

from ocr.pipeline import run, load_config, _collect_versions, get_ocr_cache_stats

class OCRDaemon:
    def __init__(self, config_path: Optional[str] = None):
        self.config_path = config_path
        self.config = None
        self.lock = Lock()
        self.start_time = time.time()
        self.request_count = 0
        self._lat_ms: list[float] = []
        self.warmup()
    
    @staticmethod
    def _percentile(values, p: float) -> float:
        if not values:
            return 0.0
        arr = sorted(values)
        k = (len(arr) - 1) * (p / 100.0)
        f = int(k)
        c = min(f + 1, len(arr) - 1)
        if f == c:
            return float(arr[f])
        d0 = arr[f] * (c - k)
        d1 = arr[c] * (k - f)
        return float(d0 + d1)
    
    def warmup(self):
        """Preload OCR models and populate module-level cache"""
        print("🔥 Warming up OCR cache (module-level instance caching)...")
        print("   📦 Using PaddleOCR model cache (~/.paddleocr/ and ~/.paddle/)")
        start = time.time()
        
        # Load config (use default path if none specified)
        config_path = self.config_path or os.path.join(ROOT, "configs", "ocr.yaml")
        self.config = load_config(config_path)
        
        # Pre-populate OCR cache by running a dummy inference
        # This triggers OCR instance creation and caches it for reuse
        try:
            # Create a tiny test image
            import tempfile
            from PIL import Image
            
            test_img = Image.new('RGB', (100, 50), color='white')
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
                test_img.save(f.name)
                
                # Run dummy inference to populate module cache
                result = run(f.name, config_path)
                os.unlink(f.name)
                
            elapsed = time.time() - start
            cache_stats = get_ocr_cache_stats()
            print(f"✅ OCR cache populated in {elapsed:.2f}s (size: {cache_stats['size']})")
            
        except Exception as e:
            print(f"⚠️  Warmup failed: {e}")
            print("OCR cache will populate on first request")
    
    def process_image(self, image_path: str) -> Dict[str, Any]:
        """Process image with prewarmed OCR instance"""
        with self.lock:
            self.request_count += 1
            start = time.time()
            
            config_path = self.config_path or os.path.join(ROOT, "configs", "ocr.yaml")
            result = run(image_path, config_path)
            
            elapsed = time.time() - start
            result['daemon_processing_ms'] = round(elapsed * 1000, 1)
            # Track recent latencies (cap to last 200)
            self._lat_ms.append(result['daemon_processing_ms'])
            if len(self._lat_ms) > 200:
                self._lat_ms = self._lat_ms[-200:]
            # Emit JSON log for observability
            try:
                p50 = round(self._percentile(self._lat_ms, 50), 1)
                p95 = round(self._percentile(self._lat_ms, 95), 1)
                box_count = 0
                try:
                    box_count = int(result.get('diagnostics', {}).get('box_count', result.get('line_count', 0)))
                except Exception:
                    box_count = int(result.get('line_count', 0) or 0)
                log = {
                    "event": "request_done",
                    "lat_ms": result['daemon_processing_ms'],
                    "p50_ms": p50,
                    "p95_ms": p95,
                    "line_count": result.get('line_count'),
                    "box_count": box_count,
                    "backend": result.get('backend_used'),
                }
                print(json.dumps(log))
            except Exception:
                pass
            
            return result
    
    def get_status(self) -> Dict[str, Any]:
        """Get daemon status information including OCR cache stats"""
        uptime = time.time() - self.start_time
        p50 = round(self._percentile(self._lat_ms, 50), 1) if self._lat_ms else 0.0
        p95 = round(self._percentile(self._lat_ms, 95), 1) if self._lat_ms else 0.0
        
        # Get cache statistics
        try:
            cache_stats = get_ocr_cache_stats()
        except Exception:
            cache_stats = {"hits": 0, "misses": 0, "size": 0, "hit_rate": 0.0}
            
        return {
            "status": "healthy",
            "uptime_seconds": round(uptime, 1),
            "requests_processed": self.request_count,
            "config_path": self.config_path or "default",
            "backend_type": self.config.backend_type if self.config else "unknown",
            "avg_requests_per_minute": round((self.request_count / uptime) * 60, 1) if uptime > 0 else 0,
            "p50_ms": p50,
            "p95_ms": p95,
            "ocr_cache": cache_stats,
        }

class OCRHandler(BaseHTTPRequestHandler):
    daemon: OCRDaemon
    
    def do_POST(self):
        if self.path == '/ocr':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                data = json.loads(post_data.decode('utf-8'))
                
                image_path = data.get('image_path')
                if not image_path:
                    self.send_error(400, "Missing 'image_path' in request body")
                    return
                
                if not os.path.isfile(image_path):
                    self.send_error(404, f"Image not found: {image_path}")
                    return
                
                result = self.daemon.process_image(image_path)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                response = json.dumps(result, ensure_ascii=False, indent=2)
                self.wfile.write(response.encode('utf-8'))
                
            except Exception as e:
                self.send_error(500, f"OCR processing failed: {e}")
        else:
            self.send_error(404, "Not found")
    
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            health = {
                "status": "healthy",
                "timestamp": time.time(),
                "host": collect_host_facts(),
                "versions": _collect_versions(),
                "python_executable": sys.executable,
            }
            response = json.dumps(health)
            self.wfile.write(response.encode('utf-8'))
            
        elif self.path == '/status':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            status = self.daemon.get_status()
            response = json.dumps(status, indent=2)
            self.wfile.write(response.encode('utf-8'))
            
        else:
            self.send_error(404, "Not found")
    
    def log_message(self, format, *args):
        """Custom logging format"""
        print(f"[{time.strftime('%H:%M:%S')}] {format % args}")

def main():
    parser = argparse.ArgumentParser(description="PaddleOCR Daemon - Prewarmed OCR Service")
    parser.add_argument('--port', type=int, default=8765, help="HTTP port (default: 8765)")
    parser.add_argument('--config', help="OCR config path (default: configs/ocr.yaml)")
    parser.add_argument('--host', default='127.0.0.1', help="Bind address (default: 127.0.0.1)")
    parser.add_argument('--force-native', action='store_true', help="Force pure PaddleOCR backend (disable PaddleX paths)")
    parser.add_argument('--workers', type=int, default=1, help="Logical worker count for thread sizing (no process fork)")
    args = parser.parse_args()
    
    # Multiprocessing start method: avoid fork with MKL/oneDNN
    try:
        mp.set_start_method("spawn", force=True)
    except RuntimeError:
        # Already set; ignore
        pass

    # Apply environment defaults for threading and backend guards
    if args.workers and args.workers > 0:
        os.environ['OCR_WORKERS'] = str(args.workers)
    apply_cpu_threading_defaults()
    
    print(f"🚀 Starting OCR Daemon on {args.host}:{args.port}")
    print(f"📁 Config: {args.config or 'configs/ocr.yaml (default)'}")
    
    # Optionally force native backend via environment valve
    if args.force_native:
        os.environ['OCR_FORCE_NATIVE'] = '1'
    # Enforce native-only backend if requested
    try:
        ensure_native_backend_or_die()
    except Exception as e:
        print(json.dumps({
            "event": "startup_error",
            "error": str(e),
            "hint": "Start without --force-native to inspect and remove conflicting modules",
        }))
        sys.exit(1)

    # Emit host and version facts once at startup for observability
    try:
        facts = {"event": "daemon_start", "host": collect_host_facts(), "versions": _collect_versions(), "workers": args.workers}
        print(json.dumps(facts))
    except Exception:
        pass

    # Initialize daemon
    daemon = OCRDaemon(args.config)
    
    # Set up HTTP server with port conflict handling
    handler_class = OCRHandler
    handler_class.daemon = daemon
    
    try:
        server = HTTPServer((args.host, args.port), handler_class)
    except OSError as e:
        if e.errno == 98:  # Address already in use
            print(f"❌ Port {args.port} is already in use!")
            print(f"💡 Kill existing daemon with: sudo pkill -f ocr_daemon")
            print(f"💡 Or use a different port with: --port 8766")
            sys.exit(1)
        else:
            raise
    
    print(f"✅ OCR Daemon ready! Endpoints:")
    print(f"   POST http://{args.host}:{args.port}/ocr")
    print(f"   GET  http://{args.host}:{args.port}/health")
    print(f"   GET  http://{args.host}:{args.port}/status")
    print(f"🎯 Press Ctrl+C to stop")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Shutting down OCR Daemon...")
        server.shutdown()

if __name__ == "__main__":
    main()
