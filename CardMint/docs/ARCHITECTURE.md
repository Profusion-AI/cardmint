# CardMint Architecture

## System Overview

CardMint is a high-performance Pokemon card scanning and inventory management system built with a microservice-inspired architecture. The system prioritizes accuracy (99.9% target) over raw speed, using multiple validation sources to ensure data integrity.

## Architecture Principles

1. **Accuracy First**: Multiple validation layers ensure 99.9% accuracy
2. **Fault Tolerance**: Circuit breakers and retry policies prevent cascading failures
3. **Observability**: Comprehensive metrics and logging for production monitoring
4. **Scalability**: Queue-based processing allows horizontal scaling
5. **Modularity**: Loosely coupled services enable independent development

## System Components

### 1. Camera Service

**Purpose**: Hardware integration for high-speed image capture

**Architecture**:
```
Node.js Process
      ↓
TypeScript Wrapper (SonyCameraProduction.ts)
      ↓ (subprocess)
C++ CLI Binary (sony-cli)
      ↓ (native calls)
Sony Camera SDK
      ↓ (USB)
Physical Camera
```

**Key Features**:
- Subprocess isolation prevents SDK crashes from affecting main process
- 35ms capture latency achieved through native bindings
- Triple buffering for continuous capture
- Automatic reconnection on failure

### 2. Image Processing Pipeline

**Components**:
- **ImageNormalizer**: Standardizes image format and quality
- **ImageProcessor**: Prepares images for OCR
- **SignalExtractor**: Identifies card regions and features

**Processing Flow**:
```
Raw Image → Normalize → Crop/Rotate → Enhance → OCR Ready
```

### 3. OCR Service

**Architecture**:
- Python subprocess running PaddleOCR
- Pokemon-specific text patterns
- Multi-pass extraction for accuracy

**Regions Processed**:
1. Header (name, HP, type)
2. Artwork area (for visual validation)
3. Attack/ability text
4. Footer (set info, number, rarity)

### 4. Card Matching Engine

**Multi-Source Validation**:
```
OCR Result
    ↓
┌───────────────┬────────────────┬─────────────────┐
│ Pokemon TCG   │ PriceCharting  │ Image Validation│
│     API       │      API       │     Service     │
└───────────────┴────────────────┴─────────────────┘
                        ↓
                 Confidence Scoring
                        ↓
                 Manual Review Queue
                   (if < 95%)
```

**Accuracy Algorithm**:
- OCR weight: 25%
- API match: 35%
- Price data: 20%
- Image similarity: 20%

### 5. Queue Management

**BullMQ Architecture**:
```
Capture Request → Redis Queue → Worker Pool (20) → Processing
                                      ↓
                               Success/Failure
                                      ↓
                            Dead Letter Queue
```

**Features**:
- Job persistence across restarts
- Exponential backoff retry
- Priority queue support
- Real-time progress tracking

### 6. Data Storage

**PostgreSQL Schema**:
```sql
cards
├── id (UUID)
├── name (TEXT)
├── set_info (JSONB)
├── pricing (JSONB)
├── images (JSONB)
├── metadata (JSONB)
└── timestamps

processing_jobs
├── id (UUID)
├── status (ENUM)
├── card_id (FK)
├── attempts (INT)
└── error_log (JSONB)
```

**Redis Usage**:
- API response caching (24hr TTL)
- Session management
- Real-time metrics
- Queue backing store

### 7. API Layer

**REST API Structure**:
```
Express Router
    ↓
Correlation ID Middleware
    ↓
Error Handler Middleware
    ↓
Route Handler
    ↓
Service Layer
    ↓
Data Access Layer
```

**WebSocket Architecture**:
```
uWebSockets.js Server
    ↓
Binary Protocol Handler
    ↓
Event Emitter
    ↓
Client Subscriptions
```

## Resilience Patterns

### Circuit Breaker

**Implementation**:
```typescript
State Machine:
CLOSED → OPEN (on threshold)
OPEN → HALF_OPEN (after timeout)
HALF_OPEN → CLOSED/OPEN (on success/failure)
```

**Configuration**:
- Failure threshold: 5 failures
- Reset timeout: 30 seconds
- Success threshold: 2 successes

### Retry Policy

