# CardMint Development Plan v2: Accuracy-First Inventory System

## Executive Summary

CardMint has achieved production-ready camera integration with performance that far exceeds requirements (35ms captures, 1,709 cards/minute). The next phase focuses on building a high-accuracy OCR and inventory management system optimized for 1,000 cards/day with 98%+ text recognition accuracy.

## Revised Requirements

### Volume & Performance
- **Daily Volume**: 1,000 cards/day (125 cards/hour)
- **Work Schedule**: 8-9 hours/day with manual handling
- **Current Performance**: 1,709 cards/minute (855x faster than needed)
- **Conclusion**: Speed is solved; focus on accuracy and inventory features

### Accuracy Goals
- **OCR Accuracy**: 98%+ (critical requirement)
- **Manual Corrections**: <2% of scanned cards
- **Confidence Scoring**: Flag uncertain reads for review
- **Validation**: Cross-reference against card databases

### Future Integration
- **QR Code System**: Unique identifiers per card
- **Batch/Lot Numbers**: For physical organization
- **Raspberry Pi Integration**: Separate system (not in MVP scope)
- **Physical Tracking**: Box location, sleeve position

## Development Phases

### Phase 1: High-Accuracy OCR Pipeline (4-5 days)
**Goal**: Achieve 98%+ OCR accuracy for card text and prepare for QR/batch codes

#### 1.1 PaddleOCR Integration
- Install PaddleOCR with high-accuracy models (not speed-optimized)
- Configure for multiple passes if needed
- Implement confidence scoring
- Add result verification and validation

#### 1.2 Image Preprocessing
- Multi-frame averaging for noise reduction
- Adaptive histogram equalization
- Perspective correction and deskewing
- Super-resolution for text regions
- Edge detection for card boundaries

#### 1.3 OCR Validation Pipeline
- Cross-reference against known card databases
- Fuzzy matching for card names
- Low-confidence flagging system
- Store multiple OCR attempts for comparison
- Manual review queue for edge cases

#### 1.4 QR/Batch Integration Prep
- Database fields for unique identifiers
- API endpoints for Raspberry Pi
- Barcode/QR detection zones
- Batch number generation logic

### Phase 2: Inventory Database Design (3-4 days)
**Goal**: Comprehensive tracking system for physical card organization

#### 2.1 Enhanced Schema Design
```sql
CREATE TABLE inventory_cards (
    -- Identity
    id UUID PRIMARY KEY,
    unique_scan_id VARCHAR(100) UNIQUE,
    qr_code VARCHAR(200),  -- Future Raspberry Pi integration
    batch_number VARCHAR(50),
    
    -- Physical Location
    box_location VARCHAR(100),
    sleeve_position INTEGER,
    storage_unit VARCHAR(50),
    
    -- Card Information
    card_name VARCHAR(200) NOT NULL,
    card_set VARCHAR(100),
    card_number VARCHAR(50),
    card_rarity VARCHAR(50),
    
    -- Quality & Value
    condition_grade VARCHAR(20),
    market_value DECIMAL(10,2),
    last_price_update TIMESTAMP,
    
    -- Acquisition
    acquisition_date DATE,
    acquisition_source VARCHAR(200),
    acquisition_cost DECIMAL(10,2),
    
    -- Scanning Metadata
    scan_sequence INTEGER,
    session_id UUID,
    ocr_confidence DECIMAL(3,2),
    requires_review BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    scanned_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_inventory_batch ON inventory_cards(batch_number);
CREATE INDEX idx_inventory_box ON inventory_cards(box_location);
CREATE INDEX idx_inventory_name ON inventory_cards(card_name);
CREATE INDEX idx_inventory_qr ON inventory_cards(qr_code);
CREATE INDEX idx_inventory_review ON inventory_cards(requires_review) WHERE requires_review = TRUE;
```

#### 2.2 Card Matching & Deduplication
- Fuzzy matching algorithms (Levenshtein distance)
- Track multiple scans of same card
- Link reprints and variants
- Build card condition history
- Duplicate detection and merging

#### 2.3 Batch Processing Workflows
- Session management (morning/afternoon runs)
- Bulk operations (mark as sleeved, boxed, shipped)
- Export formats for inventory spreadsheets
- Label printing integration points
- Batch status tracking

### Phase 3: Quality Assurance System (2-3 days)
**Goal**: Ensure 98%+ accuracy through systematic verification

#### 3.1 Confidence Scoring System
- OCR confidence thresholds (configurable)
- Image quality metrics
- Automatic re-capture triggers
- Manual review queue
- Progressive confidence improvement

#### 3.2 Verification Workflows
- Side-by-side comparison UI
- Keyboard shortcuts for corrections
- Batch verification mode
- Training data collection
- Correction history tracking

#### 3.3 Audit Trail
- Track all corrections
- Identify systematic errors
- Generate accuracy reports
- Monitor accuracy trends
- Export audit logs

