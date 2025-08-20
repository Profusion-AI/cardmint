# M4 MacBook Pro Integration - Handoff Specification

## Executive Summary
This document defines the API contract and integration requirements between the Fedora workstation (capture/orchestration) and M4 MacBook Pro (ML processing). Both systems must implement these specifications to ensure seamless distributed processing.

## API Contract Specification

### Base Configuration
- **Protocol**: HTTP/1.1 (upgradeable to HTTP/2)
- **Base URL**: `http://cardmint-ml.local:5000` (or static IP)
- **Content Type**: `multipart/form-data` for image upload, `application/json` for responses
- **Authentication**: Optional `X-API-Key` header
- **Timeout**: 10 seconds default, configurable

### Required Endpoints (Mac Must Implement)

#### 1. Health Check
```http
GET /status
```

**Response** (200 OK):
```json
{
  "status": "healthy",
  "ensemble_ready": true,
  "redis_connected": true,
  "models_loaded": ["smolvlm", "mobilenet", "yolo"],
  "uptime_seconds": 3600,
  "version": "1.0.0",
  "capabilities": {
    "single_card": true,
    "batch_processing": true,
    "gpu_acceleration": true,
    "max_batch_size": 10
  },
  "resources": {
    "cpu_percent": 45.2,
    "memory_mb": 8192,
    "gpu_memory_mb": 4096,
    "disk_space_gb": 250
  }
}
```

#### 2. Single Card Recognition
```http
POST /identify
Content-Type: multipart/form-data
```

**Request Body**:
```
image: <binary image data> (required)
request_id: string (required)
metadata: JSON string (optional)
priority: "low" | "normal" | "high" (optional, default: "normal")
return_confidence_details: boolean (optional, default: false)
```

**Response** (200 OK):
```json
{
  "card_id": "base1-4",
  "card_name": "Charizard",
  "set_name": "Base Set",
  "card_number": "4/102",
  "rarity": "Rare Holo",
  "confidence": 0.95,
  "ensemble_confidence": 0.97,
  "inference_time_ms": 1250,
  "active_models": ["smolvlm", "mobilenet"],
  "cached": false,
  "timestamp": "2025-08-20T15:30:00Z",
  "request_id": "req_123456",
  "details": {
    "edition": "Unlimited",
    "condition_estimate": "Near Mint",
    "language": "English",
    "variant": "regular",
    "special_features": ["holographic"]
  },
  "confidence_breakdown": {
    "smolvlm": 0.96,
    "mobilenet": 0.94,
    "consensus": 0.97
  }
}
```

**Error Response** (400/500):
```json
{
  "error": "Invalid image format",
  "error_code": "IMG_001",
  "request_id": "req_123456",
  "timestamp": "2025-08-20T15:30:00Z",
  "retry_after": 1000
}
```

#### 3. Batch Processing
```http
POST /batch
Content-Type: multipart/form-data
```

**Request Body**:
```
images: <multiple binary image files>
request_ids: JSON array of strings
priority: "low" | "normal" | "high"
max_parallel: integer (optional, default: 5)
```

**Response** (200 OK):
```json
{
  "batch_id": "batch_789",
  "total": 10,
  "successful": 9,
  "failed": 1,
  "results": [
    {
      "request_id": "req_001",
      "status": "success",
      "data": { /* same as single card response */ }
    },
    {
      "request_id": "req_002",
      "status": "error",
      "error": "Image too blurry",
      "error_code": "IMG_002"
    }
  ],
  "processing_time_ms": 8500,
  "average_time_ms": 850
}
```

#### 4. Model Management
```http
GET /models
```

