# CardMint Test Scripts

This directory contains comprehensive test scripts for validating CardMint's controller integration and system stability.

## Quick Start

```bash
# Run all infrastructure tests
npm run test:infrastructure

# Test port resilience
npm run test:port-resilience

# Test WebSocket discovery
npm run test:websocket-discovery

# Monitor performance
npm run test:performance

# Full test suite
npm run test:controller:full
```

## Test Scripts Overview

### 🔧 Infrastructure Tests

#### `test-port-resilience.sh`
Tests CardMint's ability to handle port conflicts and use fallback ports.

**Purpose**: Ensure system starts reliably regardless of port availability
**Scenarios**: 
- All ports free (baseline)
- API port blocked (3000)
- WebSocket port blocked (3001)  
- Dashboard ports blocked (5173-5176)
- All ports blocked (worst case)

**Usage**:
```bash
./scripts/test-port-resilience.sh
```

**Expected Output**:
- ✅ System startup within 10s for each scenario
- ✅ Fallback port detection logs
- ✅ Health endpoint accessibility
- 📄 Detailed logs in `./test-results/startup-*.log`

#### `test-websocket-discovery.js`
Tests WebSocket auto-discovery functionality using headless browser automation.

**Purpose**: Verify dashboard finds WebSocket server regardless of port
**Tests**:
- Normal connection (3001 available)
- Fallback discovery (3001 blocked, 3002 available)
- Port discovery with different dashboard ports

**Usage**:
```bash
node scripts/test-websocket-discovery.js
```

**Prerequisites**:
```bash
npm install --save-dev puppeteer
```

**Expected Output**:
- ✅ WebSocket connection within 3s
- ✅ Automatic fallback to port 3002
- ✅ Connection status updates in UI

### 📊 Performance Tests

#### `monitor-performance.sh`
Establishes performance baselines and monitors system resources.

**Purpose**: Capture CPU, memory, and I/O metrics during operation
**Duration**: Configurable (default 300s)

**Usage**:
```bash
# Monitor for 5 minutes (default)
./scripts/monitor-performance.sh

# Monitor for 1 minute
./scripts/monitor-performance.sh 60

# Monitor for 30 minutes
./scripts/monitor-performance.sh 1800
```

**Generated Files**:
- `performance-logs/performance_report_TIMESTAMP.md` - Analysis report
- `performance-logs/vmstat_TIMESTAMP.log` - System stats
- `performance-logs/pidstat_TIMESTAMP.log` - Process stats
- `performance-logs/iostat_TIMESTAMP.log` - I/O stats
- `performance-logs/system_TIMESTAMP.log` - System overview

**Target Benchmarks**:
- **Idle CPU**: < 1%
- **Active CPU**: < 10% 
- **Memory**: < 200MB
- **System Idle**: > 90%

## Test Execution Workflow

### Phase 1: Infrastructure Validation
```bash
# 1. Test port resilience
npm run test:port-resilience

# 2. Verify WebSocket discovery  
npm run test:websocket-discovery
```

### Phase 2: Performance Baseline
```bash
# Start CardMint in background
npm run dev:full &

# Monitor for 5 minutes
npm run test:performance

# Stop CardMint
pkill -f "tsx watch"
```

### Phase 3: Full Integration
```bash
# Complete test suite (when implemented)
npm run test:controller:full
```

## Test Results Analysis

### Port Resilience Results
Check test results directory:
```bash
ls -la ./test-results/
cat ./test-results/startup-E.log  # Worst case scenario
```

**Success Indicators**:
- `✅ System started successfully`
- `✅ Port fallback detected`
- `✅ API health endpoint accessible`

### WebSocket Discovery Results
Console output shows:
```
✅ Normal Connection: WebSocket connected to ws://localhost:3001
✅ Fallback Discovery: WebSocket connected to ws://localhost:3002
✅ Port Discovery: WebSocket connected to ws://localhost:3001
```