**Exponential Backoff**:
```
Attempt 1: 1s delay
Attempt 2: 2s delay
Attempt 3: 4s delay
Max delay: 30s
```

**Smart Retry Conditions**:
- Network errors: Yes
- Rate limits (429): Yes with Retry-After
- Client errors (4xx): No
- Timeouts: Yes

## Performance Optimization

### Memory Management
- Histogram arrays capped at 10,000 entries
- Image buffers pooled and reused
- Streaming for large responses
- Garbage collection tuning

### CPU Optimization
- Core isolation (2-7 for processing)
- Worker thread pool
- Native bindings for critical paths
- Async/await for I/O operations

### Network Optimization
- Connection pooling for databases
- HTTP/2 for API calls
- Binary WebSocket protocol
- Response compression

## Monitoring & Observability

### Metrics Collection
```
Prometheus Exporter (9091)
         ↓
┌────────────────────────┐
│ Custom Metrics:        │
│ - Accuracy rates       │
│ - Processing times     │
│ - Queue depths        │
│ - API success rates   │
└────────────────────────┘
```

### Logging Strategy
- Structured JSON logging
- Correlation IDs for request tracing
- Log levels: ERROR, WARN, INFO, DEBUG
- Sensitive data scrubbing

### Health Checks
```
/api/health
    ├── Database connectivity
    ├── Redis connectivity
    ├── Camera status
    ├── Queue depth
    └── Circuit breaker states
```

## Security Architecture

### Current Security Measures
1. Environment variable configuration
2. SQL injection prevention (parameterized queries)
3. Error message sanitization
4. Correlation ID tracking

### Security Gaps (v1.0-alpha)
1. No authentication system
2. No rate limiting
3. No input validation framework
4. No API key rotation

## Deployment Architecture

### Container Structure
```
cardmint-app (Node.js)
    ├── Depends on: postgres
    ├── Depends on: redis
    └── Volume mounts: images, config

cardmint-worker (Queue processor)
    ├── Replicas: 1-20
    └── Shared Redis queue
```

### Environment Separation
- Development: Local with mock services
- Staging: Docker Compose
- Production: Kubernetes/Fly.io

## Data Flow Diagram

```
Camera Capture
      ↓
Image Buffer
      ↓
Queue Manager ←→ Redis
      ↓
Worker Pool
      ↓
┌─────────────┬──────────────┬───────────────┐
│     OCR     │ API Services │ Image Valid.  │
└─────────────┴──────────────┴───────────────┘
                    ↓
              Card Matcher
                    ↓
        ┌──────────────────────┐
        │ Confidence > 95%?    │
        └──────────────────────┘
          Yes ↓          ↓ No
        Database    Manual Review
```

## Scalability Considerations

### Current Limitations
1. Single camera bottleneck
2. Fixed worker pool (20)
3. Monolithic Node.js process
4. Single PostgreSQL instance

### Scaling Strategy
1. **Horizontal**: Add more workers
2. **Vertical**: Increase resources
3. **Sharding**: Partition by date/user
4. **Caching**: Expand Redis usage

## Technology Decisions

### Why Node.js?
- Excellent async I/O performance
- Rich ecosystem for web services
- TypeScript for type safety
- Easy integration with multiple services

### Why PostgreSQL?
- JSONB for flexible schema
- Strong consistency guarantees
- Excellent performance
- Mature ecosystem

### Why Redis?
- Fast queue operations
- Pub/sub for real-time updates
- Caching layer
- Proven reliability

### Why BullMQ?
- Redis-backed persistence
- Advanced retry mechanisms
- Dashboard availability
- Active development

## Future Architecture Improvements

### Phase 1: Authentication & Security
- JWT-based authentication
- Role-based access control
- API rate limiting
- Input validation framework

### Phase 2: Scalability
- Microservice decomposition
- Message bus architecture
- Database read replicas
- CDN for images

### Phase 3: Machine Learning
- Custom OCR model training
- Card condition grading
- Price prediction models
- Anomaly detection

## Conclusion

CardMint's architecture prioritizes accuracy and reliability while maintaining high performance. The modular design allows for independent scaling and development of components, while resilience patterns ensure system stability under failure conditions. The comprehensive monitoring and observability features enable proactive issue detection and resolution in production environments.

---

*Last updated: August 2025*
*Version: 1.0-alpha*