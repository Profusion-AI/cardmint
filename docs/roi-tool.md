# ROI Calibration Tool

## 📊 **File Architecture Comparison**

### `roi_contract.json` vs `roi_templates.json`

| **Aspect** | **roi_contract.json** | **roi_templates.json** |
|------------|----------------------|------------------------|
| **Purpose** | JSON Schema/API Contract | Production ROI Templates |
| **Type** | Validation Schema | Data Configuration |
| **Content** | Output format specification | Actual ROI coordinates |
| **Usage** | Validates ML vision API responses | Drives ROI calibration tool |
| **Format** | Quadrilateral polygons `[[x,y] x4]` | Rectangle coordinates `{x,y,width,height}` |
| **Fields** | `conf`, `poly`, `homography`, `patch`, `ocr_text` | `x`, `y`, `width`, `height`, `conditions` |
| **Context** | Vision ML pipeline output validation | Template-based ROI positioning |

#### **Key Architectural Differences**:

**roi_contract.json**:
- **JSON Schema Definition** for validating vision API responses
- **Complex geometric data**: quadrilateral polygons, homography matrices  
- **ML Pipeline Integration**: confidence scores, patch paths, OCR results
- **Advanced Features**: sanity checks, geometry validation, inferred fields
- **Production Output**: Defines structure of processed card recognition results

**roi_templates.json**:
- **Static Template Configuration** for different card layouts/eras
- **Simple rectangle regions**: x,y coordinates with width,height dimensions
- **Camera Calibration Integration**: resolution settings, calibration metadata
- **Template System**: multiple layout variants (modern_standard, neo_era, base_set)
- **ROI Tool Integration**: drives the interactive calibration interface

## Overview
- **Enhanced Interactive Tool** with professional three-tab interface for defining and tuning regions of interest (ROIs)
- **Advanced UX Features**: Undo system (Ctrl+Z), dynamic scaling, glass morphism design, real-time notifications
- **Comprehensive Functionality**: editing, conditions, percent-based definitions, live previews, testing hooks, and export options

## Open The Tool

### **Enhanced ROI Tool (Recommended)**
- **Development**: `npm run dev` → `https://localhost:5175/dashboard/roi-calibration-enhanced.html`
- **Features**: Professional UI, undo system, dynamic scaling, three-tab interface

### **Basic ROI Tool (Legacy)**  
- **Development**: `npm run dev` → `https://localhost:5175/roi-calibration.html`
- **API Fallback**: `http://localhost:3000/dashboard/roi-calibration.html`

## Enhanced Workflow

### **Three-Tab Interface**

#### 🖼️ **Canvas Tab** (Interactive Editing)
- **Load Image**: Upload card images - automatic dynamic scaling preserves ROI proportions
- **ROI Manipulation**: Drag to move, corner drag to resize, arrow keys for precision (Shift=10px)
- **Visual Feedback**: Real-time coordinate updates, selection highlighting
- **Undo System**: **Ctrl+Z** reverts any ROI modifications (20-step history)

#### 📋 **Templates Tab** (Configuration)
- **Load Manifest**: Load `roi_templates.json` ("Choose File" or "Load from Server")
- **Template Selection**: Switch between modern_standard, neo_era, base_set, mcd_promo
- **Conditions**: Set `promoOnly`/`firstEditionOnly`/`era` per ROI for runtime conditional logic
- **Coordinate Editing**: Manual numeric input for precise positioning

#### 🧪 **Testing Tab** (Validation)
- **OCR Testing**: Select ROI → test different text types (name/promo/set_code) → view confidence
- **ZNCC Testing**: Template matching validation for set_icon recognition
- **Live Preview**: Real-time ROI content preview with statistics
- **Results Display**: Detailed test output and performance metrics

### **Advanced Features**
- **Dynamic Scaling**: Automatically adapts ROIs to different image resolutions
- **Smart Undo**: Tracks all modifications (drag, resize, add, delete, coordinate edits)
- **File Input Fix**: Working "Choose File" buttons for manifest and image loading
- **Professional UX**: Glass morphism design, ambient animations, notification system
- **Zoom/Snap**: Enhanced zoom controls with grid snapping (5px precision)
- **Export Options**: Full manifest or patch export with px/percent mode support

