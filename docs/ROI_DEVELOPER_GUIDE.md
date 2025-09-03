# ROI Calibration Tool - Developer Guide

## 🎯 Overview

The ROI (Region of Interest) Calibration Tool is a browser-based visual editor for precision-calibrating card scanning regions across different Pokémon card eras and layouts. This tool enables human-in-the-loop optimization of OCR and template matching accuracy through interactive boundary adjustment and real-time validation.

## ⚠️ **IMPORTANT: Tool Migration Notice**

**As of September 2, 2025**, CardMint has **two ROI calibration tools**:

### 🎨 **Enhanced ROI Tool** (RECOMMENDED)
- **Location**: `/public/dashboard/roi-calibration-enhanced.html`
- **Status**: ✅ **PRODUCTION READY** - Modern, feature-complete
- **Features**: Glass morphism UI, undo system, dynamic scaling, keyboard shortcuts
- **Performance**: Optimized with caching and micro-interactions

### 🏚️ **Legacy ROI Tool** (DEPRECATED)  
- **Location**: `/src/dashboard/roi-calibration.html`
- **Status**: ⚠️ **DEPRECATED** - Will be removed in v3.0
- **Migration**: Please switch to Enhanced ROI Tool
- **Support**: Limited - use only if Enhanced tool has issues

## 🚀 Quick Start

### Launch Enhanced Tool (Recommended)
```bash
# Development mode
npm run dev:api
# Then open: http://localhost:3000/public/dashboard/roi-calibration-enhanced.html
```

### Launch Legacy Tool (Deprecated)
```bash
# Development mode (shows deprecation warnings)
npm run dev:api  
# Then open: http://localhost:3000/dashboard/roi-calibration.html
```

### Basic Workflow
1. **Load Template**: Click "Load from Server" → Select template (modern_standard, neo_era, etc.)
2. **Load Test Image**: Upload a Golden-10 sample card image
3. **Adjust ROIs**: Drag boxes to position, Shift+drag to resize
4. **Validate**: Test OCR/ZNCC within regions for real-time feedback
5. **Export**: Save calibrated templates for production use

## 📐 ROI Types & Purpose

### Core Recognition ROIs

| ROI Name | Purpose | Card Eras | Notes |
|----------|---------|-----------|-------|
| `set_icon` | Set symbol template matching | All eras | Critical for ZNCC correlation |
| `bottom_band` | Card number extraction | All eras | Format: "065/064", "25/102" |
| `card_name` | Pokemon name OCR | All eras | Uses lexicon validation |
| `artwork` | Perceptual hashing | All eras | Main art region for pHash |
| `card_bounds` | Full card boundary | All eras | Outer card edges |

### Era-Specific ROIs

| ROI Name | Purpose | When Active | Conditions |
|----------|---------|-------------|------------|
| `promo_star` | Promo identifier | Promo cards only | `promoOnly: true` |
| `first_edition_stamp` | 1st Edition mark | Base/Jungle/Fossil | `firstEditionOnly: true` |
| `regulation_mark` | SV regulation marks | Scarlet/Violet era | `era: 'modern'` |

## 🎮 Tool Interface

### Sidebar Controls

**Template Management**
- **Load Manifest**: Import roi_templates.json from DATA_ROOT
- **Template Select**: Choose from available templates (modern_standard, neo_era, classic_base, promo_cards)

**Condition Preview** (Visual Only)
- **promoOnly**: Toggle promo-specific ROI visibility
- **firstEditionOnly**: Toggle first edition stamp visibility  
- **Era**: Preview era-specific ROI configurations

**ROI List**
- **Visibility toggles**: Show/hide individual ROIs
- **Add/Delete**: Create custom ROIs or remove existing
- **Copy/Paste**: Duplicate ROI configurations

### Canvas Controls

**Navigation**
- **Zoom**: +/- buttons or mouse wheel
- **Pan**: Click and drag canvas background
- **Snap Grid**: Enable pixel-perfect positioning

