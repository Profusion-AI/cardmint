# CardMint Internal Debug API

Secure, internal-only HTTP endpoint for LLM agents to diagnose CardMint/EverShop admin UX issues.

## Features

- **READ-ONLY v0**: No mutations, no writes, no arbitrary SQL
- **Allowlist-only commands**: Strict command registry
- **Bearer token auth**: Required on every request
- **Rate limiting**: Per-command, per-IP limits
- **PII redaction**: All outputs sanitized before returning
- **Structured audit logs**: Every command logged with request ID

## Available Commands

| Command | Description |
|---------|-------------|
| `db.check_schema` | Verify cm_* columns exist in EverShop product table |
| `db.query_postgres` | Execute template-based queries (no raw SQL) |
| `evershop.graphql_test` | Run admin products grid GraphQL query |
| `evershop.extension_status` | Report CardMint extension status |
| `logs.tail` | Tail logs from allowlisted sources with redaction |

### Query Templates (db.query_postgres)

- `product_count` - Count products with/without cm_* data
- `cm_field_population` - Check fill rates for cm_* columns
- `recent_products` - Get N most recent products

### Log Sources (logs.tail)

- `nginx_access` - Nginx access log
- `nginx_error` - Nginx error log
- `cardmint_backend` - CardMint backend service
- `evershop` - EverShop Docker container
- `postgres` - PostgreSQL Docker container

## Local Development

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Run locally
export INTERNAL_DEBUG_TOKEN="your-dev-token"
uvicorn app.main:app --reload --port 9010
```

## Production Deployment

### Docker

```bash
# Build image
docker build -t cardmint-debug-api .

# Run (bind to localhost only)
docker run -d \
  --name internal-debug-api \
  -p 127.0.0.1:9010:9010 \
  -e INTERNAL_DEBUG_TOKEN="$INTERNAL_DEBUG_TOKEN" \
  -e POSTGRES_HOST=database \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --network cardmint_network \
  cardmint-debug-api
```

### Docker Compose

```yaml
services:
  internal-debug-api:
    build: ./apps/internal-debug-api
    ports:
      - "127.0.0.1:9010:9010"
    environment:
      - INTERNAL_DEBUG_TOKEN=${INTERNAL_DEBUG_TOKEN}
      - POSTGRES_HOST=database
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    networks:
      - cardmint_network
    depends_on:
      - database
```

## API Usage

### Health Check

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:9010/internal/debug/health
```

### Execute Command

```bash
# Schema check
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"db.check_schema"}' \
  http://localhost:9010/internal/debug/command

# Template query
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"db.query_postgres","args":{"template":"cm_field_population"}}' \
  http://localhost:9010/internal/debug/command

# GraphQL test
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"evershop.graphql_test","args":{"limit":5}}' \
  http://localhost:9010/internal/debug/command

# Tail logs
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"logs.tail","args":{"source":"nginx_access","lines":50}}' \
  http://localhost:9010/internal/debug/command
```

### Error Response Example

```bash
# Unknown command
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"db.drop_tables"}' \
  http://localhost:9010/internal/debug/command

# Response:
# {
#   "request_id": "...",
#   "status": "error",
#   "error": {
#     "code": "UNKNOWN_COMMAND",
#     "message": "Unknown command: db.drop_tables",
#     "details": {"available_commands": [...]}
#   }
# }
```

## OpenAPI Documentation

When running, OpenAPI docs are available at:
- Swagger UI: http://localhost:9010/docs
- ReDoc: http://localhost:9010/redoc
- OpenAPI JSON: http://localhost:9010/openapi.json

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INTERNAL_DEBUG_TOKEN` | Yes | Bearer token for authentication |
| `INTERNAL_ALLOWED_IPS` | No | Comma-separated IP allowlist |
| `INTERNAL_TRUSTED_PROXIES` | No | Comma-separated trusted proxy IPs for X-Forwarded-For |
| `POSTGRES_HOST` | No | PostgreSQL host (default: database) |
| `POSTGRES_PORT` | No | PostgreSQL port (default: 5432) |
| `POSTGRES_USER` | No | PostgreSQL user (default: evershop) |
| `POSTGRES_PASSWORD` | Yes* | PostgreSQL password |
| `POSTGRES_DB` | No | PostgreSQL database (default: evershop) |
| `DB_WRITE_ENABLED` | No | Enable write-capable DB role (requires approvals) |
| `DB_WRITE_APPROVED` | No | Kyle approval flag for CRUD role |
| `DB_BTFRS_SNAPSHOT` | No | BTFRS snapshot completed flag |
| `EVERSHOP_GRAPHQL_URL` | No | GraphQL endpoint URL |
| `RATE_LIMIT_DB_RPM` | No | DB commands rate limit (default: 10) |
| `RATE_LIMIT_EVERSHOP_RPM` | No | EverShop commands rate limit (default: 5) |
| `RATE_LIMIT_LOGS_RPM` | No | Logs commands rate limit (default: 2) |
| `COMMAND_TIMEOUT_SEC` | No | Command timeout (default: 10) |
| `MAX_OUTPUT_BYTES` | No | Max response size (default: 65536) |
| `LOG_SOURCE_EVERSHOP_FILE` | No | EverShop log file path (no Docker socket) |
| `LOG_SOURCE_POSTGRES_FILE` | No | Postgres log file path (no Docker socket) |
| `LOG_LEVEL` | No | Logging level (default: INFO) |

See `.env.example` for all configuration options.

## Security Notes

- **Internal-only**: Bind to localhost, access via SSH tunnel
- **No raw SQL**: Only template-based queries allowed
- **No shell execution**: Log tailing uses subprocess with shell=False
- **No Docker socket**: Container logs must be provided via file mounts/forwarders
- **PII redaction**: All outputs pass through sanitization
- **Audit trail**: Every command logged with request ID and timing

## Remote Access

Access via SSH tunnel:

```bash
ssh -L 9010:localhost:9010 cardmint@droplet
```

Then use localhost:9010 from your local machine.

## Systemd (Host Service)

Use systemd to run the API directly on the host (no Docker required).

1) Create the environment file:

```bash
sudo cp /home/kyle/CardMint-workspace/apps/internal-debug-api/.env.example /etc/internal-debug-api.env
sudo chmod 600 /etc/internal-debug-api.env
# Edit /etc/internal-debug-api.env with real values
```

2) Create the systemd unit:

```bash
sudo tee /etc/systemd/system/internal-debug-api.service > /dev/null <<'EOF'
[Unit]
Description=CardMint Internal Debug API
After=network.target