### Phase 4: Inventory Management Dashboard (4-5 days)
**Goal**: Practical tools for daily card processing operations

#### 4.1 Session Management
- Start/pause/resume scanning sessions
- Cards scanned per session counter
- Session notes and annotations
- Daily productivity reports
- Break time tracking

#### 4.2 Search & Locate Features
- Find card by name/set/number
- Locate physical position (box/sleeve)
- Batch search for multiple cards
- Visual card grid with thumbnails
- Advanced filtering options

#### 4.3 Export & Reporting
- CSV/Excel export with all fields
- TCGPlayer/CardMarket formats
- Inventory valuation reports
- Collection statistics
- Custom report builder

#### 4.4 Mobile-Friendly Interface
- Responsive design for tablets
- Barcode scanner integration ready
- Quick-add while organizing
- Offline mode support
- Sync when connected

### Phase 5: System Optimization (2-3 days)
**Goal**: Reliability and maintainability (speed already exceeds needs)

#### 5.1 Moderate Optimizations
- Basic PostgreSQL tuning
- Simple Redis caching
- Standard containerization
- Image compression settings
- Backup strategies

#### 5.2 Reliability Features
- Automatic database backups
- Image archive management
- Error recovery procedures
- Session restoration
- Data integrity checks

## Technical Stack

### Core Technologies
- **OCR Engine**: PaddleOCR (high-accuracy models)
- **Image Processing**: OpenCV 4.x (CPU sufficient)
- **Database**: PostgreSQL 16 with JSONB
- **Cache**: Redis for session data
- **Queue**: BullMQ (already implemented)
- **Camera**: Sony SDK (already working)

### Infrastructure
- **Container**: Simple Podman setup
- **Monitoring**: Existing Prometheus/Grafana
- **Storage**: Local filesystem with backups
- **API**: REST + WebSocket (already built)

## Implementation Timeline

### Week 1: OCR Foundation
- Day 1-2: Install and configure PaddleOCR
- Day 2-3: Build image preprocessing pipeline
- Day 3-4: Implement validation system
- Day 4-5: Test and tune for 98% accuracy

### Week 2: Database & QA
- Day 6-7: Design and implement inventory schema
- Day 7-8: Build matching/deduplication
- Day 8-9: Create QA workflows
- Day 9-10: Integration testing

### Week 3: Dashboard & Polish
- Day 11-12: Build dashboard foundation
- Day 12-13: Add search/locate features
- Day 13-14: Export functionality
- Day 14-15: Final testing and documentation

## Success Metrics

### Primary Goals
- ✅ **OCR Accuracy**: 98%+ on card text
- ✅ **Daily Throughput**: Smooth 1,000 cards/day workflow
- ✅ **Physical Tracking**: All cards locatable to box/sleeve
- ✅ **Data Quality**: <2% require manual correction

### Secondary Goals
- ✅ **Session Management**: Natural workflow with breaks
- ✅ **Export Capability**: Multiple format support
- ✅ **API Ready**: Prepared for Raspberry Pi integration
- ✅ **Maintainable**: Simple, documented, testable

## What We're NOT Doing

### Over-optimization (Not Needed)
- ❌ Real-time kernel configuration
- ❌ CPU core isolation
- ❌ Aggressive database tuning
- ❌ Complex caching strategies
- ❌ GPU acceleration

### Complex Infrastructure (Keep Simple)
- ❌ Kubernetes/complex orchestration
- ❌ Blue-green deployment
- ❌ Multi-region setup
- ❌ Load balancing
- ❌ Microservices architecture

## Risk Mitigation

### OCR Accuracy Risks
- **Mitigation**: Multiple models, manual review, continuous improvement
- **Fallback**: Integration with external OCR APIs if needed

### Data Loss Risks
- **Mitigation**: Regular backups, transaction logs, image archives
- **Fallback**: Re-scan capability, session recovery

### Integration Risks
- **Mitigation**: Well-defined APIs, versioning, documentation
- **Fallback**: Manual data entry, CSV import/export

## Next Steps

1. **Immediate** (Today):
   - Install PaddleOCR
   - Set up development environment
   - Create test dataset

2. **Tomorrow**:
   - Build preprocessing pipeline
   - Test OCR accuracy baseline
   - Design database schema

3. **This Week**:
   - Achieve 98% OCR accuracy
   - Implement validation system
   - Deploy inventory schema

## Conclusion

This plan pivots CardMint from a speed-focused system (already achieved) to an accuracy-focused inventory management platform. By prioritizing OCR accuracy, physical tracking, and practical workflows, we'll build a system that handles the real-world requirements of processing 1,000 cards/day with minimal manual intervention.

The modular approach ensures each component can be developed and tested independently, with clear success metrics at each phase. The system is designed to be simple, maintainable, and ready for future QR code integration via Raspberry Pi.

---

*Document Version: 2.0*  
*Created: August 14, 2025*  
*Last Updated: August 14, 2025*