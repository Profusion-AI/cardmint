// Enhanced ROI Tool - Modern UX Implementation
// Compatible with existing roi-tool.ts functionality

// Type definitions (matching roi-tool.ts)
const TYPE_DEFINITIONS = {
  Rect: { x: 0, y: 0, width: 0, height: 0 },
  Conditions: { promoOnly: false, firstEditionOnly: false, era: '' },
  ROIEntry: function(rect, conditions) { return { ...rect, conditions }; },
  Manifest: {
    version: '',
    camera_calibration: {
      resolution: { width: 6000, height: 4000 },
      last_calibrated: '',
      calibration_card: ''
    },
    default_template: '',
    templates: {}
  }
};

// Class definitions for compatibility
class ROIItem {
  constructor(key, name, rect, visible, color, conditions) {
    this.key = key;
    this.name = name;
    this.rect = rect;
    this.visible = visible !== undefined ? visible : true;
    this.color = color || '#9e9e9e';
    this.conditions = conditions || {};
  }
}

class EnhancedROITool {
  constructor() {
    this.manifest = null;
    this.templateId = null;
    this.rois = [];
    this.selectedIndex = -1;
    this.imageBitmap = null;
    this.imageDataUrl = null;
    this.zoom = 0.2;
    this.panX = 0;
    this.panY = 0;
    
    // Undo system
    this.undoHistory = [];
    this.maxUndoSteps = 20;
    this.undoEnabled = true;
    this.scaleX = 1.0;
    this.scaleY = 1.0;
    this.imageLoaded = false;
    this.templateLoaded = false;
    this.dragging = false;
    this.dragMode = null;
    this.clipboardROI = null;
    this.notifications = [];
    this.notificationTimeout = null;

    // Enhanced features
    this.currentTab = 'canvas';
    this.sidebarCollapsed = { left: false, right: false };
    this.previewCanvas = null;
    this.livePreviewCanvas = null;
    
    // Performance optimizations
    this.renderThumbsDebounced = this.debounce(this.renderThumbs.bind(this), 100);
    this.highlightedROI = -1; // For thumbnail hover correlation

    // State persistence
    this.autoSaveEnabled = true;
    this.autoSaveInterval = 5000; // 5 seconds
    this.autoSaveTimer = null;
    this.stateVersion = '1.0';

    // Guidance panel state
    this.roiMetrics = new Map(); // key -> {contrast, sharpness, textDensity, lastZNCC, lastOCR, score, ts}
    this._guidanceDirty = false;
    this._guidanceDebounced = this.debounce(() => this.updateGuidancePanel(), 150);
    this._scratchCanvas = null; // For OffscreenCanvas fallback

    this.initializeDOM();
    this.setupEventListeners();
    this.initializeNotificationSystem();
    this.loadPersistedState();
    this.startAutoSave();
  }

  // ===== INITIALIZATION =====
  initializeDOM() {
    // Core elements
    this.canvas = document.getElementById('imageCanvas');
    this.wrap = document.getElementById('canvasWrap');
    this.roiList = document.getElementById('roiList');
    this.matrixStatus = document.getElementById('status');

    // Enhanced UI elements
    this.imgInput = document.getElementById('imgInput');
    this.manifestInput = document.getElementById('manifestInput');
    this.loadServerManifestBtn = document.getElementById('loadServerManifest');
    this.templateSelect = document.getElementById('templateSelect');

    // Controls
    this.zoomInBtn = document.getElementById('zoomIn');
    this.zoomOutBtn = document.getElementById('zoomOut');
    this.resetCanvasBtn = document.getElementById('resetCanvas');
    this.snapGridChk = document.getElementById('snapGrid');
    this.percentModeChk = document.getElementById('percentMode');

    // ROI Management
    this.addRoiBtn = document.getElementById('addRoi');
    this.delRoiBtn = document.getElementById('delRoi');
    this.copyRoiBtn = document.getElementById('copyRoi');
    this.pasteRoiBtn = document.getElementById('pasteRoi');
    this.thumbs = document.getElementById('thumbs');
    
    // Guidance panel setup
    this.guidancePanel = document.getElementById('guidancePanel');
    this.guidanceChips = document.getElementById('guidanceChips');

    // If missing, create minimal containers just above thumbnails:
    if (!this.guidancePanel && this.thumbs) {
      const panel = document.createElement('div');
      panel.id = 'guidancePanel';
      panel.className = 'guidance-panel';
      panel.innerHTML = `
        <div class="guidance-header">
          <span class="guidance-title">Recommended Order</span>
          <span class="guidance-hint">click to select</span>
        </div>
        <div id="guidanceChips" class="guidance-chips"></div>
      `;
      this.thumbs.parentNode?.insertBefore(panel, this.thumbs); // above thumbnail strip
      this.guidancePanel = panel;
      this.guidanceChips = panel.querySelector('#guidanceChips');
    }
    
    // Reset confirmation modal
    this.resetConfirmModal = document.getElementById('resetConfirmModal');
    this.resetConfirmBtn = document.getElementById('resetConfirmBtn');
    this.resetCancelBtn = document.getElementById('resetCancelBtn');

    // Properties
    this.roiNameInput = document.getElementById('roiNameInput');
    this.roiColorInput = document.getElementById('roiColorInput');
    this.roiXInput = document.getElementById('roiXInput');
    this.roiYInput = document.getElementById('roiYInput');
    this.roiWidthInput = document.getElementById('roiWidthInput');
    this.roiHeightInput = document.getElementById('roiHeightInput');
    this.condPromo = document.getElementById('condPromo');
    this.condFirstEd = document.getElementById('condFirstEd');
    this.condEra = document.getElementById('condEra');

    // Testing
    this.testOCRBtn = document.getElementById('testOCR');
    this.ocrTypeSel = document.getElementById('ocrTypeSel');
    this.testZNCCBtn = document.getElementById('testZNCC');
    this.testOut = document.getElementById('testOut');

    // Export
    this.exportManifestBtn = document.getElementById('exportManifest');
    this.exportPatchBtn = document.getElementById('exportPatch');
    this.exportROIConfigBtn = document.getElementById('exportROIConfig');

    // Enhanced elements
    this.notificationContainer = document.getElementById('notificationContainer');
    this.notificationBadge = document.getElementById('notificationBadge');
    this.notificationTrigger = document.getElementById('notificationTrigger');
    this.loadingOverlay = document.getElementById('loadingOverlay');
    this.livePreview = document.getElementById('livePreview');
    this.previewCanvas = document.getElementById('previewCanvas');

    // Statistics
    this.roiCount = document.getElementById('roiCount');
    this.coverageStat = document.getElementById('coverageStat');
    this.aspectStat = document.getElementById('aspectStat');
    this.positionStat = document.getElementById('positionStat');

    // Get canvas context
    this.ctx = this.canvas.getContext('2d');

    // Initialize preview canvas
    if (this.previewCanvas) {
      this.livePreviewCanvas = this.previewCanvas.getContext('2d');
    }

    // Ensure selection handles are created
    this.ensureSelectionHandles();
  }

  setupEventListeners() {
    // Core canvas interactions
    this.setupCanvasInteractions();

    // File handling
    this.setupFileHandling();

    // UI controls
    this.setupControls();

    // Testing
    this.setupTesting();

    // Export
    this.setupExport();

    // Enhanced UI interactions
    this.setupEnhancedUI();

    // Keyboard shortcuts
    this.setupKeyboardShortcuts();
  }

  ensureSelectionHandles() {
    this.selectionHandles = document.getElementById('selectionHandles');
    if (!this.selectionHandles) return;

    if (this.selectionHandles.dataset.ready === '1') return; // already built
    this.selectionHandles.dataset.ready = '1';

    const dirs = [
      ['nw', 0,   0  ],
      ['n',  50,  0  ],
      ['ne', 100, 0  ],
      ['e',  100, 50 ],
      ['se', 100, 100],
      ['s',  50,  100],
      ['sw', 0,   100],
      ['w',  0,   50 ],
    ];

    dirs.forEach(([dir, leftPct, topPct]) => {
      const h = document.createElement('div');
      h.className = `roi-handle ${dir}`;
      h.dataset.dir = dir;
      h.style.left = `${leftPct}%`;
      h.style.top = `${topPct}%`;
      // Pointer events (Pointer > mouse/touch)
      h.addEventListener('pointerdown', (e) => this.startResizeFromHandle(e, dir));
      this.selectionHandles.appendChild(h);
    });
  }

