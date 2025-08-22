# 🎯 CardMint Verification Workflow Design

## Executive Summary
A dual-pane dashboard showing real-time captures and Qwen processing queue with manual verification before database commit. Batch verification every 10-15 cards for efficient physical inventory management.

## 🖥️ Dashboard Layout Design

### Two-Pane Interface
```
┌─────────────────────────────────────────────────────────────┐
│                    CardMint Scanner Dashboard                │
├──────────────────────────┬──────────────────────────────────┤
│     CAPTURE PANE (40%)   │    VERIFICATION QUEUE (60%)      │
├──────────────────────────┼──────────────────────────────────┤
│                          │  ┌─────────────────────────────┐ │
│   [Latest Capture]       │  │ Card 1 of 12 pending        │ │
│   DSC00245.JPG          │  ├─────────────────────────────┤ │
│   ┌──────────────┐      │  │ [Qwen Result]               │ │
│   │              │      │  │ Name: Charizard             │ │
│   │   Card       │      │  │ Set: Base Set               │ │
│   │   Image      │      │  │ Number: 4/102               │ │
│   │              │      │  │ Rarity: Holo Rare           │ │
│   │              │      │  │ Variants: [Shadowless]      │ │
│   └──────────────┘      │  │ Confidence: 94%             │ │
│                          │  ├─────────────────────────────┤ │
│   Captured: 2s ago      │  │ [✓ Approve] [✗ Reject]      │ │
│   Status: Queued        │  │ [🔄 Reprocess] [✏️ Edit]    │ │
│                          │  └─────────────────────────────┘ │
│   ┌──────────────┐      │                                   │
│   │  Previous    │      │  Queue: [1][2][3][4][5]...[12] │
│   │  Captures    │      │  Approved Today: 847/859       │
│   └──────────────┘      │  Scan Group: 2025-09-01-AM-03   │
└──────────────────────────┴──────────────────────────────────┘
```

## 📊 Database Schema Enhancements

### New Verification Tables

```sql
-- Scanning sessions for physical grouping
CREATE TABLE IF NOT EXISTS scan_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id VARCHAR(50) UNIQUE NOT NULL, -- 2025-09-01-AM-03
  start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP,
  cards_scanned INTEGER DEFAULT 0,
  cards_verified INTEGER DEFAULT 0,
  cards_rejected INTEGER DEFAULT 0,
  operator_notes TEXT,
  physical_location VARCHAR(255) -- "Box 23, Rows 1-3"
);

-- Verification queue with staging data
CREATE TABLE IF NOT EXISTS verification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_path TEXT NOT NULL,
  thumbnail_path TEXT,
  capture_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  qwen_result JSON,
  qwen_confidence FLOAT,
  processing_time_ms INTEGER,
  status VARCHAR(20) DEFAULT 'pending', -- pending/approved/rejected/reprocess
  session_id VARCHAR(50),
  sequence_number INTEGER, -- order within session
  operator_action VARCHAR(20), -- approve/reject/edit
  operator_time TIMESTAMP,
  edit_history JSON, -- track manual corrections
  FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
);

-- Approved cards (final inventory)
CREATE TABLE IF NOT EXISTS verified_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Card identification
  name VARCHAR(255) NOT NULL,
  set_name VARCHAR(255),
  card_number VARCHAR(50),
  rarity VARCHAR(50),
  hp VARCHAR(20),
  pokemon_type VARCHAR(50),
  
  -- Variants and condition
  is_first_edition BOOLEAN DEFAULT 0,
  is_shadowless BOOLEAN DEFAULT 0,
  is_holo BOOLEAN DEFAULT 0,
  is_reverse_holo BOOLEAN DEFAULT 0,
  condition_grade VARCHAR(20), -- mint/near-mint/played/poor
  
  -- Verification metadata
  verification_id INTEGER,
  session_id VARCHAR(50),
  verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  qwen_confidence FLOAT,
  manual_edits JSON,
  
  -- Physical tracking
  physical_location VARCHAR(255),
  scan_group_label VARCHAR(50), -- matches physical divider
  box_number INTEGER,
  position_in_box INTEGER,
  
  -- Images
  original_image_path TEXT,
  archive_path TEXT,
  thumbnail_path TEXT,
  
  -- Pricing (updated async)
  price_data JSON,
  last_price_update TIMESTAMP,
  
  FOREIGN KEY (verification_id) REFERENCES verification_queue(id),
  FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
);

-- Edit tracking for learning
CREATE TABLE IF NOT EXISTS verification_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER,
  field_name VARCHAR(50),
  original_value TEXT,
  corrected_value TEXT,
  edit_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason VARCHAR(255),
  FOREIGN KEY (card_id) REFERENCES verification_queue(id)
);

-- Physical inventory mapping
CREATE TABLE IF NOT EXISTS physical_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_date DATE,
  session_id VARCHAR(50),
  box_label VARCHAR(50), -- "Box 2025-09-01"
  divider_label VARCHAR(50), -- "AM Session 1"
  card_count INTEGER,
  start_sequence INTEGER,
  end_sequence INTEGER,
  storage_location VARCHAR(255), -- "Shelf A, Position 3"
  notes TEXT,
  FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
);
```

