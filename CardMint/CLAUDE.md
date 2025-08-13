# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the CardMint project.

## Project Overview

CardMint is a high-performance card scanning and processing system designed to achieve sub-500ms response times and 60+ cards/minute throughput on Fedora 42 Workstation. The system processes trading cards or similar items with real-time image capture, OCR, and metadata extraction.

## Performance Requirements

### Critical Targets
- **Response time**: <500ms per card (targeting <200ms)
- **Throughput**: Minimum 60 cards/minute (targeting 80+)
- **Memory usage**: Keep heap under 2GB
- **CPU utilization**: <60% on isolated cores
- **System availability**: 99.9% uptime with automatic recovery

## Architecture Overview

### Core Components (To Be Implemented)

**Camera Pipeline**:
- V4L2 zero-copy buffer management
- OpenCV GPU acceleration for image processing
- PaddleOCR for text extraction
- Triple buffering for continuous capture

**Processing Queue**:
- BullMQ with Redis streams for job persistence
- 20 concurrent workers with rate limiting
- Exponential backoff retry logic

**Real-time Communication**:
- uWebSockets.js for dashboard streaming
- Binary message support for image previews
- Sub-20ms WebSocket latency

**Data Storage**:
- PostgreSQL 16 with optimized WAL settings
- Hybrid schema: normalized columns + JSONB metadata
- BRIN indexes for time-series data
- Redis caching with write-behind patterns

### System Optimization

**Fedora 42 Real-time Kernel**:
- PREEMPT_RT support for deterministic latencies
- CPU core isolation: `isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7`
- Performance CPU governor
- Disabled security mitigations for maximum performance

**Containerization**:
- Podman 5.x rootless containers
- Hardware device access preservation
- Blue-green deployment with systemd integration
- Zero-downtime updates

## Development Workflow

### Build Commands (To Be Defined)
```bash
# Development build
npm run dev

# Production build  
npm run build

# Run tests
npm test

# Performance profiling
npm run profile

# Camera setup
npm run camera-setup

# Debug pipeline
npm run debug-pipeline
```

### Hardware Integration
- Camera initialization in dedicated worker thread
- V4L2 configuration for 60fps MJPG capture
- GPU acceleration via CUDA (where available)
- USB memory buffer optimization

### Monitoring and Observability
- OpenTelemetry instrumentation
- Grafana dashboards for real-time metrics
- Pyroscope continuous profiling
- Multi-burn rate alerting

## Key Performance Metrics

**Latency Breakdown (Target)**:
- Camera capture: 16ms
- GPU processing: 45ms  
- OCR extraction: 120ms
- Total pipeline: ~180ms (well under 500ms target)

**Throughput Metrics**:
- `cards_processed_total`: Counter for throughput validation
- `capture_response_seconds_bucket`: P95 latency histogram
- `queue_depth_current`: Backpressure detection
- `worker_utilization_percentage`: Scaling indicators

## Technology Stack

**Backend**:
- Node.js with TypeScript
- BullMQ for job processing
- Redis for caching and streams
- PostgreSQL 16 for persistent storage

**Image Processing**:
- OpenCV with GPU acceleration
- PaddleOCR for text recognition
- V4L2 for camera control

**Frontend/Dashboard**:
- uWebSockets.js for real-time communication
- Binary WebSocket for image streaming

**Infrastructure**:
- Podman containers
- systemd for service management  
- OpenTelemetry for observability
- Grafana + Prometheus for monitoring

## Implementation Phases

### Phase 1: Foundation
- Camera pipeline setup with V4L2
- Basic image capture and processing
- PostgreSQL schema design
- Redis configuration

### Phase 2: Processing Engine  
- BullMQ job queue implementation
- OpenCV image processing pipeline
- PaddleOCR integration
- Basic performance optimization

### Phase 3: Real-time Features
- uWebSockets.js dashboard
- Live image streaming
- Real-time metrics collection
- Performance monitoring

### Phase 4: Production Optimization
- Kernel optimization deployment
- Container orchestration
- Advanced monitoring setup  
- Performance tuning and validation

## Hardware Requirements

- Sony camera compatible with Remote SDK (for high-quality capture)
- CUDA-capable GPU (recommended for processing acceleration)
- Minimum 16GB RAM
- NVMe SSD for fast I/O
- USB 3.0+ ports for camera connectivity
- Ethernet for potential network camera integration