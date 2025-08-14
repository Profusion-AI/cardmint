# CardMint Fly.io Integration Guide

## Overview
This guide documents the complete Fly.io Managed Postgres integration for CardMint, including database setup, deployment configuration, and development workflow.

## Database Configuration

### Fly.io Managed Postgres Details
- **Cluster ID**: gjpkdon11dy0yln4
- **Region**: IAD (Ashburn, Virginia)
- **PostgreSQL Version**: 16
- **Storage**: 10GB (1.2GB used)
- **CPU**: Shared x2
- **Pooling**: Enabled

### Connection Methods

#### 1. Pooled Connection (Production)
```
DATABASE_URL=postgresql://pgdb-gjpkdon11dy0yln4:LiKKi84UQOw7rftaSmCZTnp3@pgbouncer.gjpkdon11dy0yln4.flympg.net/pgdb-gjpkdon11dy0yln4
```

#### 2. Direct Connection via CLI
```bash
fly mpg connect
```

#### 3. Local Proxy Connection (Development)
```bash
# Start proxy in separate terminal
fly mpg proxy 16360 --cluster gjpkdon11dy0yln4

# Then use this connection string
DATABASE_URL=postgresql://[user]:[password]@127.0.0.1:16360/[database]?sslmode=disable
```

## Files Created/Modified

### Configuration Files

1. **`.env`** - Added DATABASE_URL and Fly.io configuration
2. **`.env.example`** - Updated with Fly.io environment variables
3. **`fly.toml`** - Fly.io deployment configuration
4. **`Dockerfile`** - Multi-stage production build

### Database Files

1. **`src/config/index.ts`** - Updated to support DATABASE_URL
2. **`src/storage/database.ts`** - Modified for connection string support
3. **`src/storage/migrations/003_pokemon_enhanced_schema.sql`** - Comprehensive Pokemon card schema

### Scripts

1. **`scripts/fly-setup.sh`** - Interactive Fly.io setup and management
2. **`scripts/deploy.sh`** - Automated deployment pipeline
3. **`scripts/start-fly-proxy.sh`** - Database proxy management
4. **`scripts/test-db-connection.js`** - Database connectivity testing

### Testing

1. **`src/test/official-images-test.ts`** - Test suite using official Pokemon card images

## Enhanced Database Schema

The new schema (`003_pokemon_enhanced_schema.sql`) includes:

### Core Tables
- `pokemon_cards` - Main card data with all Pokemon-specific fields
- `card_images` - Multiple image versions per card
- `card_prices` - Multi-source pricing data
- `card_validation` - OCR and image validation results
- `inventory_tracking` - Collection management
- `pokemon_processing_queue` - Processing pipeline stages

### Key Features
- Comprehensive Pokemon card fields (HP, types, attacks, abilities)
- Multi-source pricing (TCGPlayer, PriceCharting, CardMarket)
- Visual validation scores (SSIM, perceptual hash, etc.)
- Inventory management with grading support
- Processing queue with retry logic

## Deployment Workflow

### Initial Setup
```bash
# 1. Install flyctl (already done)
curl -L https://fly.io/install.sh | sh

# 2. Authenticate
fly auth login

# 3. Run interactive setup
./scripts/fly-setup.sh
```

### Database Migrations
```bash
# Connect to database
fly mpg connect

# Or run migrations via script
psql $DATABASE_URL -f src/storage/migrations/003_pokemon_enhanced_schema.sql
```

### Deployment
```bash
# Full deployment pipeline
./scripts/deploy.sh

# Deploy only (skip tests)
./scripts/deploy.sh deploy-only

# Check status
./scripts/deploy.sh status

# Rollback if needed
./scripts/deploy.sh rollback
```

## Development Workflow

### Local Development with Fly.io Database

1. **Start Database Proxy**
   ```bash
   # In separate terminal
   ./scripts/start-fly-proxy.sh
   ```

2. **Test Connection**
   ```bash
   node scripts/test-db-connection.js
   ```

3. **Run Application**
   ```bash
   npm run dev
   ```

### Testing with Official Images

The test suite validates OCR accuracy using known Pokemon cards:
```bash
npm run test:images
# or
npx ts-node src/test/official-images-test.ts
```

Test cards include:
- McDonald's Promos (mcd19-12)
- Neo Genesis/Destiny cards
- POP Series 6
- Sun & Moon series
- Sword & Shield series
- XY Promos

## API Integrations

The system integrates with:
1. **Pokemon TCG API** - Official card data and images
2. **PriceCharting API** - Market pricing and graded card values
3. **Fly.io Managed Postgres** - Primary database

## Next Steps

1. **Complete Fly.io Authentication**
   ```bash
   fly auth login
   ```

2. **Run Database Migrations**
   ```bash
   fly mpg connect
   # Then run SQL migrations
   ```

3. **Set Secrets**
   ```bash
   fly secrets set PRICECHARTING_API_KEY="your-key"
   fly secrets set POKEMONTCG_API_KEY="your-key"
   ```

4. **Deploy Application**
   ```bash
   fly launch  # First time
   fly deploy  # Subsequent deployments
   ```

5. **Monitor Application**
   ```bash
   fly logs
   fly status
   fly dashboard
   ```

## Troubleshooting

### Connection Issues
- Ensure you're authenticated: `fly auth whoami`
- Check cluster status: `fly mpg status gjpkdon11dy0yln4`
- Verify proxy is running for local development
- Use `fly mpg connect` for direct database access

### Deployment Issues
- Check logs: `fly logs`
- Verify secrets are set: `fly secrets list`
- Ensure Dockerfile builds locally: `docker build .`
- Check health endpoint: `curl https://[app-url]/api/health`

## Performance Targets

- **OCR Accuracy**: 99%+ (validated with test suite)
- **Response Time**: <500ms per card
- **Throughput**: 60+ cards/minute
- **Database Latency**: <100ms p95

## Security Notes

- DATABASE_URL contains credentials - never commit to git
- Use Fly.io secrets for production environment variables
- SSL is required for production database connections
- Keep API keys secure and rotate regularly

## Support

- Fly.io Dashboard: https://fly.io/dashboard
- Fly.io Docs: https://fly.io/docs/postgres/
- CardMint Issues: Track in project repository

---
*Last Updated: August 2025*
*Fly.io Managed Postgres Cluster: gjpkdon11dy0yln4*