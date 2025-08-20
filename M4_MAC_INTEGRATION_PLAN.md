# CardMint M4 MacBook Pro Integration Plan

## Executive Summary
Transform CardMint into a distributed processing system with Fedora as the capture station and M4 Mac as the ML powerhouse, reducing processing from 12-17s to 3-5s while maintaining the critical 400ms camera capture performance.

## System Architecture

### 🖥️ Fedora Workstation (Primary Control Center)
- **Role**: Camera capture, UI control, orchestration
- **Critical Function**: Sony SDK & camera operations (UNCHANGED)
- **Services**: API server, WebSocket, capture watcher, queue manager
- **Database**: SQLite for capture metadata & queue status
- **Ports**: 3000 (API), 3001 (WebSocket), 9091 (Metrics)

### 💻 M4 MacBook Pro (ML Processing Node)
- **Role**: Heavy ML/VLM inference, card recognition
- **Services**: FastAPI ML server, model manager, image storage
- **Database**: Local PostgreSQL/SQLite for inventory & images
- **Storage**: 1TB SSD for high-res images, model cache
- **Hardware**: 24GB unified memory, Apple Neural Engine
- **Ports**: 5000 (ML API), 5432 (PostgreSQL if needed)

### 🔗 Network Communication
- **Protocol**: HTTP REST API over local network
- **Endpoints**: Card recognition, batch processing, status monitoring
- **Optimization**: Direct ethernet connection or high-speed WiFi
- **Security**: Internal network only, optional API key auth
- **Latency Target**: <100ms for local network transfer

## Implementation Phases

### Phase 1: Network Infrastructure Setup (Day 1)

#### 1.1 Configure M4 Mac Network
```bash
# On Mac - Set static IP or note hostname
sudo scutil --set HostName cardmint-ml
# Or use System Preferences > Network > Advanced > TCP/IP

# Test from Fedora
ping cardmint-ml.local
# or
ping 192.168.1.100  # if using static IP
```

#### 1.2 Create Remote ML Service Abstraction
- [ ] Extend `MLServiceClient.ts` to support remote endpoint
- [ ] Add configuration for Mac ML service URL
- [ ] Implement health checks and failover logic
- [ ] Add connection pooling for efficiency

#### 1.3 Setup Shared Storage Strategy
**Option A: HTTP File Transfer (Recommended)**
- POST image data in multipart/form-data
- Return JSON response with results
- Store images on Mac after processing

**Option B: Network Mount (Alternative)**
```bash
# On Mac - Enable file sharing
System Preferences > Sharing > File Sharing

# On Fedora - Mount shared folder
sudo mount -t cifs //cardmint-ml.local/CardMint /mnt/mac-storage
```

### Phase 2: M4 Mac ML Service Deployment (Day 2-3)

#### 2.1 Port ML Services to Mac
```bash
# Clone CardMint repo on Mac
git clone [repo] ~/CardMint-Mac

# Install Python dependencies
cd ~/CardMint-Mac/src/ml
pip install -r requirements.txt

# Install Mac-specific optimizations
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install coremltools mlx transformers
```

#### 2.2 Create FastAPI ML Server
Create `mac_ml_server.py`:
```python
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(title="CardMint ML Server")

@app.post("/identify")
async def identify_card(image: UploadFile = File(...)):
    """Single card recognition endpoint"""
    # Process image with ML model
    # Return card identification
    pass

@app.post("/batch")
async def batch_process(images: List[UploadFile] = File(...)):
    """Batch processing for multiple cards"""
    pass

@app.get("/status")
async def get_status():
    """Service health and metrics"""
    return {
        "status": "healthy",
        "models_loaded": ["smolvlm", "mobilenet"],
        "gpu_available": True,
        "memory_usage_mb": 2048
    }

@app.get("/models")
async def list_models():
    """Available models and their status"""
    pass

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
```