  // ===== CANVAS INTERACTIONS =====
  setupCanvasInteractions() {
    // Pointer events (unified mouse/pen/touch) - bind methods for proper cleanup
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundEndDragSafely = this._endDragSafely.bind(this);
    
    this.canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    window.addEventListener('pointermove', this.boundOnPointerMove);
    window.addEventListener('pointerup', this.boundOnPointerUp);
    
    // Handle pointer cancellation
    this.canvas.addEventListener('lostpointercapture', this.boundEndDragSafely);
    this.canvas.addEventListener('pointercancel', this.boundEndDragSafely);
    
    // Keep keyboard and resize
    window.addEventListener('keydown', this.handleKeyDown.bind(this));
    window.addEventListener('resize', this.handleResize.bind(this));
    
    // Cursor-anchored wheel zoom
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const imgBefore = this.deviceToImageCoords(mouseX, mouseY);

      const factor = (e.deltaY < 0) ? 1.1 : 0.9;
      this.zoom = Math.max(0.01, Math.min(this.zoom * factor, 32));

      const imgAfter = this.deviceToImageCoords(mouseX, mouseY);
      // adjust pan so the point under cursor stays put
      this.panX += (imgAfter.x - imgBefore.x) * this.zoom;
      this.panY += (imgAfter.y - imgBefore.y) * this.zoom;

      this.updateImageInfo();
      this.draw();
    }, { passive: false });

    // Space + drag to pan (track space key state)
    let panning = false, lastX = 0, lastY = 0;
    let spacePressed = false;
    
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        spacePressed = true;
        this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { 
        spacePressed = false; 
        panning = false;
        this.canvas.style.cursor = 'default';
      }
    });
    
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1 || (e.button === 0 && spacePressed)) {
        panning = true; lastX = e.clientX; lastY = e.clientY; e.preventDefault();
        this.canvas.style.cursor = 'grabbing';
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (panning) { 
        this.panX += (e.clientX - lastX); 
        this.panY += (e.clientY - lastY); 
        lastX = e.clientX; 
        lastY = e.clientY; 
        this.draw(); 
      }
    });
    window.addEventListener('mouseup', () => {
      if (panning) {
        panning = false;
        this.canvas.style.cursor = spacePressed ? 'grab' : 'default';
      }
    });
  }

  _endDragSafely() {
    if (this.dragging) {
      this.dragging = false;
      this.dragMode = null;
      this.dragRectStart = null;
      this.renderThumbs(); // finalize once
    }
  }

  onPointerDown(e) {
    // Only primary or pen/touch contact
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    this.canvas.setPointerCapture?.(e.pointerId);
    this._lastPointerId = e.pointerId;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Reuse existing hit-testing path
    const imgCoords = this.deviceToImageCoords(x, y);

    let found = false;
    for (let i = 0; i < this.rois.length; i++) {
      const r = this.rois[i];
      if (!r.visible) continue;
      const roiRect = r.rect;
      if (imgCoords.x >= roiRect.x && imgCoords.x <= roiRect.x + roiRect.width &&
          imgCoords.y >= roiRect.y && imgCoords.y <= roiRect.y + roiRect.height) {
        this.selectROI(i);
        found = true;
        this.dragging = true;
        this.dragStart = { x: imgCoords.x, y: imgCoords.y };
        this.dragRectStart = { ...r.rect };
        // Touch/pen default to move; Shift on keyboards still enables resize when using mouse
        this.dragMode = (e.shiftKey && e.pointerType === 'mouse') ? 'resize' : 'move';
        this.notify('ROI selected', `Selected ${r.name}`, 'success');
        break;
      }
    }

    if (!found) {
      this.selectedIndex = -1;
      this.clearROISelection();
      this.notify('Canvas clicked', 'Click and drag to create new ROI', 'info');
    }

    this.draw();
    this.updateUI();

    // Prevent mouse compatibility events from double-firing
    e.preventDefault();
  }

  onPointerMove(e) {
    if (!this.dragging || this.selectedIndex < 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const img = this.deviceToImageCoords(x, y);

    const dx = img.x - this.dragStart.x;
    const dy = img.y - this.dragStart.y;

    const r = this.rois[this.selectedIndex];

    if (this.dragMode === 'move') {
      r.rect.x = this.roundSnap(this.dragRectStart.x + dx);
      r.rect.y = this.roundSnap(this.dragRectStart.y + dy);
    } else if (this.dragMode === 'resize') {
      r.rect.width = Math.max(10, this.roundSnap(this.dragRectStart.width + dx));
      r.rect.height = Math.max(10, this.roundSnap(this.dragRectStart.height + dy));
    }

    // Clamp to image on every update
    this.clampRect(r.rect);

    this.draw();
    this.updateROIProperties();

    e.preventDefault();
  }

  onPointerUp(e) {
    if (!this.dragging) return;

    // Save undo state after drag operation completes
    if (this.dragMode === 'move') this.saveUndoState('Move ROI');
    if (this.dragMode === 'resize') this.saveUndoState('Resize ROI');

    this.dragging = false;
    this.dragMode = null;
    this.dragRectStart = null;
    this.renderThumbs();
    
    // Update guidance panel after drag operation
    this._guidanceDebounced();

    // Release capture if we own it
    try {
      this.canvas.releasePointerCapture?.(e.pointerId);
    } catch (_) {
      // Ignore InvalidPointerId errors
    }
  }

  startResizeFromHandle(e, dir) {
    if (this.selectedIndex < 0) return;
    e.preventDefault();
    const roi = this.rois[this.selectedIndex];

    this.dragging = true;
    this.dragMode = 'resize';
    this.resizeDir = dir;
    this.dragStart = this.deviceToImageCoords(e.clientX - this.canvas.getBoundingClientRect().left,
                                              e.clientY - this.canvas.getBoundingClientRect().top);
    this.dragRectStart = { ...roi.rect };

    // Capture modifier snapshot at start (PointerEvent modifiers can change mid-drag)
    this.modShift = e.shiftKey; // keep aspect ratio
    this.modAlt   = e.altKey;   // resize from center

    // Pointer capture for robust drag
    e.currentTarget.setPointerCapture?.(e.pointerId);

    // Prevent canvas mousedown handler from initiating a move at the same time
    e.stopPropagation();

    // We'll update on window pointermove to keep it simple
    if (!this._onPointerMove) {
      this._onPointerMove = (ev) => this.onResizePointerMove(ev);
      this._onPointerUp   = (ev) => this.onResizePointerUp(ev);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp, { once: true });
    }
  }

  onResizePointerMove(e) {
    if (!this.dragging || this.dragMode !== 'resize' || this.selectedIndex < 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const img = this.deviceToImageCoords(e.clientX - rect.left, e.clientY - rect.top);

    const roi = this.rois[this.selectedIndex];
    const start = this.dragRectStart;
    const dir = this.resizeDir;

    // Anchor point: opposite side stays fixed
    let x1 = start.x, y1 = start.y, x2 = start.x + start.width, y2 = start.y + start.height;

    // Update the moving side(s)
    if (dir.includes('w')) x1 = img.x;
    if (dir.includes('e')) x2 = img.x;
    if (dir.includes('n')) y1 = img.y;
    if (dir.includes('s')) y2 = img.y;

    // Resize from center (Alt): expand/shrink symmetrically around center
    if (this.modAlt) {
      const cx = (start.x + start.width / 2);
      const cy = (start.y + start.height / 2);
      const dx = (dir.includes('w') || dir.includes('e')) ? (img.x - cx) : (start.width / 2);
      const dy = (dir.includes('n') || dir.includes('s')) ? (img.y - cy) : (start.height / 2);
      x1 = cx - Math.abs(dx);
      x2 = cx + Math.abs(dx);
      y1 = cy - Math.abs(dy);
      y2 = cy + Math.abs(dy);
    }

    // Normalize and set
    const next = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };

    // Keep aspect ratio (Shift) based on starting AR
    if (this.modShift) {
      const ar = start.width / Math.max(1, start.height);
      // Choose which dimension is primary based on drag direction
      if (dir === 'n' || dir === 's') {
        next.width = next.height * ar;
        // Anchor horizontally, expand around the anchor edge or center
        if (dir === 'n' || dir === 's') {
          // Keep center x aligned to start center to avoid sideways drift
          const cx = start.x + start.width / 2;
          next.x = cx - next.width / 2;
        }
      } else if (dir === 'e' || dir === 'w') {
        next.height = next.width / ar;
        const cy = start.y + start.height / 2;
        next.y = cy - next.height / 2;
      } else { // corner
        // Use whichever delta is larger to avoid shrinking AR unexpectedly
        const useWidth = next.width / start.width > next.height / start.height;
        if (useWidth) next.height = next.width / ar;
        else          next.width  = next.height * ar;

        // Re-anchor to correct corner
        if (dir.includes('w')) next.x = x2 - next.width;
        if (dir.includes('n')) next.y = y2 - next.height;
      }
    }

    // Snap (if grid enabled)
    next.x      = this.roundSnap(next.x);
    next.y      = this.roundSnap(next.y);
    next.width  = this.roundSnap(next.width);
    next.height = this.roundSnap(next.height);

    // Clamp to image
    this.clampRect(next);

    // Apply
    roi.rect = next;
    this.draw();
    this.updateROIProperties(); // updates stats/aspect
  }

  onResizePointerUp(e) {
    if (this.dragging && this.dragMode === 'resize') {
      this.saveUndoState('Resize ROI (handles)');
      this.renderThumbsDebounced(); // expensive; do it once at end
    }
    this.dragging = false;
    this.dragMode = null;
    this.resizeDir = null;
    this.dragRectStart = null;

    // Remove move listener
    if (this._onPointerMove) {
      window.removeEventListener('pointermove', this._onPointerMove);
      this._onPointerMove = null;
    }
  }

  handleKeyDown(event) {
    if (this.selectedIndex < 0) return;

    let dx = 0, dy = 0;
    const step = event.shiftKey ? 10 : 1;

    switch (event.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      case 'Delete':
        this.deleteSelectedROI();
        return;
      case 'c':
        if (event.ctrlKey || event.metaKey) {
          this.copySelectedROI();
          event.preventDefault();
          return;
        }
        break;
      case 'v':
        if (event.ctrlKey || event.metaKey) {
          this.pasteROI();
          event.preventDefault();
          return;
        }
        break;
    }

    if (dx || dy) {
      // Save undo state before keyboard movement
      this.saveUndoState(`Move ROI with keyboard (${dx > 0 ? '→' : dx < 0 ? '←' : ''}${dy > 0 ? '↓' : dy < 0 ? '↑' : ''})`);
      
      const r = this.rois[this.selectedIndex].rect;
      r.x += dx;
      r.y += dy;
      this.clampRect(r);  // Clamp to image bounds
      this.draw();
      this.renderThumbs();
      this.updateROIProperties();
      event.preventDefault();
    }
  }

  handleResize() {
    if (this.imageBitmap) {
      this.fitCanvas();
      this.draw();
    }
  }

  // ===== FILE HANDLING =====
  setupFileHandling() {
    if (this.imgInput) {
      this.imgInput.addEventListener('change', this.handleImageLoad.bind(this));
    }

    if (this.manifestInput) {
      this.manifestInput.addEventListener('change', this.handleManifestLoad.bind(this));
    }

    if (this.loadServerManifestBtn) {
      this.loadServerManifestBtn.addEventListener('click', this.loadServerManifest.bind(this));
    }

    if (this.templateSelect) {
      this.templateSelect.addEventListener('change', this.handleTemplateChange.bind(this));
    }
  }

  async handleImageLoad(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      this.showLoading('Loading image...');
      const dataUrl = await this.fileToDataUrl(file);
      const bitmap = await createImageBitmap(file);

      this.imageDataUrl = dataUrl;
      this.imageBitmap = bitmap;
      this.imageLoaded = true;

      if (this.manifest) {
        this.calculateScalingFactors(bitmap);
      }

      if (this.templateLoaded) {
        const res = this.manifest?.camera_calibration.resolution;
        if (res) {
          // Always reset ROIs to original coordinates first, then scale
          this.resetROIsToOriginalCoordinates();
          
          if (this.scaleX !== 1.0) {
            for (const roiItem of this.rois) {
              this.applyScaling(roiItem, res, bitmap);
            }
            this.notify('ROIs scaled', `Applied ${this.scaleX.toFixed(2)}x${this.scaleY.toFixed(2)} scaling to match image size`, 'info');
          } else {
            this.notify('ROIs ready', 'No scaling needed - image matches template calibration', 'info');
          }
        }
      }

      this.fitCanvas();
      this.draw();
      this.renderThumbs();
      this.updateImageInfo();
      
      // Save undo state after image loading and scaling
      if (this.templateLoaded) {
        this.saveUndoState('Image loaded and scaled');
      }
      
      this.notify('Image loaded', `Successfully loaded ${bitmap.width}x${bitmap.height} image`, 'success');
      
      // Update guidance panel after image load
      this._guidanceDebounced();

    } catch (error) {
      this.notify('Image load failed', `Error: ${error.message}`, 'error');
    } finally {
      this.hideLoading();
    }
  }

  async handleManifestLoad(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      this.showLoading('Loading manifest...');
      const text = await file.text();
      this.manifest = JSON.parse(text);
      this.refreshTemplateSelect();

      const defaultId = this.templateSelect.value || this.manifest.default_template;
      this.loadTemplate(defaultId);

      this.notify('Manifest loaded', 'Templates loaded successfully', 'success');

    } catch (error) {
      this.notify('Manifest load failed', `Error parsing JSON: ${error.message}`, 'error');
    } finally {
      this.hideLoading();
    }
  }

  async loadServerManifest() {
    try {
      this.showLoading('Loading from server...');
      const response = await fetch('/api/roi/manifest');

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      this.manifest = await response.json();
      this.refreshTemplateSelect();

      const defaultId = this.templateSelect.value || this.manifest.default_template;
      this.loadTemplate(defaultId);

      this.notify('Server manifest loaded', 'Templates synchronized successfully', 'success');

    } catch (error) {
      this.notify('Server load failed', `Error: ${error.message}`, 'error');
    } finally {
      this.hideLoading();
    }
  }

  handleTemplateChange() {
    const templateId = this.templateSelect.value;
    if (templateId) {
      this.loadTemplate(templateId);
    }
  }

  // ===== CONTROLS SETUP =====
  setupControls() {
    if (this.zoomInBtn) {
      this.zoomInBtn.addEventListener('click', () => this.adjustZoom(1.25));
    }

    if (this.zoomOutBtn) {
      this.zoomOutBtn.addEventListener('click', () => this.adjustZoom(0.8));
    }

    if (this.resetCanvasBtn) {
      this.resetCanvasBtn.addEventListener('click', () => this.showResetConfirmation());
    }

    if (this.addRoiBtn) {
      this.addRoiBtn.addEventListener('click', () => this.addNewROI());
    }

    if (this.delRoiBtn) {
      this.delRoiBtn.addEventListener('click', () => this.deleteSelectedROI());
    }

    if (this.copyRoiBtn) {
      this.copyRoiBtn.addEventListener('click', () => this.copySelectedROI());
    }

    if (this.pasteRoiBtn) {
      this.pasteRoiBtn.addEventListener('click', () => this.pasteROI());
    }
    
    // Reset confirmation modal listeners
    if (this.resetConfirmBtn) {
      this.resetConfirmBtn.addEventListener('click', () => this.confirmReset());
    }
    
    if (this.resetCancelBtn) {
      this.resetCancelBtn.addEventListener('click', () => this.hideResetConfirmation());
    }
    
    // Close modal on overlay click
    if (this.resetConfirmModal) {
      this.resetConfirmModal.addEventListener('click', (e) => {
        if (e.target === this.resetConfirmModal) {
          this.hideResetConfirmation();
        }
      });
    }
  }

  // ===== TESTING SETUP =====
  setupTesting() {
    if (this.testOCRBtn) {
      this.testOCRBtn.addEventListener('click', () => this.testOCR());
    }

    if (this.testZNCCBtn) {
      this.testZNCCBtn.addEventListener('click', () => this.testZNCC());
    }
  }

  // ===== EXPORT SETUP =====
  setupExport() {
    if (this.exportManifestBtn) {
      this.exportManifestBtn.addEventListener('click', () => this.exportManifest());
    }

    if (this.exportPatchBtn) {
      this.exportPatchBtn.addEventListener('click', () => this.exportPatch());
    }

    if (this.exportROIConfigBtn) {
      this.exportROIConfigBtn.addEventListener('click', () => this.exportROIConfig());
    }
  }

  // ===== ENHANCED UI INTERACTIONS =====
  setupEnhancedUI() {
    // Tab switching
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        this.switchTab(tab);
      });
    });

    // Sidebar toggles
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      this.toggleSidebar('left');
    });

    document.getElementById('rightSidebarToggle')?.addEventListener('click', () => {
      this.toggleSidebar('right');
    });

    // Notification system
    this.notificationTrigger?.addEventListener('click', () => {
      this.notificationContainer?.classList.toggle('visible');
    });

    // ROI property changes
    if (this.roiNameInput) {
      this.roiNameInput.addEventListener('input', (e) => {
        if (this.selectedIndex >= 0) {
          this.rois[this.selectedIndex].name = e.target.value;
          this.renderROIList();
        }
      });
    }

    if (this.roiColorInput) {
      this.roiColorInput.addEventListener('change', (e) => {
        if (this.selectedIndex >= 0) {
          this.rois[this.selectedIndex].color = e.target.value;
          this.draw();
          this.renderROIList();
        }
      });
    }

    // Coordinate inputs with live updates
    [this.roiXInput, this.roiYInput, this.roiWidthInput, this.roiHeightInput].forEach(input => {
      if (input) {
        input.addEventListener('change', () => this.updateROIFromProperties());
      }
    });

    // Condition checkboxes
    if (this.condPromo) {
      this.condPromo.addEventListener('change', () => this.updateROIConditions());
    }

    if (this.condFirstEd) {
      this.condFirstEd.addEventListener('change', () => this.updateROIConditions());
    }

    if (this.condEra) {
      this.condEra.addEventListener('change', () => this.updateROIConditions());
    }

    // File input triggers
    document.querySelector('.file-select-btn')?.addEventListener('click', () => {
      this.triggerManifestLoad();
    });

    document.querySelector('.load-image-btn')?.addEventListener('click', () => {
      this.triggerImageLoad();
    });
    
    // State management buttons
    document.getElementById('saveStateBtn')?.addEventListener('click', () => {
      const saved = this.saveState();
      if (saved) {
        this.showNotification('Session saved successfully', 'success');
      }
    });
    
    document.getElementById('clearStateBtn')?.addEventListener('click', () => {
      if (confirm('Clear all saved sessions and cache? This cannot be undone.')) {
        this.clearPersistedState();
      }
    });
    
    // Auto-save toggle
    document.getElementById('autoSaveToggle')?.addEventListener('change', (e) => {
      this.autoSaveEnabled = e.target.checked;
      if (this.autoSaveEnabled) {
        this.startAutoSave();
        this.showNotification('Auto-save enabled', 'info');
      } else {
        this.stopAutoSave();
        this.showNotification('Auto-save disabled', 'info');
      }
    });
  }

  // ===== KEYBOARD SHORTCUTS =====
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 'z':
            e.preventDefault();
            this.undo();
            break;
          case 's':
            e.preventDefault();
            this.exportPatch();
            break;
          case 'o':
            e.preventDefault();
            this.triggerImageLoad();
            break;
          case 'n':
            e.preventDefault();
            this.addNewROI();
            break;
        }
      }
    });
  }

  // ===== CORE FUNCTIONALITY =====
  deviceToImageCoords(x, y) {
    const imgX = (x - this.panX) / this.zoom;
    const imgY = (y - this.panY) / this.zoom;
    return { x: imgX, y: imgY };
  }

  roundSnap(value) {
    return this.snapGridChk?.checked ? Math.round(value / 5) * 5 : value;
  }

  adjustZoom(factor) {
    this.zoom *= factor;
    this.draw();
  }

  fitCanvas() {
    if (!this.imageBitmap) return;

    const maxW = this.wrap.clientWidth - 20;
    const maxH = this.wrap.clientHeight - 20;
    const scaleX = maxW / this.imageBitmap.width;
    const scaleY = maxH / this.imageBitmap.height;
    this.zoom = Math.min(scaleX, scaleY);
    this.panX = (this.wrap.clientWidth - this.imageBitmap.width * this.zoom) / 2;
    this.panY = (this.wrap.clientHeight - this.imageBitmap.height * this.zoom) / 2;
  }

  calculateScalingFactors(imageBitmap, crop = null) {
    if (!this.manifest?.camera_calibration?.resolution) return;

    const calib = this.manifest.camera_calibration.resolution; // {width, height}
    // If the upstream pipeline crops/deskews before we get the image, pass a crop rect:
    // crop = { x: 0, y: 0, width: imageBitmap.width, height: imageBitmap.height }
    const targetW = crop ? crop.width : imageBitmap.width;
    const targetH = crop ? crop.height : imageBitmap.height;

    this.scaleX = targetW / calib.width;
    this.scaleY = targetH / calib.height;

    // If there is a crop, keep the offset so we can re-center correctly
    this.offsetX = crop ? crop.x : 0;
    this.offsetY = crop ? crop.y : 0;

    // Optional: warn if aspect differs; that signals upstream mismatch.
    const aspectDiff = Math.abs((calib.width / calib.height) - (targetW / targetH));
    if (aspectDiff > 0.01) {
      console.warn(`[SCALING] Aspect mismatch calib=${calib.width}x${calib.height} img=${targetW}x${targetH}`);
    }

    console.log(`[SCALING-DEBUG] Image: ${imageBitmap.width}x${imageBitmap.height}`);
    console.log(`[SCALING-DEBUG] Calibration: ${calib.width}x${calib.height}`);
    console.log(`[SCALING-DEBUG] Scaling: ${this.scaleX.toFixed(3)}x${this.scaleY.toFixed(3)}`);
  }

  applyScaling(roiItem, res, imageBitmap) {
    if (!roiItem.originalRect) return;

    // Scale about the top-left of the calibration frame, then add any crop offset
    const { scaleX, scaleY, offsetX = 0, offsetY = 0 } = this;

    roiItem.rect.width  = roiItem.originalRect.width  * scaleX;
    roiItem.rect.height = roiItem.originalRect.height * scaleY;
    roiItem.rect.x      = roiItem.originalRect.x * scaleX + offsetX;
    roiItem.rect.y      = roiItem.originalRect.y * scaleY + offsetY;

    // Clamp into the image bounds
    const maxW = imageBitmap.width, maxH = imageBitmap.height;
    roiItem.rect.x = Math.max(0, Math.min(roiItem.rect.x, maxW - 1));
    roiItem.rect.y = Math.max(0, Math.min(roiItem.rect.y, maxH - 1));
    roiItem.rect.width  = Math.max(1, Math.min(roiItem.rect.width,  maxW - roiItem.rect.x));
    roiItem.rect.height = Math.max(1, Math.min(roiItem.rect.height, maxH - roiItem.rect.y));

    console.log(`[SCALING-DEBUG] ${roiItem.key}: orig(${roiItem.originalRect.x},${roiItem.originalRect.y},${roiItem.originalRect.width},${roiItem.originalRect.height}) → scaled(${roiItem.rect.x.toFixed(0)},${roiItem.rect.y.toFixed(0)},${roiItem.rect.width.toFixed(0)},${roiItem.rect.height.toFixed(0)})`);
  }

  resetROIsToOriginalCoordinates() {
    // Reset all ROIs back to their original template coordinates
    for (const roiItem of this.rois) {
      if (roiItem.originalRect) {
        roiItem.rect.x = roiItem.originalRect.x;
        roiItem.rect.y = roiItem.originalRect.y;
        roiItem.rect.width = roiItem.originalRect.width;
        roiItem.rect.height = roiItem.originalRect.height;
      }
    }
    console.log(`[SCALING-DEBUG] Reset ${this.rois.length} ROIs to original template coordinates`);
  }

  // ===== UNDO SYSTEM =====
  saveUndoState(action = 'ROI modification') {
    if (!this.undoEnabled) return;

    // Create a deep copy of current ROI state
    const undoState = {
      action: action,
      timestamp: Date.now(),
      rois: this.rois.map(roi => ({
        key: roi.key,
        name: roi.name,
        rect: { ...roi.rect },
        originalRect: { ...roi.originalRect },
        visible: roi.visible,
        color: roi.color,
        conditions: roi.conditions ? { ...roi.conditions } : undefined
      })),
      selectedIndex: this.selectedIndex
    };

    this.undoHistory.push(undoState);

    // Limit undo history size
    if (this.undoHistory.length > this.maxUndoSteps) {
      this.undoHistory.shift();
    }

    console.log(`[UNDO] Saved state: ${action} (${this.undoHistory.length} states in history)`);
  }

  undo() {
    if (this.undoHistory.length === 0) {
      this.notify('Undo failed', 'No actions to undo', 'warning');
      return;
    }

    const previousState = this.undoHistory.pop();
    
    // Temporarily disable undo to prevent recursive saves
    this.undoEnabled = false;

    // Restore the previous state
    this.rois = previousState.rois.map(roi => ({
      key: roi.key,
      name: roi.name,
      rect: { ...roi.rect },
      originalRect: { ...roi.originalRect },
      visible: roi.visible,
      color: roi.color,
      conditions: roi.conditions ? { ...roi.conditions } : undefined
    }));

    this.selectedIndex = previousState.selectedIndex;

    // Update all UI elements
    this.renderROIList();
    this.updateROIProperties();
    this.draw();
    this.renderThumbs();
    this.updateLivePreview();

    this.notify('Undo successful', `Reverted: ${previousState.action}`, 'success');
    console.log(`[UNDO] Restored state: ${previousState.action} (${this.undoHistory.length} states remaining)`);

    // Re-enable undo
    this.undoEnabled = true;
  }

  clearUndoHistory() {
    this.undoHistory = [];
    console.log(`[UNDO] Cleared undo history`);
  }

  refreshTemplateSelect() {
    if (!this.manifest || !this.templateSelect) return;

    this.templateSelect.innerHTML = '<option value="">Select template...</option>';

    Object.values(this.manifest.templates).forEach(tpl => {
      const option = document.createElement('option');
      option.value = tpl.id;
      option.textContent = `${tpl.name} (${tpl.id})`;
      if (this.manifest.default_template === tpl.id) {
        option.selected = true;
      }
      this.templateSelect.appendChild(option);
    });
  }

  loadTemplate(templateId) {
    if (!this.manifest) return;

    const template = this.manifest.templates[templateId];
    if (!template) return;

    this.templateId = templateId;
    
    // Try to load template-specific state first
    const stateLoaded = this.loadTemplateSpecificState(templateId);
    
    if (!stateLoaded) {
      // No saved state, build fresh ROIs from template
      this.rois = this.buildROIItemsFromTemplate(template);
    }
    
    this.templateLoaded = true;

    if (this.imageLoaded && this.imageBitmap) {
      const res = this.manifest.camera_calibration.resolution;
      if (res) {
        // Recalculate scaling for current image
        this.calculateScalingFactors(this.imageBitmap);
        
        // Reset to template coordinates, then scale
        this.resetROIsToOriginalCoordinates();
        
        if (this.scaleX !== 1.0) {
          for (const roiItem of this.rois) {
            this.applyScaling(roiItem, res, this.imageBitmap);
          }
          this.notify('Template scaled', `Applied ${this.scaleX.toFixed(2)}x${this.scaleY.toFixed(2)} scaling to template ROIs`, 'info');
        } else {
          this.notify('Template ready', 'Template ROIs loaded at original scale', 'info');
        }
      }
    }

    this.selectedIndex = this.rois.findIndex(r => r.name === 'card_bounds');
    if (this.selectedIndex === -1) {
      this.selectedIndex = 0;
    }

    this.renderROIList();
    this.renderThumbs();
    this.updateROIProperties();
    this.draw();

    // Save initial state after template loads for undo baseline
    this.clearUndoHistory(); // Clear any previous history
    this.saveUndoState('Template loaded');

    this.notify('Template loaded', `Loaded ${template.name} template`, 'success');
    
    // Update guidance panel after template load
    this._guidanceDebounced();
  }

  buildROIItemsFromTemplate(template) {
    const list = [];
    const res = this.manifest?.camera_calibration.resolution || { width: 6000, height: 4000 };

    const add = (key, entry) => {
      if (!entry) return;

      const pick = Array.isArray(entry) ? entry[0] : entry;
      let rect;

      if (typeof pick.x_pct === 'number') {
        rect = {
          x: Math.round(pick.x_pct * res.width),
          y: Math.round(pick.y_pct * res.height),
          width: Math.round(pick.width_pct * res.width),
          height: Math.round(pick.height_pct * res.height),
        };
      } else {
        rect = {
          x: pick.x || 0,
          y: pick.y || 0,
          width: pick.width || 0,
          height: pick.height || 0,
        };
      }

      list.push({
        key,
        name: key,
        rect,
        originalRect: { ...rect }, // Preserve original template coordinates
        visible: true,
        color: this.defaultColorFor(key),
        conditions: pick.conditions,
      });
    };

    const keys = ['set_icon', 'bottom_band', 'regulation_mark', 'artwork', 'card_bounds', 'card_name', 'promo_star', 'first_edition_stamp'];
    const allKeys = Array.from(new Set([...keys, ...Object.keys(template.rois || {})]));

    for (const k of allKeys) {
      add(k, template.rois?.[k]);
    }

    return list;
  }

  defaultColorFor(key) {
    const colors = {
      set_icon: '#00d1b2',
      bottom_band: '#ff3860',
      regulation_mark: '#3273dc',
      artwork: '#ffdd57',
      card_bounds: '#23d160',
      card_name: '#b86bff',
      promo_star: '#ff9800',
      first_edition_stamp: '#795548',
    };
    return colors[key] || '#9e9e9e';
  }

  selectROI(index) {
    this.selectedIndex = index;
    this.updateROIProperties();
    this.updateLivePreview();
    this.renderROIList();
    
    // Update guidance panel after ROI selection
    this._guidanceDebounced();
  }

  updateROIProperties() {
    if (this.selectedIndex < 0 || !this.rois[this.selectedIndex]) {
      this.clearROISelection();
      return;
    }

    const roi = this.rois[this.selectedIndex];

    if (this.roiNameInput) {
      this.roiNameInput.value = roi.name;
    }

    if (this.roiColorInput) {
      this.roiColorInput.value = roi.color;
    }

    if (this.roiXInput) this.roiXInput.value = Math.round(roi.rect.x);
    if (this.roiYInput) this.roiYInput.value = Math.round(roi.rect.y);
    if (this.roiWidthInput) this.roiWidthInput.value = Math.round(roi.rect.width);
    if (this.roiHeightInput) this.roiHeightInput.value = Math.round(roi.rect.height);

    if (this.condPromo) this.condPromo.checked = roi.conditions?.promoOnly ?? false;
    if (this.condFirstEd) this.condFirstEd.checked = roi.conditions?.firstEditionOnly ?? false;
    if (this.condEra) {
      this.condEra.value = roi.conditions?.era || '';
    }

    this.updateROIStats();
  }

  clearROISelection() {
    if (this.roiNameInput) this.roiNameInput.value = '';
    if (this.roiColorInput) this.roiColorInput.value = '#9e9e9e';
    if (this.roiXInput) this.roiXInput.value = '';
    if (this.roiYInput) this.roiYInput.value = '';
    if (this.roiWidthInput) this.roiWidthInput.value = '';
    if (this.roiHeightInput) this.roiHeightInput.value = '';
    if (this.condPromo) this.condPromo.checked = false;
    if (this.condFirstEd) this.condFirstEd.checked = false;
    if (this.condEra) this.condEra.value = '';
  }

  updateROIFromProperties() {
    if (this.selectedIndex < 0) return;

    // Save undo state before manual coordinate change
    this.saveUndoState('Edit ROI coordinates');

    const roi = this.rois[this.selectedIndex];
    roi.rect.x = parseInt(this.roiXInput.value) || 0;
    roi.rect.y = parseInt(this.roiYInput.value) || 0;
    roi.rect.width = parseInt(this.roiWidthInput.value) || 0;
    roi.rect.height = parseInt(this.roiHeightInput.value) || 0;

    this.draw();
    this.renderThumbsDebounced();
    this.updateROIStats();
    
    // Update guidance panel after ROI change
    this._guidanceDebounced();
    
    // Auto-save state after property change
    this.saveState();
  }

  updateROIConditions() {
    if (this.selectedIndex < 0) return;

    const roi = this.rois[this.selectedIndex];
    roi.conditions = roi.conditions || {};

    roi.conditions.promoOnly = this.condPromo?.checked || false;
    roi.conditions.firstEditionOnly = this.condFirstEd?.checked || false;
    roi.conditions.era = this.condEra?.value || undefined;

    if (Object.keys(roi.conditions).length === 0) {
      roi.conditions = undefined;
    }
  }

  updateROIStats() {
    if (!this.imageBitmap || this.selectedIndex < 0) return;

    const roi = this.rois[this.selectedIndex];
    const totalPixels = this.imageBitmap.width * this.imageBitmap.height;
    const roiPixels = roi.rect.width * roi.rect.height;
    const coverage = ((roiPixels / totalPixels) * 100).toFixed(2);

    if (this.coverageStat) this.coverageStat.textContent = `${coverage}%`;
    if (this.aspectStat) this.aspectStat.textContent = `${(roi.rect.width / roi.rect.height).toFixed(2)}:1`;
    if (this.positionStat) this.positionStat.textContent = `(${Math.round(roi.rect.x)}, ${Math.round(roi.rect.y)})`;
  }

  updateImageInfo() {
    const dimensions = document.getElementById('imageInfo');
    const zoomIndicator = document.getElementById('zoomIndicator');

    if (dimensions && this.imageBitmap) {
      dimensions.innerHTML = `${this.imageBitmap.width} × ${this.imageBitmap.height}`;
    }

    if (zoomIndicator) {
      zoomIndicator.textContent = this.imageLoaded ? `${(this.zoom * 100).toFixed(0)}%` : '100%';
    }
  }

  updateUI() {
    if (this.matrixStatus && this.imageLoaded && this.zoom) {
      this.matrixStatus.textContent = `Zoom ${(this.zoom * 100).toFixed(0)}%`;
    }
  }

  // ===== ROI MANAGEMENT =====
  addNewROI() {
    // Save undo state before adding new ROI
    this.saveUndoState('Add ROI');

    const roi = {
      key: 'custom',
      name: 'Custom ROI',
      rect: { x: 100, y: 100, width: 200, height: 120 },
      originalRect: { x: 100, y: 100, width: 200, height: 120 }, // Add originalRect for consistency
      visible: true,
      color: '#9e9e9e',
    };

    this.rois.push(roi);
    this.selectedIndex = this.rois.length - 1;

    this.renderROIList();
    this.updateROIProperties();
    this.draw();

    this.notify('ROI added', 'New custom ROI created', 'success');
  }

  deleteSelectedROI() {
    if (this.selectedIndex < 0) return;

    // Save undo state before deleting ROI
    this.saveUndoState('Delete ROI');

    const roi = this.rois.splice(this.selectedIndex, 1)[0];
    this.selectedIndex = Math.min(this.selectedIndex, this.rois.length - 1);

    this.renderROIList();
    this.updateROIProperties();
    this.draw();
    this.renderThumbs();

    this.notify('ROI deleted', `Deleted ${roi.name}`, 'success');
  }

  copySelectedROI() {
    if (this.selectedIndex < 0) return;

    this.clipboardROI = JSON.parse(JSON.stringify(this.rois[this.selectedIndex]));
    this.notify('ROI copied', 'ROI copied to clipboard', 'success');
  }

  pasteROI() {
    if (!this.clipboardROI) return;

    // Save undo state before pasting ROI
    this.saveUndoState('Paste ROI');

    const copy = JSON.parse(JSON.stringify(this.clipboardROI));
    copy.name += ' (copy)';
    copy.rect.x += 10; // Offset slightly
    copy.rect.y += 10;

    this.rois.push(copy);
    this.selectedIndex = this.rois.length - 1;

    this.renderROIList();
    this.updateROIProperties();
    this.draw();
    this.renderThumbs();

    this.notify('ROI pasted', 'ROI pasted from clipboard', 'success');
  }

  // ===== RENDERING =====
  draw() {
    if (!this.ctx || !this.imageBitmap) return;

    const w = this.canvas.width = this.wrap.clientWidth;
    const h = this.canvas.height = this.wrap.clientHeight;

    this.ctx.clearRect(0, 0, w, h);

    // Draw image
    this.ctx.save();
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.setTransform(this.zoom, 0, 0, this.zoom, this.panX, this.panY);
    this.ctx.drawImage(this.imageBitmap, 0, 0);
    this.ctx.restore();

    // Draw grid
    if (this.snapGridChk?.checked) {
      this.drawGrid();
    }

    // Draw ROIs
    this.drawROIs();

    // Draw selection handles
    if (this.selectedIndex >= 0) {
      this.drawSelectionHandles();
    }

    this.updateUI();
  }

  drawGrid() {
    if (!this.ctx || !this.imageBitmap) return;

    this.ctx.save();
    this.ctx.setTransform(this.zoom, 0, 0, this.zoom, this.panX, this.panY);
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.lineWidth = 1 / this.zoom;

    const step = 50;
    for (let x = 0; x < this.imageBitmap.width; x += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.imageBitmap.height);
      this.ctx.stroke();
    }

    for (let y = 0; y < this.imageBitmap.height; y += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.imageBitmap.width, y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  drawROIs() {
    if (!this.ctx) return;

    this.rois.forEach((r, idx) => {
      if (!r.visible) return;

      this.ctx.save();
      this.ctx.setTransform(this.zoom, 0, 0, this.zoom, this.panX, this.panY);

      const col = r.color || '#9e9e9e';
      
      // Check if this ROI is highlighted (from thumbnail hover)
      const isHighlighted = idx === this.highlightedROI;
      const isSelected = idx === this.selectedIndex;
      
      // Set stroke style based on state
      if (isHighlighted) {
        this.ctx.strokeStyle = col;
        this.ctx.lineWidth = 4 / this.zoom; // Thicker line for highlight
        this.ctx.shadowColor = col;
        this.ctx.shadowBlur = 10 / this.zoom;
      } else {
        this.ctx.strokeStyle = col;
        this.ctx.lineWidth = 2 / this.zoom;
        this.ctx.shadowBlur = 0;
      }
      
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      this.ctx.strokeRect(r.rect.x, r.rect.y, r.rect.width, r.rect.height);

      // Fill for selected or highlighted
      if (isSelected) {
        this.ctx.fillStyle = 'rgba(255, 255, 0, 0.08)';
        this.ctx.fillRect(r.rect.x, r.rect.y, r.rect.width, r.rect.height);
      } else if (isHighlighted) {
        // Pulsing effect for highlighted ROI
        const pulse = Math.sin(Date.now() / 200) * 0.1 + 0.15;
        this.ctx.fillStyle = `rgba(${parseInt(col.slice(1, 3), 16)}, ${parseInt(col.slice(3, 5), 16)}, ${parseInt(col.slice(5, 7), 16)}, ${pulse})`;
        this.ctx.fillRect(r.rect.x, r.rect.y, r.rect.width, r.rect.height);
      }

      // Label with enhanced visibility for highlighted
      if (isHighlighted) {
        // Draw label background for better visibility
        const labelText = r.name || r.key;
        this.ctx.font = `bold ${16 / this.zoom}px sans-serif`;
        const metrics = this.ctx.measureText(labelText);
        const labelHeight = 20 / this.zoom;
        
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        this.ctx.fillRect(r.rect.x, r.rect.y - labelHeight - 4, metrics.width + 8, labelHeight + 4);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText(labelText, r.rect.x + 4, r.rect.y - 4);
      } else {
        // Normal label
        this.ctx.fillStyle = col;
        this.ctx.font = `${14 / this.zoom}px sans-serif`;
        this.ctx.fillText(r.name, r.rect.x + 4, r.rect.y + (14 / this.zoom) + 4);
      }

      this.ctx.restore();
    });
  }

  drawSelectionHandles() {
    if (!this.ctx || this.selectedIndex < 0) return;
    const roi = this.rois[this.selectedIndex];
    const handlesElement = document.getElementById('selectionHandles');
    if (!handlesElement) return;

    // Size/position in CSS pixels (screen space)
    const displayX = roi.rect.x * this.zoom + this.panX;
    const displayY = roi.rect.y * this.zoom + this.panY;
    const displayW = roi.rect.width * this.zoom;
    const displayH = roi.rect.height * this.zoom;

    handlesElement.style.display = 'block';
    handlesElement.style.left = `${displayX}px`;
    handlesElement.style.top = `${displayY}px`;
    handlesElement.style.width = `${displayW}px`;
    handlesElement.style.height = `${displayH}px`;

    // Auto-hide handles if the box is too small on screen
    const small = displayW < 40 || displayH < 40;
    handlesElement.classList.toggle('small', small);
  }

  renderROIList() {
    if (!this.roiList) return;

    this.roiList.innerHTML = '';

    this.rois.forEach((r, idx) => {
      const div = document.createElement('div');
      div.className = `roi-item ${idx === this.selectedIndex ? 'selected' : ''}`;
      div.dataset.index = idx;

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = r.visible;
      chk.addEventListener('change', () => {
        r.visible = chk.checked;
        this.draw();
        this.renderThumbsDebounced();
        this.updateROIStats();
      });

      const colorPreview = document.createElement('div');
      colorPreview.className = 'roi-color-preview';
      colorPreview.style.backgroundColor = r.color;

      const nameInput = document.createElement('input');
      nameInput.className = 'roi-name-input';
      nameInput.type = 'text';
      nameInput.value = r.name;
      nameInput.addEventListener('input', () => {
        r.name = nameInput.value;
        this.notify('ROI renamed', `Renamed to ${r.name}`, 'info');
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'roi-delete-btn';
      deleteBtn.innerHTML = '×';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedIndex = idx;
        this.deleteSelectedROI();
      });

      div.appendChild(chk);
      div.appendChild(colorPreview);
      div.appendChild(nameInput);
      div.appendChild(deleteBtn);

      div.addEventListener('click', () => this.selectROI(idx));
      this.roiList.appendChild(div);
    });

    this.updateROICount();
  }

  renderThumbs() {
    if (!this.thumbs || !this.imageBitmap) return;

    this.thumbs.innerHTML = '';

    // Add title if there are visible ROIs
    const visibleROIs = this.rois.filter(r => r.visible);
    if (visibleROIs.length > 0) {
      const stripHeader = document.createElement('div');
      stripHeader.className = 'thumbnail-strip-header';
      stripHeader.innerHTML = `<span class="strip-icon">🖼️</span> ROI Previews (${visibleROIs.length})`;
      this.thumbs.appendChild(stripHeader);
    }

    // Create scrollable container
    const thumbContainer = document.createElement('div');
    thumbContainer.className = 'thumbnail-container';

    this.rois.forEach((r, index) => {
      if (!r.visible) return;

      // Create wrapper for each thumbnail
      const thumbWrapper = document.createElement('div');
      thumbWrapper.className = 'thumb-wrapper';
      
      // Mark selected thumbnail
      if (index === this.selectedIndex) {
        thumbWrapper.classList.add('selected');
      }

      // Create canvas element
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 80;
      canvas.className = 'thumb-canvas';
      
      // Click handler for selection
      thumbWrapper.addEventListener('click', () => {
        const idx = this.rois.indexOf(r);
        if (idx >= 0) {
          this.selectROI(idx);
          this.renderThumbs(); // Re-render to update selection
          // Persist the selection
          this.saveState();
        }
      });
      
      // Hover handlers for visual correlation
      thumbWrapper.addEventListener('mouseenter', () => {
        this.highlightedROI = this.rois.indexOf(r);
        this.draw(); // Redraw canvas with highlight
      });
      
      thumbWrapper.addEventListener('mouseleave', () => {
        this.highlightedROI = -1;
        this.draw(); // Remove highlight
      });

      // Draw preview
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Calculate crop area with padding
        const padding = 20;
        const sx = Math.max(0, Math.round(r.rect.x - padding));
        const sy = Math.max(0, Math.round(r.rect.y - padding));
        const sw = Math.min(this.imageBitmap.width - sx, Math.round(r.rect.width + padding * 2));
        const sh = Math.min(this.imageBitmap.height - sy, Math.round(r.rect.height + padding * 2));

        // Fill background
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Calculate scaling to fit canvas
        const scale = Math.min(canvas.width / sw, canvas.height / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        const dx = (canvas.width - dw) / 2;
        const dy = (canvas.height - dh) / 2;

        // Draw image portion
        try {
          ctx.drawImage(this.imageBitmap, sx, sy, sw, sh, dx, dy, dw, dh);

          // Draw ROI highlight on preview
          const roiX = dx + ((r.rect.x - sx) * scale);
          const roiY = dy + ((r.rect.y - sy) * scale);
          const roiW = r.rect.width * scale;
          const roiH = r.rect.height * scale;

          // Draw border with ROI color
          ctx.strokeStyle = r.color || '#9e9e9e';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 3]);
          ctx.strokeRect(roiX, roiY, roiW, roiH);
          ctx.setLineDash([]);

          // Add semi-transparent overlay
          ctx.fillStyle = r.color ? `${r.color}33` : 'rgba(158, 158, 158, 0.2)';
          ctx.fillRect(roiX, roiY, roiW, roiH);
        } catch (e) {
          console.warn('Failed to draw thumbnail:', e);
        }
      }

      // Create label with ROI info
      const label = document.createElement('div');
      label.className = 'thumb-label';
      
      // Color indicator dot
      const colorDot = document.createElement('span');
      colorDot.className = 'thumb-color-dot';
      colorDot.style.backgroundColor = r.color || '#9e9e9e';
      
      // ROI name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'thumb-name';
      nameSpan.textContent = r.name || r.key || `ROI ${index + 1}`;
      
      // Size info
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'thumb-size';
      sizeSpan.textContent = `${Math.round(r.rect.width)}×${Math.round(r.rect.height)}`;
      
      label.appendChild(colorDot);
      label.appendChild(nameSpan);
      label.appendChild(sizeSpan);

      // Add selected indicator
      if (index === this.selectedIndex) {
        const selectedBadge = document.createElement('div');
        selectedBadge.className = 'thumb-selected-badge';
        selectedBadge.innerHTML = '✓';
        thumbWrapper.appendChild(selectedBadge);
      }

      // Assemble thumbnail
      thumbWrapper.appendChild(canvas);
      thumbWrapper.appendChild(label);
      
      // Add to container
      thumbContainer.appendChild(thumbWrapper);
    });

    // Show empty state if no visible ROIs
    if (visibleROIs.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'thumbnail-empty-state';
      emptyState.innerHTML = `
        <span class="empty-icon">📭</span>
        <span class="empty-text">No visible ROIs to preview</span>
      `;
      thumbContainer.appendChild(emptyState);
    }

    this.thumbs.appendChild(thumbContainer);
    
    // Update guidance panel after thumbs render
    this._guidanceDebounced();
  }

  updateROICount() {
    if (this.roiCount) {
      this.roiCount.textContent = `(${this.rois.length})`;
    }
  }

  ensurePreviewCanvas() {
    if (!this._previewCanvas) {
      this._previewCanvas = document.createElement('canvas');
      this._previewCanvas.className = 'preview-canvas';
    }
    return this._previewCanvas;
  }

  updateLivePreview() {
    if (!this.livePreview || this.selectedIndex < 0 || !this.imageBitmap) {
      return this.clearLivePreview();
    }

    // Reset container (avoid duplication)
    this.livePreview.innerHTML = '';

    // Reuse/create one canvas
    const canvas = this.ensurePreviewCanvas();
    const ctx = canvas.getContext('2d');

    // HiDPI crispness
    const dpr = window.devicePixelRatio || 1;

    const roi = this.rois[this.selectedIndex];
    const max = 200;
    const ar = roi.rect.width / Math.max(1, roi.rect.height);
    const wCss = ar >= 1 ? max : Math.max(1, Math.round(max * ar));
    const hCss = ar >= 1 ? Math.max(1, Math.round(max / ar)) : max;

    canvas.width = Math.round(wCss * dpr);
    canvas.height = Math.round(hCss * dpr);
    canvas.style.width = `${wCss}px`;
    canvas.style.height = `${hCss}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = Math.max(0, Math.round(roi.rect.x));
    const sy = Math.max(0, Math.round(roi.rect.y));
    const sw = Math.max(1, Math.round(roi.rect.width));
    const sh = Math.max(1, Math.round(roi.rect.height));

    ctx.drawImage(this.imageBitmap, sx, sy, sw, sh, 0, 0, wCss, hCss);

    const info = document.createElement('div');
    info.className = 'roi-preview-info';
    info.innerHTML = `<strong>${roi.name}</strong><br>${Math.round(roi.rect.width)}×${Math.round(roi.rect.height)}`;

    this.livePreview.appendChild(canvas);
    this.livePreview.appendChild(info);
  }

  clearLivePreview() {
    if (this.livePreview) {
      this.livePreview.innerHTML = `
        <div class="preview-placeholder">
          <span class="placeholder-icon">📷</span>
          <span class="placeholder-text">Select an ROI to preview</span>
        </div>
      `;
    }
  }

  // ===== TAB SYSTEM =====
  switchTab(tabName) {
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    this.currentTab = tabName;
    this.notify('Tab switched', `Switched to ${tabName} tab`, 'info');
  }

  // ===== SIDEBAR MANAGEMENT =====
  toggleSidebar(side) {
    this.sidebarCollapsed[side] = !this.sidebarCollapsed[side];
    const sidebar = document.querySelector(`.${side}-sidebar`);
    if (sidebar) {
      sidebar.classList.toggle('collapsed', this.sidebarCollapsed[side]);
    }
    
    // Save state after sidebar toggle
    this.saveState();
  }

  // ===== FILE UTILITIES =====
  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ===== NOTIFICATION SYSTEM =====
  initializeNotificationSystem() {
    this.notifications = [];
    this._notificationWindowMs = 3000; // dedupe window (ms)
    
    // Add accessibility attributes to container
    if (this.notificationContainer) {
      this.notificationContainer.setAttribute('role', 'status');
      this.notificationContainer.setAttribute('aria-live', 'polite');
    }
  }

  getNotificationKey(n) {
    // Identical-ness definition: same type+title+message (case-normalized)
    return `${n.type}::${n.title.toLowerCase()}::${n.message.toLowerCase()}`;
  }

  removeNotificationElement(div) {
    const tid = Number(div.dataset.timeoutId);
    if (tid) clearTimeout(tid);
    div.classList.add('fade-out');
    setTimeout(() => {
      const key = div.dataset.key;
      this.notifications = this.notifications.filter(n => n.key !== key);
      this.updateNotificationBadge(); // keep badge in sync
      div.remove();
    }, 300);
  }

  notify(title, message, type = 'info') {
    const now = Date.now();
    const n = { id: now, title, message, type, timestamp: now, count: 1 };
    n.key = this.getNotificationKey(n);

    // Dedupe: bump count if same key within window
    const recent = this.notifications.find(x => x.key === n.key && (now - x.timestamp) < this._notificationWindowMs);
    if (recent) {
      recent.count++;
      recent.timestamp = now; // slide the window forward
      // Update the visible badge if present
      const node = this.notificationContainer?.querySelector(`.notification[data-key="${recent.key}"] .notification-count`);
      if (node) node.textContent = `×${recent.count}`;
    } else {
      this.notifications.unshift(n);
      if (this.notifications.length > 50) this.notifications.pop(); // cap memory
      this.showNotification(n);
    }

    this.renderNotifications();
    this.updateNotificationBadge();
  }

  showNotification(n) {
    if (!this.notificationContainer) return;

    const div = document.createElement('div');
    div.className = `notification ${n.type}`;
    div.dataset.key = n.key;

    div.innerHTML = `
      <div class="notification-content">
        <div class="notification-title">${n.title}</div>
        <div class="notification-message">${n.message}</div>
      </div>
      <div class="notification-count" style="margin-left:8px; font-weight:600; opacity:0.8; white-space:nowrap;">
        ${n.count > 1 ? `×${n.count}` : ''}
      </div>
      <button class="notification-close" aria-label="Close">&times;</button>
    `;

    // Close handler clears this node's timer
    div.querySelector('.notification-close')?.addEventListener('click', () => {
      this.removeNotificationElement(div);
    });

    this.notificationContainer.appendChild(div);

    const timeout = setTimeout(() => this.removeNotificationElement(div), 5000);
    div.dataset.timeoutId = String(timeout);
  }

  renderNotifications() {
    // Update notification list in dropdown
  }

  updateNotificationBadge() {
    const count = this.notifications.filter(n => n.type === 'error' || n.type === 'warning').length;
    if (this.notificationBadge) {
      this.notificationBadge.textContent = count > 0 ? count.toString() : '';
      this.notificationBadge.style.display = count > 0 ? 'flex' : 'none';
    }
  }

  // ===== LOADING OVERLAY =====
  showLoading(message = 'Loading...') {
    if (this.loadingOverlay) {
      const textElement = this.loadingOverlay.querySelector('.loading-text');
      if (textElement) textElement.textContent = message;
      this.loadingOverlay.classList.add('show');
    }
  }

  hideLoading() {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.remove('show');
    }
  }

  // ===== TESTING =====
  async testOCR() {
    if (!this.imageDataUrl || this.selectedIndex < 0) {
      this.notify('Test failed', 'Please select an ROI and ensure an image is loaded', 'error');
      return;
    }

    try {
      const roi = this.rois[this.selectedIndex].rect;
      const ocrType = this.ocrTypeSel?.value || 'card_name';

      this.showLoading('Running OCR test...');

      const response = await fetch('/api/roi/ocr-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: this.imageDataUrl,
          roi,
          textType: ocrType,
        }),
      });

      const result = await response.json();

      if (this.testOut) {
        this.testOut.innerHTML = `
          <div class="result-item ${result.success ? 'success' : 'error'}">
            <div class="result-content">
              <strong>OCR Result:</strong>
              <div class="result-value">"${result.text || 'No text detected'}"</div>
              <div class="result-meta">Confidence: ${(result.confidence || 0).toFixed(2)}</div>
            </div>
          </div>
        `;
      }

      // Cache OCR confidence for guidance panel
      const key = this.rois[this.selectedIndex]?.key;
      if (key) {
        const m = this.roiMetrics.get(key) || {};
        m.lastOCR = Number(result.confidence || 0);
        m.ts = Date.now();
        this.roiMetrics.set(key, m);
        this._guidanceDebounced();
      }

      this.notify('OCR test complete', `Result: ${result.text || 'no text'}`, result.success ? 'success' : 'error');

    } catch (error) {
      this.notify('OCR test failed', `Error: ${error.message}`, 'error');
    } finally {
      this.hideLoading();
    }
  }

  async testZNCC() {
    if (!this.imageDataUrl || this.selectedIndex < 0) {
      this.notify('Test failed', 'Please select an ROI and ensure an image is loaded', 'error');
      return;
    }

    try {
      const roi = this.rois[this.selectedIndex].rect;

      this.showLoading('Running ZNCC test...');

      const response = await fetch('/api/roi/zncc-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: this.imageDataUrl,
          roi,
        }),
      });

      const result = await response.json();

      if (this.testOut) {
        this.testOut.innerHTML = `
          <div class="result-item ${result.success ? 'success' : 'error'}">
            <div class="result-content">
              <strong>ZNCC Matching:</strong>
              <div class="result-value">${result.matched ? 'PASS' : 'FAIL'}</div>
              <div class="result-meta">Confidence: ${(result.confidence || 0).toFixed(3)}</div>
            </div>
          </div>
        `;
      }

      // Cache ZNCC confidence for guidance panel
      const key = this.rois[this.selectedIndex]?.key;
      if (key) {
        const m = this.roiMetrics.get(key) || {};
        m.lastZNCC = Number(result.confidence || 0);
        m.ts = Date.now();
        this.roiMetrics.set(key, m);
        this._guidanceDebounced();
      }

      this.notify('ZNCC test complete', `${result.matched ? 'Match found' : 'No match'}`, result.success ? 'success' : 'success');

    } catch (error) {
      this.notify('ZNCC test failed', `Error: ${error.message}`, 'error');
    } finally {
      this.hideLoading();
    }
  }

  // ===== EXPORT FUNCTIONALITY =====
  exportManifest() {
    if (!this.manifest) {
      this.notify('Export failed', 'No manifest loaded', 'error');
      return;
    }

    const updatedManifest = this.exportCurrentManifest();
    const data = JSON.stringify(updatedManifest, null, 2);
    this.download('roi_manifest.json', data, 'application/json');

    this.notify('Manifest exported', 'Full manifest downloaded', 'success');
  }

  exportPatch() {
    if (!this.templateId) {
      this.notify('Export failed', 'No template loaded', 'error');
      return;
    }

    const patch = this.exportPatchJSON();
    const data = JSON.stringify(patch, null, 2);
    this.download(`roi_patch_${this.templateId}.json`, data, 'application/json');

    this.notify('Patch exported', 'Template patch downloaded', 'success');
  }

  exportROIConfig() {
    if (!this.templateId || this.rois.length === 0) {
      this.notify('Export failed', 'No ROI data available', 'error');
      return;
    }

    const roiConfig = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      template: this.templateId,
      rois: this.rois.map(roi => ({
        key: roi.key,
        name: roi.name,
        color: roi.color,
        visible: roi.visible,
        conditions: roi.conditions,
      })),
      image_info: this.imageLoaded ? {
        width: this.imageBitmap.width,
        height: this.imageBitmap.height,
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        scaleX: this.scaleX,
        scaleY: this.scaleY
      } : null
    };

    const data = JSON.stringify(roiConfig, null, 2);
    this.download('roi_config.json', data, 'application/json');

    this.notify('ROI Config exported', 'Configuration downloaded', 'success');
  }

  exportCurrentManifest() {
    if (!this.manifest || !this.templateId) {
      throw new Error('No manifest/template loaded');
    }

    const out = JSON.parse(JSON.stringify(this.manifest));
    const tpl = out.templates[this.templateId];
    tpl.rois = tpl.rois || {};

    const calib = out.camera_calibration.resolution;

    for (const r of this.rois) {
      const pct = {
        x_pct: r.rect.x / calib.width,
        y_pct: r.rect.y / calib.height,
        width_pct: r.rect.width / calib.width,
        height_pct: r.rect.height / calib.height,
      };
      const px = { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height };

      const entry = this.percentModeChk?.checked
        ? { ...pct, conditions: r.conditions }
        : { ...px, conditions: r.conditions };

      tpl.rois[r.key] = entry;
    }

    return out;
  }

  exportPatchJSON() {
    if (!this.templateId) return null;

    const calib = this.manifest?.camera_calibration.resolution || { width: 6000, height: 4000 };
    const updates = { rois: {}, conditions: {} };

    for (const r of this.rois) {
      const pct = {
        x_pct: Number((r.rect.x / calib.width).toFixed(6)),
        y_pct: Number((r.rect.y / calib.height).toFixed(6)),
        width_pct: Number((r.rect.width / calib.width).toFixed(6)),
        height_pct: Number((r.rect.height / calib.height).toFixed(6)),
      };
      const px = { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height };

      updates.rois[r.key] = this.percentModeChk?.checked
        ? { ...pct, conditions: r.conditions }
        : { ...px, conditions: r.conditions };
    }

    return {
      templateId: this.templateId,
      updates,
      exported_at: new Date().toISOString(),
    };
  }

  download(name, data, mime = 'application/json') {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ===== ADDITIONAL ENHANCED FEATURES =====

  // File loading triggers
  triggerImageLoad() {
    if (this.imgInput) {
      this.imgInput.click();
    }
  }

  triggerManifestLoad() {
    const fileInput = document.querySelector('input[type="file"][accept=".json"]');
    if (fileInput) {
      fileInput.click();
    }
  }

  // Enhanced effects initialization
  initializeEffects() {
    this.addDynamicBackground();
    this.addRotationEffects();
    this.addMicroInteractions();
  }

  addDynamicBackground() {
    // Add subtle background color changes based on active state
    this._bgInterval = setInterval(() => {
      if (this.imageLoaded && this.selectedIndex >= 0) {
        const hue = (Date.now() / 100) % 360;
        const root = document.documentElement;
        root.style.setProperty('--dynamic-accent', `hsl(${hue}, 70%, 60%)`);
      }
    }, 100);
  }

  addRotationEffects() {
    // Add subtle rotation effects for floating elements on hover
    const floatingElements = document.querySelectorAll('.floating-btn');
    floatingElements.forEach(element => {
      element.addEventListener('mouseenter', () => {
        element.style.transform = 'scale(1.1) rotate(5deg)';
      });
      element.addEventListener('mouseleave', () => {
        element.style.transform = 'scale(1) rotate(0deg)';
      });
    });
  }

  addMicroInteractions() {
    // Add ripple effects to buttons
    const buttons = document.querySelectorAll('button:not(.notification-close)');
    buttons.forEach(button => {
      button.addEventListener('click', this.createRippleEffect.bind(this));
    });
  }

  createRippleEffect(event) {
    const button = event.currentTarget;
    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';
    ripple.style.cssText = `
      position: absolute;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.4);
      transform: scale(0);
      animation: ripple 600ms linear;
      pointer-events: none;
    `;

    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';

    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  // ===== UTILITY METHODS =====
  debounce(func, delay) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
  }

  clampRect(rect) {
    const minW = 10, minH = 10;
    if (!this.imageBitmap) return rect;

    // Normalize if inverted (in case of cross-over drags)
    if (rect.width < 0) { rect.x += rect.width; rect.width = Math.abs(rect.width); }
    if (rect.height < 0){ rect.y += rect.height; rect.height = Math.abs(rect.height); }

    rect.width  = Math.max(minW, rect.width);
    rect.height = Math.max(minH, rect.height);

    const maxX = this.imageBitmap.width - rect.width;
    const maxY = this.imageBitmap.height - rect.height;

    rect.x = Math.max(0, Math.min(rect.x, maxX));
    rect.y = Math.max(0, Math.min(rect.y, maxY));
    return rect;
  }

  // ===== IMAGE QUALITY METRICS =====
  toGray(imgData) {
    const { data, width, height } = imgData;
    const gray = new Uint8ClampedArray(width * height);
    for (let i=0, j=0; i<data.length; i+=4, j++) {
      gray[j] = 0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2];
    }
    return { gray, width, height };
  }

  laplacianVariance(gray, width, height) {
    // 3x3 kernel: [0,1,0; 1,-4,1; 0,1,0]
    let sum=0, sum2=0, n=0;
    for (let y=1; y<height-1; y++) {
      for (let x=1; x<width-1; x++) {
        const i = y*width + x;
        const L = -4*gray[i] + gray[i-1] + gray[i+1] + gray[i-width] + gray[i+width];
        sum += L; sum2 += L*L; n++;
      }
    }
    const mean = sum / Math.max(1,n);
    const varL = (sum2 / Math.max(1,n)) - mean*mean;
    // Normalize roughly to 0..1 (empirical clamp)
    return Math.max(0, Math.min(1, varL / 5000));
  }

  otsuPercentBlack(gray, width, height) {
    // Otsu threshold + % below threshold
    const hist = new Uint32Array(256);
    for (let i=0; i<gray.length; i++) hist[gray[i]]++;
    const total = gray.length;

    let sum=0; for (let t=0;t<256;t++) sum += t * hist[t];
    let sumB=0, wB=0, wF=0, varMax=0, thr=0;
    for (let t=0;t<256;t++) {
      wB += hist[t]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) { varMax = varBetween; thr = t; }
    }
    let black=0;
    for (let i=0;i<gray.length;i++) if (gray[i] <= thr) black++;
    return black / Math.max(1,total); // 0..1
  }

  contrastStd(gray) {
    // Standard deviation of luminance normalized to 0..1
    let s=0, s2=0, n=gray.length;
    for (let i=0;i<n;i++) { s += gray[i]; s2 += gray[i]*gray[i]; }
    const mean = s / Math.max(1,n);
    const varv = Math.max(0, (s2/Math.max(1,n)) - mean*mean);
    return Math.min(1, Math.sqrt(varv)/255);
  }

  computeROIQuality(roi) {
    if (!this.imageBitmap) return null;

    const { x, y, width, height } = roi.rect;
    if (width < 8 || height < 8) return { contrast:0, sharpness:0, textDensity:0 };

    // Use OffscreenCanvas if available, else a single hidden canvas
    const off = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(Math.max(1,width), Math.max(1,height))
      : (this._scratchCanvas ||= (() => {
          const c = document.createElement('canvas'); c.style.display='none'; document.body.appendChild(c); return c;
        })());

    if (!(off instanceof OffscreenCanvas)) { off.width = Math.max(1,width); off.height = Math.max(1,height); }

    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(this.imageBitmap, Math.round(x), Math.round(y), Math.round(width), Math.round(height),
                   0, 0, Math.round(width), Math.round(height));
    const imgData = octx.getImageData(0, 0, Math.round(width), Math.round(height));
    const { gray, width: w, height: h } = this.toGray(imgData);

    const contrast = this.contrastStd(gray);
    const sharpness = this.laplacianVariance(gray, w, h);
    const textDensity = this.otsuPercentBlack(gray, w, h);

    return { contrast, sharpness, textDensity };
  }

  // ===== ROI SCORING AND RANKING =====
  scoreROI(key, metrics) {
    // Baseline weights
    let w = { contrast: 0.35, sharpness: 0.35, textDensity: 0.30, ocr: 0.15, zncc: 0.15 };

    // Text-centric ROIs
    if (key === 'card_name' || key === 'regulation_mark') {
      w = { contrast: 0.40, sharpness: 0.25, textDensity: 0.35, ocr: 0.25, zncc: 0.10 };
    }

    // Template/icon-centric ROIs
    if (key === 'set_icon' || key === 'promo_star' || key === 'first_edition_stamp') {
      w = { contrast: 0.25, sharpness: 0.35, textDensity: 0.20, ocr: 0.10, zncc: 0.30 };
    }

    // Normalize inputs to 0..1; metrics.* already in 0..1; missing conf → 0
    const ocr = Math.max(0, Math.min(1, metrics.lastOCR ?? 0));
    const zncc = Math.max(0, Math.min(1, metrics.lastZNCC ?? 0));

    const base = (w.contrast*metrics.contrast) + (w.sharpness*metrics.sharpness) + (w.textDensity*metrics.textDensity);
    const hist = (w.ocr*ocr) + (w.zncc*zncc);

    // Small bonus if ROI size is "reasonable" (avoids micro-ROIs)
    const sizeBonus = metrics._sizeOk ? 0.02 : 0;

    return Math.max(0, Math.min(1, base + hist + sizeBonus));
  }

  // Simple color badge mapping
  _badge(v) { 
    return v >= 0.75 ? 'badge-good' : v >= 0.45 ? 'badge-warn' : 'badge-bad'; 
  }

  updateGuidancePanel() {
    if (!this.guidanceChips || !this.imageBitmap) return;

    const items = [];
    for (const r of this.rois) {
      if (!r.visible) continue;

      // compute or reuse
      let m = this.roiMetrics.get(r.key);
      const stale = !m || !m.ts || (Date.now() - m.ts) > 2000 || m._w !== r.rect.width || m._h !== r.rect.height || m._x !== r.rect.x || m._y !== r.rect.y;

      if (stale) {
        const mm = this.computeROIQuality(r);
        if (!mm) continue;
        m = { ...m, ...mm, ts: Date.now(), _w: r.rect.width, _h: r.rect.height, _x: r.rect.x, _y: r.rect.y };
      }
      m._sizeOk = (r.rect.width * r.rect.height) >= 8000;
      m.score = this.scoreROI(r.key, m);
      this.roiMetrics.set(r.key, m);

      items.push({ key: r.key, name: r.name || r.key, color: r.color, metrics: m, idx: this.rois.indexOf(r) });
    }

    items.sort((a,b) => b.metrics.score - a.metrics.score);

    // Render chips
    this.guidanceChips.innerHTML = '';
    const topN = items.slice(0, Math.min(items.length, 8));
    for (const it of topN) {
      const chip = document.createElement('div');
      chip.className = 'guidance-chip';
      chip.innerHTML = `
        <span class="score-badge">${it.metrics.score.toFixed(2)}</span>
        <span>${it.name}</span>
        <span class="metric-badge ${this._badge(it.metrics.contrast)}">C:${it.metrics.contrast.toFixed(2)}</span>
        <span class="metric-badge ${this._badge(it.metrics.sharpness)}">S:${it.metrics.sharpness.toFixed(2)}</span>
        <span class="metric-badge ${this._badge(it.metrics.textDensity)}">T:${it.metrics.textDensity.toFixed(2)}</span>
        ${it.metrics.lastOCR  != null ? `<span class="metric-badge ${this._badge(it.metrics.lastOCR)}">OCR:${it.metrics.lastOCR.toFixed(2)}</span>` : ''}
        ${it.metrics.lastZNCC != null ? `<span class="metric-badge ${this._badge(it.metrics.lastZNCC)}">TMP:${it.metrics.lastZNCC.toFixed(2)}</span>` : ''}
      `;
      chip.addEventListener('click', () => { this.selectROI(it.idx); this.renderThumbs(); });
      this.guidanceChips.appendChild(chip);
    }
  }

  // ===== STATE PERSISTENCE =====
  saveState() {
    try {
      const state = {
        version: this.stateVersion,
        timestamp: Date.now(),
        
        // Template state
        templateId: this.templateId,
        manifest: this.manifest,
        rois: this.rois.map(roi => ({
          key: roi.key,
          name: roi.name,
          rect: { ...roi.rect },
          originalRect: roi.originalRect ? { ...roi.originalRect } : null,
          visible: roi.visible,
          color: roi.color,
          conditions: { ...roi.conditions }
        })),
        
        // UI state
        selectedIndex: this.selectedIndex,
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        currentTab: this.currentTab,
        sidebarCollapsed: { ...this.sidebarCollapsed },
        
        // User preferences
        snapGrid: this.snapGridChk?.checked || false,
        percentMode: this.percentModeChk?.checked || false,
        
        // Image state (lightweight reference)
        imageLoaded: this.imageLoaded,
        imageDataUrl: this.imageLoaded && this.imageDataUrl ? this.imageDataUrl.substring(0, 100) : null, // Store partial for validation
        
        // Scaling info
        scaleX: this.scaleX,
        scaleY: this.scaleY
      };
      
      localStorage.setItem('roi_tool_state', JSON.stringify(state));
      
      // Also save template-specific state
      if (this.templateId) {
        localStorage.setItem(`roi_tool_template_${this.templateId}`, JSON.stringify({
          rois: state.rois,
          selectedIndex: state.selectedIndex,
          timestamp: Date.now()
        }));
      }
      
      // Update last save time in UI
      const lastSaveElement = document.getElementById('lastSaveTime');
      if (lastSaveElement) {
        const now = new Date();
        lastSaveElement.textContent = `Last saved: ${now.toLocaleTimeString()}`;
      }
      
      return true;
    } catch (error) {
      console.error('Failed to save state:', error);
      return false;
    }
  }

  loadPersistedState() {
    try {
      const savedState = localStorage.getItem('roi_tool_state');
      if (!savedState) return false;
      
      const state = JSON.parse(savedState);
      
      // Validate version
      if (state.version !== this.stateVersion) {
        console.warn('State version mismatch, skipping load');
        return false;
      }
      
      // Restore template state
      if (state.manifest) {
        this.manifest = state.manifest;
        this.templateId = state.templateId;
        this.templateLoaded = true;
        
        // Restore template dropdown
        if (this.templateSelect && state.templateId) {
          this.refreshTemplateSelect();     // was: this.populateTemplateDropdown();
          this.templateSelect.value = state.templateId;
          
          // Fallback if restored templateId isn't present (manifest changed)
          if (!Array.from(this.templateSelect.options).some(o => o.value === state.templateId)) {
            this.templateSelect.value = this.manifest?.default_template || '';
          }
        }
      }
      
      // Restore ROIs with proper object construction
      if (state.rois && state.rois.length > 0) {
        this.rois = state.rois.map(roiData => {
          const roi = new ROIItem(
            roiData.key,
            roiData.name,
            roiData.rect,
            roiData.visible,
            roiData.color,
            roiData.conditions
          );
          // Preserve original rect for scaling
          if (roiData.originalRect) {
            roi.originalRect = roiData.originalRect;
          }
          return roi;
        });
        this.renderROIList();
      }
      
      // Restore UI state
      this.selectedIndex = state.selectedIndex || -1;
      this.zoom = state.zoom || 0.2;
      this.panX = state.panX || 0;
      this.panY = state.panY || 0;
      this.currentTab = state.currentTab || 'canvas';
      
      // Restore sidebar collapse states
      if (state.sidebarCollapsed) {
        this.sidebarCollapsed = state.sidebarCollapsed;
        // Apply collapse states to UI
        if (this.sidebarCollapsed.left) {
          document.querySelector('.left-sidebar')?.classList.add('collapsed');
        }
        if (this.sidebarCollapsed.right) {
          document.querySelector('.right-sidebar')?.classList.add('collapsed');
        }
      }
      
      // Restore user preferences
      if (this.snapGridChk) this.snapGridChk.checked = state.snapGrid || false;
      if (this.percentModeChk) this.percentModeChk.checked = state.percentMode || false;
      
      // Restore scaling info
      this.scaleX = state.scaleX || 1.0;
      this.scaleY = state.scaleY || 1.0;
      
      // Update UI to reflect restored state
      if (this.selectedIndex >= 0 && this.selectedIndex < this.rois.length) {
        this.selectROI(this.selectedIndex);
      }
      
      this.showNotification('Previous session restored', 'success');
      this.draw();
      
      return true;
    } catch (error) {
      console.error('Failed to load persisted state:', error);
      return false;
    }
  }

  loadTemplateSpecificState(templateId) {
    try {
      const savedState = localStorage.getItem(`roi_tool_template_${templateId}`);
      if (!savedState) return false;
      
      const state = JSON.parse(savedState);
      
      // Check if state is recent (within 24 hours)
      const stateAge = Date.now() - state.timestamp;
      if (stateAge > 24 * 60 * 60 * 1000) {
        console.log('Template state too old, ignoring');
        return false;
      }
      
      // Restore ROIs for this specific template
      if (state.rois && state.rois.length > 0) {
        this.rois = state.rois.map(roiData => {
          const roi = new ROIItem(
            roiData.key,
            roiData.name,
            roiData.rect,
            roiData.visible,
            roiData.color,
            roiData.conditions
          );
          if (roiData.originalRect) {
            roi.originalRect = roiData.originalRect;
          }
          return roi;
        });
        
        this.selectedIndex = state.selectedIndex || -1;
        this.renderROIList();
        this.draw();
        
        this.showNotification(`Template state restored from ${new Date(state.timestamp).toLocaleString()}`, 'info');
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to load template-specific state:', error);
      return false;
    }
  }

  clearPersistedState() {
    try {
      // Clear main state
      localStorage.removeItem('roi_tool_state');
      
      // Clear all template-specific states
      const keys = Object.keys(localStorage);
      keys.forEach(key => {
        if (key.startsWith('roi_tool_template_')) {
          localStorage.removeItem(key);
        }
      });
      
      this.showNotification('All saved states cleared', 'info');
      return true;
    } catch (error) {
      console.error('Failed to clear persisted state:', error);
      return false;
    }
  }

  startAutoSave() {
    if (!this.autoSaveEnabled) return;
    
    // Clear existing timer
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }
    
    // Set up auto-save interval
    this.autoSaveTimer = setInterval(() => {
      if (this.templateLoaded || this.imageLoaded) {
        const saved = this.saveState();
        if (saved) {
          console.log('Auto-saved state at', new Date().toLocaleTimeString());
        }
      }
    }, this.autoSaveInterval);
  }

  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  // ===== LIFECYCLE MANAGEMENT =====
  destroy() {
    // Stop auto-save
    this.stopAutoSave();
    
    // Save final state
    this.saveState();
    
    // Clean up event listeners and timers
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    if (this._bgInterval) {
      clearInterval(this._bgInterval);
    }

    // Clean up global pointer event listeners if they were added
    if (this.boundOnPointerMove) {
      window.removeEventListener('pointermove', this.boundOnPointerMove);
      this.boundOnPointerMove = null;
    }
    if (this.boundOnPointerUp) {
      window.removeEventListener('pointerup', this.boundOnPointerUp);
      this.boundOnPointerUp = null;
    }
    if (this.boundEndDragSafely) {
      this.canvas?.removeEventListener('lostpointercapture', this.boundEndDragSafely);
      this.canvas?.removeEventListener('pointercancel', this.boundEndDragSafely);
      this.boundEndDragSafely = null;
    }

    // Release pointer capture just in case
    try {
      if (this._lastPointerId && this.canvas) {
        this.canvas.releasePointerCapture?.(this._lastPointerId);
      }
    } catch (_) {
      // Ignore InvalidPointerId errors
    }

    // Clean up resize event listeners if registered
    if (this._onPointerMove) {
      window.removeEventListener('pointermove', this._onPointerMove);
      this._onPointerMove = null;
    }

    // Remove all dynamically added elements
    if (this.notificationContainer) {
      this.notificationContainer.innerHTML = '';
    }

    // Reset canvas
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
};

// ===== SINGLETON INSTANCE MANAGEMENT =====
let instance = null;

function initializeEnhancedROITool() {
  if (!instance) {
    instance = new EnhancedROITool();
    window.enhancedROITool = instance; // <-- ensure global access
    instance.initializeEffects();
  }
  return instance;
}

// ===== CSS ANIMATIONS =====
const styleSheet = document.createElement('style');
styleSheet.textContent = `
@keyframes ripple {
  to {
    transform: scale(2);
    opacity: 0;
  }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 5px rgba(99, 102, 241, 0.5); }
  50% { box-shadow: 0 0 20px rgba(99, 102, 241, 0.8); }
}