## 🔄 Workflow Implementation

### Scanning Flow

```javascript
// Core workflow manager
class VerificationWorkflow {
  constructor() {
    this.currentSession = null;
    this.pendingQueue = [];
    this.batchSize = 15; // cards before verification
    this.autoSaveInterval = 30000; // 30 seconds
  }
  
  async startSession() {
    const sessionId = this.generateSessionId(); // 2025-09-01-AM-03
    this.currentSession = await db.createSession(sessionId);
    return sessionId;
  }
  
  async onCapture(imagePath) {
    // 1. Add to capture pane immediately
    dashboard.showLatestCapture(imagePath);
    
    // 2. Queue for Qwen processing
    const queueItem = await db.addToQueue({
      image_path: imagePath,
      session_id: this.currentSession.id,
      sequence_number: this.getNextSequence()
    });
    
    // 3. Send to Qwen (async)
    this.processWithQwen(queueItem);
    
    // 4. Update counter
    dashboard.updateCaptureCount(this.currentSession.cards_scanned++);
  }
  
  async processWithQwen(queueItem) {
    // Process with optimal 1280px resolution
    const result = await qwenService.process(queueItem.image_path);
    
    // Update queue with results
    await db.updateQueue(queueItem.id, {
      qwen_result: result,
      qwen_confidence: result.confidence,
      status: 'pending'
    });
    
    // Add to verification pane
    dashboard.addToVerificationQueue(queueItem);
    
    // Alert if batch ready
    if (this.pendingQueue.length >= this.batchSize) {
      dashboard.showBatchReadyAlert();
    }
  }
  
  async approveCard(queueId, edits = null) {
    const queueItem = await db.getQueueItem(queueId);
    
    // Create verified card record
    const verifiedCard = await db.createVerifiedCard({
      ...queueItem.qwen_result,
      ...edits, // manual corrections
      verification_id: queueId,
      session_id: this.currentSession.id,
      physical_location: this.getCurrentBoxLocation()
    });
    
    // Update queue status
    await db.updateQueue(queueId, {
      status: 'approved',
      operator_action: 'approve',
      operator_time: new Date()
    });
    
    // Track edits for ML improvement
    if (edits) {
      await this.trackEdits(queueId, edits);
    }
    
    // Update dashboard
    dashboard.moveToApproved(queueId);
    this.updateStats();
  }
  
  getCurrentBoxLocation() {
    const session = this.currentSession;
    return {
      box_label: `Box ${session.scan_date}`,
      divider: `${session.period}-${session.batch}`,
      position: session.cards_verified + 1
    };
  }
}
```

## 🎨 UI Components

### React Dashboard Components