**ROI Manipulation**
- **Move**: Drag ROI center
- **Resize**: Shift+drag ROI corners/edges
- **Keyboard nudging**: Arrow keys (1px), Shift+arrows (10px)

### Testing Panel

**OCR Validation**
- **Test OCR button**: Extract text from selected ROI
- **Text Type**: Choose recognition mode (name, promo, set_code, regulation_mark)
- **Results**: Text + confidence score + engine used

**ZNCC Validation**
- **Test ZNCC button**: Template match within set_icon ROI
- **Results**: Correlation score + matching scale + pass/fail status

## 📊 Expected Outputs

### ROI Template Structure
```json
{
  "version": "1.0",
  "camera_calibration": {
    "resolution": {"width": 6000, "height": 4000},
    "last_calibrated": "2025-09-01T12:00:00.000Z",
    "calibration_card": "golden_10_charizard"
  },
  "default_template": "modern_standard",
  "templates": {
    "modern_standard": {
      "id": "modern_standard",
      "name": "Modern Standard",
      "description": "SWSH and SV era cards",
      "layout_hint": "modern",
      "era": "modern",
      "rotation_deg": 0,
      "confidence": 0.95,
      "rois": {
        "set_icon": {"x": 4200, "y": 200, "width": 600, "height": 400},
        "bottom_band": {"x": 300, "y": 3400, "width": 5400, "height": 400},
        "card_name": {"x": 700, "y": 650, "width": 4200, "height": 280},
        "promo_star": {
          "x": 4800, "y": 300, "width": 300, "height": 300,
          "conditions": {"promoOnly": true}
        },
        "regulation_mark": {
          "x": 5200, "y": 3600, "width": 200, "height": 200,
          "conditions": {"era": "modern"}
        }
      }
    }
  }
}
```

### Coordinate Systems

**Pixel Coordinates** (Default)
```json
{"x": 4200, "y": 200, "width": 600, "height": 400}
```
- Fixed pixel positions at calibration resolution (6000x4000)
- Scaled automatically to target image resolution

**Percent Coordinates** (Recommended)
```json
{"x_pct": 0.70, "y_pct": 0.05, "width_pct": 0.10, "height_pct": 0.10}
```
- Resolution-independent percentages (0.0-1.0)
- Better for cross-resolution robustness

### OCR Test Results
```json
{
  "text": "Charizard",
  "confidence": 0.96,
  "engine": "tesseract"
}
```

### ZNCC Test Results
```json
{
  "matched": true,
  "confidence": 0.89,
  "best_candidate": {
    "set_code": "swsh",
    "set_name": "Sword & Shield Base Set",
    "correlation": 0.89,
    "scale": 1.0,
    "position": {"x": 4350, "y": 250}
  },
  "processing_time_ms": 45
}
```

## 🔧 Developer Workflow

### 1. Template Calibration Process

**Initial Setup**
```bash
# Ensure clean environment
npm run dev
# Open tool: http://localhost:5173/roi-calibration.html
```

**Per-Era Calibration**
1. **Classic Era** (Base, Jungle, Fossil)
   - Load `classic_base` template
   - Test with Base Set Charizard
   - Verify first_edition_stamp positioning
   - Validate set_icon correlation with base set symbols

2. **Neo Era** (Neo Genesis-Destiny) 
   - Load `neo_era` template  
   - Test with Neo Genesis cards
   - Verify first_edition_stamp differences
   - Validate era-specific set icons

3. **Modern Era** (SWSH, SV)
   - Load `modern_standard` template
   - Test with recent cards
   - Verify regulation_mark extraction
   - Validate modern set icon positioning

4. **Promo Cards**
   - Load `promo_cards` template
   - Test with various promo formats
   - Verify promo_star detection
   - Validate promo numbering patterns

### 2. Validation Standards

**OCR Confidence Thresholds**
- **Card Names**: ≥0.85 confidence (lexicon-validated)
- **Card Numbers**: ≥0.70 confidence (pattern-validated) 
- **Promo Codes**: ≥0.80 confidence (format-validated)
- **Regulation Marks**: ≥0.90 confidence (strict D/E/F/G/H)

