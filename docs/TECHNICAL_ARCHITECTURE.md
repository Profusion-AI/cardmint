# CardMint Technical Architecture

## System Overview

CardMint is a high-performance Pokemon card recognition system built with a microservices architecture, combining computer vision, machine learning, and external API validation for accurate card identification.

```
┌─────────────────────────────────────────────────────────────┐
│                     CardMint Dashboard                       │
│                   http://localhost:8080                      │
│  ┌──────────────────────┬──────────────────────────────┐   │
│  │  Recognition Results  │      API Console             │   │
│  │  - Card Preview       │  - Request/Response Logs    │   │
│  │  - ML Results         │  - Confidence Tracking      │   │
│  │  - Validation Status  │  - Error Monitoring         │   │
│  └──────────────────────┴──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│              Recognition Service (FastAPI)                   │
│                   http://localhost:8000                      │
│  ┌──────────────┬──────────────┬──────────────────────┐   │
│  │  MobileNetV3 │  ORB Matcher │    PaddleOCR        │   │
│  │   (15MB)     │  (Keypoints) │  (Text Extract)     │   │
│  └──────────────┴──────────────┴──────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
│  Redis Cache     │ │  PostgreSQL  │ │  External APIs   │
│  localhost:6379  │ │  (Fly.io)    │ │  - Pokemon TCG   │
│  - Results       │ │  - Cards     │ │  - PriceCharting │
│  - Embeddings    │ │  - Vectors   │ │  (future)        │
└──────────────────┘ └──────────────┘ └──────────────────┘
```

## Component Architecture

### 1. Frontend Layer

#### Dashboard (`src/dashboard/ensemble-dashboard.html`)
- **Technology:** Vanilla JavaScript, HTML5, CSS3
- **Features:**
  - Single-page application with tabbed interface
  - Real-time API monitoring console
  - Image preview with metadata display
  - WebSocket support for hot-reload
  - Responsive design with particle animations

#### Dashboard Server (`src/ml/dashboard-server.py`)
- **Technology:** FastAPI, Watchdog
- **Features:**
  - Hot-reload development server
  - WebSocket connections for live updates
  - Static file serving
  - Automatic browser refresh on file changes

### 2. ML Service Layer

#### Recognition Service (`src/ml/api/recognition_service.py`)
- **Technology:** FastAPI, Uvicorn
- **Endpoints:**
  - `POST /api/recognize/lightweight` - Card recognition
  - `GET /api/models/status` - System resource monitoring
  - `POST /api/recognize/heavy` - Future GPU endpoint
- **Features:**
  - Lifespan event management
  - Redis connection pooling
  - Graceful shutdown handling

#### ML Ensemble (`src/ml/ensemble.py`)
- **Architecture:** Adaptive three-model ensemble
- **Models:**
  1. **MobileNetV3** - CNN for visual features
  2. **ORB Matcher** - Keypoint matching
  3. **PaddleOCR** - Text extraction
- **Optimizations:**
  - Intel Extension for PyTorch
  - CPU-optimized operations
  - Dynamic model loading

### 3. Integration Layer

#### MLServiceClient (`src/services/MLServiceClient.ts`)
- **Technology:** TypeScript, Axios
- **Features:**
  - Type-safe API client
  - Retry logic with exponential backoff
  - Error handling and logging
  - Response transformation

#### MLValidationService (`src/services/MLValidationService.ts`)
- **Technology:** TypeScript
- **Features:**
  - Pokemon TCG API integration
  - Multi-source confidence scoring
  - Fuzzy string matching
  - Market price enrichment
  - Review requirement detection

### 4. Data Layer

#### PostgreSQL Database
- **Location:** Fly.io cloud
- **Schema:**
  ```sql
  cards (
    id UUID PRIMARY KEY,
    name TEXT,
    set_name TEXT,
    card_number TEXT,
    rarity TEXT,
    condition TEXT,
    market_price DECIMAL,
    image_url TEXT,
    embedding VECTOR(768),
    created_at TIMESTAMP
  )
  ```

#### Redis Cache
- **Location:** localhost:6379
- **Usage:**
  - Recognition result caching
  - Embedding storage
  - Session management
  - Rate limiting

## API Specifications

### Recognition API

#### POST /api/recognize/lightweight
```json
Request:
  Content-Type: multipart/form-data
  Body: file (image)

Response:
{
  "card_name": "Charizard",
  "set_name": "Base Set",
  "card_number": "4/102",
  "rarity": "Rare Holo",
  "confidence": 0.923,
  "ensemble_confidence": 0.945,
  "inference_time_ms": 828,
  "active_models": ["mobilenet", "orb", "paddle_ocr"],
  "api_validated": false,
  "market_price": null
}
```