```typescript
// Main dashboard container
export const ScannerDashboard: React.FC = () => {
  const [latestCapture, setLatestCapture] = useState<Capture | null>(null);
  const [verificationQueue, setQueue] = useState<QueueItem[]>([]);
  const [currentCard, setCurrentCard] = useState<QueueItem | null>(null);
  const [stats, setStats] = useState<SessionStats>({});
  
  return (
    <div className="dashboard-grid">
      <CapturePane 
        capture={latestCapture}
        recentCaptures={recentCaptures}
      />
      <VerificationPane
        queue={verificationQueue}
        currentCard={currentCard}
        onApprove={handleApprove}
        onReject={handleReject}
        onEdit={handleEdit}
      />
      <StatusBar stats={stats} />
    </div>
  );
};

// Verification card component
export const VerificationCard: React.FC<{card: QueueItem}> = ({card}) => {
  const [edits, setEdits] = useState({});
  const [showEdit, setShowEdit] = useState(false);
  
  return (
    <div className="verification-card">
      <div className="card-images">
        <img src={card.thumbnail_path} className="card-thumb" />
        <img src={card.qwen_result.reference_image} className="reference" />
      </div>
      
      <div className="card-details">
        <EditableField 
          label="Name" 
          value={card.qwen_result.name}
          onChange={(v) => setEdits({...edits, name: v})}
        />
        <EditableField 
          label="Set" 
          value={card.qwen_result.set_name}
        />
        <EditableField 
          label="Number" 
          value={card.qwen_result.card_number}
        />
        <div className="variants">
          <Checkbox label="1st Edition" checked={card.qwen_result.is_first_edition} />
          <Checkbox label="Shadowless" checked={card.qwen_result.is_shadowless} />
          <Checkbox label="Holo" checked={card.qwen_result.is_holo} />
        </div>
        <ConfidenceBar value={card.qwen_confidence} />
      </div>
      
      <div className="actions">
        <button className="approve" onClick={() => onApprove(card.id, edits)}>
          ✓ Approve
        </button>
        <button className="reject" onClick={() => onReject(card.id)}>
          ✗ Reject
        </button>
        <button className="edit" onClick={() => setShowEdit(true)}>
          ✏️ Edit
        </button>
        <button className="reprocess" onClick={() => onReprocess(card.id)}>
          🔄 Reprocess
        </button>
      </div>
    </div>
  );
};
```

## 📦 Physical Organization System

### Batch Labeling Strategy

```
Physical Storage Layout:
========================
Box: 2025-09-01
├── Divider: AM-01 (cards 1-50)
├── Divider: AM-02 (cards 51-100)
├── Divider: AM-03 (cards 101-150)
└── Divider: PM-01 (cards 151-200)

Box: 2025-09-02
├── Divider: AM-01 (cards 201-250)
└── ...
```

### Label Generation

```javascript
class PhysicalInventoryManager {
  generateLabels(session) {
    return {
      boxLabel: `Box ${session.scan_date}`,
      dividerLabel: `${session.period}-${Math.ceil(session.sequence / 50)}`,
      cardRange: `${session.start_seq}-${session.end_seq}`,
      qrCode: this.generateQR(session.id)
    };
  }
  
  printBatchLabels() {
    // Generate PDF with labels
    const labels = this.generateLabels(this.currentSession);
    
    return {
      boxLabel: labels.boxLabel,
      dividers: labels.dividers,
      manifest: this.generateManifest()
    };
  }
  
  generateManifest() {
    // CSV/PDF of cards in this batch
    return db.getSessionCards(this.currentSession.id)
      .map(card => ({
        position: card.position_in_box,
        name: card.name,
        set: card.set_name,
        number: card.card_number,
        value: card.estimated_value
      }));
  }
}
```

## 🚀 Quick Actions & Keyboard Shortcuts

### Efficiency Features

