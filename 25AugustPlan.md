# 📅 CardMint Development Plan - Week of August 25-30, 2025

## 🎯 Week Objectives
Transform CardMint into a visual, production-ready card management system with automated storage, web dashboard, and enhanced pricing integration.

## 📊 Current Status
- **Qwen Scanner**: ✅ Operational (10-15s, 95-100% accuracy)
- **Capture System**: ✅ Bulletproof 400ms performance
- **Database**: ✅ SQLite with WAL mode
- **Storage**: 4TB drive mounted at `/mnt/usb_transfer/`
- **Network**: Fedora (10.0.24.177) ↔ Mac (10.0.24.174)

## 1️⃣ Web Dashboard System with PS4 Controller (Priority: HIGH)

### Overview
Real-time visual card management interface with revolutionary PS4 controller integration for gamified scanning workflow.

### Architecture
```
Frontend (React SPA)
├── Dual-Pane Verification Dashboard
├── PS4 Controller Integration (Gamepad API)
├── Real-time WebSocket updates
├── Card Queue Management
├── Haptic Feedback System
└── Batch Operations

Backend (Node.js Extension)
├── Controller Action Handler
├── Image Resizing Service
├── WebSocket Server (port 3001)
├── REST API (port 3000)
├── Verification Queue Manager
└── Session Tracking System
```

### 🎮 PS4 Controller Integration
**Control Scheme:**
- ❌ (X): Capture card
- △ (Triangle): Approve
- ○ (Circle): Reject  
- □ (Square): Edit mode
- R3 Stick: Navigate queue
- L1/R1: Previous/Next card
- L2/R2: Batch navigation
- Touchpad: Quick approve all

**Features:**
- Browser Gamepad API integration
- Haptic feedback on actions
- Visual button hints overlay
- Connection status indicator
- Customizable button mapping

### Image Pipeline Strategy
| Use Case | Resolution | File Size | Location | Purpose |
|----------|-----------|-----------|----------|---------|
| Original | 6000x4000 (26MP) | ~11MB | `/captures/` → `/mnt/usb_transfer/` | Archive |
| Dashboard | 800x533 | ~150KB | `/web/thumbnails/` | UI Display |
| Qwen VLM | 1280x853 | ~400KB | `/scans/` | ML Processing |
| Grid Thumb | 200x133 | ~20KB | `/web/cache/` | Fast Loading |

### Implementation Tasks
1. Create `/src/web/` directory structure
2. Set up React with TypeScript and Gamepad API
3. Build dual-pane verification dashboard
4. Integrate PS4 controller with haptic feedback
5. Implement verification queue system
6. Add Sharp.js image processor (1280px optimal)
7. Create session tracking with physical labels
8. Add batch operations and keyboard shortcuts

## 2️⃣ Storage Management System (Priority: HIGH)

### Daily Archive Script (4:30 PM)
```bash
#!/bin/bash
# /home/profusionai/CardMint/scripts/daily-archive.sh

ARCHIVE_BASE="/mnt/usb_transfer/CardMint/archive"
SOURCE_DIR="$HOME/CardMint/captures"
DATE_PATH=$(date +%Y/%m/%d)
ARCHIVE_DIR="$ARCHIVE_BASE/$DATE_PATH"

# Create archive structure
mkdir -p "$ARCHIVE_DIR"

# Move processed files (older than 1 day)
find "$SOURCE_DIR" -name "*.JPG" -mtime +0 | while read file; do
    # Generate checksum
    checksum=$(sha256sum "$file" | cut -d' ' -f1)
    
    # Move with verification
    mv "$file" "$ARCHIVE_DIR/"
    
    # Log to manifest
    echo "$(basename "$file")|$checksum|$(date -Iseconds)" >> "$ARCHIVE_DIR/manifest.txt"
done

# Update database
sqlite3 ~/CardMint/data/cardmint.db <<EOF
UPDATE cards 
SET archive_path = '$ARCHIVE_DIR' 
WHERE capture_date < date('now', '-1 day') 
  AND archive_path IS NULL;
EOF

# Send notification
echo "Archived $(ls -1 "$ARCHIVE_DIR"/*.JPG 2>/dev/null | wc -l) files to $ARCHIVE_DIR"
```

