# CardMint Internal Debug API
# Production-ready container for diagnostic API service

FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
# - curl: for health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Create non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 9010

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:9010/internal/debug/health -H "Authorization: Bearer ${INTERNAL_DEBUG_TOKEN}" || exit 1

# Run with uvicorn
# Bind to 0.0.0.0 inside container, but expose only to localhost in docker-compose
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9010"]