### Model Status API

#### GET /api/models/status
```json
Response:
{
  "active_models": ["mobilenet", "orb", "paddle_ocr"],
  "resource_usage": {
    "ram_mb": 350,
    "ram_limit_mb": 4000,
    "cpu_percent": 12.5
  },
  "model_details": {
    "mobilenet": {"loaded": true, "size_mb": 15},
    "orb": {"loaded": true, "size_mb": 0},
    "paddle_ocr": {"loaded": true, "size_mb": 135}
  }
}
```

## Data Flow

### Card Recognition Pipeline

```
1. Image Upload
   ├─> Dashboard validates file type
   ├─> Display preview with metadata
   └─> Send to Recognition API

2. ML Processing
   ├─> MobileNetV3 extracts visual features
   ├─> ORB Matcher finds keypoints
   ├─> PaddleOCR extracts text
   └─> Ensemble combines predictions

3. Validation
   ├─> MLValidationService queries Pokemon TCG API
   ├─> Fuzzy matching for card verification
   ├─> Confidence score calculation
   └─> Review flagging if needed

4. Response
   ├─> Dashboard displays results
   ├─> API Console logs activity
   ├─> Cache results in Redis
   └─> Optional: Store in PostgreSQL
```

## Performance Characteristics

### Response Times
- **Image Preview:** < 50ms (client-side)
- **ML Inference:** 828ms average
- **API Validation:** 200-500ms (when available)
- **Total Pipeline:** < 1.5 seconds

### Resource Usage
- **RAM:**
  - MobileNetV3: 15MB
  - ORB Matcher: Minimal
  - PaddleOCR: 135MB
  - Service Overhead: 100MB
  - **Total:** 250-350MB

- **CPU:**
  - Idle: 2-5%
  - Processing: 40-60%
  - Optimized with Intel Extensions

### Scalability
- **Concurrent Requests:** 10-20 (CPU-limited)
- **Cache Hit Rate:** 60-80% for common cards
- **Database Connections:** Pool of 10
- **Redis Connections:** Pool of 20

## Security Considerations

### API Security
- **CORS:** Configured for localhost only
- **Rate Limiting:** Via Redis (future)
- **Input Validation:** File type and size limits
- **SQL Injection:** Parameterized queries
- **XSS Protection:** Content-Type headers

### Data Privacy
- **No PII Storage:** Only card data stored
- **Local Processing:** ML runs on-premises
- **Optional Cloud:** External APIs optional
- **Secure Connections:** HTTPS in production

## Deployment Architecture

### Development
```bash
# Local services
- Dashboard: http://localhost:8080
- API: http://localhost:8000
- Redis: localhost:6379
- PostgreSQL: Fly.io connection
```

### Production (Future)
```bash
# Docker Compose deployment
- Nginx: Reverse proxy
- Dashboard: Static hosting
- API: Gunicorn + Uvicorn
- Redis: Docker container
- PostgreSQL: Managed database
```

## Monitoring & Logging

### Application Logs
- **Location:** stdout/stderr
- **Format:** Structured JSON (Pino)
- **Levels:** DEBUG, INFO, WARN, ERROR

### API Console
- **Real-time monitoring** in dashboard
- **Request/Response tracking**
- **Error detection and display**
- **Performance metrics**

### Health Checks
- `/health` - Service health
- `/api/models/status` - Model status
- Redis PING - Cache availability
- PostgreSQL connection check

## Technology Stack

### Backend
- **Python 3.11** - Primary language
- **FastAPI** - Web framework
- **PyTorch 2.6** - ML framework
- **Intel Extension** - CPU optimizations
- **Redis** - Caching layer
- **PostgreSQL** - Primary database

### Frontend
- **HTML5/CSS3** - Structure and styling
- **JavaScript ES6+** - Interactivity
- **TypeScript** - Type safety
- **Axios** - HTTP client

### DevOps
- **Docker** - Containerization
- **Fly.io** - Cloud hosting
- **GitHub Actions** - CI/CD
- **Archon** - Knowledge management

## Future Architecture Plans

### Phase 1: GPU Support
- Add CUDA support for 10x faster inference
- Implement TripletResNet101 model
- Batch processing capabilities

### Phase 2: Microservices
- Separate ML models into individual services
- Kubernetes orchestration
- Service mesh for communication

### Phase 3: Advanced Features
- Real-time WebSocket updates
- Multi-language OCR support
- Blockchain verification for rare cards
- Mobile app with camera integration

---

*Last Updated: August 18, 2025*
*Architecture Version: 2.0.0*