/**
 * @deprecated This ROI Calibration Tool is deprecated as of September 2, 2025
 * 
 * MIGRATION NOTICE:
 * Please use the Enhanced ROI Tool instead:
 * → Location: /public/dashboard/roi-calibration-enhanced.html
 * → Features: Modern UX, undo system, improved scaling, better performance
 * → Compatibility: 100% backward compatible with existing templates
 * 
 * This legacy tool will be removed in CardMint v3.0
 * See: /docs/ROI-DEPRECATION-PLAN.md for full migration guide
 * 
 * @legacy ROI Calibration Tool - interactive canvas editor
 */

type Rect = { x: number; y: number; width: number; height: number };
type Conditions = { promoOnly?: boolean; firstEditionOnly?: boolean; era?: 'classic'|'neo'|'modern'|'promo' };

type ROIEntry = (Rect | { x_pct:number;y_pct:number;width_pct:number;height_pct:number }) & { conditions?: Conditions };
type ROIs = Record<string, ROIEntry | ROIEntry[]>;

type Manifest = {
  version: string;
  camera_calibration: { resolution: { width:number; height:number }; last_calibrated: string; calibration_card: string };
  default_template: string;
  templates: Record<string, { id:string; name:string; description:string; layout_hint:string; era:string; rotation_deg:number; confidence:number; rois: ROIs; }>;
};

const COLORS: Record<string, string> = {
  set_icon: '#00d1b2',
  bottom_band: '#ff3860',
  regulation_mark: '#3273dc',
  artwork: '#ffdd57',
  card_bounds: '#23d160',
  card_name: '#b86bff',
  promo_star: '#ff9800',
  first_edition_stamp: '#795548',
  other: '#9e9e9e',
};

type ROIItem = {
  key: string; // canonical roi key
  name: string; // editable label
  rect: Rect;
  visible: boolean;
  color: string;
  conditions?: Conditions;
};

// DEPRECATION WARNING: Show immediately when script loads
console.warn('🚨 DEPRECATED: Legacy ROI Calibration Tool');
console.warn('📍 This tool will be removed in CardMint v3.0');
console.warn('✨ Please migrate to Enhanced ROI Tool: /public/dashboard/roi-calibration-enhanced.html');
console.warn('📋 Migration guide: /docs/ROI-DEPRECATION-PLAN.md');

