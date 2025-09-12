// CardMint ROI Editor - Canvas-based implementation
// Simpler than LSF but provides the same functionality with better performance
// #Claude-CLI: Using Canvas API instead of LSF to avoid React complexity and meet performance targets

import { clampSnapBox, type ROI } from './roi-utils.js'
import './components/roi-crop-preview.js'
import type { RoiCropPreview, FieldKey } from './components/roi-crop-preview.ts'

const SNAP = 8
const MIN = 16

export class RoiEditorLSF {
  private host: HTMLElement
  private shadow: ShadowRoot
  private container: HTMLDivElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private img: HTMLImageElement | null = null
  private field = ''
  private currentROI: ROI | null = null
  private isDragging = false
  private isResizing = false
  private dragStart = { x: 0, y: 0 }
  private resizeHandle = ''
  private onChange: (roi: ROI) => void

  // Mouse interaction state
  private mousePos = { x: 0, y: 0 }
  private scale = 1
  private offset = { x: 0, y: 0 }
  
  // Undo/redo functionality
  private undoStack: ROI[] = []
  private redoStack: ROI[] = []

  // Live crop preview component
  private preview: RoiCropPreview | null = null
  private sourceBitmap: ImageBitmap | null = null

  constructor(host: HTMLElement, onChange: (roi: ROI) => void) {
    this.host = host
    this.shadow = host.attachShadow({ mode: 'open' })
    this.onChange = onChange
    this.setupShadowDOM()
    this.bindEvents()
  }

  private setupShadowDOM() {
    // Create isolated styles
    const styles = document.createElement('style')
    styles.textContent = `
      .roi-editor {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .roi-canvas-container {
        position: relative;
        background: white;
        border-radius: 8px;
        padding: 20px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        max-width: 90vw;
        max-height: 90vh;
      }
      .roi-canvas {
        border: 2px solid #ddd;
        cursor: crosshair;
        display: block;
      }
      .roi-canvas:hover {
        border-color: #007acc;
      }
      .roi-controls {
        margin-top: 12px;
        text-align: center;
      }
      .roi-button {
        margin: 0 8px;
        padding: 8px 16px;
        background: #007acc;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: system-ui, sans-serif;
        font-size: 14px;
      }
      .roi-button:hover {
        background: #005a9e;
      }
      .roi-button.secondary {
        background: #666;
      }
      .roi-button.secondary:hover {
        background: #555;
      }
      .roi-instructions {
        margin-bottom: 12px;
        color: #666;
        font-size: 14px;
        font-family: system-ui, sans-serif;
        text-align: center;
      }
    `

    this.container = document.createElement('div')
    this.container.className = 'roi-editor'
    
    const canvasContainer = document.createElement('div')
    canvasContainer.className = 'roi-canvas-container'
    
    const instructions = document.createElement('div')
    instructions.className = 'roi-instructions'
    instructions.textContent = 'Click and drag to select ROI. Use arrow keys to nudge (±1px, Shift ±5px, Alt ±10px). Ctrl+Z/Y for undo/redo. Escape to close.'
    
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'roi-canvas'
    this.ctx = this.canvas.getContext('2d')!
    
    const controls = document.createElement('div')
    controls.className = 'roi-controls'
    
    const applyBtn = document.createElement('button')
    applyBtn.className = 'roi-button'
    applyBtn.textContent = 'Apply Changes'
    applyBtn.onclick = () => this.applyChanges()
    
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'roi-button secondary'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.onclick = () => this.close()
    
    controls.append(applyBtn, cancelBtn)
    canvasContainer.append(instructions, this.canvas, controls)
    this.container.appendChild(canvasContainer)
    this.shadow.append(styles, this.container)
  }

  async mount(imgSrc: string, field: string, roi?: ROI, ocrText?: string) {
    this.field = field
    this.currentROI = roi || null
    
    this.img = new Image()
    this.img.onload = async () => {
      try {
        this.setupCanvas()
        this.render()
        await this.setupPreview(field as FieldKey, ocrText)
      } catch (error) {
        console.error('Failed to setup preview:', error)
        // Continue without preview if it fails
      }
    }
    this.img.onerror = () => {
      console.error('Failed to load image for ROI editor:', imgSrc)
    }
    this.img.src = imgSrc
    
    this.host.hidden = false
  }