```javascript
// Keyboard shortcuts
const shortcuts = {
  'Space': 'Capture next card',
  'Enter': 'Approve current',
  'Delete': 'Reject current',
  'E': 'Edit mode',
  'R': 'Reprocess',
  'Tab': 'Next in queue',
  'Shift+Tab': 'Previous in queue',
  'Ctrl+S': 'Save session',
  'Ctrl+P': 'Print labels',
  'B': 'Mark batch complete'
};

// Batch operations
class BatchOperations {
  async approveAll() {
    // Approve all with confidence > 90%
    const highConfidence = this.queue.filter(c => c.confidence > 0.9);
    for (const card of highConfidence) {
      await this.approve(card.id);
    }
  }
  
  async flagLowConfidence() {
    // Flag for review
    const lowConfidence = this.queue.filter(c => c.confidence < 0.7);
    lowConfidence.forEach(c => c.flagForReview = true);
  }
}
```

## 📈 Analytics & Learning

### Track Corrections for ML Improvement

```sql
-- Common corrections view
CREATE VIEW common_corrections AS
SELECT 
  field_name,
  original_value,
  corrected_value,
  COUNT(*) as frequency
FROM verification_edits
GROUP BY field_name, original_value, corrected_value
ORDER BY frequency DESC;

-- Accuracy by session
CREATE VIEW session_accuracy AS
SELECT 
  session_id,
  AVG(qwen_confidence) as avg_confidence,
  COUNT(*) as total_cards,
  SUM(CASE WHEN manual_edits IS NOT NULL THEN 1 ELSE 0 END) as cards_edited,
  ROUND(100.0 * SUM(CASE WHEN manual_edits IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as accuracy_rate
FROM verified_cards
GROUP BY session_id;
```

## 🎯 Optimized Workflow Timeline

### Typical 15-Card Batch Cycle

```
Timeline (5 minutes total):
============================
0:00 - Start batch, begin scanning
0:30 - Card 1-5 scanned (30s)
1:00 - Card 6-10 scanned, Qwen processing 1-5
1:30 - Card 11-15 scanned, Qwen processing 6-10
2:00 - Stop scanning, start verification
2:30 - Verify cards 1-5 (30s)
3:00 - Verify cards 6-10 (30s)
3:30 - Verify cards 11-15 (30s)
4:00 - Print batch label
4:30 - Physical placement in box
5:00 - Start next batch
```

## 💡 Additional Features

### Smart Suggestions
- Auto-complete from Pokemon TCG database
- Suggest likely sets based on card design
- Flag potential high-value cards
- Detect common variants automatically

### Quality Checks
- Blur detection on captures
- Duplicate detection
- Missing data warnings
- Condition grading assistance

### Reporting
- Daily scan summary
- Value tracking dashboard
- Collection completeness
- Physical location map

## 🔧 Implementation Priority

### Week 1 (Aug 26-30)
1. **Database schema** - Create verification tables
2. **Basic dashboard** - Two-pane layout
3. **Capture display** - Real-time image updates
4. **Queue system** - Pending verification list
5. **Approval flow** - Basic approve/reject

### Week 2 (Sept 2-6)
1. **Edit interface** - Field corrections
2. **Batch operations** - Multiple card actions
3. **Physical labels** - PDF generation
4. **Session tracking** - Scan groups
5. **Keyboard shortcuts** - Speed improvements

### Week 3 (Sept 9-13)
1. **Analytics** - Accuracy tracking
2. **Smart features** - Auto-suggestions
3. **Quality checks** - Image validation
4. **Export tools** - Inventory reports
5. **Polish** - UI refinements

## 📝 Summary

This verification workflow provides:
- **Visual confirmation** before database commit
- **Batch processing** every 10-15 cards
- **Physical organization** matching digital records
- **Edit tracking** for ML improvement
- **Efficient shortcuts** for speed

The dual-pane dashboard ensures you can maintain high scanning speed while ensuring data quality, with physical inventory perfectly synchronized to your digital records.

---

*Design Date: August 22, 2025*
*Target Implementation: Week of August 26-30*
*Priority: Essential for production scanning*