**Response** (200 OK):
```json
{
  "available_models": [
    {
      "name": "smolvlm",
      "version": "2.0.0",
      "status": "loaded",
      "memory_mb": 2048,
      "supports_gpu": true,
      "accuracy": 0.96
    },
    {
      "name": "mobilenet",
      "version": "1.5.0",
      "status": "loaded",
      "memory_mb": 512,
      "supports_gpu": true,
      "accuracy": 0.92
    },
    {
      "name": "yolo-cards",
      "version": "1.0.0",
      "status": "available",
      "memory_mb": 1024,
      "supports_gpu": true,
      "accuracy": 0.94
    }
  ],
  "active_ensemble": ["smolvlm", "mobilenet"],
  "total_memory_usage_mb": 2560,
  "gpu_enabled": true
}
```

#### 5. Cache Management
```http
GET /cache/stats
```

**Response** (200 OK):
```json
{
  "cache_enabled": true,
  "total_entries": 1523,
  "memory_usage_mb": 245,
  "hit_rate": 0.72,
  "ttl_seconds": 3600,
  "oldest_entry": "2025-08-20T10:00:00Z",
  "last_cleanup": "2025-08-20T14:00:00Z"
}
```

```http
POST /cache/clear
```

**Response** (200 OK):
```json
{
  "entries_cleared": 1523,
  "memory_freed_mb": 245
}
```

### Optional Advanced Endpoints

#### 6. Streaming Recognition (WebSocket)
```
ws://cardmint-ml.local:5001/stream
```

**Message Format**:
```json
{
  "type": "recognize",
  "request_id": "req_123",
  "image_base64": "..."
}
```

**Response Format**:
```json
{
  "type": "result",
  "request_id": "req_123",
  "data": { /* same as single card response */ }
}
```

#### 7. Metrics Endpoint (Prometheus)
```http
GET /metrics
```

**Response** (text/plain):
```
# HELP ml_inference_duration_seconds ML inference duration
# TYPE ml_inference_duration_seconds histogram
ml_inference_duration_seconds_bucket{le="0.5"} 245
ml_inference_duration_seconds_bucket{le="1.0"} 892
ml_inference_duration_seconds_bucket{le="2.0"} 1205
ml_inference_duration_seconds_sum 1847.23
ml_inference_duration_seconds_count 1205

# HELP ml_model_memory_bytes Memory usage per model
# TYPE ml_model_memory_bytes gauge
ml_model_memory_bytes{model="smolvlm"} 2147483648
ml_model_memory_bytes{model="mobilenet"} 536870912
```

## Fedora-Side Implementation Requirements

### 1. RemoteMLClient Integration
The Fedora system has implemented `RemoteMLClient.ts` with:
- Connection pooling for efficiency
- Exponential backoff retry logic
- Health monitoring with 30-second intervals
- Metrics collection (latency, success rate)
- Event emitter for status updates
- Automatic fallback to local OCR

### 2. Configuration via Environment Variables
```bash
# Required settings in .env
REMOTE_ML_ENABLED=true
REMOTE_ML_HOST=cardmint-ml.local
REMOTE_ML_PORT=5000
REMOTE_ML_TIMEOUT=10000
PROCESSING_MODE=distributed  # or hybrid
ML_FALLBACK_ENABLED=true
```

### 3. Error Handling Strategy
- **Network Errors**: 3 retries with exponential backoff
- **Timeout**: Fallback to local OCR after 10 seconds
- **Service Unavailable**: Queue requests locally, retry later
- **Invalid Response**: Log error, use fallback
- **High Latency**: Switch to local if >10s consistently

### 4. Expected Performance Characteristics
- **Network Transfer**: 100-500ms for 5MB image
- **ML Inference**: 1-3 seconds on M4 Mac
- **Total Round Trip**: 3-5 seconds target
- **Fallback Trigger**: >10 seconds or 3 failures

## Mac-Side Implementation Requirements

### 1. Server Framework
- **Recommended**: FastAPI (Python) or Express (Node.js)
- **Required Features**:
  - Async request handling
  - File upload support (multipart)
  - JSON response serialization
  - CORS headers for web dashboard
  - Request ID tracking

