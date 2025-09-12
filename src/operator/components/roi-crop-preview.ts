// CardMint ROI Crop Preview Component
// Picture-in-picture live crop preview for ROI editor modal
// #Claude-CLI: Shadow DOM component with robust error handling and performance optimization

export type RoiRect = { x: number; y: number; w: number; h: number };
export type FieldKey = 'name' | 'hp' | 'set_number';

const MAX_W = 220;
const MAX_H = 140;
const MIN_SIDE = 2;
const UPSCALE_CAP = 3; // Avoid huge upscales

export class RoiCropPreview extends HTMLElement {
  private shadow: ShadowRoot;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private labelEl: HTMLSpanElement;
  private valueEl: HTMLDivElement;
  private cornerSwapBtn: HTMLButtonElement;
  
  // Source data
  private sourceCanvas?: HTMLCanvasElement;
  private sourceBitmap?: ImageBitmap;
  private roi?: RoiRect;
  private field: FieldKey = 'name';
  
  // Position state
  private isBottomLeft = false;
  
  // Performance optimization
  private lastRoiString = '';
  private devicePixelRatio: number;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this.devicePixelRatio = window.devicePixelRatio || 1;
    this.setupShadowDOM();
    
    // Accessibility
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
    this.setAttribute('tabindex', '-1');
  }

  private setupShadowDOM() {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('part', 'wrapper');
    
    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: absolute;
        z-index: 1000;
        display: grid;
        gap: 8px;
        padding: 10px;
        background: rgba(20,20,24,0.92);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        color: #fff;
        width: fit-content;
        max-width: ${MAX_W + 20}px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        user-select: none;
        pointer-events: auto;
        /* Default: top-right */
        top: 12px;
        right: 12px;
      }
      :host(.bottom-left) {
        top: auto;
        bottom: 12px;
        right: auto;
        left: 12px;
      }
      .header {
        font: 600 12px/1.2 system-ui, sans-serif;
        opacity: 0.9;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .corner-swap {
        background: none;
        border: none;
        color: rgba(255,255,255,0.6);
        cursor: pointer;
        padding: 2px 4px;
        font-size: 10px;
        border-radius: 3px;
      }
      .corner-swap:hover {
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.9);
      }
      canvas {
        display: block;
        border-radius: 6px;
        background: #111;
        image-rendering: pixelated;
      }
      canvas:empty {
        min-height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .meta {
        font: 11px/1.2 system-ui, sans-serif;
        color: #c7c7c7;
        word-break: break-word;
      }
      .warning {
        font-size: 10px;
        color: #ffaa44;
        opacity: 0.8;
      }
      .status-small {
        font-size: 10px;
        color: #888;
        text-align: center;
        padding: 8px;
      }
      @media (max-width: 480px) {
        :host {
          padding: 8px;
          max-width: ${MAX_W}px;
        }
        .meta {
          display: none;
        }
      }
    `;

    // Header with field label and corner swap
    this.labelEl = document.createElement('span');
    this.labelEl.textContent = 'Editing: —';
    
    this.cornerSwapBtn = document.createElement('button');
    this.cornerSwapBtn.className = 'corner-swap';
    this.cornerSwapBtn.textContent = '⤡';
    this.cornerSwapBtn.title = 'Move to opposite corner';
    this.cornerSwapBtn.onclick = () => this.toggleCorner();
    
    const header = document.createElement('div');
    header.className = 'header';
    header.appendChild(this.labelEl);
    header.appendChild(this.cornerSwapBtn);

    // Canvas for crop preview
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-crop', '');
    const maybeCtx = this.canvas.getContext('2d');
    if (!maybeCtx) throw new Error('2D context not available');
    this.ctx = maybeCtx;

    // OCR value display
    this.valueEl = document.createElement('div');
    this.valueEl.className = 'meta';
    this.valueEl.textContent = '';

    wrapper.appendChild(header);
    wrapper.appendChild(this.canvas);
    wrapper.appendChild(this.valueEl);
    this.shadow.append(style, wrapper);
  }

  private toggleCorner() {
    this.isBottomLeft = !this.isBottomLeft;
    if (this.isBottomLeft) {
      this.classList.add('bottom-left');
      this.cornerSwapBtn.textContent = '⤢';
    } else {
      this.classList.remove('bottom-left');
      this.cornerSwapBtn.textContent = '⤡';
    }
  }

  setField(field: FieldKey) {
    this.field = field;
    this.labelEl.textContent = `Editing: ${field.toUpperCase().replace('_', ' ')}`;
  }

  async setSource(source: HTMLCanvasElement | ImageBitmap): Promise<void> {
    // Clean up previous source
    if (this.sourceBitmap && this.sourceBitmap !== source) {
      this.sourceBitmap.close();
    }
    
    this.sourceCanvas = undefined;
    this.sourceBitmap = undefined;

    if ('close' in source) {
      // ImageBitmap
      this.sourceBitmap = source;
    } else if ('getContext' in source) {
      // HTMLCanvasElement
      this.sourceCanvas = source;
    } else {
      throw new Error('setSource requires HTMLCanvasElement or ImageBitmap');
    }

    this.redraw();
  }

  setROI(roi: RoiRect) {
    // Performance optimization: skip redraw if ROI hasn't changed
    const roiString = `${roi.x},${roi.y},${roi.w},${roi.h}`;
    if (roiString === this.lastRoiString) {
      return;
    }
    this.lastRoiString = roiString;

    // Clamp ROI to prevent errors
    const srcW = this.sourceBitmap?.width ?? this.sourceCanvas?.width ?? 0;
    const srcH = this.sourceBitmap?.height ?? this.sourceCanvas?.height ?? 0;
    if (!srcW || !srcH) {
      this.roi = undefined;
      this.showStatus('No source image');
      return;
    }

    const x = Math.max(0, Math.min(Math.floor(roi.x), srcW));
    const y = Math.max(0, Math.min(Math.floor(roi.y), srcH));
    const w = Math.max(0, Math.min(Math.floor(roi.w), srcW - x));
    const h = Math.max(0, Math.min(Math.floor(roi.h), srcH - y));

    this.roi = { x, y, w, h };
    this.redraw();
  }

  setOCRText(text?: string) {
    if (text) {
      this.valueEl.textContent = `Current OCR: ${text}`;
      this.valueEl.className = 'meta';
    } else {
      this.valueEl.textContent = '';
    }
  }

  private showStatus(message: string) {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.setAttribute('data-crop', '');
    this.valueEl.textContent = message;
    this.valueEl.className = 'status-small';
  }

  private redraw() {
    if (!this.roi) return;
    
    const srcW = this.sourceBitmap?.width ?? this.sourceCanvas?.width ?? 0;
    const srcH = this.sourceBitmap?.height ?? this.sourceCanvas?.height ?? 0;
    if (!srcW || !srcH) {
      this.showStatus('No source');
      return;
    }

    const { x: sx, y: sy, w: sw, h: sh } = this.roi;
    
    // Validate crop bounds
    if (sw < MIN_SIDE || sh < MIN_SIDE || sx + sw > srcW || sy + sh > srcH) {
      this.showStatus('ROI too small or out of bounds');
      return;
    }

    // Calculate display dimensions with pixel ratio
    const scale = Math.min(MAX_W / sw, MAX_H / sh, UPSCALE_CAP);
    const displayW = Math.max(1, Math.round(sw * scale));
    const displayH = Math.max(1, Math.round(sh * scale));
    
    // Set canvas backing store for crisp rendering
    this.canvas.width = displayW * this.devicePixelRatio;
    this.canvas.height = displayH * this.devicePixelRatio;
    this.canvas.style.width = `${displayW}px`;
    this.canvas.style.height = `${displayH}px`;
    
    // Set data attribute for E2E testing
    this.canvas.setAttribute('data-crop', `${sx},${sy},${sw},${sh}`);

    // Configure context for crisp rendering
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.clearRect(0, 0, displayW, displayH);

    try {
      if (this.sourceBitmap) {
        this.ctx.drawImage(this.sourceBitmap, sx, sy, sw, sh, 0, 0, displayW, displayH);
      } else if (this.sourceCanvas) {
        this.ctx.drawImage(this.sourceCanvas, sx, sy, sw, sh, 0, 0, displayW, displayH);
      }
    } catch (error) {
      console.warn('Failed to draw crop preview:', error);
      this.showStatus('Render error');
    }
  }

  // Cleanup method
  destroy() {
    if (this.sourceBitmap) {
      this.sourceBitmap.close();
      this.sourceBitmap = undefined;
    }
    this.sourceCanvas = undefined;
    this.roi = undefined;
    this.lastRoiString = '';
  }

  // Lifecycle
  disconnectedCallback() {
    this.destroy();
  }
}

// Register the custom element
customElements.define('roi-crop-preview', RoiCropPreview);