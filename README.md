# CardMint - High-Performance Card Scanning System

CardMint is a high-performance card scanning and processing system designed to achieve sub-500ms response times and 60+ cards/minute throughput. It integrates Sony camera hardware with real-time processing and database operations for automated card digitization.

## Features

- **Real-time capture**: 60+ fps camera integration with Sony SDK
- **Fast processing**: Sub-200ms target latency per card
- **OCR extraction**: PaddleOCR integration for text recognition
- **Queue management**: BullMQ-based job processing with 20 concurrent workers
- **Live streaming**: WebSocket-based real-time updates and image preview
- **Performance monitoring**: Built-in metrics and OpenTelemetry support
- **Auto-recovery**: Automatic reconnection and error handling

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ Sony Camera │────▶│ Capture API  │────▶│   BullMQ    │
└─────────────┘     └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │  WebSocket   │     │  Workers    │
                    │   Server     │     │   (x20)     │
                    └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │  Dashboard   │     │ PostgreSQL  │
                    └──────────────┘     └─────────────┘
```

## Prerequisites

- Node.js 20+ 
- PostgreSQL 16
- Redis 7+
- Sony Camera SDK dependencies
- Linux (Fedora 42 recommended)

## Installation

1. Clone the repository:
```bash
cd /home/profusionai/CardMint
```

2. Install dependencies:
```bash
npm install
```

3. Install system dependencies:
```bash
# Redis
sudo dnf install redis
sudo systemctl enable --now redis

# PostgreSQL 16
sudo dnf install postgresql16-server postgresql16
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql

# Build tools for native bindings
sudo dnf install gcc g++ make cmake python3
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

5. Build Sony SDK bindings:
```bash
cd src/camera
node-gyp configure build
cd ../..
```

6. Initialize database:
```bash
# Create database and user
sudo -u postgres psql
CREATE DATABASE cardmint;
CREATE USER cardmint WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE cardmint TO cardmint;
\q
```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

### Run Tests
```bash
npm test
```

### Performance Profiling
```bash
npm run profile
```

## API Endpoints

### REST API

- `GET /api/health` - Health check
- `GET /api/cards` - List cards
- `GET /api/cards/:id` - Get card details
- `POST /api/capture` - Trigger capture
- `GET /api/queue/status` - Queue status
- `GET /api/metrics` - Performance metrics

### WebSocket Events

Connect to `ws://localhost:3001` for real-time updates.

Messages:
- `subscribe` - Subscribe to events
- `getQueueStatus` - Get current queue status
- `getMetrics` - Get performance metrics

## Performance Targets

- **Capture latency**: <20ms
- **Processing latency**: <50ms
- **OCR latency**: <120ms
- **Total pipeline**: <200ms
- **Throughput**: 80+ cards/minute
- **Memory usage**: <2GB heap

## Configuration

Key configuration options in `.env`:

```env
# Camera settings
CAMERA_MODE=USB
CAMERA_FPS=60
CAMERA_RESOLUTION=1920x1080

# Processing
MAX_WORKERS=20
WORKER_CONCURRENCY=3
JOB_TIMEOUT_MS=5000

# Performance
USE_GPU=true
ENABLE_METRICS=true
CPU_CORES=2-7
```

## Monitoring

### Prometheus Metrics
Available at `http://localhost:9090/metrics`

### Health Check
```bash
curl http://localhost:3000/api/health
```

### Queue Status
```bash
curl http://localhost:3000/api/queue/status
```

## System Optimization

For optimal performance on Fedora 42:

1. Enable CPU isolation:
```bash
# Add to kernel parameters
isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7
```

2. Set performance governor:
```bash
sudo cpupower frequency-set -g performance
```

3. Increase file limits:
```bash
# /etc/security/limits.conf
* soft nofile 65536
* hard nofile 65536
```

## Troubleshooting

### Camera not detected
- Check USB connection
- Verify Sony SDK libraries are in LD_LIBRARY_PATH
- Run `npm run camera-setup` for diagnostics

### High latency
- Check CPU governor settings
- Verify Redis and PostgreSQL performance
- Review worker concurrency settings

### Memory issues
- Adjust `MEMORY_LIMIT_MB` in .env
- Check for memory leaks with profiling tools
- Review image buffer management

## Development

### Project Structure
```
CardMint/
├── src/
│   ├── camera/       # Sony SDK bindings
│   ├── processing/   # Image processing
│   ├── queue/        # Job queue management
│   ├── storage/      # Database and cache
│   ├── api/          # REST and WebSocket
│   └── utils/        # Utilities
├── dist/             # Compiled output
└── package.json
```

### Building Native Bindings
```bash
cd src/camera
node-gyp rebuild
```

### Running with Debug Output
```bash
LOG_LEVEL=debug npm run dev
```

## License

MIT

## Support

For issues and questions, please check the documentation or open an issue in the repository.