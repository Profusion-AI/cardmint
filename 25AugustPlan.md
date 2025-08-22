# 📅 CardMint Development Plan - Week of August 25-30, 2025

## 🎯 Week Objectives
Transform CardMint into a visual, production-ready card management system with automated storage, web dashboard, and enhanced pricing integration.

## 📊 Current Status
- **Qwen Scanner**: ✅ Operational (10-15s, 95-100% accuracy)
- **Capture System**: ✅ Bulletproof 400ms performance
- **Database**: ✅ SQLite with WAL mode
- **Storage**: 4TB drive mounted at `/mnt/usb_transfer/`
- **Network**: Fedora (10.0.24.177) ↔ Mac (10.0.24.174)

## 1️⃣ Web Dashboard System (Priority: HIGH)

### Overview
Real-time visual card management interface running on Fedora for organizing and processing 10,000+ cards.

### Architecture
```
Frontend (React SPA)
├── Card Grid View (thumbnails)
├── Real-time WebSocket updates
├── Card Detail Modal
├── Collection Management
└── Export Tools

Backend (Node.js Extension)
├── Image Resizing Service
├── WebSocket Server (port 3001)
├── REST API (port 3000)
└── Static File Server
```

### Image Pipeline Strategy
| Use Case | Resolution | File Size | Location | Purpose |
|----------|-----------|-----------|----------|---------|
| Original | 6000x4000 (26MP) | ~11MB | `/captures/` → `/mnt/usb_transfer/` | Archive |
| Dashboard | 800x533 | ~150KB | `/web/thumbnails/` | UI Display |
| Qwen VLM | 1280x853 | ~400KB | `/scans/` | ML Processing |
| Grid Thumb | 200x133 | ~20KB | `/web/cache/` | Fast Loading |

### Implementation Tasks
1. Create `/src/web/` directory structure
2. Set up React with TypeScript
3. Implement Sharp.js image processor
4. Build card grid interface
5. Add WebSocket live updates
6. Create detail view modal
7. Add collection grouping

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

## 📅 Daily Schedule

### Monday, August 26
- [x] Create this plan document
- [ ] Image resizing tests with Qwen
- [ ] Set up web dashboard structure
- [ ] Create Sharp.js service

### Tuesday, August 27
- [ ] Build React dashboard UI
- [ ] Implement WebSocket updates
- [ ] Create thumbnail generator
- [ ] Test storage archive script

### Wednesday, August 28
- [ ] Deploy database enhancements
- [ ] Add pricing tables
- [ ] Implement API cache
- [ ] Create collection management

### Thursday, August 29
- [ ] Integrate PriceCharting updates
- [ ] Handle Pokemon TCG rate limits
- [ ] Add batch processing queue
- [ ] Test with 100+ cards

### Friday, August 30
- [ ] Performance optimization
- [ ] Load testing dashboard
- [ ] Documentation updates
- [ ] Prepare for 10,000 card processing

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

- [ ] Visual dashboard operational
- [ ] Automated storage working
- [ ] Pricing data integrated
- [ ] 100+ cards processed successfully
- [ ] All systems stable for scale

---

**Last Updated**: August 22, 2025
**Target Completion**: August 30, 2025
**Status**: PLANNED