**ZNCC Correlation Thresholds**
- **Set Icons**: ≥0.78 correlation (configurable via SET_ICON_NCC_THRESH)
- **Multi-scale testing**: 0.75x, 1.0x, 1.25x scales
- **Early exit**: >0.90 correlation stops further testing

**ROI Positioning Accuracy**
- **Pixel precision**: ±5px tolerance for manual adjustment
- **Percentage precision**: ±0.5% tolerance for cross-resolution scaling
- **Visual validation**: ROI boxes should tightly bound target regions

### 3. Export Workflows

**Full Manifest Export**
- Complete roi_templates.json with all templates
- Use for fresh installations or major updates
- Includes camera calibration metadata

**Patch Export** 
```json
{
  "templateId": "modern_standard",
  "updates": {
    "rois": {
      "card_name": {"x": 720, "y": 660, "width": 4180, "height": 270}
    },
    "conditions": {
      "card_name": {"era": "modern"}
    }
  }
}
```
- Minimal changes for incremental updates
- Use for fine-tuning existing templates

### 4. Integration Testing

**Golden-10 Validation**
```bash
# After calibration changes
npm run evaluate:golden10

# Expected improvements:
# - Set icon accuracy: +15-20%
# - Text extraction: +25-30% 
# - Overall confidence: +10-15%
```

**Production Deployment**
```bash
# Copy calibrated templates to production
cp data/roi_templates.json /path/to/production/data/

# Restart services to load new templates
npm run prod:clean && npm run prod:build && npm run prod:start
```

## 🎯 Accuracy Optimization Tips

### ROI Positioning Best Practices

**Set Icons**
- Position tightly around symbol (no excess background)
- Account for foil/texture variations in modern cards
- Test with multiple cards from same set for consistency

**Text Regions**  
- Include slight padding for OCR preprocessing
- Avoid cutting off descenders (g, j, p, q, y)
- Exclude decorative elements that confuse OCR

**Card Names**
- Capture full name width including accents/symbols
- Exclude set icon overlap in right margin
- Account for longer names (e.g., "Garchomp & Giratina-GX")

### Common Calibration Issues

**Resolution Scaling Problems**
- Symptom: ROIs work in tool but fail in production
- Solution: Use percent coordinates for resolution independence
- Validation: Test with multiple image sizes

**Era Condition Conflicts**
- Symptom: Wrong ROIs active for card type
- Solution: Verify condition logic matches card characteristics  
- Validation: Test promo/first-edition toggles

**OCR Preprocessing Failures**
- Symptom: Low confidence despite good positioning
- Solution: Adjust ROI padding, check text type mapping
- Validation: Compare raw vs preprocessed image crops

## 📈 Performance Targets

### Latency Budgets
- **ROI Extraction**: <5ms per region
- **OCR Processing**: <40ms per text region  
- **ZNCC Matching**: <40ms per set icon
- **Total Pipeline**: <100ms P95 latency

### Accuracy Targets
- **Set Icon Recognition**: ≥95% correlation success
- **Card Name Extraction**: ≥90% lexicon match rate
- **Number Pattern Matching**: ≥85% format validation
- **Cross-Resolution Stability**: <2% accuracy drop across scales

## 🔍 Troubleshooting

### Tool Won't Load
```bash
# Check for stale processes
ps aux | grep -i roi
pkill -f "roi-calibration\|vite.*roi"

# Restart fresh
npm run dev
```

### API Endpoints Not Responding
```bash
# Verify server is running
curl http://localhost:3000/api/roi/manifest

# Check logs for errors
npm run dev:api 2>&1 | grep -i error
```

### ROI Changes Not Persisting
- Verify DATA_ROOT/roi_templates.json is writable
- Check browser localStorage for cached data
- Use "Export Manifest" to save changes explicitly

### Poor OCR Results
- Verify text_type matches content (name vs promo vs set_code)
- Check ROI positioning excludes background noise
- Test with different preprocessing parameters

This guide provides the foundation for effective ROI calibration and continuous accuracy improvement through human-in-the-loop optimization.