const DEFAULT_KEYS = ['set_icon','bottom_band','regulation_mark','artwork','card_bounds','card_name','promo_star','first_edition_stamp'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// DOM elements - will be initialized when DOM is ready
let imgInput: HTMLInputElement;
let manifestInput: HTMLInputElement;
let loadServerManifestBtn: HTMLButtonElement;
let templateSelect: HTMLSelectElement;
let canvas: HTMLCanvasElement;
let wrap: HTMLDivElement;
let roiList: HTMLDivElement;
let addRoiBtn: HTMLButtonElement;
let delRoiBtn: HTMLButtonElement;
let copyRoiBtn: HTMLButtonElement;
let pasteRoiBtn: HTMLButtonElement;
let thumbs: HTMLDivElement;
let zoomInBtn: HTMLButtonElement;
let zoomOutBtn: HTMLButtonElement;
let snapGridChk: HTMLInputElement;
let percentModeChk: HTMLInputElement;
let condPromo: HTMLInputElement;
let condFirstEd: HTMLInputElement;
let condEra: HTMLSelectElement;
let testOCRBtn: HTMLButtonElement;
let ocrTypeSel: HTMLSelectElement;
let testZNCCBtn: HTMLButtonElement;
let testOut: HTMLDivElement;
let exportManifestBtn: HTMLButtonElement;
let exportPatchBtn: HTMLButtonElement;
let statusSpan: HTMLSpanElement;
let ctx: CanvasRenderingContext2D;

let imageBitmap: ImageBitmap | null = null;
let imageDataUrl: string | null = null;
let manifest: Manifest | null = null;
let templateId: string | null = null;
let rois: ROIItem[] = [];
let selectedIndex: number = -1;
let zoom = 0.2;
let panX = 0, panY = 0;
let scaleX = 1.0, scaleY = 1.0;
let imageLoaded = false;
let templateLoaded = false;
let dragging = false;
let dragMode: 'move'|'resize'|null = null;
let dragStart = {x:0, y:0};
let dragRectStart: Rect | null = null;
let clipboardROI: ROIItem | null = null;

function roundSnap(v:number): number {
  if (!snapGridChk.checked) return v;
  return Math.round(v / 5) * 5;
}

function deviceToImageCoords(x:number, y:number): {x:number; y:number} {
  const imgX = (x - panX) / zoom;
  const imgY = (y - panY) / zoom;
  return { x: imgX, y: imgY };
}

function fitCanvas() {
  if (!imageBitmap) return;
  const maxW = wrap.clientWidth - 20;
  const maxH = wrap.clientHeight - 20;
  const scaleX = maxW / imageBitmap.width;
  const scaleY = maxH / imageBitmap.height;
  zoom = Math.min(scaleX, scaleY);
  panX = (wrap.clientWidth - imageBitmap.width * zoom) / 2;
  panY = (wrap.clientHeight - imageBitmap.height * zoom) / 2;
}

function calculateScalingFactors(imageBitmap: ImageBitmap): void {
  if (!manifest) return;
  const res = manifest.camera_calibration.resolution;
  // Stub detection: assume card is 80% of image size, centered
  const detectedWidth = imageBitmap.width * 0.8;
  const detectedHeight = imageBitmap.height * 0.8;
  scaleX = detectedWidth / res.width;
  scaleY = detectedHeight / res.height;
  console.log(`[SCALING-DEBUG] Image dimensions: ${imageBitmap.width}x${imageBitmap.height} (aspect: ${(imageBitmap.width / imageBitmap.height).toFixed(3)})`);
  console.log(`[SCALING-DEBUG] Detected size: ${detectedWidth.toFixed(0)}x${detectedHeight.toFixed(0)} (aspect: ${(detectedWidth / detectedHeight).toFixed(3)})`);
  console.log(`[SCALING-DEBUG] Calibration size: ${res.width}x${res.height} (aspect: ${(res.width / res.height).toFixed(3)})`);
  console.log(`[SCALING-DEBUG] Scaling factors: scaleX=${scaleX.toFixed(3)}, scaleY=${scaleY.toFixed(3)} (ratio: ${(scaleX / scaleY).toFixed(3)})`);
  console.log(`Detected scaling: scaleX=${scaleX.toFixed(3)}, scaleY=${scaleY.toFixed(3)}, detectedSize=${detectedWidth.toFixed(0)}x${detectedHeight.toFixed(0)}, calibSize=${res.width}x${res.height}`);
}

function applyScaling(rect: Rect, res: {width:number; height:number}, imageBitmap: ImageBitmap): void {
  const originalAspect = rect.width / rect.height;
  console.log(`[SCALING-DEBUG] Original ROI rect: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, aspect=${originalAspect.toFixed(3)}`);
  const midX = res.width / 2;
  const midY = res.height / 2;
  const imgMidX = imageBitmap.width / 2;
  const imgMidY = imageBitmap.height / 2;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const newCenterX = (centerX - midX) * scaleX + imgMidX;
  const newCenterY = (centerY - midY) * scaleY + imgMidY;
  rect.width = rect.width * scaleX;
  rect.height = rect.height * scaleY;
  rect.x = newCenterX - rect.width / 2;
  rect.y = newCenterY - rect.height / 2;
  const scaledAspect = rect.width / rect.height;
  console.log(`[SCALING-DEBUG] Scaled ROI rect: x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, aspect=${scaledAspect.toFixed(3)}, aspect_change=${(scaledAspect / originalAspect).toFixed(3)}`);
}

function draw() {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0,0,w,h);
  if (!imageBitmap) return;
  // image
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
  ctx.drawImage(imageBitmap, 0, 0);
  // grid overlay (light)
  if (snapGridChk.checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1 / zoom;
    const step = 50;
    for (let x = 0; x < imageBitmap.width; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,imageBitmap.height); ctx.stroke(); }
    for (let y = 0; y < imageBitmap.height; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(imageBitmap.width,y); ctx.stroke(); }
  }
  // ROIs
  rois.forEach((r, idx) => {
    if (!r.visible) return;
    const col = r.color || COLORS.other;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2 / zoom;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.strokeRect(r.rect.x, r.rect.y, r.rect.width, r.rect.height);
    if (idx === selectedIndex) {
      ctx.fillStyle = 'rgba(255,255,0,0.08)';
      ctx.fillRect(r.rect.x, r.rect.y, r.rect.width, r.rect.height);
      // handles
      const hs = 8 / zoom;
      const corners = [
        [r.rect.x, r.rect.y],
        [r.rect.x + r.rect.width, r.rect.y],
        [r.rect.x + r.rect.width, r.rect.y + r.rect.height],
        [r.rect.x, r.rect.y + r.rect.height],
      ];
      ctx.fillStyle = col;
      for (const [hx, hy] of corners) { ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs); }
    }
    // label
    ctx.fillStyle = col;
    ctx.font = `${14/zoom}px sans-serif`;
    ctx.fillText(r.name || r.key, r.rect.x + 4, r.rect.y + 14/zoom + 2);
  });
  ctx.restore();
  statusSpan.textContent = imageBitmap ? `Zoom ${(zoom*100).toFixed(0)}%` : '';
}

