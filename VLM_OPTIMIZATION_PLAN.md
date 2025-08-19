# VLM Optimization Plan for CardMint
*Date: August 19, 2025*

## Executive Summary

This document outlines the complete plan to transform CardMint from an OCR-first architecture (12-17s processing) to a VLM-first architecture targeting <3s processing time on Intel Core i5 10th Gen hardware with integrated UHD Graphics.

## Current State Analysis

### Performance Bottlenecks Identified
- **OCR Processing Time**: 12-17 seconds total
  - Model loading: 6-7 seconds
  - Actual OCR: 5-6 seconds
- **Resource Usage**: 
  - CPU: 747% (all 8 cores at 100%)
  - Memory: 1.5GB peak
  - Threads: 38 concurrent
- **Hardware**: Intel Core i5 10th Gen with Intel UHD Graphics (no discrete GPU)
- **Core Capture**: 400ms (working perfectly, MUST NOT TOUCH)

### OCR Investigation Findings
- PaddleOCR v3.x has significant API changes from v2
- Card name detection failing due to hardcoded y<100 pixel threshold
- Phase 2A smart preprocessing implemented but processing time still excessive
- 12% improvement achieved with detection threshold tuning

## Proposed Architecture: VLM-First with Intel Optimizations

### Core Strategy
1. **Primary**: Vision-Language Model (SmolVLM 500M) for card identification
2. **Secondary**: Lightweight OCR for confirmation only
3. **Intel-Specific**: Leverage IPEX, OpenVINO, and Intel UHD Graphics

### Target Performance
```yaml
Fast Path (70% of cards): 500ms
Medium Path (20% of cards): 1.3s
Slow Path (10% of cards): 4-5s
Average: ~1.06s per card
```

## Implementation Phases

### Phase 0: Safety Infrastructure (Week 0)
**Critical - Do First**

1. **Complete System Backup**
   ```bash
   tar -czf CardMint-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
     --exclude=node_modules --exclude=dist /home/profusionai/CardMint
   ```

2. **Feature Flag System**
   - Create `src/config/features.ts` with rollout controls
   - Environment-based feature toggles
   - Percentage-based gradual rollout (1% → 5% → 20% → 50% → 100%)

3. **Performance Baseline**
   - Record current OCR performance on 100 test cards
   - Document memory usage patterns
   - Create rollback scripts

4. **Emergency Rollback**
   - One-command rollback capability
   - Automatic rollback on performance degradation
   - Health monitoring with thresholds

### Phase 1: Intel Foundation (Week 1)

1. **Install Intel Optimizations**
   ```bash
   pip install intel-extension-for-pytorch
   pip install openvino-dev
   pip install neural-compressor
   ```

2. **Create Intel-Optimized Model Manager**
   - File: `src/ml/model_manager_intel.py`
   - Intel MKL-DNN optimizations
   - Thread tuning for i5 10th gen (4 physical cores)
   - BFloat16 support detection

3. **Hot Model Architecture**
   - Keep models permanently loaded (no lazy loading)
   - Avoid 6-7s model loading penalty on each card
   - Memory-mapped model storage to reduce RAM usage

### Phase 2: Model Optimization (Week 2)

1. **SmolVLM Integration**
   - 500M parameter model (2GB memory)
   - Pokemon-specific prompting
   - INT8 quantization for 2-4x speedup

2. **OpenVINO Conversion**
   - Convert PyTorch models to OpenVINO IR format
   - Enable FP16 precision for Intel UHD Graphics
   - Multi-device inference (CPU + iGPU)

3. **OCR Optimization**
   - Switch from PaddleOCR server to mobile models
   - PP-OCRv4 mobile (50MB vs 135MB)
   - Region-targeted OCR (only scan VLM-identified areas)

### Phase 3: Pipeline Integration (Week 3)

1. **Hybrid Quick-Scan Architecture**
   ```python
   # Processing stages with early exit
   1. Ultra-fast signature check (100ms) - cache hit
   2. Quick OCR name region only (500ms) - 90% confidence
   3. Database fuzzy match (100ms) - known cards
   4. VLM inference (3-4s) - ambiguous cards only
   5. OCR confirmation (1s) - low confidence only
   ```

2. **Shadow Mode Testing**
   - Run VLM in parallel without affecting production
   - Compare results with existing OCR pipeline
   - Collect accuracy and performance metrics

3. **Resource Allocation**
   ```yaml
   CPU Cores:
     VLM: 2 cores
     OCR: 1 core
     System/API: 1 core
   
   Memory:
     VLM (quantized): 1.5GB
     OCR (mobile): 300MB
     Cache: 500MB
     Buffer: 2GB
     Total: ~5GB (safe for 16GB system)
   ```

### Phase 4: Performance Tuning (Week 4)

1. **Intel-Specific Optimizations**
   - Intel UHD Graphics for preprocessing
   - AVX-512 vector instructions
   - Intel QuickSync for image decode (if applicable)

2. **Adaptive Pipeline**
   - Skip VLM for high-confidence quick scans
   - Progressive enhancement based on confidence
   - Smart caching with LRU eviction

