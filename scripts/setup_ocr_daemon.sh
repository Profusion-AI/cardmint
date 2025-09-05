#!/bin/bash
# Setup script for CardMint OCR Daemon

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🚀 Setting up CardMint OCR Daemon..."

# Make scripts executable
chmod +x "$SCRIPT_DIR/ocr_daemon.py"
chmod +x "$SCRIPT_DIR/ocr_client.py"

echo "✅ Made scripts executable"

# Install systemd service (optional)
if command -v systemctl &> /dev/null; then
    echo "📦 Installing systemd service..."
    
    sudo cp "$SCRIPT_DIR/cardmint-ocr.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    
    echo "✅ Systemd service installed"
    echo ""
    echo "To enable auto-start:"
    echo "  sudo systemctl enable cardmint-ocr"
    echo ""
    echo "To start the service:"
    echo "  sudo systemctl start cardmint-ocr"
    echo ""
    echo "To check status:"
    echo "  sudo systemctl status cardmint-ocr"
    echo ""
fi

echo "🎯 Manual usage:"
echo ""
echo "Start daemon:"
echo "  cd $PROJECT_DIR"
echo "  python scripts/ocr_daemon.py"
echo ""
echo "Test client:"
echo "  python scripts/ocr_client.py --health"
echo "  python scripts/ocr_client.py /path/to/image.png"
echo ""
echo "API endpoints:"
echo "  POST http://127.0.0.1:8765/ocr"
echo "  GET  http://127.0.0.1:8765/health"  
echo "  GET  http://127.0.0.1:8765/status"
echo ""
echo "✅ Setup complete!"