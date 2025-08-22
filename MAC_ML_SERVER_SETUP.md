# CardMint M4 Mac ML Server Setup & Operations

## Quick Start

### On the M4 Mac:

1. **Set hostname (one-time setup):**
   ```bash
   sudo scutil --set HostName cardmint-ml
   ```

2. **Navigate to ML server directory:**
   ```bash
   cd /path/to/cardmint/ml_server
   ```

3. **Start the server:**
   ```bash
   ./start_server.sh
   ```
   
   Or manually:
   ```bash
   python main.py
   ```

4. **Verify server is running:**
   ```bash
   curl http://localhost:5001/status
   ```

## Server Endpoints

- **Health Check:** `http://10.0.24.174:5001/status`
- **Card Identification:** `POST http://10.0.24.174:5001/identify`
- **Inventory:** `GET http://10.0.24.174:5001/inventory`

## Performance Characteristics

- **Port:** 5001 (macOS uses 5000 for Control Center)
- **First Request:** ~5 seconds (model warmup)
- **Cached Requests:** 2-3ms
- **Memory Usage:** ~4GB (target <5GB)
- **Response Cache:** 5 minutes
- **Rate Limiting:** 429 responses when overloaded

## Integration with Fedora

### On the Fedora workstation:

1. **Test connectivity:**
   ```bash
   cd /home/profusionai/CardMint
   ./scripts/test-ml-connectivity.sh
   ```

2. **Run integration tests:**
   ```bash
   node scripts/test-ml-integration.js
   ```

3. **Start CardMint with ML enabled:**
   ```bash
   npm run dev
   ```

4. **Monitor logs:**
   ```bash
   tail -f logs/cardmint.log | grep "ML"
   ```

## Configuration

### Environment Variables (Fedora .env):
```bash
REMOTE_ML_ENABLED=true
REMOTE_ML_HOST=10.0.24.174
REMOTE_ML_PORT=5001
PROCESSING_MODE=hybrid  # or 'distributed' for full ML
```

## Monitoring

### Check server status:
```bash
# From Fedora
curl http://10.0.24.174:5001/status | jq

# Response shows:
# - Models loaded (smolvlm, mobilenet, yolo)
# - Memory usage
# - Queue depth
# - Uptime
```

### Monitor performance:
```bash
# Watch for rate limiting (429 responses)
tail -f logs/cardmint.log | grep "429"

# Check cache hit rate
curl http://10.0.24.174:5001/inventory | jq '.cache_stats'
```

## Troubleshooting

### Server not reachable:
1. Check Mac firewall settings
2. Verify server is running: `ps aux | grep python`
3. Check port: `lsof -i :5001`
4. Try direct IP instead of hostname

### High latency:
1. Check network: `ping 10.0.24.174`
2. Monitor CPU on Mac: `top`
3. Check memory: `vm_stat`
4. Restart server if needed

### Rate limiting (429 errors):
1. Normal behavior under load
2. CardMint will automatically defer requests
3. Reduce `MAX_CONCURRENT_ML_REQUESTS` if needed
4. Check queue depth in status endpoint

## Operational Procedures

### Daily Operations:
1. **Morning:** Check server health
2. **Monitor:** Memory usage stays under 5GB
3. **Review:** Cache hit rates
4. **Evening:** Check error logs

### Restart Procedure:
```bash
# On Mac
pkill -f "python main.py"
./start_server.sh

# Verify
curl http://localhost:5001/status
```

### Performance Tuning:
- Adjust cache TTL if needed (default 5 min)
- Monitor first-request warmup times
- Track p95 latencies
- Optimize batch sizes for throughput

## Architecture Overview

```
Fedora (Capture)          Mac M4 (ML Processing)
┌─────────────────┐      ┌─────────────────┐
│ Sony Camera     │      │ FastAPI Server  │
│ 400ms capture   │      │ Port 5001       │
├─────────────────┤      ├─────────────────┤
│ AsyncWatcher    │      │ ML Models:      │
│ <50ms detection │─────>│ - SmolVLM       │
├─────────────────┤ HTTP │ - MobileNet     │
│ RemoteMLClient  │      │ - YOLO          │
│ Retry + Defer   │      ├─────────────────┤
├─────────────────┤      │ SQLite DB       │
│ SQLite DB       │      │ Inventory       │
│ Card storage    │      │ tracking        │
└─────────────────┘      └─────────────────┘
```

## Success Metrics

✅ **Working:**
- Server responds to health checks
- Models loaded successfully
- Idempotency via BLAKE3 hashing
- Rate limiting protects server
- 5-minute response caching

🎯 **Target Performance:**
- End-to-end: 3-5 seconds (vs 12-17s OCR)
- Network latency: <100ms
- ML inference: 2-3 seconds
- Memory usage: <5GB
- Cache hit rate: >30%

## Next Steps

1. **Production deployment:**
   - Set up systemd service on Mac
   - Configure auto-start on boot
   - Set up monitoring alerts

2. **Performance optimization:**
   - Fine-tune model selection
   - Optimize batch processing
   - Implement model quantization

3. **Reliability:**
   - Add health check automation
   - Implement log rotation
   - Set up backup ML server