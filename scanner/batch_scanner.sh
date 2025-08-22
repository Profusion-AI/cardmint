#!/bin/bash

# CardMint Batch Scanner for Fedora
# Processes multiple card images efficiently

# Configuration
SCAN_DIR="$HOME/CardMint/scans"
PROCESSED_DIR="$HOME/CardMint/processed"
LOG_FILE="$HOME/CardMint/logs/batch_$(date +%Y%m%d_%H%M%S).log"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Create directories
mkdir -p "$SCAN_DIR" "$PROCESSED_DIR" "$(dirname "$LOG_FILE")"

echo "======================================"
echo "CardMint Batch Scanner"
echo "======================================"
echo "Scan Directory: $SCAN_DIR"
echo "Log File: $LOG_FILE"
echo ""

# Function to process images
process_images() {
    local count=0
    local success=0
    local failed=0
    
    # Find all image files
    for img in "$SCAN_DIR"/*.{jpg,jpeg,png,JPG,JPEG,PNG} 2>/dev/null; do
        [ -e "$img" ] || continue
        
        count=$((count + 1))
        filename=$(basename "$img")
        
        echo -n "[$count] Processing $filename... "
        
        # Process with Python scanner
        if python3 ~/CardMint/cardmint_scanner.py --file "$img" >> "$LOG_FILE" 2>&1; then
            echo -e "${GREEN}✓${NC}"
            success=$((success + 1))
            
            # Move to processed
            mv "$img" "$PROCESSED_DIR/"
        else
            echo -e "${RED}✗${NC}"
            failed=$((failed + 1))
        fi
        
        # Brief delay between cards
        sleep 0.5
    done
    
    echo ""
    echo "======================================"
    echo "Batch Processing Complete"
    echo "======================================"
    echo -e "Total: $count | ${GREEN}Success: $success${NC} | ${RED}Failed: $failed${NC}"
    echo "Log saved to: $LOG_FILE"
}

# Function to watch directory
watch_mode() {
    echo "Watching $SCAN_DIR for new images..."
    echo "Press Ctrl+C to stop"
    echo ""
    
    while true; do
        # Check for new images
        if ls "$SCAN_DIR"/*.{jpg,jpeg,png,JPG,JPEG,PNG} >/dev/null 2>&1; then
            echo "New images detected!"
            process_images
        fi
        
        # Wait before next check
        sleep 5
    done
}

# Main script
case "${1:-scan}" in
    watch)
        watch_mode
        ;;
    scan)
        process_images
        ;;
    *)
        echo "Usage: $0 [scan|watch]"
        echo "  scan  - Process all images once"
        echo "  watch - Continuously monitor for new images"
        exit 1
        ;;
esac