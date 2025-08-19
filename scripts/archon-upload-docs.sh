#!/bin/bash

# Archon Documentation Upload Script for CardMint
# This script uploads ONLY documentation to Archon's Supabase
# Production data stays in Fly.io PostgreSQL

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
ARCHON_SERVER="http://localhost:8181"
CARDMINT_DIR="/home/profusionai/CardMint"

echo -e "${GREEN}=== Archon Documentation Upload ===${NC}"
echo -e "${YELLOW}Purpose: Upload CardMint docs to Archon's knowledge base${NC}"
echo -e "${YELLOW}Database: Archon Supabase (separate from CardMint production)${NC}"
echo ""

# Check if Archon server is running
if ! curl -s -f "${ARCHON_SERVER}/api/health" > /dev/null 2>&1; then
    echo -e "${RED}Error: Archon server is not running at ${ARCHON_SERVER}${NC}"
    echo "Please start Archon first: cd ~/Archon && sudo docker compose up -d"
    exit 1
fi

echo -e "${GREEN}✓ Archon server is running${NC}"

# List of documentation files to upload (NO PRODUCTION DATA)
DOCS_TO_UPLOAD=(
    # Core documentation
    "CLAUDE.md"
    "README.md"
    "Core-Functionalities.md"
    "DATABASE_SEPARATION_GUIDE.md"
    "PRODUCTION_MILESTONE.md"
    "CLEANUP_SUMMARY_2025-08-18.md"
    
    # Architecture docs
    "docs/ARCHITECTURE.md"
    "docs/CAMERA_SETUP.md"
    "docs/CAPTURE_PROCESS_REQUIREMENTS.md"
    "docs/PC_REMOTE_CAPTURE_IMPLEMENTATION.md"
    
    # Integration guides
    "ARCHON_INTEGRATION_GUIDE.md"
    "FLY_INTEGRATION_GUIDE.md"
    "FLY_SUCCESS.md"
    
    # Security and operations
    "SECURITY.md"
    "RUNBOOK.md"
    "CONTRIBUTING.md"
)

# Files to NEVER upload (contains production data or credentials)
FORBIDDEN_PATTERNS=(
    "*.env*"
    "*.key"
    "*.pem"
    "*.cert"
    "*password*"
    "*secret*"
    "*.jpg"
    "*.jpeg"
    "*.png"
    "captures/*"
    "cache/*"
    "node_modules/*"
)

echo ""
echo "Preparing to upload ${#DOCS_TO_UPLOAD[@]} documentation files..."
echo ""

# Function to upload a single file
upload_file() {
    local file=$1
    local full_path="${CARDMINT_DIR}/${file}"
    
    if [ ! -f "$full_path" ]; then
        echo -e "${YELLOW}  ⚠ Skipping $file (not found)${NC}"
        return 1
    fi
    
    # Check file size (skip if > 10MB)
    local file_size=$(stat -f%z "$full_path" 2>/dev/null || stat -c%s "$full_path" 2>/dev/null)
    if [ "$file_size" -gt 10485760 ]; then
        echo -e "${YELLOW}  ⚠ Skipping $file (too large: >10MB)${NC}"
        return 1
    fi
    
    echo -n "  Uploading $file... "
    
    # Upload to Archon
    response=$(curl -s -X POST "${ARCHON_SERVER}/api/knowledge/upload" \
        -F "files=@${full_path}" \
        -F "tags=cardmint,documentation" \
        -F "project=CardMint" \
        2>/dev/null)
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        return 1
    fi
}

# Upload each documentation file
success_count=0
fail_count=0

for doc in "${DOCS_TO_UPLOAD[@]}"; do
    if upload_file "$doc"; then
        ((success_count++))
    else
        ((fail_count++))
    fi
done

echo ""
echo -e "${GREEN}=== Upload Summary ===${NC}"
echo -e "  Successfully uploaded: ${GREEN}${success_count}${NC} files"
if [ $fail_count -gt 0 ]; then
    echo -e "  Failed/Skipped: ${YELLOW}${fail_count}${NC} files"
fi

echo ""
echo -e "${GREEN}=== Database Separation Reminder ===${NC}"
echo -e "  ${YELLOW}📚 Archon Supabase:${NC} Documentation & knowledge (just uploaded)"
echo -e "  ${YELLOW}💾 CardMint Fly.io:${NC} Production card data (unchanged)"
echo ""
echo -e "${GREEN}Documentation upload complete!${NC}"
echo "Access Archon UI at: http://localhost:3737"