function defaultColorFor(key:string): string {
  return COLORS[key] || COLORS.other;
}

function buildROIItemsFromTemplate(tpl: any): ROIItem[] {
  const list: ROIItem[] = [];
  const res = manifest?.camera_calibration.resolution || { width: 6000, height: 4000 };
  const add = (key: string, entry: ROIEntry | undefined) => {
    if (!entry) return;
    const pick = Array.isArray(entry) ? entry[0] as any : entry as any;
    let rect: Rect;
    if (typeof pick.x_pct === 'number') {
      // percent of calibration
      rect = {
        x: Math.round(pick.x_pct * res.width),
        y: Math.round(pick.y_pct * res.height),
        width: Math.round(pick.width_pct * res.width),
        height: Math.round(pick.height_pct * res.height),
      };
    } else {
      rect = { x: pick.x || 0, y: pick.y || 0, width: pick.width || 0, height: pick.height || 0 };
    }
    list.push({ key, name: key, rect, visible: true, color: defaultColorFor(key), conditions: pick.conditions });
  };
  const keys = Array.from(new Set([...DEFAULT_KEYS, ...Object.keys(tpl.rois || {})]));
  for (const k of keys) add(k, tpl.rois?.[k]);
  return list;
}

function renderROIList() {
  roiList.innerHTML = '';
  rois.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'roi-item';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = r.visible; chk.onchange = () => { r.visible = chk.checked; draw(); renderThumbs(); };
    const color = document.createElement('span'); color.className = 'legend'; color.style.backgroundColor = r.color;
    const name = document.createElement('input'); name.type = 'text'; name.value = r.name; name.oninput = () => r.name = name.value;
    const lock = document.createElement('button'); lock.textContent = 'Lock'; lock.onclick = () => {/* future */};
    div.onclick = () => { selectedIndex = idx; draw(); };
    div.append(chk, color, name);
    roiList.appendChild(div);
  });
}

