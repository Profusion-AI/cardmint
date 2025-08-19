#!/usr/bin/env python3
"""
Hot-reloading development server for the ML ensemble dashboard.
Automatically refreshes the browser when HTML/CSS/JS files change.
"""

from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import asyncio
import uvicorn
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import logging
from typing import Set
import json

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Track connected WebSocket clients
connected_clients: Set[WebSocket] = set()

# Create FastAPI app for the dashboard
app = FastAPI(title="CardMint Dashboard Server")

# Dashboard directory
DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"
if not DASHBOARD_DIR.exists():
    DASHBOARD_DIR = Path("/home/profusionai/CardMint/src/dashboard")

# Ensure dashboard directory exists
DASHBOARD_DIR.mkdir(exist_ok=True)


class FileChangeHandler(FileSystemEventHandler):
    """Handler for file change events that triggers browser reload"""
    
    def __init__(self):
        self.last_modified = 0
        
    def on_modified(self, event):
        if event.is_directory:
            return
            
        # Check if it's an HTML, CSS, or JS file
        if any(event.src_path.endswith(ext) for ext in ['.html', '.css', '.js']):
            logger.info(f"🔄 File changed: {event.src_path}")
            asyncio.create_task(notify_clients_reload())


async def notify_clients_reload():
    """Notify all connected WebSocket clients to reload"""
    disconnected = set()
    
    for client in connected_clients:
        try:
            await client.send_json({"action": "reload"})
        except:
            disconnected.add(client)
    
    # Remove disconnected clients
    for client in disconnected:
        connected_clients.discard(client)
    
    if connected_clients:
        logger.info(f"📡 Sent reload signal to {len(connected_clients)} clients")


# Inject hot-reload script into HTML
HOT_RELOAD_SCRIPT = """
<script>
(function() {
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
        
        ws.onopen = function() {
            console.log('🔥 Hot reload connected');
            // Add visual indicator
            const indicator = document.createElement('div');
            indicator.id = 'hot-reload-indicator';
            indicator.innerHTML = '🔥 Hot Reload Active';
            indicator.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(16, 185, 129, 0.9);
                color: white;
                padding: 8px 16px;
                border-radius: 20px;
                font-family: monospace;
                font-size: 12px;
                z-index: 10000;
                animation: pulse 2s infinite;
            `;
            document.body.appendChild(indicator);
        
        // Add pulse animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%, 100% { opacity: 0.9; transform: scale(1); }
                50% { opacity: 1; transform: scale(1.05); }
            }
        `;
        document.head.appendChild(style);
    };
    
    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        if (data.action === 'reload') {
            console.log('🔄 Reloading page...');
            // Flash effect before reload
            document.body.style.transition = 'opacity 0.2s';
            document.body.style.opacity = '0.5';
            setTimeout(() => window.location.reload(), 200);
        }
    };
    
        ws.onerror = function(error) {
            // Silently ignore WebSocket errors - hot reload is optional
            console.log('Hot reload not available - manual refresh required');
        };
        
        ws.onclose = function() {
            // Don't attempt reconnect if WebSocket fails
            console.log('Hot reload disconnected');
        };
    } catch (e) {
        // If WebSocket creation fails, just log it
        console.log('Hot reload feature not available');
    }
})();
</script>
"""


@app.get("/")
async def serve_dashboard():
    """Serve the ensemble dashboard with hot-reload script injected"""
    dashboard_file = DASHBOARD_DIR / "ensemble-dashboard.html"
    
    if not dashboard_file.exists():
        return HTMLResponse("""
        <html>
        <head>
            <title>Dashboard Not Found</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }
                .message {
                    text-align: center;
                    padding: 40px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                }
                h1 { margin-bottom: 20px; }
                code {
                    background: rgba(0,0,0,0.3);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 14px;
                }
            </style>
        </head>
        <body>
            <div class="message">
                <h1>📂 Dashboard Not Found</h1>
                <p>Looking for: <code>""" + str(dashboard_file) + """</code></p>
                <p style="margin-top: 20px;">Please ensure the dashboard HTML file exists.</p>
            </div>
        </body>
        </html>
        """)
    
    # Read the HTML file
    with open(dashboard_file, 'r') as f:
        html_content = f.read()
    
    # Inject hot-reload script before closing body tag
    if '</body>' in html_content:
        html_content = html_content.replace('</body>', HOT_RELOAD_SCRIPT + '\n</body>')
    else:
        html_content += HOT_RELOAD_SCRIPT
    
    return HTMLResponse(content=html_content)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for hot-reload notifications"""
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f"🔌 Client connected. Total clients: {len(connected_clients)}")
    
    try:
        # Keep connection alive
        while True:
            # Wait for any message (we don't expect any, but this keeps connection open)
            await websocket.receive_text()
    except:
        pass
    finally:
        connected_clients.discard(websocket)
        logger.info(f"🔌 Client disconnected. Total clients: {len(connected_clients)}")


# Serve static files (CSS, JS, images)
@app.get("/{file_path:path}")
async def serve_static(file_path: str):
    """Serve static files from the dashboard directory"""
    file = DASHBOARD_DIR / file_path
    if file.exists() and file.is_file():
        return FileResponse(file)
    return HTMLResponse(status_code=404, content="File not found")


def start_file_watcher():
    """Start watching dashboard directory for changes"""
    event_handler = FileChangeHandler()
    observer = Observer()
    observer.schedule(event_handler, str(DASHBOARD_DIR), recursive=True)
    observer.start()
    logger.info(f"👀 Watching for changes in: {DASHBOARD_DIR}")
    return observer


if __name__ == "__main__":
    print("\n" + "="*60)
    print("🚀 CardMint Dashboard with Hot Reload")
    print("="*60)
    print(f"📂 Dashboard directory: {DASHBOARD_DIR}")
    print(f"🌐 Open in browser: http://localhost:8080")
    print(f"🔥 Hot reload enabled - changes auto-refresh!")
    print(f"📝 Edit HTML/CSS/JS files and save to see changes")
    print("="*60 + "\n")
    
    # Start file watcher
    observer = start_file_watcher()
    
    try:
        # Run the server
        uvicorn.run(
            app,
            host="0.0.0.0",
            port=8080,
            log_level="info"
        )
    finally:
        observer.stop()
        observer.join()