  private async setupPreview(field: FieldKey, ocrText?: string) {
    if (!this.img) return;
    
    // Clean up existing preview
    if (this.preview) {
      this.preview.destroy();
      this.preview.remove();
      this.preview = null;
    }
    
    if (this.sourceBitmap) {
      this.sourceBitmap.close();
      this.sourceBitmap = null;
    }

    // Create new preview component
    this.preview = document.createElement('roi-crop-preview') as RoiCropPreview;
    this.preview.setField(field);
    
    // Add to modal container (not shadow root to avoid CSS isolation issues)
    this.container.appendChild(this.preview);
    
    // Create ImageBitmap from the loaded image for efficient preview rendering
    try {
      this.sourceBitmap = await createImageBitmap(this.img);
      await this.preview.setSource(this.sourceBitmap);
    } catch (error) {
      console.warn('Failed to create ImageBitmap, falling back to image element:', error);
      // Fallback: create a canvas from the image
      const fallbackCanvas = document.createElement('canvas');
      fallbackCanvas.width = this.img.width;
      fallbackCanvas.height = this.img.height;
      const fallbackCtx = fallbackCanvas.getContext('2d');
      if (fallbackCtx) {
        fallbackCtx.drawImage(this.img, 0, 0);
        await this.preview.setSource(fallbackCanvas);
      }
    }
    
    // Set initial ROI and OCR text
    if (this.currentROI) {
      this.preview.setROI(this.currentROI);
    }
    if (ocrText) {
      this.preview.setOCRText(ocrText);
    }
  }

  private updatePreview() {
    if (this.preview && this.currentROI) {
      this.preview.setROI(this.currentROI);
    }
  }

  private setupCanvas() {
    if (!this.img) return
    
    // Set canvas size to fit image while maintaining aspect ratio
    const maxW = Math.min(800, window.innerWidth * 0.7)
    const maxH = Math.min(600, window.innerHeight * 0.7)
    
    this.scale = Math.min(maxW / this.img.width, maxH / this.img.height, 1)
    
    this.canvas.width = this.img.width * this.scale
    this.canvas.height = this.img.height * this.scale
    
    // Center the image
    this.offset.x = 0
    this.offset.y = 0
  }

  private render() {
    if (!this.img || !this.ctx) return
    
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    
    // Draw image
    this.ctx.drawImage(this.img, 0, 0, this.canvas.width, this.canvas.height)
    
    // Draw ROI if it exists
    if (this.currentROI) {
      this.drawROI(this.currentROI)
    }
  }

  private drawROI(roi: ROI) {
    // Convert ROI from image coordinates to canvas coordinates
    const canvasROI = {
      x: roi.x * this.scale,
      y: roi.y * this.scale,
      w: roi.w * this.scale,
      h: roi.h * this.scale
    }
    
    this.ctx.save()
    
    // Draw semi-transparent overlay everywhere except ROI
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    
    // Clear ROI area (composite operation)
    this.ctx.globalCompositeOperation = 'destination-out'
    this.ctx.fillRect(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h)
    
    // Reset composite operation and draw ROI border
    this.ctx.globalCompositeOperation = 'source-over'
    this.ctx.strokeStyle = '#007acc'
    this.ctx.lineWidth = 2
    this.ctx.setLineDash([])
    this.ctx.strokeRect(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h)
    
    // Draw resize handles
    this.drawResizeHandles(canvasROI)
    
    this.ctx.restore()
  }

  private drawResizeHandles(canvasROI: { x: number; y: number; w: number; h: number }) {
    const handleSize = 8
    const handles = [
      { x: canvasROI.x - handleSize/2, y: canvasROI.y - handleSize/2, pos: 'nw' },
      { x: canvasROI.x + canvasROI.w - handleSize/2, y: canvasROI.y - handleSize/2, pos: 'ne' },
      { x: canvasROI.x - handleSize/2, y: canvasROI.y + canvasROI.h - handleSize/2, pos: 'sw' },
      { x: canvasROI.x + canvasROI.w - handleSize/2, y: canvasROI.y + canvasROI.h - handleSize/2, pos: 'se' }
    ]
    
    this.ctx.fillStyle = '#007acc'
    this.ctx.strokeStyle = 'white'
    this.ctx.lineWidth = 1
    
    handles.forEach(handle => {
      this.ctx.fillRect(handle.x, handle.y, handleSize, handleSize)
      this.ctx.strokeRect(handle.x, handle.y, handleSize, handleSize)
    })
  }