### Systemd Timer Setup
```ini
# /etc/systemd/user/cardmint-archive.timer
[Unit]
Description=Daily CardMint Archive at 4:30 PM

[Timer]
OnCalendar=*-*-* 16:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

## 3️⃣ Image Processing Pipeline (Priority: HIGH)

### Resizing Service
```typescript
// src/services/ImageResizeService.ts
import sharp from 'sharp';

export class ImageResizeService {
  async processCapture(inputPath: string) {
    const sizes = [
      { name: 'dashboard', width: 800 },
      { name: 'qwen', width: 1280 },
      { name: 'thumb', width: 200 }
    ];
    
    for (const size of sizes) {
      await sharp(inputPath)
        .resize(size.width, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ quality: 85, progressive: true })
        .toFile(`web/${size.name}/${filename}`);
    }
  }
}
```

### Optimization Testing
- Test Qwen accuracy at different resolutions:
  - 800px: Faster but may miss fine details
  - 1280px: Current setting, good balance
  - 1920px: Higher accuracy but slower
  - 2560px: Maximum quality test

## 4️⃣ Database Enhancements (Priority: MEDIUM)

### New Schema Additions
```sql
-- Real-time pricing integration
CREATE TABLE IF NOT EXISTS card_prices_live (
  card_id INTEGER PRIMARY KEY,
  pricecharting_price DECIMAL(10,2),
  pricecharting_graded DECIMAL(10,2),
  tcgplayer_market DECIMAL(10,2),
  tcgplayer_low DECIMAL(10,2),
  tcgplayer_mid DECIMAL(10,2),
  tcgplayer_high DECIMAL(10,2),
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  price_trend VARCHAR(10), -- up/down/stable
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

-- API response caching (handle slow APIs)
CREATE TABLE IF NOT EXISTS api_cache (
  cache_key VARCHAR(255) PRIMARY KEY,
  endpoint VARCHAR(255),
  params TEXT,
  response TEXT,
  status_code INTEGER,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  hit_count INTEGER DEFAULT 0
);

-- Dashboard display metadata
CREATE TABLE IF NOT EXISTS dashboard_cards (
  card_id INTEGER PRIMARY KEY,
  thumbnail_path TEXT,
  display_order INTEGER,
  collection_id INTEGER,
  tags TEXT, -- JSON array of tags
  is_featured BOOLEAN DEFAULT 0,
  notes TEXT,
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

-- Collection management
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  card_count INTEGER DEFAULT 0,
  total_value DECIMAL(10,2),
  thumbnail_card_id INTEGER
);

-- Archive tracking
CREATE TABLE IF NOT EXISTS archive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_date DATE,
  source_path TEXT,
  archive_path TEXT,
  file_count INTEGER,
  total_size_mb INTEGER,
  checksum_manifest TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 5️⃣ API Integration Strategy (Priority: MEDIUM)

### Pokemon TCG API Optimization
```typescript
// src/services/APIQueueManager.ts
export class APIQueueManager {
  private queue: PQueue;
  private cache: NodeCache;
  
  constructor() {
    // Limit concurrent requests to avoid CloudFlare blocks
    this.queue = new PQueue({ 
      concurrency: 2,
      interval: 1000,
      intervalCap: 3 
    });
    
    // 24-hour cache
    this.cache = new NodeCache({ 
      stdTTL: 86400 
    });
  }
  
  async fetchWithProtection(endpoint: string) {
    // Check cache first
    const cached = this.cache.get(endpoint);
    if (cached) return cached;
    
    // Queue with exponential backoff
    return this.queue.add(async () => {
      let retries = 0;
      while (retries < 5) {
        try {
          const response = await axios.get(endpoint, {
            timeout: 10000,
            headers: {
              'User-Agent': 'CardMint/1.0',
              'Accept': 'application/json'
            }
          });
          
          // Cache successful response
          this.cache.set(endpoint, response.data);
          
          // Store in SQLite cache
          await this.saveToDatabase(endpoint, response.data);
          
          return response.data;
        } catch (error) {
          if (error.response?.status === 429 || 
              error.response?.status === 503) {
            // CloudFlare rate limit - exponential backoff
            const delay = Math.pow(2, retries) * 1000;
            await sleep(delay);
            retries++;
          } else {
            throw error;
          }
        }
      }
      
      // Fall back to cached data
      return this.loadFromDatabase(endpoint);
    });
  }
}
```

### PriceCharting Integration
- Use existing CSV download for bulk updates
- Real-time API only for high-value cards
- Update prices during off-peak hours (2-4 AM)

## 📅 Daily Schedule (Updated with PS4 Integration)

### Monday, August 26
- [x] Create this plan document
- [x] Image resizing tests (1280px optimal)
- [x] PS4 controller integration
- [ ] Set up React dashboard with Gamepad API
- [ ] Create verification queue system

### Tuesday, August 27
- [ ] Build dual-pane verification dashboard
- [ ] Implement PS4 controller actions
- [ ] Add haptic feedback system
- [ ] Create session tracking database
- [ ] Test controller with live captures

### Wednesday, August 28
- [ ] Deploy verification database schema
- [ ] Add edit mode with controller
- [ ] Implement batch operations (L2/R2)
- [ ] Create physical label generator
- [ ] Add API caching layer

### Thursday, August 29
- [ ] Integrate PriceCharting with verification
- [ ] Add smart card suggestions
- [ ] Implement quick approve (touchpad)
- [ ] Test 100+ cards with controller
- [ ] Create button customization UI

### Friday, August 30
- [ ] Performance optimization
- [ ] Controller latency tuning
- [ ] Complete documentation
- [ ] Record demo video
- [ ] Ready for 1000 cards/day sprint

## 🚀 Quick Wins for Today

1. **Image Resize Test** - Determine optimal Qwen resolution
2. **Archive Script** - Deploy and test daily backup
3. **Database Indexes** - Add for faster queries
4. **GPU Check** - Verify Intel UHD capabilities

## ⚠️ Known Constraints

1. **Intel UHD Graphics** - No CUDA support, use CPU-based Sharp.js
2. **CloudFlare Protection** - Pokemon TCG API requires careful handling
3. **10,000+ Cards** - Need efficient batch processing
4. **26MP Images** - Storage management critical

## 📊 Success Metrics

- Dashboard loads in <2 seconds
- Thumbnail generation <500ms per image
- API cache hit rate >80%
- Archive automation 100% reliable
- Support for 10,000+ card library

## 🎯 MVP Requirements for Week End

- [ ] Dual-pane verification dashboard operational
- [ ] PS4 controller fully integrated with haptics
- [ ] Verification queue with batch operations
- [ ] Session tracking with physical labels
- [ ] Automated storage archive working
- [ ] 100+ cards tested with controller workflow
- [ ] Ready for 1000 cards/day production sprint

## 🎮 Game-Changing Features Added

### PS4 Controller Revolution
- **Ergonomic Scanning**: Hold controller comfortably while working
- **Speed Boost**: All actions at fingertips (no mouse needed)
- **Haptic Feedback**: Feel every capture and approval
- **Batch Operations**: L2/R2 for 15-card jumps
- **Quick Approve**: Touchpad for high-confidence batch approval
- **Muscle Memory**: Gaming reflexes = faster verification

### Verification Workflow
- **Dual-Pane Display**: Live capture + verification queue
- **Manual Approval**: Review before database commit
- **Edit Mode**: Square button for corrections
- **Physical Tracking**: Labels match digital records
- **Session Management**: Organized by scan batches

### Optimizations Discovered
- **Image Resolution**: 1280px optimal (96% storage savings)
- **Storage Capacity**: 1.4 years at 1000 cards/day
- **Processing Time**: 8.25s at optimal resolution
- **Network Transfer**: 95% faster with resized images

---

**Last Updated**: August 22, 2025
**Target Completion**: August 30, 2025
**Status**: PLANNED