### 2. Model Management
```python
class ModelManager:
    """Singleton pattern for model lifecycle"""
    
    def __init__(self):
        self.models = {}
        self.load_models_on_startup()
    
    def load_models_on_startup(self):
        """Load all models into memory once"""
        # SmolVLM with Core ML optimization
        # MobileNet for quick inference
        # Keep models warm in memory
    
    def predict(self, image, ensemble=True):
        """Run inference with loaded models"""
        # No model loading here - use pre-loaded
        # Return consensus or single model result
```

### 3. Apple Silicon Optimization
```python
# Use MPS (Metal Performance Shaders) backend
import torch
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

# Or use Core ML for maximum performance
import coremltools as ct
model = ct.convert(pytorch_model, convert_to="mlprogram")

# Or use MLX for Apple Silicon
import mlx
model = mlx.load("model.safetensors")
```

### 4. Database Schema (Local Inventory)
```sql
-- Mac-local PostgreSQL or SQLite
CREATE TABLE processed_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(255) UNIQUE NOT NULL,
    captured_at TIMESTAMP NOT NULL,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Image storage
    image_path TEXT NOT NULL,
    image_hash VARCHAR(64),
    image_size_bytes INTEGER,
    
    -- Recognition results
    card_name TEXT NOT NULL,
    set_name TEXT,
    card_number VARCHAR(20),
    rarity VARCHAR(50),
    edition VARCHAR(50),
    language VARCHAR(20) DEFAULT 'English',
    
    -- Confidence metrics
    confidence FLOAT NOT NULL,
    ensemble_confidence FLOAT,
    model_used VARCHAR(100),
    inference_time_ms INTEGER,
    
    -- Market data (optional)
    estimated_value DECIMAL(10,2),
    condition_estimate VARCHAR(20),
    
    -- Metadata
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cards_request_id ON processed_cards(request_id);
CREATE INDEX idx_cards_captured_at ON processed_cards(captured_at);
CREATE INDEX idx_cards_card_name ON processed_cards(card_name);
CREATE INDEX idx_cards_confidence ON processed_cards(confidence);
```

### 5. Startup Sequence
```python
async def startup():
    """Server startup sequence"""
    # 1. Load all ML models into memory
    await model_manager.initialize()
    
    # 2. Test GPU/Neural Engine availability
    check_hardware_acceleration()
    
    # 3. Connect to local database
    await database.connect()
    
    # 4. Warm up models with test inference
    await model_manager.warmup()
    
    # 5. Start background tasks
    start_cache_cleanup_task()
    start_metrics_collection()
    
    # 6. Log ready status
    logger.info(f"ML Server ready on port {PORT}")
```

## Network Communication Patterns

### 1. Request Flow
```
Fedora                          Mac
  |                              |
  |------ POST /identify ------->|
  |         (image data)         |
  |                              |
  |<----- JSON Response ---------|
  |     (card identification)    |
```

### 2. Health Monitoring
```
Fedora                          Mac
  |                              |
  |------ GET /status ---------->|
  |      (every 30 sec)          |
  |                              |
  |<----- Health Status ---------|
  |                              |
```

### 3. Fallback Scenario
```
Fedora                          Mac
  |                              |
  |------ POST /identify ------->| (timeout)
  |           ...10s...           |
  |                              |
  |   [Timeout - Use Local OCR]  |
  |                              |
```

## Testing Protocol

### 1. Integration Test Checklist
- [ ] Mac server responds to health checks
- [ ] Single image recognition works
- [ ] Batch processing handles 10 images
- [ ] Network failure triggers fallback
- [ ] High latency triggers fallback
- [ ] Cache improves response time
- [ ] Metrics endpoint provides data

### 2. Performance Benchmarks
```bash
# From Fedora, test single card
time curl -X POST http://cardmint-ml.local:5000/identify \
  -F "image=@test-card.jpg" \
  -F "request_id=test-001"

# Expected: < 3 seconds

# Test batch of 10 cards
for i in {1..10}; do
  curl -X POST http://cardmint-ml.local:5000/identify \
    -F "image=@test-card-$i.jpg" \
    -F "request_id=test-$i" &
done
wait

# Expected: All complete in < 15 seconds
```