function renderThumbs() {
  thumbs.innerHTML = '';
  if (!imageBitmap) return;
  rois.forEach((r) => {
    if (!r.visible) return;
    const c = document.createElement('canvas'); c.width = 96; c.height = 64; c.className = 'thumb';
    const tctx = c.getContext('2d')!;
    const sx = Math.max(0, Math.round(r.rect.x));
    const sy = Math.max(0, Math.round(r.rect.y));
    const sw = Math.max(1, Math.round(r.rect.width));
    const sh = Math.max(1, Math.round(r.rect.height));
    const tmp = new OffscreenCanvas(sw, sh);
    const tmpCtx = tmp.getContext('2d')!;
    tmpCtx.drawImage(imageBitmap!, sx, sy, sw, sh, 0, 0, sw, sh);
    tctx.drawImage(tmp as any, 0, 0, 96, 64);
    thumbs.appendChild(c);
  });
}

function refreshTemplateSelect() {
  templateSelect.innerHTML = '';
  if (!manifest) return;
  Object.values(manifest.templates).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = `${t.name} (${t.id})`;
    if (manifest!.default_template === t.id) opt.selected = true;
    templateSelect.appendChild(opt);
  });
}

function loadTemplate(id: string) {
  if (!manifest) return;
  const tpl = manifest.templates[id];
  if (!tpl) return;
  templateId = id;
  rois = buildROIItemsFromTemplate(tpl);
  templateLoaded = true;
  const res = manifest.camera_calibration.resolution;
  if (imageLoaded && imageBitmap && res && scaleX !== 1.0) {
    for (const r of rois) applyScaling(r.rect, res, imageBitmap);
  }
  selectedIndex = rois.findIndex(r => r.key === 'card_name');
  renderROIList();
  renderThumbs();
  draw();
}

function updateFromConditionsUI() {
  // Not wiring conditions to filtering; they export with ROI entries
}

function exportCurrentManifest(): Manifest {
  if (!manifest || !templateId) throw new Error('No manifest/template loaded');
  const out: Manifest = JSON.parse(JSON.stringify(manifest));
  const tpl = out.templates[templateId];
  tpl.rois = tpl.rois || {} as any;
  const calib = out.camera_calibration.resolution;
  for (const r of rois) {
    const pct = {
      x_pct: r.rect.x / calib.width,
      y_pct: r.rect.y / calib.height,
      width_pct: r.rect.width / calib.width,
      height_pct: r.rect.height / calib.height,
    };
    // Store both px and percent for flexibility
    (tpl.rois as any)[r.key] = percentModeChk.checked
      ? { ...pct, conditions: r.conditions }
      : { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height, conditions: r.conditions };
  }
  return out;
}

