# CardMint ML Integration Complete Guide

## 🎯 Integration Status: READY

The distributed ML processing system between Fedora (capture) and M4 Mac (ML inference) is now fully configured and ready for testing.

## Architecture Overview

```
┌─────────────────────────┐         ┌─────────────────────────┐
│   FEDORA WORKSTATION    │         │    M4 MACBOOK PRO       │
├─────────────────────────┤         ├─────────────────────────┤
│ • Sony Camera (400ms)   │  HTTP   │ • FastAPI ML Server     │
│ • AsyncCaptureWatcher   │────────>│ • Port 5001             │
│ • RemoteMLClient        │         │ • SmolVLM, MobileNet    │
│ • SQLite Database       │<────────│ • BLAKE3 Idempotency    │
│ • Redis Queue Manager   │         │ • 5-min Response Cache  │
└─────────────────────────┘         └─────────────────────────┘
```

## Quick Start Guide

### Step 1: Verify Mac ML Server
```bash
# From Fedora, check Mac server status
curl http://10.0.24.174:5001/status | jq
```

### Step 2: Start CardMint Server
```bash
cd /home/profusionai/CardMint
npm run dev
```

### Step 3: Monitor Pipeline
```bash
# In a new terminal
./scripts/monitor-ml-pipeline.sh
```

### Step 4: Test Card Processing
```bash
# Place a card image in captures directory
cp test-card.jpg captures/DSC00001.JPG

# Or trigger capture
./capture-card
```

## Configuration Files

### 1. Environment Configuration (`.env`)
✅ **Already Updated:**
- `REMOTE_ML_ENABLED=true`
- `REMOTE_ML_HOST=10.0.24.174`
- `REMOTE_ML_PORT=5001`
- `PROCESSING_MODE=hybrid`

### 2. Processing Modes
- **local**: OCR only (12-17s) - fallback mode
- **hybrid**: Mix of ML and OCR (recommended for start)
- **distributed**: Full ML processing (3-5s target)

## Available Scripts

### Testing & Monitoring
```bash
# Test network connectivity
./scripts/test-ml-connectivity.sh

# Run integration tests
node scripts/test-ml-integration.js

# Monitor live pipeline
./scripts/monitor-ml-pipeline.sh
```

## Performance Expectations

### Current OCR Baseline
- Processing Time: 12-17 seconds
- CPU Usage: 747%
- Memory: 1.5GB

### ML Integration Target
- Processing Time: 3-5 seconds ✨
- Network Latency: <100ms
- ML Inference: 2-3 seconds
- Memory (Mac): <5GB

## Operational Procedures

### Daily Operations

#### Morning Startup
1. **Mac:** Start ML server
   ```bash
   cd ml_server && ./start_server.sh
   ```

2. **Fedora:** Start CardMint
   ```bash
   cd /home/profusionai/CardMint && npm run dev
   ```

3. **Verify:** Check connectivity
   ```bash
   ./scripts/test-ml-connectivity.sh
   ```

4. **Monitor:** Open dashboard
   ```bash
   ./scripts/monitor-ml-pipeline.sh
   ```

### Processing Workflow

1. **Capture:** Sony camera captures card (400ms)
2. **Detection:** AsyncCaptureWatcher detects file (<50ms)
3. **Queue:** Image queued for processing
4. **ML Request:** RemoteMLClient sends to Mac
5. **Inference:** Mac processes with ML models (2-3s)
6. **Response:** Results returned with confidence
7. **Storage:** Card data saved to SQLite

### Error Handling

#### Mac Server Unreachable
- System automatically defers requests
- Queued for retry when server returns
- No impact on capture performance

#### Rate Limiting (429)
- Normal under high load
- Automatic exponential backoff
- Requests deferred to queue

#### High Latency
- Fallback to OCR if >7 seconds
- Check network connectivity
- Monitor Mac CPU/memory

## Troubleshooting Guide

### Common Issues

1. **"Mac hostname not found"**
   - Use IP address: `10.0.24.174`
   - Or configure Mac hostname: `sudo scutil --set HostName cardmint-ml`

2. **"Connection refused"**
   - Check Mac ML server is running
   - Verify port 5001 is open
   - Check firewall settings

3. **"Socket hang up"**
   - Server overloaded or timeout
   - Check Mac memory usage
   - Reduce concurrent requests

4. **"429 Too Many Requests"**
   - Rate limiting active (normal)
   - System will auto-retry
   - Check queue depth

### Debug Commands

```bash
# Check Mac server health
curl -v http://10.0.24.174:5001/status

# Test single image
curl -X POST http://10.0.24.174:5001/identify \
  -F "image=@test-card.jpg"

# Check CardMint logs
tail -f logs/cardmint.log | grep -E "ML|ERROR"

# Monitor queue status
watch -n 1 'curl -s localhost:3000/api/queue/status | jq'
```

## Performance Tuning

### Optimize Network
```bash
# In .env, adjust:
REMOTE_ML_TIMEOUT=5000      # Reduce if network is fast
MAX_CONCURRENT_ML_REQUESTS=2 # Increase carefully
```

### Cache Settings
```bash
# In .env, tune:
ML_CACHE_TTL=600           # 10 minutes for stable cards
LOCAL_CACHE_SIZE_MB=1000   # Increase for more caching
```

### Processing Mode
```bash
# Start conservative:
PROCESSING_MODE=hybrid     # Test with mixed mode

# Once stable:
PROCESSING_MODE=distributed # Full ML processing
```

## Monitoring Metrics

### Key Indicators
- **ML Latency:** Target <5 seconds
- **Cache Hit Rate:** Target >30%
- **Queue Depth:** Should stay <50
- **Memory (Mac):** Keep <5GB
- **Error Rate:** Should be <1%

### Dashboard Views
The monitoring script shows:
- Server health status
- Active models
- Resource usage
- Queue depths
- Recent activity

## Next Steps

### Immediate Testing
1. ✅ Configuration complete
2. ✅ Scripts ready
3. ⏳ Start CardMint server
4. ⏳ Test with real cards
5. ⏳ Monitor performance

### Production Readiness
1. Set up systemd services
2. Configure log rotation
3. Add alerting rules
4. Document runbooks
5. Train operators

## Success Criteria

✅ **Completed:**
- ML server accessible at `10.0.24.174:5001`
- Environment configured for distributed processing
- Testing and monitoring scripts created
- Documentation complete

🎯 **To Validate:**
- End-to-end processing under 5 seconds
- Successful fallback on ML failure
- No impact on 400ms capture
- Stable under continuous load

## Commands Reference

```bash
# Start services
npm run dev                          # Start CardMint
./scripts/monitor-ml-pipeline.sh     # Monitor pipeline

# Testing
./scripts/test-ml-connectivity.sh    # Test connectivity
node scripts/test-ml-integration.js  # Integration tests

# Operations
./capture-card                        # Capture a card
curl http://10.0.24.174:5001/status # Check ML server
curl localhost:3000/api/health       # Check CardMint
```

---

**Status:** The integration is fully configured and ready for testing. Start the CardMint server with `npm run dev` to begin processing cards with ML!