#### 2.3 Implement Persistent Model Loading
```python
class ModelManager:
    def __init__(self):
        self.models = {}
        self.load_models()
    
    def load_models(self):
        # Load SmolVLM with Core ML optimization
        self.models['smolvlm'] = self.load_smolvlm()
        # Load MobileNet for quick inference
        self.models['mobilenet'] = self.load_mobilenet()
        
    def load_smolvlm(self):
        # Use MLX or Core ML for Apple Silicon optimization
        pass
```

#### 2.4 Setup Local Inventory Database
```sql
-- Create inventory schema on Mac
CREATE TABLE cards (
    id UUID PRIMARY KEY,
    captured_at TIMESTAMP,
    processed_at TIMESTAMP,
    image_path TEXT,
    card_name TEXT,
    set_name TEXT,
    card_number TEXT,
    rarity TEXT,
    confidence FLOAT,
    market_price DECIMAL(10,2),
    metadata JSONB
);

CREATE INDEX idx_cards_name ON cards(card_name);
CREATE INDEX idx_cards_captured ON cards(captured_at);
```

### Phase 3: Fedora Integration & Communication (Day 4-5)

#### 3.1 Update CaptureWatcher Service
Modify `src/services/CaptureWatcher.ts`:
```typescript
private async handleNewCapture(filePath: string): Promise<void> {
  if (config.features.remoteMLEnabled) {
    // Send to Mac ML service
    const result = await this.sendToMacML(filePath);
    // Process result
  } else {
    // Use local processing
    await this.processLocally(filePath);
  }
}

private async sendToMacML(filePath: string): Promise<MLResult> {
  const formData = new FormData();
  formData.append('image', fs.createReadStream(filePath));
  
  const response = await axios.post(
    `${config.remoteMl.host}:${config.remoteMl.port}/identify`,
    formData,
    { timeout: config.remoteMl.timeout }
  );
  
  return response.data;
}
```

#### 3.2 Modify ImageProcessor Pipeline
Update `src/processing/ImageProcessor.ts`:
```typescript
async process(options: ProcessingOptions): Promise<ProcessingResult> {
  // Check if remote ML is enabled
  if (config.features.remoteMLEnabled) {
    try {
      // Try remote ML first
      const remoteResult = await this.processRemote(options);
      if (remoteResult.confidence > 0.85) {
        return remoteResult;
      }
    } catch (error) {
      logger.warn('Remote ML failed, falling back to local', error);
    }
  }
  
  // Fallback to local processing
  return this.processLocal(options);
}
```

#### 3.3 Implement Hybrid Processing Mode
```typescript
export class HybridProcessor {
  async processShadowMode(image: Buffer): Promise<ComparisonResult> {
    // Run both local and remote in parallel
    const [localResult, remoteResult] = await Promise.all([
      this.processLocal(image),
      this.processRemote(image)
    ]);
    
    // Log comparison for analysis
    logger.info('Shadow mode comparison', {
      local: { time: localResult.timeMs, confidence: localResult.confidence },
      remote: { time: remoteResult.timeMs, confidence: remoteResult.confidence },
      speedup: localResult.timeMs / remoteResult.timeMs
    });
    
    // Use remote result if confidence is higher
    return remoteResult.confidence > localResult.confidence 
      ? remoteResult 
      : localResult;
  }
}
```

### Phase 4: Performance Optimization (Day 6-7)

#### 4.1 Network Optimization
```typescript
// Connection pooling
const axiosInstance = axios.create({
  httpAgent: new http.Agent({ 
    keepAlive: true,
    maxSockets: 10
  }),
  httpsAgent: new https.Agent({ 
    keepAlive: true,
    maxSockets: 10
  })
});

// Request batching
class RequestBatcher {
  private queue: Request[] = [];
  private timer: NodeJS.Timeout;
  
  add(request: Request): void {
    this.queue.push(request);
    this.scheduleFlush();
  }
  
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    
    const batch = this.queue.splice(0, 10); // Max 10 per batch
    await this.sendBatch(batch);
  }
}
```

#### 4.2 Caching Strategy
```typescript
// Distributed cache configuration
export const cacheConfig = {
  fedora: {
    redis: {
      host: 'localhost',
      port: 6379,
      ttl: 300 // 5 minutes for recent results
    }
  },
  mac: {
    local: {
      maxSize: 1000, // Cache last 1000 predictions
      ttl: 3600 // 1 hour
    }
  }
};
```

