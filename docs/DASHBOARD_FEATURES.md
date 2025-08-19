# CardMint Dashboard Features Documentation

## Overview
The CardMint Dashboard is a sophisticated web interface for Pokemon card recognition, providing real-time ML ensemble processing, image preview capabilities, and comprehensive API monitoring tools.

**URL:** http://localhost:8080  
**Hot-reload:** Enabled (automatic refresh on file changes)

## Core Features

### 1. Image Preview System
Enhanced upload experience with full card preview before processing.

#### Features:
- **Full-resolution preview** - Cards displayed with `object-fit: contain` for perfect aspect ratio
- **Image metadata display** - Shows filename, dimensions (e.g., 734×1024), and file size
- **Clear button** - Red × button with hover effects to reset and upload different card
- **Processing overlay** - Dark overlay with spinner shows during ML recognition
- **Smooth animations** - Fade-in effects for polished user experience

#### How It Works:
1. Upload via button click or drag-and-drop
2. Image immediately displays in preview area
3. Metadata calculated and shown above preview
4. Processing overlay appears during recognition
5. Results display on the right side

### 2. API Console Tab
Real-time monitoring of all backend API operations with comprehensive logging.

#### Tab Interface:
- **Recognition Results** (default) - Traditional card detection results view
- **API Console** - Backend API activity monitor with terminal-style interface

#### Console Features:
- **Real-time logging** - All API calls logged with timestamps
- **Color-coded entries:**
  - 🔵 Blue - API requests
  - 🟢 Green - Successful responses (200 status)
  - 🔴 Red - Errors and failures
  - 🟡 Yellow - Warnings (low confidence, API unavailable)
- **Copy to clipboard** - Export entire console log as formatted text
- **Auto-scrolling** - Latest entries appear at top
- **JSON formatting** - Response bodies displayed with syntax highlighting

#### Monitored APIs:
1. **Recognition API** (`POST /api/recognize/lightweight`)
   - Request: filename, size, file type
   - Response: card name, confidence, inference time
   - Warnings: Low confidence alerts (< 70%)

2. **Model Status** (`GET /api/models/status`)
   - Active models list
   - RAM usage (e.g., 350MB / 4000MB)
   - CPU utilization percentage
   - Resource monitoring

3. **Pokemon TCG API** (when available)
   - Validation attempts
   - Success/failure status
   - Market price data
   - Official image URLs

### 3. ML Ensemble Integration
Three-model ensemble architecture for robust card recognition.

#### Active Models:
- **MobileNetV3** - Lightweight CNN for visual features (15MB)
- **ORB Matcher** - Keypoint matching for exact card identification
- **PaddleOCR** - Text extraction for card details

#### Performance Metrics:
- **Inference time:** ~828ms average
- **RAM usage:** 150-200MB for core models
- **Confidence scoring:** Weighted ensemble (ML 40%, API 40%, OCR 20%)

### 4. Validation Pipeline
Multi-stage validation with graceful degradation.

#### Validation Stages:
1. **ML Recognition** - Initial card detection via ensemble
2. **API Validation** - Pokemon TCG API verification (when available)
3. **Confidence Calculation** - Combined scoring from all sources
4. **Review Flagging** - Automatic flagging of low-confidence results

#### Validation Indicators:
- **Pokemon TCG API:** ✅ Validated / ❌ Not Available
- **Market Price:** Shows TCGPlayer pricing when available
- **Official Image:** Indicates availability of official card image
- **Validation Method:** ML Only / ML + API / OCR Validated

## Technical Implementation

### Frontend Architecture
```javascript
// Key Components
- Tab navigation system
- API console logger
- Image preview handler
- WebSocket support (optional)
- Resource monitoring
```

### API Console Logger
```javascript
// Logging function signature
logApiCall(type, method, url, data)

// Entry types
- 'request' - Outgoing API calls
- 'response' - Successful responses
- 'error' - Failed requests
- 'warning' - Low confidence or unavailable services
```

### Console Export Format
```
[timestamp] TYPE: METHOD URL - Status: XXX - Confidence: XX%
Result: {JSON response body}
```

## Usage Examples

### Basic Card Recognition
1. Open dashboard at http://localhost:8080
2. Click "Upload Image" or drag card image
3. View preview with metadata
4. Watch processing animation
5. Review results and confidence scores

### API Monitoring
1. Upload card for processing
2. Click "API Console" tab
3. View real-time API activity:
   - Request details with timestamps
   - Response times and status codes
   - Confidence scores and warnings
4. Click "Copy Console" to export log

### Debugging Low Confidence
1. Check API Console for warnings
2. Review confidence scores in console
3. Verify API availability status
4. Check for network errors in red entries

## Configuration

### Environment Variables
```bash
# API endpoints
API_URL=http://localhost:8000
WS_URL=ws://localhost:3001

# Optional API keys
POKEMONTCG_API_KEY=your_key_here
```

### Dashboard Server
```bash
# Start with hot-reload
cd /home/profusionai/CardMint/src/ml
python dashboard-server.py

# Access points
Dashboard: http://localhost:8080
Hot-reload: Automatic on file changes
```

## Browser Compatibility
- **Chrome/Edge:** Full support
- **Firefox:** Full support
- **Safari:** Full support
- **Mobile:** Responsive design, touch-enabled

## Performance Optimizations
- Lazy loading of images
- DOM virtualization (50 console entries max)
- Debounced resource monitoring (5-second intervals)
- Client-side image preview (no upload for preview)
- Efficient console logging with array management

## Troubleshooting

### Console Not Logging
- Verify API service running on port 8000
- Check browser console for errors
- Ensure correct API_URL in JavaScript

### Preview Not Showing
- Check file type is image/*
- Verify FileReader API support
- Clear browser cache if needed

### Copy to Clipboard Failed
- HTTPS required for clipboard API in production
- Fallback to manual selection if API unavailable
- Check browser permissions

## Future Enhancements
- WebSocket real-time updates
- Historical console persistence
- Advanced filtering options
- Export to CSV/JSON formats
- Performance graphing
- Multi-card batch processing

---

*Last Updated: August 18, 2025*
*Version: 2.0.0 - Enhanced Dashboard with API Console*