### Performance Results
Review generated report:
```bash
cat ./performance-logs/performance_report_TIMESTAMP.md
```

**Key Metrics**:
- Average CPU Usage
- Memory Usage Patterns  
- Network Connection Stats
- Performance Assessment vs Targets

## Integration with npm Scripts

Add to `package.json`:
```json
{
  "scripts": {
    "test:port-resilience": "./scripts/test-port-resilience.sh",
    "test:websocket-discovery": "node scripts/test-websocket-discovery.js",
    "test:performance": "./scripts/monitor-performance.sh 300",
    "test:performance:quick": "./scripts/monitor-performance.sh 60",
    "test:infrastructure": "npm run test:port-resilience && npm run test:websocket-discovery",
    "test:controller:smoke": "npm run test:controller && npm run test:infrastructure",
    "test:controller:full": "echo 'Full controller test suite - coming soon'"
  }
}
```

## Troubleshooting

### Common Issues

#### Port Resilience Test Fails
```bash
# Check for lingering processes
ps aux | grep -E "(tsx|vite|node)"
pkill -f "tsx watch" && pkill -f "vite"

# Verify ports are free
netstat -tlnp | grep -E ":(3000|3001|5173)"
```

#### WebSocket Discovery Test Fails
```bash
# Install puppeteer if missing
npm install --save-dev puppeteer

# Check browser dependencies (Ubuntu/Debian)
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxss1 \
  libxtst6 \
  xdg-utils
```

#### Performance Monitor Issues
```bash
# Install required tools
sudo apt-get install sysstat iproute2 bc

# Check if tools are available
iostat -V && vmstat -V && pidstat -V
```

### Log Analysis

#### Viewing Test Logs
```bash
# Most recent test results
ls -lt ./test-results/ | head -5

# WebSocket connection logs
grep -i "websocket\|connection" ./test-results/*.log

# Performance summaries
find ./performance-logs -name "*.md" -exec cat {} \;
```

#### Debugging Port Conflicts
```bash
# Find process using specific port
sudo lsof -i :3000
sudo lsof -i :3001

# Kill processes on specific ports
sudo fuser -k 3000/tcp
sudo fuser -k 3001/tcp
```

## Test Development

### Adding New Tests

1. **Create test script** in `scripts/` directory
2. **Make executable**: `chmod +x scripts/your-test.sh`
3. **Add npm script** to `package.json`
4. **Document** in this README
5. **Add to CI pipeline** (when available)

### Test Script Template
```bash
#!/bin/bash
# scripts/test-template.sh

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

cleanup() {
    echo "Cleaning up..."
}

trap cleanup EXIT

main() {
    echo "Starting your test..."
    
    # Test implementation here
    
    log_success "Test completed"
}

main "$@"
```

## CI/CD Integration

### GitHub Actions Workflow
```yaml
name: Infrastructure Tests
on: [push, pull_request]

jobs:
  test-infrastructure:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'
      - name: Install dependencies  
        run: npm ci
      - name: Install system dependencies
        run: sudo apt-get install -y sysstat iproute2 bc
      - name: Run port resilience test
        run: npm run test:port-resilience
      - name: Run WebSocket discovery test
        run: npm run test:websocket-discovery
      - name: Upload test results
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/
```

## Future Enhancements

### Planned Test Scripts
- `test-controller-hardware.sh` - Hardware-in-the-loop testing
- `test-end-to-end.js` - Complete workflow automation  
- `test-stress.sh` - Load testing and stress scenarios
- `test-recovery.sh` - Failure recovery validation

### Integration Improvements
- Real-time dashboard for test results
- Automated test scheduling
- Performance regression detection
- Test result visualization

## References

- [CardMint Controller Integration Test Plan](../docs/controller-integration-test-plan.md)
- [CardMint Architecture Documentation](../CLAUDE.md)
- [Production Deployment Guide](../docs/deployment.md)

---

*For questions or issues with test scripts, see the troubleshooting section above or check the main project documentation.*