  private bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e))
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e))
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e))
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp())
    
    // Keyboard events for the container
    this.container.addEventListener('keydown', (e) => this.onKeyDown(e))
    
    // Make container focusable for keyboard events
    this.container.tabIndex = -1
    this.container.focus()
  }

  private getMousePos(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    }
  }

  private getResizeHandle(pos: { x: number; y: number }): string {
    if (!this.currentROI) return ''
    
    const canvasROI = {
      x: this.currentROI.x * this.scale,
      y: this.currentROI.y * this.scale,
      w: this.currentROI.w * this.scale,
      h: this.currentROI.h * this.scale
    }
    
    const handleSize = 8
    const tolerance = handleSize
    
    // Check each corner
    if (Math.abs(pos.x - canvasROI.x) <= tolerance && Math.abs(pos.y - canvasROI.y) <= tolerance) return 'nw'
    if (Math.abs(pos.x - (canvasROI.x + canvasROI.w)) <= tolerance && Math.abs(pos.y - canvasROI.y) <= tolerance) return 'ne'
    if (Math.abs(pos.x - canvasROI.x) <= tolerance && Math.abs(pos.y - (canvasROI.y + canvasROI.h)) <= tolerance) return 'sw'
    if (Math.abs(pos.x - (canvasROI.x + canvasROI.w)) <= tolerance && Math.abs(pos.y - (canvasROI.y + canvasROI.h)) <= tolerance) return 'se'
    
    return ''
  }

  private isInsideROI(pos: { x: number; y: number }): boolean {
    if (!this.currentROI) return false
    
    const canvasROI = {
      x: this.currentROI.x * this.scale,
      y: this.currentROI.y * this.scale,
      w: this.currentROI.w * this.scale,
      h: this.currentROI.h * this.scale
    }
    
    return pos.x >= canvasROI.x && pos.x <= canvasROI.x + canvasROI.w &&
           pos.y >= canvasROI.y && pos.y <= canvasROI.y + canvasROI.h
  }

  private onMouseDown(e: MouseEvent) {
    this.mousePos = this.getMousePos(e)
    
    // Save current state to undo stack before any changes
    if (this.currentROI) {
      this.saveToUndoStack()
    }
    
    // Check if clicking on resize handle
    this.resizeHandle = this.getResizeHandle(this.mousePos)
    if (this.resizeHandle) {
      this.isResizing = true
      this.canvas.style.cursor = this.resizeHandle + '-resize'
      return
    }
    
    // Check if clicking inside existing ROI (for dragging)
    if (this.currentROI && this.isInsideROI(this.mousePos)) {
      this.isDragging = true
      this.dragStart = this.mousePos
      this.canvas.style.cursor = 'move'
      return
    }
    
    // Create new ROI
    const imagePos = {
      x: this.mousePos.x / this.scale,
      y: this.mousePos.y / this.scale
    }
    
    this.currentROI = { x: imagePos.x, y: imagePos.y, w: MIN, h: MIN }
    this.isResizing = true
    this.resizeHandle = 'se'
    this.canvas.style.cursor = 'se-resize'
    this.updatePreview()
    
    e.preventDefault()
  }

  private onMouseMove(e: MouseEvent) {
    const newPos = this.getMousePos(e)
    
    if (this.isResizing && this.currentROI) {
      this.handleResize(newPos)
    } else if (this.isDragging && this.currentROI) {
      this.handleDrag(newPos)
    } else {
      // Update cursor based on what's under the mouse
      const handle = this.getResizeHandle(newPos)
      if (handle) {
        this.canvas.style.cursor = handle + '-resize'
      } else if (this.currentROI && this.isInsideROI(newPos)) {
        this.canvas.style.cursor = 'move'
      } else {
        this.canvas.style.cursor = 'crosshair'
      }
    }
    
    this.mousePos = newPos
  }

  private onMouseUp() {
    this.isDragging = false
    this.isResizing = false
    this.resizeHandle = ''
    this.canvas.style.cursor = 'crosshair'
  }

  private handleResize(newPos: { x: number; y: number }) {
    if (!this.currentROI || !this.img) return
    
    const imgW = this.img.width
    const imgH = this.img.height
    
    // Convert to image coordinates
    const imgPos = {
      x: newPos.x / this.scale,
      y: newPos.y / this.scale
    }
    
    let newROI = { ...this.currentROI }
    
    switch (this.resizeHandle) {
      case 'se':
        newROI.w = Math.max(MIN, imgPos.x - newROI.x)
        newROI.h = Math.max(MIN, imgPos.y - newROI.y)
        break
      case 'sw':
        newROI.w = Math.max(MIN, newROI.x + newROI.w - imgPos.x)
        newROI.h = Math.max(MIN, imgPos.y - newROI.y)
        newROI.x = imgPos.x
        break
      case 'ne':
        newROI.w = Math.max(MIN, imgPos.x - newROI.x)
        newROI.h = Math.max(MIN, newROI.y + newROI.h - imgPos.y)
        newROI.y = imgPos.y
        break
      case 'nw':
        newROI.w = Math.max(MIN, newROI.x + newROI.w - imgPos.x)
        newROI.h = Math.max(MIN, newROI.y + newROI.h - imgPos.y)
        newROI.x = imgPos.x
        newROI.y = imgPos.y
        break
    }
    
    // Apply snap and clamp
    this.currentROI = clampSnapBox(newROI, imgW, imgH)
    this.render()
    this.updatePreview()
  }

  private handleDrag(newPos: { x: number; y: number }) {
    if (!this.currentROI || !this.img) return
    
    const deltaX = (newPos.x - this.dragStart.x) / this.scale
    const deltaY = (newPos.y - this.dragStart.y) / this.scale
    
    const newROI = {
      x: this.currentROI.x + deltaX,
      y: this.currentROI.y + deltaY,
      w: this.currentROI.w,
      h: this.currentROI.h
    }
    
    // Apply snap and clamp
    this.currentROI = clampSnapBox(newROI, this.img.width, this.img.height)
    this.dragStart = newPos
    this.render()
    this.updatePreview()
  }

  private applyChanges() {
    if (this.currentROI) {
      this.onChange(this.currentROI)
    }
    this.close()
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      this.close()
      return
    }
    
    if (!this.currentROI || !this.img) return
    
    // Undo/Redo
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      this.undo()
      return
    }
    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
      e.preventDefault()
      this.redo()
      return
    }
    
    // Arrow key nudging
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault()
      this.nudgeROI(e.key, e.shiftKey, e.altKey)
    }
  }
  
  private nudgeROI(direction: string, shift: boolean, alt: boolean) {
    if (!this.currentROI || !this.img) return
    
    // Save current state to undo stack before making changes
    this.saveToUndoStack()
    
    // Determine nudge amount
    let amount = 1
    if (shift) amount = 5
    if (alt) amount = 10
    
    let newROI = { ...this.currentROI }
    
    switch (direction) {
      case 'ArrowUp':
        newROI.y -= amount
        break
      case 'ArrowDown':
        newROI.y += amount
        break
      case 'ArrowLeft':
        newROI.x -= amount
        break
      case 'ArrowRight':
        newROI.x += amount
        break
    }
    
    // Apply snap and clamp
    this.currentROI = clampSnapBox(newROI, this.img.width, this.img.height)
    this.render()
    this.updatePreview()
  }
  
  private saveToUndoStack() {
    if (!this.currentROI) return
    
    // Limit undo stack size
    if (this.undoStack.length >= 20) {
      this.undoStack.shift()
    }
    
    this.undoStack.push({ ...this.currentROI })
    // Clear redo stack when new action is performed
    this.redoStack = []
  }
  
  private undo() {
    if (this.undoStack.length === 0 || !this.currentROI) return
    
    // Save current state to redo stack
    this.redoStack.push({ ...this.currentROI })
    
    // Restore previous state
    this.currentROI = this.undoStack.pop()!
    this.render()
    this.updatePreview()
  }
  
  private redo() {
    if (this.redoStack.length === 0) return
    
    if (this.currentROI) {
      // Save current state to undo stack
      this.undoStack.push({ ...this.currentROI })
    }
    
    // Restore from redo stack
    this.currentROI = this.redoStack.pop()!
    this.render()
    this.updatePreview()
  }

  private close() {
    this.host.hidden = true
    this.img = null
    this.currentROI = null
    this.isDragging = false
    this.isResizing = false
    
    // Clean up preview component
    if (this.preview) {
      this.preview.destroy()
      this.preview.remove()
      this.preview = null
    }
    
    // Clean up source bitmap
    if (this.sourceBitmap) {
      this.sourceBitmap.close()
      this.sourceBitmap = null
    }
    
    // Clear undo/redo stacks
    this.undoStack = []
    this.redoStack = []
  }

  destroy() {
    this.close()
    this.shadow.innerHTML = ''
  }
}