#### 4.3 Load Balancing
```python
# On Mac - Concurrent request handling
from concurrent.futures import ThreadPoolExecutor
import asyncio

class RequestHandler:
    def __init__(self, max_workers=4):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.queue = asyncio.Queue(maxsize=100)
    
    async def process_request(self, image_data):
        # Add backpressure handling
        if self.queue.full():
            return {"error": "Server at capacity", "retry_after": 1}
        
        await self.queue.put(image_data)
        result = await self.process_with_model(image_data)
        self.queue.get_nowait()
        return result
```

### Phase 5: Monitoring & Reliability (Day 8)

#### 5.1 Cross-Machine Monitoring
```yaml
# prometheus.yml additions
scrape_configs:
  - job_name: 'cardmint-fedora'
    static_configs:
      - targets: ['localhost:9091']
  
  - job_name: 'cardmint-mac'
    static_configs:
      - targets: ['cardmint-ml.local:9092']
```

#### 5.2 Error Handling & Recovery
```typescript
class RemoteMLClient {
  private retryConfig = {
    attempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    factor: 2
  };
  
  async callWithRetry(request: Request): Promise<Response> {
    let lastError;
    
    for (let i = 0; i < this.retryConfig.attempts; i++) {
      try {
        return await this.makeRequest(request);
      } catch (error) {
        lastError = error;
        const delay = Math.min(
          this.retryConfig.initialDelay * Math.pow(this.retryConfig.factor, i),
          this.retryConfig.maxDelay
        );
        await this.sleep(delay);
      }
    }
    
    // Fall back to local processing
    logger.warn('All retries failed, using local processing', lastError);
    return this.processLocally(request);
  }
}
```

#### 5.3 Testing & Validation
```bash
# End-to-end test script
#!/bin/bash

# Test single card processing
time curl -X POST http://localhost:3000/api/capture \
  -F "image=@test-card.jpg"

# Test batch processing
for i in {1..100}; do
  curl -X POST http://localhost:3000/api/capture \
    -F "image=@test-card-$i.jpg" &
done
wait

# Check metrics
curl http://localhost:9091/metrics | grep cardmint_
curl http://cardmint-ml.local:9092/metrics | grep ml_
```

## Configuration Files

### `.env` Updates
```bash
# Remote ML Service Configuration
REMOTE_ML_ENABLED=true
REMOTE_ML_HOST=cardmint-ml.local
# REMOTE_ML_HOST=192.168.1.100  # Alternative: use static IP
REMOTE_ML_PORT=5000
REMOTE_ML_TIMEOUT=10000
REMOTE_ML_RETRY_ATTEMPTS=3
REMOTE_ML_API_KEY=optional_security_key

# Processing Mode
PROCESSING_MODE=distributed  # local|distributed|hybrid
ML_SHADOW_MODE=false  # Set to true to compare both methods
ML_FALLBACK_ENABLED=true  # Fallback to local on remote failure

# Storage Strategy
IMAGE_TRANSFER_METHOD=http  # http|smb|nfs
REMOTE_STORAGE_PATH=/Users/[username]/CardMint/storage
LOCAL_CACHE_SIZE_MB=500

# Performance Tuning
MAX_CONCURRENT_ML_REQUESTS=5
BATCH_SIZE=10
NETWORK_COMPRESSION=true
```

