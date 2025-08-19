#!/bin/bash

# CardMint Fly.io Setup Script
# Sets up Fly.io deployment and database connections

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "====================================="
echo "CardMint Fly.io Setup"
echo "====================================="

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null && ! command -v /home/profusionai/.fly/bin/flyctl &> /dev/null; then
    echo "Installing flyctl..."
    curl -L https://fly.io/install.sh | sh
    export FLYCTL_INSTALL="/home/profusionai/.fly"
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
fi

# Use full path if needed
FLYCTL="flyctl"
if ! command -v flyctl &> /dev/null; then
    FLYCTL="/home/profusionai/.fly/bin/flyctl"
fi

echo "Using flyctl at: $(which $FLYCTL || echo $FLYCTL)"

# Function to check if logged in
check_auth() {
    if ! $FLYCTL auth whoami &> /dev/null; then
        echo "Not logged in to Fly.io. Please authenticate..."
        $FLYCTL auth login
    else
        echo "✓ Authenticated as: $($FLYCTL auth whoami)"
    fi
}

# Function to setup database proxy
setup_db_proxy() {
    echo ""
    echo "Setting up database proxy..."
    echo "This will create a local proxy to your Fly.io Managed Postgres"
    echo ""
    
    # Check if proxy is already running
    if lsof -Pi :16360 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "⚠ Port 16360 is already in use. Proxy might be running."
        echo "To stop it: kill \$(lsof -Pi :16360 -sTCP:LISTEN -t)"
    else
        echo "Starting proxy on port 16360..."
        echo "Run this command in a separate terminal:"
        echo ""
        echo "  $FLYCTL mpg proxy 16360 --cluster gjpkdon11dy0yln4"
        echo ""
        echo "Or connect directly with:"
        echo "  $FLYCTL mpg connect"
        echo ""
        echo "Keep the proxy running while developing locally."
    fi
}

# Function to run database migrations
run_migrations() {
    echo ""
    echo "Running database migrations..."
    
    # Check if psql is installed
    if ! command -v psql &> /dev/null; then
        echo "⚠ psql not found. Install postgresql-client to run migrations."
        echo "  sudo dnf install postgresql"
        return 1
    fi
    
    # Load DATABASE_URL from .env
    if [ -f "$PROJECT_ROOT/.env" ]; then
        export $(grep -E '^DATABASE_URL=' "$PROJECT_ROOT/.env" | xargs)
    fi
    
    if [ -z "$DATABASE_URL" ]; then
        echo "⚠ DATABASE_URL not found in .env file"
        return 1
    fi
    
    echo "Applying migrations..."
    for migration in "$PROJECT_ROOT"/src/storage/migrations/*.sql; do
        if [ -f "$migration" ]; then
            echo "  Applying: $(basename "$migration")"
            psql "$DATABASE_URL" -f "$migration" || {
                echo "⚠ Migration failed: $(basename "$migration")"
                echo "  You may need to run the proxy first:"
                echo "  $FLYCTL proxy 16360:5432 -a cardmint-db"
                return 1
            }
        fi
    done
    
    echo "✓ Migrations completed"
}

# Function to set secrets
set_secrets() {
    echo ""
    echo "Setting Fly.io secrets..."
    
    # Load from .env
    if [ -f "$PROJECT_ROOT/.env" ]; then
        source "$PROJECT_ROOT/.env"
    fi
    
    # Only set if not empty
    if [ -n "$PRICECHARTING_API_KEY" ]; then
        echo "Setting PRICECHARTING_API_KEY..."
        $FLYCTL secrets set PRICECHARTING_API_KEY="$PRICECHARTING_API_KEY" -a cardmint
    fi
    
    if [ -n "$POKEMONTCG_API_KEY" ]; then
        echo "Setting POKEMONTCG_API_KEY..."
        $FLYCTL secrets set POKEMONTCG_API_KEY="$POKEMONTCG_API_KEY" -a cardmint
    fi
    
    # DATABASE_URL is already set by Fly Managed Postgres
    echo "✓ Secrets configured"
}

# Main menu
main_menu() {
    echo ""
    echo "What would you like to do?"
    echo "1) Check Fly.io authentication"
    echo "2) Setup database proxy for local development"
    echo "3) Run database migrations"
    echo "4) Set application secrets"
    echo "5) Deploy to Fly.io"
    echo "6) Show deployment status"
    echo "7) Open Fly.io dashboard"
    echo "8) Tail application logs"
    echo "9) Connect to database console"
    echo "0) Exit"
    echo ""
    read -p "Enter choice: " choice
    
    case $choice in
        1)
            check_auth
            main_menu
            ;;
        2)
            setup_db_proxy
            main_menu
            ;;
        3)
            run_migrations
            main_menu
            ;;
        4)
            set_secrets
            main_menu
            ;;
        5)
            echo "Deploying to Fly.io..."
            cd "$PROJECT_ROOT"
            $FLYCTL deploy
            main_menu
            ;;
        6)
            $FLYCTL status -a cardmint
            main_menu
            ;;
        7)
            $FLYCTL dashboard -a cardmint
            main_menu
            ;;
        8)
            echo "Tailing logs (Ctrl+C to stop)..."
            $FLYCTL logs -a cardmint
            main_menu
            ;;
        9)
            echo "Connecting to database..."
            $FLYCTL postgres connect -a cardmint-db
            main_menu
            ;;
        0)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo "Invalid choice"
            main_menu
            ;;
    esac
}

# Start
check_auth
main_menu