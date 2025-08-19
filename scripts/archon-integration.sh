#!/bin/bash

# Archon-CardMint Integration Helper
# Maintains strict separation between knowledge (Archon) and production (CardMint) databases

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Service endpoints
ARCHON_UI="http://localhost:3737"
ARCHON_SERVER="http://localhost:8181"
ARCHON_MCP="http://localhost:8051"
CARDMINT_API="http://localhost:3000"
FLY_PROXY="localhost:16380"

# Function to display menu
show_menu() {
    clear
    echo -e "${BLUE}==================================${NC}"
    echo -e "${BLUE}   Archon-CardMint Integration${NC}"
    echo -e "${BLUE}==================================${NC}"
    echo ""
    echo -e "${YELLOW}Database Separation Status:${NC}"
    echo -e "  📚 Knowledge DB: Archon Supabase"
    echo -e "  💾 Production DB: CardMint Fly.io"
    echo ""
    echo -e "${GREEN}Available Actions:${NC}"
    echo ""
    echo "  1) Check service status"
    echo "  2) Upload documentation to Archon"
    echo "  3) Query Archon knowledge base"
    echo "  4) Create task in Archon"
    echo "  5) Check CardMint database (Fly.io)"
    echo "  6) View database separation guide"
    echo "  7) Start Archon services"
    echo "  8) Open Archon UI"
    echo "  9) Test MCP connection"
    echo "  0) Exit"
    echo ""
}

# Check service status
check_status() {
    echo -e "${BLUE}Checking service status...${NC}"
    echo ""
    
    # Check Archon services
    echo -e "${YELLOW}Archon Services (Supabase Knowledge):${NC}"
    
    if curl -s -f "${ARCHON_SERVER}/api/health" > /dev/null 2>&1; then
        echo -e "  ✅ Archon Server: ${GREEN}Running${NC} (port 8181)"
    else
        echo -e "  ❌ Archon Server: ${RED}Not running${NC}"
    fi
    
    if curl -s -f "${ARCHON_UI}" > /dev/null 2>&1; then
        echo -e "  ✅ Archon UI: ${GREEN}Running${NC} (port 3737)"
    else
        echo -e "  ❌ Archon UI: ${RED}Not running${NC}"
    fi
    
    if nc -z localhost 8051 2>/dev/null; then
        echo -e "  ✅ Archon MCP: ${GREEN}Running${NC} (port 8051)"
    else
        echo -e "  ❌ Archon MCP: ${RED}Not running${NC}"
    fi
    
    echo ""
    echo -e "${YELLOW}CardMint Services (Fly.io Production):${NC}"
    
    if curl -s -f "${CARDMINT_API}/api/health" > /dev/null 2>&1; then
        echo -e "  ✅ CardMint API: ${GREEN}Running${NC} (port 3000)"
    else
        echo -e "  ❌ CardMint API: ${RED}Not running${NC}"
    fi
    
    if nc -z localhost 16380 2>/dev/null; then
        echo -e "  ✅ Fly.io Proxy: ${GREEN}Connected${NC} (port 16380)"
    else
        echo -e "  ❌ Fly.io Proxy: ${RED}Not connected${NC}"
    fi
}

# Upload documentation
upload_docs() {
    echo -e "${BLUE}Uploading documentation to Archon knowledge base...${NC}"
    echo -e "${YELLOW}(This goes to Supabase, NOT production database)${NC}"
    echo ""
    
    if [ -f "/home/profusionai/CardMint/scripts/archon-upload-docs.sh" ]; then
        /home/profusionai/CardMint/scripts/archon-upload-docs.sh
    else
        echo -e "${RED}Upload script not found!${NC}"
    fi
}

# Query knowledge base
query_knowledge() {
    echo -e "${BLUE}Query Archon Knowledge Base${NC}"
    echo -e "${YELLOW}(Searches documentation in Supabase)${NC}"
    echo ""
    read -p "Enter search query: " query
    
    if [ -z "$query" ]; then
        echo -e "${RED}Query cannot be empty${NC}"
        return
    fi
    
    echo ""
    echo "Searching for: '$query'"
    echo ""
    
    response=$(curl -s -X POST "${ARCHON_SERVER}/api/knowledge/search" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$query\", \"match_count\": 5}" \
        2>/dev/null)
    
    if [ $? -eq 0 ]; then
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        echo -e "${RED}Failed to query knowledge base${NC}"
    fi
}

