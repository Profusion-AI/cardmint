# CardMint E2E Pipeline Integration - August 29, 2025

## 🎯 Executive Summary

**MILESTONE**: Dual LM Studio CLI integration for enhanced verification pipeline  
**IMPLEMENTATION DATE**: August 29, 2025  
**CORE ENHANCEMENT**: GPT-OSS-20B verification layer on Fedora post-vision processing

## 🏗️ Architecture Overview

### Enhanced Pipeline Flow
```
[Card Capture] 
    ↓ (~400ms)
[Sony Camera] 
    ↓ 
[Mac M4 Vision Processing] ← Qwen2.5-VL-7B (10.0.24.174:1234)
    ↓ (2-3s vision inference)
[Fedora Verification Layer] ← GPT-OSS-20B (localhost:41343) **NEW**
    ↓ (50-100ms text verification)
[Confidence Router] → [Database Storage]
```

### Dual LM Studio Configuration

#### **Primary Instance: Mac M4 (Vision)**
- **Endpoint**: `http://10.0.24.174:1234` 
- **Model**: Qwen2.5-VL-7B-Instruct
- **Purpose**: Card image recognition and metadata extraction
- **Performance**: 2-3 seconds per card, 95-100% accuracy
- **Status**: Production-ready, always loaded

#### **Secondary Instance: Fedora (Verification)** 🆕
- **Endpoint**: `http://localhost:41343`
- **Model**: GPT-OSS-20B (downloading as of Aug 29)
- **Purpose**: Validate extracted text data and semantic consistency
- **Performance**: Target 50-100ms response time
- **Management**: CLI-automated via `fedora-verifier.sh`

## 🛠️ Implementation Components

### 1. CLI Management Infrastructure

#### **scripts/lms-manager.sh** - Unified Pipeline Management
- **Purpose**: Orchestrate both Mac and Fedora LM Studio instances
- **Features**: 
  - Health checking both endpoints
  - Model loading/unloading coordination
  - Status monitoring across distributed setup
  - Automated pipeline startup/shutdown

**Key Commands:**
```bash
./scripts/lms-manager.sh start        # Start complete pipeline
./scripts/lms-manager.sh status       # Check both instances
./scripts/lms-manager.sh health       # Perform inference tests
./scripts/lms-manager.sh stop         # Graceful shutdown
```

#### **scripts/fedora-verifier.sh** - Verification Service Manager
- **Purpose**: Dedicated management for GPT-OSS-20B verification
- **Features**:
  - Automated server startup on port 41343
  - Model loading with optimal GPU settings
  - Verification testing and benchmarking
  - Service monitoring and auto-restart

**Key Commands:**
```bash
./scripts/fedora-verifier.sh start      # Start verification service
./scripts/fedora-verifier.sh test       # Run verification tests
./scripts/fedora-verifier.sh benchmark  # Performance validation
./scripts/fedora-verifier.sh monitor    # Continuous monitoring
```

### 2. Verification Integration Points

#### **Enhanced Confidence Router**
The existing `ConfidenceRouter.ts` will be enhanced to include GPT-OSS-20B verification:

**New Verification Rules:**
- ≥90% confidence: Skip verification (fast path maintained)
- 70-89% confidence: Run GPT-OSS-20B verification **NEW**
- <70% confidence: Mandatory verification + human review
- High-value cards: Always verify regardless of confidence

#### **Verification Flow Implementation**
```typescript
// Post-vision processing verification
1. Mac returns: { card_title, identifier, set_name, confidence }
2. If confidence 70-89%: Queue for Fedora verification
3. GPT-OSS-20B validates: semantic consistency, format validation
4. Database cross-check for known discrepancies  
5. Confidence adjustment: -0.2 to +0.1 based on verification
6. Final routing decision: approve/review/reject
```

### 3. Performance Targets

#### **Verification Service SLA**
- **Response Time**: 50-100ms per verification
- **Availability**: 99.5% uptime during scanning sessions
- **Accuracy**: 95%+ agreement with database lookups
- **Throughput**: Support for 60+ cards/minute pipeline

#### **Resource Utilization**
- **GPU**: Auto-allocation via `--gpu=auto`
- **Memory**: ~6-8GB for GPT-OSS-20B (estimates)
- **CPU**: Fedora cores 2-7 for inference
- **TTL**: 1-hour model persistence (`--ttl=3600`)

## 🔧 Technical Configuration

### Environment Variables (Updated .env)
```bash
# LM Studio Dual Instance Configuration
LMSTUDIO_MAC_URL=http://10.0.24.174:1234
LMSTUDIO_MAC_MODEL=qwen2.5-vl-7b-instruct
LMSTUDIO_LOCAL_URL=http://localhost:41343
LMSTUDIO_LOCAL_MODEL=openai/gpt-oss-20b
LMSTUDIO_VERIFIER_ENABLED=true
LMSTUDIO_VERIFIER_THRESHOLD=0.70
LMSTUDIO_VERIFIER_TIMEOUT_MS=2000
```

