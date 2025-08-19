# CardMint 🎴

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/yourusername/cardmint/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> High-performance Pokemon card scanning and recognition system with advanced ML ensemble achieving 828ms inference and real-time API monitoring dashboard

## 🚀 Features

### New in v2.0.0
- **🎨 Advanced Dashboard**: Beautiful UI with image preview and API console
- **🤖 ML Ensemble**: Three-model architecture (MobileNetV3 + ORB + PaddleOCR)
- **🔧 API Console**: Real-time backend monitoring with copy-to-clipboard
- **📷 Image Preview**: Full-resolution card preview before processing
- **✨ Hot-reload**: Automatic dashboard refresh during development

### Core Features
- **⚡ High-Performance**: 828ms ML inference, 400ms camera capture
- **🎯 95%+ Accuracy**: Multi-model ensemble with API validation
- **📸 Hardware Integration**: Native Sony camera SDK support
- **💰 Real-time Pricing**: Pokemon TCG API with market prices
- **🔍 Advanced OCR**: PaddleOCR with Pokemon-specific patterns
- **🛡️ Production Ready**: Graceful degradation, error recovery
- **📊 Observability**: Real-time metrics, API activity logging
- **🔄 Queue Management**: BullMQ with 20 concurrent workers

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Architecture](#-architecture)
- [API Documentation](#-api-documentation)
- [Performance](#-performance)
- [Configuration](#-configuration)
- [Development](#-development)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Contributing](#-contributing)
- [Security](#-security)
- [License](#-license)

## 🏁 Quick Start

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL 16+
- Redis 7+
- Linux OS (for camera integration)
- API Keys from [PriceCharting](https://www.pricecharting.com/api) and [Pokemon TCG](https://pokemontcg.io)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/cardmint.git
cd cardmint

# Install dependencies
npm install
cd src/ml && pip install -r requirements.txt && cd ../..

# Set up environment
cp .env.example .env
# Edit .env with your API keys and configuration

# Set up databases
./setup-postgres.sh
redis-server

# Run database migrations
npm run db:migrate

# Start ML recognition service
cd src/ml && python api/recognition_service.py &

# Start dashboard with hot-reload
python dashboard-server.py &

# Access the dashboard
open http://localhost:8080
```

### Basic Usage

```bash
# Start the server
npm start

# API Health Check
curl http://localhost:3000/api/health

# Trigger card capture
curl -X POST http://localhost:3000/api/capture

# View metrics
curl http://localhost:9091/metrics
```

## 🏗 Architecture

CardMint uses a microservice-inspired architecture with specialized components:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Camera SDK    │────▶│  Image Capture  │────▶│  Queue Manager  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   PostgreSQL    │◀────│  Card Matcher   │◀────│   OCR Service   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                │
                        ┌───────┴────────┐
                        ▼                ▼
                ┌──────────────┐ ┌──────────────┐
                │ PriceCharting│ │ Pokemon TCG  │
                │     API      │ │     API      │
                └──────────────┘ └──────────────┘
```

### Core Components

- **Camera Service**: Hardware integration for high-speed capture
- **OCR Pipeline**: PaddleOCR with Pokemon-specific patterns
- **Card Matcher**: 99.9% accuracy validation system
- **API Services**: Real-time pricing and card data
- **Queue System**: BullMQ for reliable job processing
- **Storage Layer**: PostgreSQL + Redis caching

For detailed architecture documentation, see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 📡 API Documentation

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/cards` | List all cards |
| GET | `/api/cards/:id` | Get specific card |
| POST | `/api/capture` | Trigger capture |
| GET | `/api/queue/status` | Queue status |
| GET | `/api/accuracy/status` | Accuracy metrics |

### WebSocket Events

Connect to `ws://localhost:3001` for real-time updates:

- `capture:started` - Capture initiated
- `capture:completed` - Image captured
- `processing:progress` - OCR/matching progress
- `card:identified` - Card successfully identified

For complete API documentation, see [API.md](docs/API.md).

## ⚡ Performance

### Current Metrics (v2.0.0)

| Metric | Target | Achieved | Status |
|--------|--------|----------|--------|
| Camera Capture | <500ms | 400ms | ✅ Maintained |
| ML Inference | <1000ms | 828ms | ✅ Optimized |
| Dashboard Load | <2s | <1s | ✅ Fast |
| OCR Accuracy | >95% | 95%+ | ✅ On target |
| Ensemble Confidence | >90% | 92%+ | ✅ Exceeds |
| API Response | <2s | <100ms | ✅ Excellent |
| RAM Usage | <500MB | 150-200MB | ✅ Efficient |

### Optimization Features

- **ML Ensemble**: MobileNetV3 + ORB + PaddleOCR
- **Intel Extension**: CPU-optimized PyTorch
- **Smart Caching**: Redis with 24hr TTL
- **Connection Pooling**: Database and API connections
- **Graceful Degradation**: API failures don't break pipeline
- **Hot-reload Dashboard**: Auto-refresh during development

## ⚙️ Configuration

### Environment Variables

Key configuration options in `.env`:

```bash
# API Configuration
PRICECHARTING_API_KEY=your_key_here
POKEMONTCG_API_KEY=your_key_here

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cardmint

# Performance
MAX_WORKERS=20
USE_GPU=true
CIRCUIT_BREAKER_THRESHOLD=5

# Monitoring
ENABLE_METRICS=true
LOG_LEVEL=info
```

See [.env.example](.env.example) for all options.

## 🛠 Development

### Project Structure

```
CardMint/
├── src/
│   ├── api/          # REST API endpoints
│   ├── camera/       # Camera integration
│   ├── services/     # Business logic
│   ├── utils/        # Utilities & helpers
│   └── types/        # TypeScript definitions
├── test/
│   ├── unit/         # Unit tests
│   ├── integration/  # Integration tests
│   └── e2e/          # End-to-end tests
└── docs/             # Documentation
```

### Building from Source

```bash
# Install dependencies
npm install

# TypeScript compilation
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific suite
npm test -- cardMatcher

# Integration tests
npm run test:integration
```

### Test Coverage Goals

- Unit Tests: 80%+ coverage
- Integration Tests: Critical paths
- E2E Tests: User workflows

## 🚀 Deployment

### Docker

```bash
# Build image
docker build -t cardmint:latest .

# Run container
docker run -p 3000:3000 cardmint:latest
```

### Production Checklist

- [ ] Environment variables configured
- [ ] Database migrations run
- [ ] Redis connection verified
- [ ] API keys validated
- [ ] Monitoring enabled
- [ ] Backups configured

## 🤝 Contributing

We love contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Code of Conduct
- Development setup
- Pull request process
- Coding standards

### Good First Issues

Check out issues labeled [`good first issue`](https://github.com/yourusername/cardmint/labels/good%20first%20issue) to get started!

## 🔒 Security

- **Reporting**: See [SECURITY.md](SECURITY.md) for vulnerability reporting
- **Known Issues**: Currently in alpha, authentication not yet implemented
- **Best Practices**: Never commit API keys or `.env` files

## 📊 Status & Roadmap

### Current Status: v2.0.0

- ✅ Core scanning functionality
- ✅ ML ensemble recognition (3 models)
- ✅ Advanced dashboard with API console
- ✅ Image preview system
- ✅ Real-time API monitoring
- ✅ Pokemon TCG API integration
- ✅ Production resilience patterns
- 🚧 PriceCharting integration
- 📅 Authentication system
- 📅 Mobile app

### Upcoming Features

- [ ] Web dashboard for inventory management
- [ ] Batch processing mode
- [ ] Export to CSV/JSON
- [ ] Collection valuation
- [ ] Trade recommendations
- [ ] Market trend analysis

## 📈 Metrics & Monitoring

Access real-time metrics at `http://localhost:9091/metrics`:

- `cardmint_accuracy_pipeline_percent` - Overall accuracy
- `cardmint_capture_latency_milliseconds` - Capture performance
- `cardmint_cards_processed_total` - Total processed
- `circuit_breaker_state_*` - API health

## 🙏 Acknowledgments

- [Pokemon TCG API](https://pokemontcg.io) for card data
- [PriceCharting](https://www.pricecharting.com) for pricing data
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) for OCR capabilities
- All contributors and testers

## 📝 License

CardMint is MIT licensed. See [LICENSE](LICENSE) for details.

## 📧 Contact

- **Issues**: [GitHub Issues](https://github.com/yourusername/cardmint/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/cardmint/discussions)
- **Security**: See [SECURITY.md](SECURITY.md)

---

<p align="center">
  Made with ❤️ for the Pokemon TCG community
  <br>
  <a href="https://github.com/yourusername/cardmint">Star us on GitHub!</a>
</p>