#!/bin/bash

# CardMint Deployment Script
# Handles building, testing, and deploying to Fly.io

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Flyctl path
FLYCTL="flyctl"
if ! command -v flyctl &> /dev/null; then
    FLYCTL="/home/profusionai/.fly/bin/flyctl"
fi

echo -e "${GREEN}====================================="
echo "CardMint Deployment Pipeline"
echo -e "=====================================${NC}"

# Function to run tests
run_tests() {
    echo -e "${YELLOW}Running tests...${NC}"
    cd "$PROJECT_ROOT"
    
    # TypeScript compilation check
    echo "Checking TypeScript compilation..."
    npm run typecheck || {
        echo -e "${RED}✗ TypeScript compilation failed${NC}"
        exit 1
    }
    
    # Run tests if they exist
    if [ -f "package.json" ] && grep -q '"test"' package.json; then
        npm test || {
            echo -e "${RED}✗ Tests failed${NC}"
            exit 1
        }
    fi
    
    echo -e "${GREEN}✓ All tests passed${NC}"
}

# Function to build the application
build_app() {
    echo -e "${YELLOW}Building application...${NC}"
    cd "$PROJECT_ROOT"
    
    # Build TypeScript
    npm run build || {
        echo -e "${RED}✗ Build failed${NC}"
        exit 1
    }
    
    echo -e "${GREEN}✓ Build successful${NC}"
}

# Function to validate environment
validate_env() {
    echo -e "${YELLOW}Validating environment...${NC}"
    
    # Check for required files
    required_files=("fly.toml" "package.json" "tsconfig.json")
    for file in "${required_files[@]}"; do
        if [ ! -f "$PROJECT_ROOT/$file" ]; then
            echo -e "${RED}✗ Missing required file: $file${NC}"
            exit 1
        fi
    done
    
    # Check Fly.io auth
    if ! $FLYCTL auth whoami &> /dev/null; then
        echo -e "${RED}✗ Not authenticated with Fly.io${NC}"
        echo "Run: $FLYCTL auth login"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Environment validated${NC}"
}

# Function to deploy
deploy() {
    echo -e "${YELLOW}Deploying to Fly.io...${NC}"
    cd "$PROJECT_ROOT"
    
    # Deploy with Fly.io
    $FLYCTL deploy --strategy rolling || {
        echo -e "${RED}✗ Deployment failed${NC}"
        exit 1
    }
    
    echo -e "${GREEN}✓ Deployment successful${NC}"
}

# Function to run post-deployment checks
post_deploy_checks() {
    echo -e "${YELLOW}Running post-deployment checks...${NC}"
    
    # Check application status
    $FLYCTL status -a cardmint || {
        echo -e "${RED}✗ Application status check failed${NC}"
        exit 1
    }
    
    # Health check
    APP_URL=$($FLYCTL info -a cardmint --json | jq -r '.Hostname')
    if [ -n "$APP_URL" ]; then
        echo "Checking health endpoint..."
        curl -f "https://$APP_URL/api/health" || {
            echo -e "${YELLOW}⚠ Health check failed (app might still be starting)${NC}"
        }
    fi
    
    echo -e "${GREEN}✓ Post-deployment checks complete${NC}"
}

# Function to rollback
rollback() {
    echo -e "${YELLOW}Rolling back to previous version...${NC}"
    
    # Get the previous release
    PREV_VERSION=$($FLYCTL releases -a cardmint --json | jq -r '.[1].Version')
    
    if [ -n "$PREV_VERSION" ]; then
        $FLYCTL deploy -i "$PREV_VERSION" -a cardmint || {
            echo -e "${RED}✗ Rollback failed${NC}"
            exit 1
        }
        echo -e "${GREEN}✓ Rolled back to version $PREV_VERSION${NC}"
    else
        echo -e "${RED}✗ No previous version found${NC}"
        exit 1
    fi
}

# Main deployment flow
main() {
    case "${1:-deploy}" in
        test)
            run_tests
            ;;
        build)
            run_tests
            build_app
            ;;
        deploy)
            validate_env
            run_tests
            build_app
            deploy
            post_deploy_checks
            ;;
        deploy-only)
            validate_env
            deploy
            post_deploy_checks
            ;;
        rollback)
            rollback
            ;;
        status)
            $FLYCTL status -a cardmint
            ;;
        logs)
            $FLYCTL logs -a cardmint
            ;;
        *)
            echo "Usage: $0 {test|build|deploy|deploy-only|rollback|status|logs}"
            echo ""
            echo "  test        - Run tests only"
            echo "  build       - Run tests and build"
            echo "  deploy      - Full deployment pipeline (default)"
            echo "  deploy-only - Deploy without tests/build"
            echo "  rollback    - Rollback to previous version"
            echo "  status      - Show deployment status"
            echo "  logs        - Tail application logs"
            exit 1
            ;;
    esac
}

main "$@"