### CLI Model Loading Commands
```bash
# Mac M4: Vision model (manual setup on Mac terminal)
lms load qwen2.5-vl-7b-instruct --gpu=max --identifier="vision" --host=10.0.24.174

# Fedora: Verification model (automated via scripts)  
lms load openai/gpt-oss-20b --identifier="cardmint-verifier" --gpu=auto --ttl=3600
```

### Service Startup Integration
```bash
# Add to existing startup scripts
./scripts/lms-manager.sh start  # Replaces manual LM Studio management
systemctl --user enable cardmint-verifier.service  # Auto-start on boot
```

## 📊 Monitoring & Observability

### Health Check Integration
```typescript
// New health check endpoints
GET /api/health/lmstudio-mac     → Mac vision model status
GET /api/health/lmstudio-fedora  → Fedora verifier status  
GET /api/health/verification     → End-to-end verification test
```

### Metrics Tracking
- Vision inference latency (Mac)
- Verification response time (Fedora) 
- Agreement rate between models
- Pipeline throughput with verification
- Error rates per instance

### Logging Strategy
- `logs/mac-lmstudio.log` - Mac vision model logs
- `logs/fedora-verifier.log` - Fedora verification logs
- `logs/verification-pipeline.log` - E2E verification decisions

## 🚀 Deployment Strategy

### Phase 1: Foundation (August 29) ✅ COMPLETE
- ✅ CLI management scripts created (`lms-manager.sh`, `fedora-verifier.sh`)
- ✅ Fedora verification service framework implemented
- ✅ Configuration management system (`lmstudio.ts`)
- ✅ Enhanced ConfidenceRouter with GPT-OSS-20B integration
- ✅ FedoraVerificationService TypeScript class implemented
- ✅ Comprehensive test suite created (`test-dual-lmstudio.ts`)
- 🔄 GPT-OSS-20B model download in progress (user-managed)

### Phase 2: Integration (August 30-31)
- ✅ ~~Implement `FedoraVerificationService.ts`~~ (completed ahead of schedule)
- ✅ ~~Enhance `ConfidenceRouter` with verification logic~~ (completed ahead of schedule)
- ✅ ~~Update configuration management~~ (completed ahead of schedule)
- ⏳ End-to-end testing with golden dataset (ready for execution)
- ⏳ Production pipeline integration (ready for deployment)

### Phase 3: Production (September 1)
- Deploy to production pipeline
- Monitor performance metrics
- Optimize verification thresholds
- Documentation and team training

## 🎯 Success Criteria

### Performance Benchmarks
- **Overall pipeline**: <5 seconds per card (including verification)
- **Verification overhead**: <100ms additional latency
- **Accuracy improvement**: 2-5% boost in overall confidence
- **Throughput maintenance**: 60+ cards/minute sustained

### Operational Excellence  
- **Zero-downtime**: Fallback to Mac-only processing if Fedora unavailable
- **Self-healing**: Automatic service restart via monitoring
- **Observability**: Clear metrics on verification effectiveness
- **Maintainability**: CLI-based model management

## 🔒 Risk Mitigation

### Fallback Strategies
1. **Fedora Service Down**: Continue with Mac-only processing
2. **Model Loading Failed**: Retry with exponential backoff  
3. **Verification Timeout**: Default to original confidence score
4. **Resource Exhaustion**: Model TTL ensures memory cleanup

### Performance Safeguards
- Verification queue with circuit breaker
- Timeout enforcement (2s max per verification)
- Resource monitoring and alerting
- Graceful degradation under load

## 📋 Next Steps (Post-August 29)

### Immediate Actions
1. Complete GPT-OSS-20B download and testing
2. Implement TypeScript verification service integration
3. Update CardMint E2E pipeline configuration  
4. Execute golden dataset validation

### Future Enhancements
- Multi-model ensemble verification (Q4 2025)
- Adaptive confidence thresholds based on card type
- Real-time verification performance optimization
- Community model integration support

---

## 📋 Implementation Summary

**MILESTONE ACHIEVED**: All core components implemented ahead of schedule!

### ✅ Completed Components
1. **CLI Management Infrastructure**
   - `scripts/lms-manager.sh` - Unified LM Studio pipeline management
   - `scripts/fedora-verifier.sh` - Dedicated Fedora verification service
   - `scripts/test-dual-lmstudio.ts` - Comprehensive integration testing

2. **TypeScript Integration Layer**
   - `src/services/FedoraVerificationService.ts` - GPT-OSS-20B verification service
   - `src/config/lmstudio.ts` - Dual instance configuration management
   - Enhanced `src/core/verification/ConfidenceRouter.ts` - Intelligent routing

3. **Configuration & Environment**
   - Updated `.env.example` with dual LM Studio settings
   - Comprehensive validation and health checking
   - Fallback strategies for service failures

### 🔄 Ready for Execution
- GPT-OSS-20B model download (user-initiated)
- Service startup via `./scripts/lms-manager.sh start`
- End-to-end testing via `./scripts/test-dual-lmstudio.ts`

---

**Document Version**: 2.0  
**Last Updated**: August 29, 2025, 2:30 PM EST  
**Next Review**: August 30, 2025 (Testing & validation)  
**Status**: 🟢 IMPLEMENTATION COMPLETE - Ready for testing & deployment