.selected-roi-item {
  animation: pulse-glow 1.5s infinite;
}

.zoom-indicator {
  transition: all 0.3s ease;
}

.zoom-indicator.updating {
  color: var(--accent-primary);
  transform: scale(1.1);
}

/* Selection overlay holds 8 handles */
#selectionHandles {
  position: absolute;
  pointer-events: none;      /* overlay itself ignores clicks … */
  box-sizing: border-box;
  border: 1px dashed rgba(255,255,255,0.6);
  z-index: 10;              /* above canvas */
  touch-action: none;        /* prevent browser gestures */
}

#selectionHandles .roi-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #fff;
  border: 1px solid #222;
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.2);
  transform: translate(-50%, -50%);  /* place by center */
  pointer-events: auto;              /* …but handles receive them */
  touch-action: none;                /* prevent scrolling on handle drags */
}

#selectionHandles .roi-handle.nw, #selectionHandles .roi-handle.se { cursor: nwse-resize; }
#selectionHandles .roi-handle.ne, #selectionHandles .roi-handle.sw { cursor: nesw-resize; }
#selectionHandles .roi-handle.n,  #selectionHandles .roi-handle.s  { cursor: ns-resize; }
#selectionHandles .roi-handle.e,  #selectionHandles .roi-handle.w  { cursor: ew-resize; }

