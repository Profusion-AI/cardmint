# CardMint Production Dockerfile
# Multi-stage build for optimized production deployment

# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm install --save-dev typescript @types/node

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    postgresql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1001 cardmint && \
    chown -R cardmint:cardmint /app

# Copy package files
COPY --chown=cardmint:cardmint package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application from builder
COPY --chown=cardmint:cardmint --from=builder /app/dist ./dist

# Copy migrations and scripts
COPY --chown=cardmint:cardmint src/storage/migrations ./src/storage/migrations
COPY --chown=cardmint:cardmint scripts ./scripts

# Copy configuration files
COPY --chown=cardmint:cardmint fly.toml ./

# Switch to non-root user
USER cardmint

# Environment variables (defaults, overridden by Fly.io)
ENV NODE_ENV=production \
    PORT=3000 \
    WS_PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Expose ports
EXPOSE 3000 3001 9091

# Start the application
CMD ["node", "dist/index.js"]