## Schema Additions
- **New ROIs**: card_name, promo_star, first_edition_stamp. Existing kept: set_icon, bottom_band, regulation_mark, artwork, card_bounds.
- **Conditions**: ROI-level optional `{ promoOnly?: boolean; firstEditionOnly?: boolean; era?: 'classic'|'neo'|'modern'|'promo' }`.
- **Percent Mode**: ROI entries may use `{ x_pct, y_pct, width_pct, height_pct }`. Tool can export px or percent.
- **Dynamic Scaling**: Original template coordinates preserved for consistent scaling across image sizes.

## Runtime Wiring
- **ROIRegistry**: Now resolves conditional and percent ROIs, returning px-scaled rectangles via getScaledROIs.
- **TextMatcher**: Supports text_type: 'name' using rois.card_name and Pokemon lexicon validation.
- **SetIconMatcher**: Exposes ROI-based matching endpoint via API for quick ZNCC tests.

## API Hooks
- `GET /api/roi/manifest` → returns DATA_ROOT/roi_templates.json
- `POST /api/roi/ocr-test { imageData, roi, text_type }` → returns `{ text, confidence, engine }`
- `POST /api/roi/zncc-test { imageData, roi }` → returns match result with correlation/scale

## 🎯 Production Tips

### **Template Calibration Strategy**
- **Golden-10 Per Template**: Calibrate using representative card images for each era
- **Critical ROI Validation**: Ensure precise alignment for `set_icon`, `bottom_band`, `promo_star`, `first_edition_stamp`, `card_name`
- **Cross-Resolution Testing**: Test ROI scaling with various image sizes to verify dynamic scaling

### **Best Practices**
- **Percent Mode Preferred**: Use percent-based coordinates for resolution-independent scaling
- **Undo Frequently**: Use Ctrl+Z liberally during adjustment - 20-step history prevents data loss
- **Template Baseline**: Each template load creates clean undo history for consistent starting points
- **Live Validation**: Test OCR/ZNCC immediately after ROI adjustments for real-time feedback

### **Quality Validation**
```bash
# Measure accuracy improvements after calibration
npm run evaluate:golden10
# Run both lenient and strict accuracy tests
```

### **File Architecture Integration**
- **roi_templates.json**: Edit and calibrate via this tool → feeds ROI positioning system
- **roi_contract.json**: Validates ML pipeline outputs → separate from calibration process
- **Dynamic Bridge**: ROIRegistry converts template coordinates to runtime polygons as needed

## 🔧 Undo System Features

### **Comprehensive State Tracking**
Every ROI modification is automatically tracked:

| **Action** | **Undo Description** | **Trigger** |
|------------|---------------------|-------------|
| 🖱️ **Mouse drag move** | "Move ROI" | Mouse up after drag |
| 🔄 **Mouse drag resize** | "Resize ROI" | Mouse up after resize |
| ⌨️ **Keyboard arrow keys** | "Move ROI with keyboard (→↓)" | Arrow key press |
| ➕ **Add new ROI** | "Add ROI" | Before adding |
| 🗑️ **Delete ROI** | "Delete ROI" | Before deleting |
| 📋 **Paste ROI** | "Paste ROI" | Before pasting |
| 🔢 **Coordinate edit** | "Edit ROI coordinates" | Property field change |
| 📁 **Template load** | "Template loaded" | After template loads |
| 🖼️ **Image scale** | "Image loaded and scaled" | After image scaling |

### **Smart History Management**
- **20-step undo history** with automatic cleanup
- **Template isolation**: Each template load starts fresh history
- **State preservation**: Maintains ROI coordinates, selection, visibility, colors, conditions
- **UI synchronization**: Updates all panels, lists, and previews on undo
- **User feedback**: Success/warning notifications with action descriptions

### **Keyboard Shortcuts**
- **Ctrl+Z** / **Cmd+Z**: Undo last action
- **Ctrl+S** / **Cmd+S**: Export patch
- **Ctrl+O** / **Cmd+O**: Load image
- **Ctrl+N** / **Cmd+N**: Add new ROI
- **Ctrl+C** / **Cmd+C**: Copy selected ROI
- **Ctrl+V** / **Cmd+V**: Paste ROI
- **Delete**: Delete selected ROI
- **Escape**: Deselect current ROI