### `features.ts` Additions
```typescript
export interface DistributedFeatures {
  remoteMLEnabled: boolean;
  remoteMLHost: string;
  remoteMLPort: number;
  transferMethod: 'http' | 'filesystem' | 'hybrid';
  hybridMode: boolean;
  localFallback: boolean;
  shadowMode: boolean;
  compressionEnabled: boolean;
}

export function getDistributedFeatures(): DistributedFeatures {
  return {
    remoteMLEnabled: process.env.REMOTE_ML_ENABLED === 'true',
    remoteMLHost: process.env.REMOTE_ML_HOST || 'localhost',
    remoteMLPort: parseInt(process.env.REMOTE_ML_PORT || '5000'),
    transferMethod: (process.env.IMAGE_TRANSFER_METHOD || 'http') as any,
    hybridMode: process.env.PROCESSING_MODE === 'hybrid',
    localFallback: process.env.ML_FALLBACK_ENABLED !== 'false',
    shadowMode: process.env.ML_SHADOW_MODE === 'true',
    compressionEnabled: process.env.NETWORK_COMPRESSION === 'true'
  };
}
```

## Performance Metrics & Targets

### Current Baseline (Local Processing)
| Metric | Value | Status |
|--------|-------|--------|
| Camera Capture | 400ms | ✅ Critical |
| OCR Processing | 12-17s | ❌ Too Slow |
| Total Pipeline | 15-20s | ❌ Needs Improvement |
| Throughput | 3-4 cards/min | ❌ Below Target |
| CPU Usage | 747% | ⚠️ High |
| Memory Usage | 1.5GB | ✅ Acceptable |

### Target with M4 Mac (Distributed)
| Metric | Target | Expected | Improvement |
|--------|--------|----------|-------------|
| Camera Capture | 400ms | 400ms | No Change (Critical) |
| ML Inference | <3s | 1-2s | 10x Faster |
| Network Transfer | <500ms | 100-200ms | Negligible |
| Total Pipeline | <5s | 3-5s | 4x Faster |
| Throughput | 20 cards/min | 12-20 cards/min | 5x Better |
| Fedora CPU | <200% | 100-150% | 5x Lower |
| Mac CPU | <60% | 40-60% | Efficient |

## Risk Mitigation Strategies

### Critical Safeguards
1. **Sony SDK Independence**
   - Zero modifications to camera capture code
   - Capture performance monitoring with alerts
   - Separate binary remains untouched

2. **Automatic Fallback**
   ```typescript
   if (remoteML.isHealthy()) {
     return processRemote();
   } else {
     logger.warn('Remote ML unhealthy, using local');
     return processLocal();
   }
   ```

3. **Data Integrity**
   - Transaction logs for all transfers
   - Checksums for image validation
   - Duplicate detection before processing

4. **Instant Rollback**
   ```bash
   # Emergency rollback script
   export REMOTE_ML_ENABLED=false
   export PROCESSING_MODE=local
   systemctl restart cardmint
   ```

### Monitoring Triggers & Alerts
| Condition | Threshold | Action |
|-----------|-----------|--------|
| Processing Time | >10s | Alert & consider fallback |
| Mac CPU Usage | >90% | Throttle requests |
| Network Latency | >1s | Check connection |
| Error Rate | >5% | Investigate & fallback |
| Memory Usage (Mac) | >20GB | Restart ML service |
| Queue Depth | >100 | Scale or throttle |

## Testing Strategy

### Unit Tests
```typescript
describe('RemoteMLClient', () => {
  it('should handle remote service timeout', async () => {
    // Test timeout and fallback
  });
  
  it('should retry on network failure', async () => {
    // Test retry logic
  });
  
  it('should fall back to local on persistent failure', async () => {
    // Test fallback mechanism
  });
});
```

### Integration Tests
```bash
# Test Fedora to Mac communication
npm run test:integration -- --remote

# Test end-to-end pipeline
npm run test:e2e -- --distributed
```

### Load Tests
```javascript
// Load test with k6
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: 10, // 10 virtual users
  duration: '5m', // 5 minute test
};

export default function() {
  const response = http.post('http://localhost:3000/api/capture', {
    image: open('test-card.jpg', 'b'),
  });
  
  check(response, {
    'status is 200': (r) => r.status === 200,
    'processing time < 5s': (r) => r.timings.duration < 5000,
  });
}
```

### Acceptance Criteria Checklist
- [ ] Camera capture remains at 400ms (±10ms)
- [ ] End-to-end processing < 5s (95th percentile)
- [ ] Recognition accuracy ≥ 95%
- [ ] Graceful degradation on Mac failure
- [ ] No data loss during transfers
- [ ] Shadow mode shows Mac faster than OCR
- [ ] Load test passes with 100 concurrent requests
- [ ] Rollback completes in < 10 seconds

