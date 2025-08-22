#!/bin/bash

# Send message to Mac from Fedora
# Usage: ./send_to_mac.sh "message" [priority]

MAC_IP="10.0.24.174"
MAC_PORT="5002"
MESSAGE="$1"
PRIORITY="${2:-normal}"  # Default to normal if not specified

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

if [ -z "$MESSAGE" ]; then
    echo -e "${RED}Error: Message required${NC}"
    echo "Usage: $0 \"message\" [priority]"
    echo "Priority options: normal, urgent, info"
    exit 1
fi

# Send the message
echo -e "${BLUE}Sending to Mac: ${MESSAGE}${NC}"

RESPONSE=$(curl -s -X POST "http://${MAC_IP}:${MAC_PORT}/send" \
  -H "Content-Type: application/json" \
  -d "{
    \"sender\": \"Fedora\",
    \"content\": \"${MESSAGE}\",
    \"priority\": \"${PRIORITY}\"
  }" 2>&1)

# Check if successful
if echo "$RESPONSE" | grep -q "delivered"; then
    echo -e "${GREEN}✅ Message sent successfully${NC}"
    
    # Show different icon based on priority
    case "$PRIORITY" in
        urgent)
            echo -e "${RED}🚨 Sent as URGENT${NC}"
            ;;
        info)
            echo -e "${YELLOW}ℹ️  Sent as INFO${NC}"
            ;;
        *)
            echo -e "${GREEN}✉️  Sent as NORMAL${NC}"
            ;;
    esac
else
    echo -e "${RED}❌ Failed to send message${NC}"
    echo "Response: $RESPONSE"
    
    # Check if server is reachable
    echo -e "\n${YELLOW}Checking connectivity...${NC}"
    if ping -c 1 -W 1 ${MAC_IP} > /dev/null 2>&1; then
        echo -e "${GREEN}Mac is reachable at ${MAC_IP}${NC}"
        echo -e "${YELLOW}Message channel may not be running on Mac${NC}"
        echo "On Mac, run: python3 message_channel.py"
    else
        echo -e "${RED}Cannot reach Mac at ${MAC_IP}${NC}"
        echo "Check network connection and Mac IP address"
    fi
fi