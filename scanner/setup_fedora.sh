#!/bin/bash

# CardMint Fedora Setup Script
# Installs all dependencies and configures the scanner

set -e

echo "======================================"
echo "CardMint Fedora Setup"
echo "======================================"

# Configuration
MAC_IP="10.0.24.174"
CARDMINT_DIR="$HOME/CardMint"

# Check Python version
echo "Checking Python version..."
python3 --version

# Install system dependencies
echo "Installing system dependencies..."
sudo dnf install -y python3-pip python3-devel gcc libjpeg-devel zlib-devel

# Create CardMint directory structure
echo "Creating directory structure..."
mkdir -p "$CARDMINT_DIR"/{scans,processed,logs,config}

# Install Python packages
echo "Installing Python packages..."
pip3 install --user \
    pillow \
    requests \
    numpy \
    python-dotenv

# Copy scanner files
echo "Setting up scanner files..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/cardmint_scanner.py" "$CARDMINT_DIR/"
cp "$SCRIPT_DIR/batch_scanner.sh" "$CARDMINT_DIR/"
cp "$SCRIPT_DIR/monitor_scanner.py" "$CARDMINT_DIR/"
chmod +x "$CARDMINT_DIR"/*.sh

# Create configuration file
echo "Creating configuration..."
cat > "$CARDMINT_DIR/config/settings.json" << EOF
{
    "mac_server": "http://$MAC_IP:1234",
    "cardmint_api": "http://$MAC_IP:5001",
    "use_direct_lm_studio": true,
    "scan_directory": "$CARDMINT_DIR/scans",
    "processed_directory": "$CARDMINT_DIR/processed",
    "log_level": "INFO",
    "batch_delay": 0.5,
    "max_image_size": 1280,
    "jpeg_quality": 90
}
EOF

# Create desktop entry for GUI scanner
if [ -d "$HOME/.local/share/applications" ]; then
    cat > "$HOME/.local/share/applications/cardmint.desktop" << EOF
[Desktop Entry]
Name=CardMint Scanner
Comment=Pokemon Card Scanner
Exec=gnome-terminal -- python3 $CARDMINT_DIR/cardmint_scanner.py --watch
Icon=scanner
Terminal=true
Type=Application
Categories=Graphics;Photography;
EOF
    chmod +x "$HOME/.local/share/applications/cardmint.desktop"
    echo "Desktop entry created"
fi

# Create aliases
echo "Creating shell aliases..."
cat >> "$HOME/.bashrc" << 'EOF'

# CardMint aliases
alias cardmint='python3 ~/CardMint/cardmint_scanner.py'
alias cardmint-watch='python3 ~/CardMint/cardmint_scanner.py --watch'
alias cardmint-batch='bash ~/CardMint/batch_scanner.sh'
alias cardmint-stats='python3 ~/CardMint/cardmint_scanner.py --stats'
alias cardmint-export='python3 ~/CardMint/cardmint_scanner.py --export html'
EOF

# Test connection to Mac
echo ""
echo "Testing connection to Mac server..."
if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://$MAC_IP:1234/v1/models" | grep -q "200"; then
    echo "✅ Successfully connected to Mac LM Studio server!"
else
    echo "⚠️  Cannot connect to Mac server at $MAC_IP:1234"
    echo "   Please ensure LM Studio is running on Mac"
fi

echo ""
echo "======================================"
echo "Setup Complete!"
echo "======================================"
echo ""
echo "Quick Start Guide:"
echo "1. Place card images in: $CARDMINT_DIR/scans/"
echo "2. Run scanner: cardmint --scan"
echo "3. Watch mode: cardmint-watch"
echo "4. View stats: cardmint-stats"
echo "5. Export HTML: cardmint-export"
echo ""
echo "Mac Server: http://$MAC_IP:1234"
echo "CardMint API: http://$MAC_IP:5001"
echo ""
echo "Reload shell for aliases: source ~/.bashrc"