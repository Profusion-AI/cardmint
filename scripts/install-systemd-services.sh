#!/bin/bash
# Install CardMint systemd services for LM Studio and KeepWarm daemon

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

echo "🔧 Installing CardMint systemd services..."
echo ""

# Create systemd user directory if it doesn't exist
mkdir -p "$SYSTEMD_USER_DIR"

# Check if lmstudio.service already exists
if systemctl --user list-unit-files | grep -q "lmstudio.service"; then
    echo "✅ lmstudio.service already installed"
else
    echo "⚠️  lmstudio.service not found!"
    echo "   Please ensure LM Studio CLI is installed and configured"
    echo "   Run: lms --help"
    exit 1
fi

# Install cardmint-keepwarm.service
echo "📦 Installing cardmint-keepwarm.service..."
cp "$REPO_ROOT/deployment/systemd/cardmint-keepwarm.service" "$SYSTEMD_USER_DIR/"
echo "   Copied to: $SYSTEMD_USER_DIR/cardmint-keepwarm.service"

# Reload systemd
echo "🔄 Reloading systemd daemon..."
systemctl --user daemon-reload

# Show service status
echo ""
echo "📊 Service status:"
echo "   lmstudio.service:"
systemctl --user status lmstudio.service --no-pager -l || true
echo ""
echo "   cardmint-keepwarm.service:"
systemctl --user status cardmint-keepwarm.service --no-pager -l || true

echo ""
echo "✅ Installation complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Enable services to start on boot:"
echo "      systemctl --user enable lmstudio.service"
echo "      systemctl --user enable cardmint-keepwarm.service"
echo ""
echo "   2. Start services now:"
echo "      systemctl --user start lmstudio.service"
echo "      systemctl --user start cardmint-keepwarm.service"
echo ""
echo "   3. Check status:"
echo "      systemctl --user status lmstudio.service"
echo "      systemctl --user status cardmint-keepwarm.service"
echo ""
echo "   4. View logs:"
echo "      journalctl --user -u lmstudio.service -f"
echo "      journalctl --user -u cardmint-keepwarm.service -f"
echo ""
echo "   5. Verify keepwarm health:"
echo "      python3 $REPO_ROOT/scripts/cardmint-keepwarm-enhanced.py --check"
echo ""