function download(name:string, data:string, mime='application/json') {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function exportPatch() {
  if (!templateId) return;
  const calib = manifest?.camera_calibration.resolution || { width: 6000, height: 4000 };
  const updates: any = { rois: {}, conditions: {} };
  for (const r of rois) {
    const pct = {
      x_pct: Number((r.rect.x / calib.width).toFixed(6)),
      y_pct: Number((r.rect.y / calib.height).toFixed(6)),
      width_pct: Number((r.rect.width / calib.width).toFixed(6)),
      height_pct: Number((r.rect.height / calib.height).toFixed(6)),
    };
    const px = { x: r.rect.x, y: r.rect.y, width: r.rect.width, height: r.rect.height };
    updates.rois[r.key] = percentModeChk.checked ? { ...pct, conditions: r.conditions } : { ...px, conditions: r.conditions };
  }
  const patch = { templateId, updates };
  download(`roi_patch_${templateId}.json`, JSON.stringify(patch, null, 2));
}

// Interaction

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// Initialize DOM elements and event handlers
function initializeDOM() {
  // Initialize DOM element references
  imgInput = document.getElementById('imgInput') as HTMLInputElement;
  manifestInput = document.getElementById('manifestInput') as HTMLInputElement;
  loadServerManifestBtn = document.getElementById('loadServerManifest') as HTMLButtonElement;
  templateSelect = document.getElementById('templateSelect') as HTMLSelectElement;
  canvas = document.getElementById('imageCanvas') as HTMLCanvasElement;
  wrap = document.getElementById('canvasWrap') as HTMLDivElement;
  roiList = document.getElementById('roiList') as HTMLDivElement;
  addRoiBtn = document.getElementById('addRoi') as HTMLButtonElement;
  delRoiBtn = document.getElementById('delRoi') as HTMLButtonElement;
  copyRoiBtn = document.getElementById('copyRoi') as HTMLButtonElement;
  pasteRoiBtn = document.getElementById('pasteRoi') as HTMLButtonElement;
  thumbs = document.getElementById('thumbs') as HTMLDivElement;
  zoomInBtn = document.getElementById('zoomIn') as HTMLButtonElement;
  zoomOutBtn = document.getElementById('zoomOut') as HTMLButtonElement;
  snapGridChk = document.getElementById('snapGrid') as HTMLInputElement;
  percentModeChk = document.getElementById('percentMode') as HTMLInputElement;
  condPromo = document.getElementById('condPromo') as HTMLInputElement;
  condFirstEd = document.getElementById('condFirstEd') as HTMLInputElement;
  condEra = document.getElementById('condEra') as HTMLSelectElement;
  testOCRBtn = document.getElementById('testOCR') as HTMLButtonElement;
  ocrTypeSel = document.getElementById('ocrType') as HTMLSelectElement;
  testZNCCBtn = document.getElementById('testZNCC') as HTMLButtonElement;
  testOut = document.getElementById('testOut') as HTMLDivElement;
  exportManifestBtn = document.getElementById('exportManifest') as HTMLButtonElement;
  exportPatchBtn = document.getElementById('exportPatch') as HTMLButtonElement;
  statusSpan = document.getElementById('status') as HTMLSpanElement;

  // Assume canvas exists since safeInitialize checked it
  ctx = canvas.getContext('2d')!;

  // Set up event handlers
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const imgCoords = deviceToImageCoords(x, y);
    
    let found = false;
    for (let i = 0; i < rois.length; i++) {
      const r = rois[i];
      if (!r.visible) continue;
      const rect = r.rect;
      if (imgCoords.x >= rect.x && imgCoords.x <= rect.x + rect.width &&
          imgCoords.y >= rect.y && imgCoords.y <= rect.y + rect.height) {
        selectedIndex = i;
        found = true;
        renderROIList();
        draw();
        renderThumbs();
        break;
      }
    }
    
    if (!found) {
      selectedIndex = -1;
      renderROIList();
      draw();
      renderThumbs();
    }
    
    if (found) {
      dragging = true;
      dragStart = {x: imgCoords.x, y: imgCoords.y};
      dragRectStart = {...rois[selectedIndex].rect};
      dragMode = e.shiftKey ? 'resize' : 'move';
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging || selectedIndex < 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const imgCoords = deviceToImageCoords(x, y);
    const dx = imgCoords.x - dragStart.x;
    const dy = imgCoords.y - dragStart.y;
    
    if (dragMode === 'move') {
      rois[selectedIndex].rect.x = roundSnap(dragRectStart!.x + dx);
      rois[selectedIndex].rect.y = roundSnap(dragRectStart!.y + dy);
    } else if (dragMode === 'resize') {
      // Resize logic would go here
      rois[selectedIndex].rect.width = Math.max(10, roundSnap(dragRectStart!.width + dx));
      rois[selectedIndex].rect.height = Math.max(10, roundSnap(dragRectStart!.height + dy));
    }
    
    draw();
  });

  window.addEventListener('mouseup', () => { 
    dragging = false; 
    dragMode = null; 
    dragRectStart = null; 
    renderThumbs(); 
  });

  window.addEventListener('keydown', (e) => {
    if (selectedIndex < 0) return;
    let dx = 0, dy = 0;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp') dy = -step;
    if (e.key === 'ArrowDown') dy = step;
    if (dx || dy) {
      rois[selectedIndex].rect.x += dx;
      rois[selectedIndex].rect.y += dy;
      draw();
      renderThumbs();
      e.preventDefault();
    }
  });

  window.addEventListener('resize', () => { 
    if (imageBitmap) { 
      fitCanvas(); 
      draw(); 
    }
  });

  zoomInBtn.onclick = () => { zoom *= 1.25; draw(); };
  zoomOutBtn.onclick = () => { zoom /= 1.25; draw(); };
  addRoiBtn.onclick = () => { rois.push({ key: 'custom', name: 'custom', rect: { x: 100, y: 100, width: 200, height: 120 }, visible: true, color: COLORS.other }); renderROIList(); draw(); };
  delRoiBtn.onclick = () => { if (selectedIndex >= 0) { rois.splice(selectedIndex, 1); selectedIndex = -1; renderROIList(); draw(); renderThumbs(); } };
  copyRoiBtn.onclick = () => { clipboardROI = selectedIndex >= 0 ? JSON.parse(JSON.stringify(rois[selectedIndex])) : null; };
  pasteRoiBtn.onclick = () => { if (clipboardROI) { const c = JSON.parse(JSON.stringify(clipboardROI)); rois.push(c); renderROIList(); draw(); renderThumbs(); } };

  imgInput.onchange = async () => {
    const file = imgInput.files?.[0]; if (!file) return;
    imageDataUrl = await fileToDataUrl(file);
    const bmp = await createImageBitmap(file);
    imageBitmap = bmp;
    imageLoaded = true;
    if (manifest) calculateScalingFactors(bmp);
    const res = manifest?.camera_calibration.resolution;
    if (templateLoaded && res && scaleX !== 1.0) {
      for (const r of rois) applyScaling(r.rect, res, bmp);
    }
    fitCanvas(); draw(); renderThumbs();
  };

  manifestInput.onchange = async () => {
    const file = manifestInput.files?.[0]; if (!file) return;
    const text = await file.text();
    manifest = JSON.parse(text) as Manifest;
    refreshTemplateSelect();
    const id = templateSelect.value || manifest.default_template;
    loadTemplate(id);
  };

  loadServerManifestBtn.onclick = async () => {
    try {
      const res = await fetch('/api/roi/manifest');
      const json = await res.json();
      manifest = json as Manifest;
      refreshTemplateSelect();
      const id = templateSelect.value || manifest!.default_template;
      loadTemplate(id);
    } catch (e) {
      alert('Failed to load manifest from server');
    }
  };

  templateSelect.onchange = () => loadTemplate(templateSelect.value);
  condPromo.onchange = condFirstEd.onchange = () => updateFromConditionsUI();
  condEra.onchange = () => updateFromConditionsUI();

  testOCRBtn.onclick = async () => {
    if (!imageDataUrl || selectedIndex < 0) return;
    const r = rois[selectedIndex].rect;
    try {
      const res = await fetch('/api/roi/ocr-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, roi: r, textType: ocrTypeSel.value }),
      });
      const result = await res.json();
      testOut.textContent = `OCR: "${result.text}" (conf: ${result.confidence?.toFixed(2) || 'N/A'})`;
    } catch (e) {
      testOut.textContent = `OCR Error: ${e}`;
    }
  };

  testZNCCBtn.onclick = async () => {
    if (!imageDataUrl || selectedIndex < 0) return;
    const r = rois[selectedIndex].rect;
    try {
      const res = await fetch('/api/roi/zncc-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, roi: r }),
      });
      const result = await res.json();
      testOut.textContent = `ZNCC: ${result.matched ? 'PASS' : 'FAIL'} (conf: ${result.confidence?.toFixed(2) || 'N/A'})`;
    } catch (e) {
      testOut.textContent = `ZNCC Error: ${e}`;
    }
  };
  exportManifestBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'roi_templates.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  exportPatchBtn.onclick = () => exportPatch();

  // Initialize empty UI
  draw();
}

// Wait for DOM to be ready, then initialize
function safeInitialize() {
  if (document.getElementById('imageCanvas')) {
    initializeDOM();
  } else {
    // DOM not ready yet, wait a bit and try again
    setTimeout(safeInitialize, 10);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeInitialize);
} else {
  safeInitialize();
}