### 3. Fallback Testing
```bash
# Simulate Mac unavailable
export REMOTE_ML_HOST=invalid.local
npm run test:integration

# Should see: "Falling back to local OCR"
```

## Security Considerations

### 1. Network Security
- Internal network only (no internet exposure)
- Optional API key authentication
- Rate limiting per client IP
- Request size limits (max 10MB per image)

### 2. Data Privacy
- Images stored locally only
- No cloud uploads without explicit config
- Request IDs for audit trail
- Automatic cleanup of old data

## Monitoring & Observability

### 1. Key Metrics to Track
- `ml_inference_duration_seconds`: Processing time
- `ml_requests_total`: Request count
- `ml_requests_failed_total`: Failure count
- `ml_fallback_triggered_total`: Fallback usage
- `ml_cache_hit_ratio`: Cache effectiveness
- `ml_model_memory_bytes`: Memory per model

### 2. Logging Requirements
```json
{
  "timestamp": "2025-08-20T15:30:00Z",
  "level": "INFO",
  "service": "remote-ml",
  "request_id": "req_123456",
  "action": "recognize",
  "card_name": "Charizard",
  "confidence": 0.95,
  "duration_ms": 1250,
  "model": "smolvlm",
  "cache_hit": false
}
```

### 3. Alerting Thresholds
- Error rate > 5%: Warning
- Error rate > 10%: Critical
- Latency > 5s (p95): Warning
- Latency > 10s (p95): Critical
- Mac unreachable > 1 minute: Critical

## Deployment Checklist

### Fedora Side (Already Implemented)
- [x] RemoteMLClient.ts created
- [x] Distributed configuration module
- [x] Environment variables configured
- [x] Retry and fallback logic
- [x] Health monitoring
- [ ] Update ImageProcessor.ts to use RemoteMLClient
- [ ] Update CaptureWatcher.ts for remote processing
- [ ] Test end-to-end pipeline

### Mac Side (To Be Implemented)
- [ ] Create FastAPI server with all endpoints
- [ ] Implement ModelManager with persistent loading
- [ ] Optimize for Apple Silicon (MPS/CoreML/MLX)
- [ ] Setup local database for inventory
- [ ] Implement caching layer
- [ ] Add metrics endpoint
- [ ] Create startup/shutdown sequences
- [ ] Test with real card images

## Version Compatibility

### API Version: 1.0.0
- Fedora RemoteMLClient: 1.0.0
- Mac ML Server: Must implement 1.0.0
- Breaking changes require version bump
- Backward compatibility for 2 versions

### Future Enhancements (v2.0)
- Streaming recognition via WebSocket
- Progressive image loading
- Multi-language support
- Condition grading endpoint
- Price prediction endpoint
- Bulk export capabilities

## Troubleshooting Guide

### Common Issues & Solutions

| Issue | Diagnosis | Solution |
|-------|-----------|----------|
| Connection refused | Mac server not running | Start server on Mac port 5000 |
| Timeout errors | Network or slow inference | Check network, increase timeout |
| Low confidence | Poor image quality | Improve lighting, check focus |
| Memory errors | Models too large | Reduce batch size, optimize models |
| Cache misses | TTL too short | Increase cache TTL |
| Fallback triggered | Mac unhealthy | Check Mac logs, restart service |

## Contact & Support

**Fedora Side**: CardMint development environment
**Mac Side**: M4 MacBook Pro ML environment
**Integration Issues**: Check both system logs
**Performance Issues**: Review metrics on both sides

---

**Document Version**: 1.0.0  
**Last Updated**: 2025-08-20  
**Status**: Ready for Mac-side implementation  
**Next Review**: After initial integration testing