## Deployment Checklist

### Pre-Deployment
- [ ] Backup current system
- [ ] Document current performance baseline
- [ ] Test network connectivity between machines
- [ ] Verify Mac has sufficient resources
- [ ] Create rollback script

### Deployment Steps
1. [ ] Deploy Mac ML service
2. [ ] Test Mac service independently
3. [ ] Update Fedora configuration
4. [ ] Enable shadow mode first
5. [ ] Monitor shadow mode results
6. [ ] Gradually increase traffic to Mac
7. [ ] Disable shadow mode when confident
8. [ ] Document final configuration

### Post-Deployment
- [ ] Monitor performance metrics
- [ ] Collect user feedback
- [ ] Fine-tune based on real usage
- [ ] Document lessons learned
- [ ] Plan next optimizations

## Future Enhancements

### Short Term (1-2 weeks)
- [ ] Implement batch processing for multiple cards
- [ ] Add condition grading ML model
- [ ] Optimize image compression algorithms
- [ ] Implement predictive caching

### Medium Term (1-2 months)
- [ ] Multi-Mac support for scaling
- [ ] Advanced queue management with priorities
- [ ] Real-time UI updates via WebSocket
- [ ] Automated model retraining pipeline

### Long Term (3+ months)
- [ ] Edge deployment on specialized hardware
- [ ] Mobile app with direct Mac communication
- [ ] Cloud backup and sync (when budget allows)
- [ ] API marketplace integration

## Success Metrics

### Week 1 Goals
- Remote ML service operational
- 50% reduction in processing time
- Successful fallback testing
- No impact on camera capture

### Month 1 Goals
- Consistent <5s processing
- 95%+ recognition accuracy
- 1000+ cards processed
- Zero data loss incidents

### Quarter 1 Goals
- 20,000+ cards in inventory
- 99% uptime achieved
- ROI demonstrated
- Ready for production scale

## Appendices

### A. Network Topology Diagram
```
[Sony Camera] ─USB─> [Fedora Workstation]
                          │
                          ├─> SQLite DB (metadata)
                          ├─> Redis Cache
                          └─> HTTP API :3000
                               │
                               ├─[Ethernet/WiFi]─>
                               │
                     [M4 MacBook Pro]
                          │
                          ├─> ML Models (SmolVLM, etc)
                          ├─> PostgreSQL/SQLite (inventory)
                          ├─> Image Storage (1TB)
                          └─> FastAPI :5000
```

### B. Code Repository Structure
```
CardMint/
├── src/
│   ├── ml/                    # ML services (to be deployed on Mac)
│   │   ├── mac_ml_server.py   # New: Mac ML server
│   │   ├── model_manager.py   # New: Model lifecycle management
│   │   └── ...existing files
│   ├── services/
│   │   ├── RemoteMLClient.ts  # New: Remote ML communication
│   │   └── ...existing files
│   └── config/
│       ├── distributed.ts     # New: Distributed config
│       └── ...existing files
├── scripts/
│   ├── deploy-mac.sh          # New: Mac deployment script
│   ├── test-distributed.sh    # New: Distributed testing
│   └── emergency-rollback.sh  # Existing: Enhanced for distributed
└── docs/
    └── M4_MAC_INTEGRATION_PLAN.md  # This document
```

### C. Troubleshooting Guide

| Issue | Diagnosis | Solution |
|-------|-----------|----------|
| Mac unreachable | Ping fails | Check network, firewall |
| Slow inference | >5s processing | Check Mac resources, model size |
| High error rate | Logs show failures | Check model loading, memory |
| Fallback triggered | Remote unavailable | Investigate Mac service health |
| Network congestion | High latency | Switch to ethernet, check router |

---

**Document Version**: 1.0.0  
**Last Updated**: 2025-08-20  
**Author**: CardMint Development Team  
**Status**: Ready for Implementation