# Create task
create_task() {
    echo -e "${BLUE}Create Task in Archon${NC}"
    echo -e "${YELLOW}(Stored in Archon's task management, not production DB)${NC}"
    echo ""
    
    read -p "Task title: " title
    read -p "Task description: " description
    read -p "Priority (1-10): " priority
    
    if [ -z "$title" ]; then
        echo -e "${RED}Title cannot be empty${NC}"
        return
    fi
    
    response=$(curl -s -X POST "${ARCHON_SERVER}/api/tasks" \
        -H "Content-Type: application/json" \
        -d "{
            \"title\": \"$title\",
            \"description\": \"$description\",
            \"priority\": $priority,
            \"project\": \"CardMint\",
            \"status\": \"todo\"
        }" 2>/dev/null)
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Task created successfully!${NC}"
    else
        echo -e "${RED}Failed to create task${NC}"
    fi
}

# Check CardMint database
check_cardmint_db() {
    echo -e "${BLUE}CardMint Production Database Status${NC}"
    echo -e "${YELLOW}(Fly.io PostgreSQL - Card data only)${NC}"
    echo ""
    
    # Check if fly proxy is running
    if ! nc -z localhost 16380 2>/dev/null; then
        echo -e "${RED}Fly proxy not running!${NC}"
        echo "Start it with: fly proxy 16380:5432 -a cardmint-db"
        return
    fi
    
    echo -e "${GREEN}Fly proxy is connected${NC}"
    echo ""
    echo "Database info:"
    echo "  Host: localhost:16380"
    echo "  Database: pgdb-gjpkdon11dy0yln4"
    echo "  Purpose: Production card data ONLY"
    echo ""
    echo "Sample query (read-only):"
    echo "  SELECT COUNT(*) FROM cards;"
}

# View separation guide
view_guide() {
    if [ -f "/home/profusionai/CardMint/DATABASE_SEPARATION_GUIDE.md" ]; then
        less "/home/profusionai/CardMint/DATABASE_SEPARATION_GUIDE.md"
    else
        echo -e "${RED}Separation guide not found!${NC}"
    fi
}

# Start Archon
start_archon() {
    echo -e "${BLUE}Starting Archon services...${NC}"
    cd /home/profusionai/Archon
    sudo docker compose up -d
    echo ""
    echo -e "${GREEN}Archon services starting...${NC}"
    echo "Wait a few seconds for services to be ready"
}

# Open UI
open_ui() {
    echo -e "${BLUE}Opening Archon UI...${NC}"
    echo "URL: ${ARCHON_UI}"
    
    # Try to open in browser
    if command -v xdg-open > /dev/null; then
        xdg-open "${ARCHON_UI}"
    elif command -v open > /dev/null; then
        open "${ARCHON_UI}"
    else
        echo "Please open in your browser: ${ARCHON_UI}"
    fi
}

# Test MCP
test_mcp() {
    echo -e "${BLUE}Testing MCP Connection${NC}"
    echo ""
    
    # Test health endpoint
    echo -n "Testing MCP health... "
    if curl -s -f "${ARCHON_MCP}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
        return
    fi
    
    # Test tool listing
    echo -n "Fetching available tools... "
    response=$(curl -s "${ARCHON_MCP}/tools" 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
        echo ""
        echo "Available MCP tools:"
        echo "$response" | python3 -m json.tool 2>/dev/null | grep '"name"' || echo "$response"
    else
        echo -e "${RED}✗${NC}"
    fi
}

# Main loop
while true; do
    show_menu
    read -p "Select action: " choice
    echo ""
    
    case $choice in
        1) check_status ;;
        2) upload_docs ;;
        3) query_knowledge ;;
        4) create_task ;;
        5) check_cardmint_db ;;
        6) view_guide ;;
        7) start_archon ;;
        8) open_ui ;;
        9) test_mcp ;;
        0) echo "Exiting..."; exit 0 ;;
        *) echo -e "${RED}Invalid option${NC}" ;;
    esac
    
    echo ""
    read -p "Press Enter to continue..."
done