3. **Monitoring & Alerting**
   - Real-time performance dashboard
   - Automatic rollback triggers
   - Memory pressure monitoring

## Critical Safety Measures

### Development Pitfalls to Avoid

1. **Model Loading Time Trap**
   - Keep models HOT in memory - no lazy loading
   - First card would be 8-10s with lazy loading

2. **Worker Overload**
   - Use 1-2 workers maximum (not 20)
   - Sequential processing to avoid CPU thrashing

3. **Memory Leaks**
   - Redis with TTL and max memory limits
   - LRU cache eviction policies
   - Monitor memory constantly

4. **API Bottlenecks**
   - 1-second hard timeout on external APIs
   - Background retry queue for failures
   - Cache successful API responses

5. **Integration Risks**
   - Feature flag everything
   - Keep legacy code intact
   - Test in shadow mode first

## Rollout Strategy

### Gradual Deployment
```yaml
Week 1: Shadow mode (0% production impact)
Week 2: 1% of cards use VLM
Week 3: 20% of cards use VLM
Week 4: 100% deployment
Month 2: Optimization and fine-tuning
```

### Success Metrics
- **Processing Time**: <3s VLM + <1s OCR = <4s total
- **Accuracy**: 85%+ card identification
- **Resource Usage**: <5GB RAM, <60% CPU average
- **Throughput**: 10+ cards/minute sustained
- **Core Capture**: 400ms maintained (UNCHANGED)

### Rollback Triggers
- Average processing time >10 seconds
- Memory usage >7GB
- Error rate >5%
- Core capture affected in any way

## File Structure

### New Files to Create
```
src/
├── ml/
│   ├── intel_optimizer.py          # Intel-specific optimizations
│   ├── model_manager_intel.py      # IPEX-optimized model loading
│   ├── memory_optimizer.py         # Memory-mapped models
│   ├── hybrid_intel_scanner.py     # CPU+iGPU pipeline
│   ├── quantization_intel.py       # INT8 quantization
│   └── vlm_service.py              # VLM FastAPI service
├── config/
│   ├── features.ts                 # Feature flags
│   └── intel_resources.py          # Intel resource config
├── processing/
│   ├── VLMProcessor.ts            # VLM integration layer
│   └── IntelOptimizedProcessor.ts # Intel-optimized pipeline
├── monitoring/
│   └── PerformanceMonitor.ts      # Health monitoring
└── utils/
    └── confidenceFusion.ts        # Result combination logic
```

### Modified Files
```
src/
├── ml/
│   └── ensemble.py                # Add VLM to ensemble
├── ocr/
│   └── paddleocr_service.py      # Switch to mobile models
├── processing/
│   └── ImageProcessor.ts         # VLM-first logic
├── queue/
│   └── QueueManager.ts           # Reduce workers to 1-2
└── dashboard/
    └── ensemble-dashboard.html   # VLM UI updates
```

## Commands & Setup

### Installation
```bash
# Intel optimizations
pip install intel-extension-for-pytorch==2.1.0
pip install openvino-dev==2023.3.0
pip install neural-compressor==2.5

# Check Intel GPU
clinfo | grep "Intel"
intel_gpu_top

# Model downloads
huggingface-cli download HuggingFaceTB/SmolVLM-500M-Instruct
```

### Testing
```bash
# Create baseline
python scripts/create-baseline.py

# Test in shadow mode
export VLM_SHADOW_MODE=true
npm run dev

# Gradual rollout
export VLM_ENABLED=true
export VLM_PERCENTAGE=1  # Start with 1%
```

### Emergency Rollback
```bash
# Instant rollback
./scripts/emergency-rollback.sh

# Or manually
export VLM_ENABLED=false
export LEGACY_FALLBACK=true
pm2 restart cardmint
```

## Expected Outcomes

### Week 4 Realistic Targets
- Average processing: 3-5 seconds (down from 12-17s)
- Fast path (70% of cards): 500ms
- Memory usage: ~5GB (well within limits)
- CPU usage: 40-60% average (down from 747%)

### 6-Month Optimization Goals
- Average processing: 1-2 seconds
- Cache hit rate: 30%+
- Quick-scan success: 90%+
- VLM only for truly ambiguous cards

## Risk Mitigation

1. **Performance Degradation**: Automatic rollback at 10s threshold
2. **Memory Pressure**: Model swapping and cache eviction
3. **CPU Saturation**: Dynamic worker scaling
4. **Accuracy Issues**: Manual review queue for low confidence
5. **Core Capture Impact**: Complete isolation maintained

## Conclusion

This plan provides a safe, gradual path from the current 12-17s OCR processing to a target of 1-2s average processing using VLM with Intel optimizations. The approach prioritizes:

1. **Zero production impact** during development
2. **Gradual rollout** with instant rollback capability
3. **Intel-specific optimizations** for maximum performance
4. **Realistic targets** based on actual hardware constraints
5. **Complete protection** of the working 400ms capture system

The combination of SmolVLM, Intel optimizations (IPEX, OpenVINO), and smart pipeline design should achieve the 6-second per card target within 4 weeks, with further optimization possible over time.