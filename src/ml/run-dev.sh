#!/bin/bash
# Development script to run both API and dashboard with hot reloading

echo "🚀 Starting CardMint ML Development Environment"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down services...${NC}"
    kill $API_PID $DASHBOARD_PID 2>/dev/null
    exit 0
}

trap cleanup INT TERM

# Start the API service in background
echo -e "${BLUE}Starting Recognition API...${NC}"
python api/recognition_service.py &
API_PID=$!
echo -e "${GREEN}✓ API running on http://localhost:8000${NC}"
echo -e "${GREEN}  Documentation: http://localhost:8000/docs${NC}"
echo ""

# Give API a moment to start
sleep 2

# Start the dashboard with hot reload
echo -e "${BLUE}Starting Dashboard with Hot Reload...${NC}"
python dashboard-server.py &
DASHBOARD_PID=$!
echo -e "${GREEN}✓ Dashboard running on http://localhost:8080${NC}"
echo -e "${GREEN}  Hot reload enabled - save files to refresh!${NC}"
echo ""

echo "=============================================="
echo -e "${YELLOW}Services Running:${NC}"
echo "• Recognition API: http://localhost:8000"
echo "• API Docs: http://localhost:8000/docs"
echo "• Dashboard: http://localhost:8080"
echo ""
echo -e "${YELLOW}Tips:${NC}"
echo "• Edit src/dashboard/ensemble-dashboard.html"
echo "• Changes auto-refresh in browser"
echo "• Press Ctrl+C to stop all services"
echo "=============================================="
echo ""

# Keep script running
wait