[Service]
Type=simple
User=kyle
WorkingDirectory=/home/kyle/CardMint-workspace/apps/internal-debug-api
EnvironmentFile=/etc/internal-debug-api.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/home/kyle/CardMint-workspace/apps/internal-debug-api/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 9010
Restart=on-failure
RestartSec=5
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
EOF
```

3) Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable internal-debug-api.service
sudo systemctl start internal-debug-api.service
```

4) Check status:

```bash
systemctl status internal-debug-api.service
ss -ltnp | rg ':9010'
```

## Operator Runbook: Log File Forwarding

The Internal Debug API does **not** access the Docker socket for security reasons. Container logs (EverShop, PostgreSQL) must be made available as files for the `logs.tail` command to read.

### Option 1: Docker Logging Driver (Recommended for Production)

Configure Docker containers to write logs to files using the `json-file` or `local` logging driver:

```yaml
# docker-compose.yml
services:
  evershop:
    image: evershop/evershop:latest
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
    # Logs will be at: /var/lib/docker/containers/<container-id>/<container-id>-json.log
```

Then symlink or copy to a known path:

```bash
# Find container ID
EVERSHOP_ID=$(docker ps -qf "name=evershop")

# Create symlink (requires root)
ln -sf /var/lib/docker/containers/${EVERSHOP_ID}/${EVERSHOP_ID}-json.log /var/log/evershop/stdout.log
```

Set in `.env`:
```bash
LOG_SOURCE_EVERSHOP_FILE=/var/log/evershop/stdout.log
LOG_SOURCE_POSTGRES_FILE=/var/log/postgres/postgres.log
```

### Option 2: Docker Compose Log Redirection

Add a sidecar or use Docker Compose logging configuration:

```yaml
services:
  evershop:
    image: evershop/evershop:latest
    volumes:
      - evershop_logs:/app/logs

  postgres:
    image: postgres:15
    command: ["postgres", "-c", "logging_collector=on", "-c", "log_directory=/var/log/postgresql"]
    volumes:
      - postgres_logs:/var/log/postgresql

volumes:
  evershop_logs:
  postgres_logs:
```

Mount these volumes to the Internal Debug API container:

```yaml
  internal-debug-api:
    volumes:
      - evershop_logs:/var/log/evershop:ro
      - postgres_logs:/var/log/postgres:ro
    environment:
      - LOG_SOURCE_EVERSHOP_FILE=/var/log/evershop/stdout.log
      - LOG_SOURCE_POSTGRES_FILE=/var/log/postgres/postgresql.log
```

### Option 3: Host-Side Log Forwarder

> **Security Note:** This option runs on the **host machine** (not inside any container). The forwarder process requires Docker socket access to read container logs, but the Internal Debug API container does **not** get Docker socket access—it only reads the resulting log files.

Use a simple host-side script to forward container logs to files:

```bash
#!/bin/bash
# /opt/cardmint/log-forwarder.sh
# Runs on HOST with Docker socket access. Writes to files that API reads.
set -e

mkdir -p /var/log/evershop /var/log/postgres

docker logs -f evershop > /var/log/evershop/stdout.log 2>&1 &
docker logs -f postgres > /var/log/postgres/postgres.log 2>&1 &
wait
```

Run as a systemd service on the host:

```ini
[Unit]
Description=Docker Log Forwarder (host-side)
After=docker.service
Requires=docker.service

[Service]
ExecStart=/opt/cardmint/log-forwarder.sh
Restart=always
RestartSec=5
# Runs as root on host to access Docker socket
User=root

[Install]
WantedBy=multi-user.target
```

The API container mounts the output files read-only:

```yaml
  internal-debug-api:
    volumes:
      - /var/log/evershop:/var/log/evershop:ro
      - /var/log/postgres:/var/log/postgres:ro
    # NO docker.sock mount - API only reads log files
```

### Verification

After setup, verify logs are accessible:

```bash
# Check file exists and has recent content
tail -n 5 /var/log/evershop/stdout.log
tail -n 5 /var/log/postgres/postgres.log

# Test via API
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"logs.tail","args":{"source":"evershop","lines":10}}' \
  http://localhost:9010/internal/debug/command | jq
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| "Log source not configured" | Set `LOG_SOURCE_EVERSHOP_FILE` or `LOG_SOURCE_POSTGRES_FILE` env var |
| "Failed to read log source" | Check file permissions (API needs read access) |
| Empty results | Verify container is writing logs; check symlink target exists |
| Stale logs | Restart log forwarder; check Docker logging driver rotation |

### Security Considerations

- Log files should be read-only to the API container (`:ro` mount flag)
- Do not mount `/var/run/docker.sock` - use file-based logging instead
- Rotate logs to prevent disk exhaustion (use Docker's `max-size`/`max-file` options)
- PII in logs is automatically redacted by the API before returning results