/* Hide handles when overlay is too small (zoomed way out) */
#selectionHandles.small .roi-handle { display: none; }

/* Canvas touch safety */
#imageCanvas { touch-action: none; }

/* Template select dropdown styling for better contrast */
#templateSelect {
  background: var(--bg-primary, #1a1a1a);
  color: var(--text-primary, #e5e5e5);
  border: 1px solid var(--border-color, #404040);
  border-radius: 4px;
  padding: 4px 8px;
}

#templateSelect option {
  background: var(--bg-primary, #1a1a1a);
  color: var(--text-primary, #e5e5e5);
  padding: 4px 8px;
}

#templateSelect option:hover {
  background: var(--accent-primary, #6366f1);
  color: white;
}

/* Improve all select elements for consistency */
select {
  background: var(--bg-primary, #1a1a1a);
  color: var(--text-primary, #e5e5e5);
  border: 1px solid var(--border-color, #404040);
  border-radius: 4px;
  padding: 4px 8px;
}

select option {
  background: var(--bg-primary, #1a1a1a);
  color: var(--text-primary, #e5e5e5);
  padding: 4px 8px;
}

/* Guidance Panel Styles */
.guidance-panel { 
  display: flex; 
  flex-direction: column; 
  gap: 6px; 
  margin: 8px 0 4px; 
}
.guidance-header { 
  display: flex; 
  align-items: center; 
  justify-content: space-between; 
  font-size: 12px; 
  opacity: 0.8; 
}
.guidance-title { 
  font-weight: 600; 
  letter-spacing: 0.2px; 
}
.guidance-chips { 
  display: flex; 
  flex-wrap: wrap; 
  gap: 6px; 
}
.guidance-chip {
  display: inline-flex; 
  align-items: center; 
  gap: 6px; 
  padding: 6px 8px; 
  border-radius: 10px;
  background: rgba(255,255,255,0.06); 
  border: 1px solid rgba(255,255,255,0.1); 
  cursor: pointer;
  transition: transform 0.1s ease, background 0.2s ease; 
  user-select: none;
}
.guidance-chip:hover { 
  transform: translateY(-1px); 
}
.score-badge { 
  font-weight: 700; 
  font-variant-numeric: tabular-nums; 
}
.metric-badge { 
  font-size: 11px; 
  opacity: 0.8; 
}
.badge-good { color: #4ade80; }   /* green */
.badge-warn { color: #fbbf24; }   /* amber */
.badge-bad  { color: #f87171; }   /* red */
`;
document.head.appendChild(styleSheet);

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeEnhancedROITool);
} else {
  initializeEnhancedROITool();
}

// Export the class for potential external use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EnhancedROITool, initializeEnhancedROITool };
}

// ===== ADDITIONAL LOCAL UTILITIES =====

// Add global keyboard shortcuts
document.addEventListener('DOMContentLoaded', () => {
  // Add global Enter key support for focused inputs
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement) {
      const element = document.activeElement;
      if (element.tagName === 'INPUT' && element.type === 'number') {
        element.blur(); // Trigger change event
      }
    }
  });

  // Add ESC key to deselect current ROI
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.enhancedROITool) {
      window.enhancedROITool.selectedIndex = -1;
      window.enhancedROITool.draw();
      window.enhancedROITool.clearROISelection();
      window.enhancedROITool.notify('ROI deselected', 'No ROI selected', 'info');
    }
  });
});

// Add to window for global access
window.EnhancedROITool = EnhancedROITool;
window.initializeEnhancedROITool = initializeEnhancedROITool;

// ===== ENHANCED INITIALIZATION =====
document.addEventListener('DOMContentLoaded', () => {
  // Add any additional global event handlers here

  // Monitor for window resize and throttle updates
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (window.enhancedROITool) {
        window.enhancedROITool.handleResize();
      }
    }, 250);
  });

  // Add touch support for mobile devices
  let touchStartX, touchStartY;
  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  });

  document.addEventListener('touchmove', (e) => {
    if (!touchStartX || !touchStartY) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;

    // Add multitouch zoom support here if needed
    // For now, basic touch move handling
  });
});
