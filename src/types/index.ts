export interface Card {
  id: string;
  capturedAt: Date;
  processedAt?: Date;
  imageUrl: string;
  thumbnailUrl?: string;
  status: CardStatus;
  metadata: CardMetadata;
  ocrData?: OCRData;
  error?: string;
}

export enum CardStatus {
  CAPTURING = 'capturing',
  CAPTURED = 'captured',
  QUEUED = 'queued',
  PROCESSING = 'processing',
  PROCESSED = 'processed',
  FAILED = 'failed',
  RETRYING = 'retrying',
}

export interface CardMetadata {
  cardName?: string;
  cardSet?: string;
  cardNumber?: string;
  rarity?: string;
  condition?: string;
  language?: string;
  runId?: string;
  preset?: string;
  captureCount?: number;
  captureTime?: number;
  customFields?: Record<string, any>;
}

export interface OCRData {
  fullText: string;
  regions: OCRRegion[];
  confidence: number;
  processingTimeMs: number;
}

export interface OCRRegion {
  text: string;
  confidence: number;
  boundingBox: BoundingBox;
  type?: 'title' | 'description' | 'stats' | 'other';
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureRequest {
  sessionId: string;
  captureMode: 'single' | 'continuous' | 'batch';
  settings?: CaptureSettings;
}

export interface CaptureSettings {
  resolution?: string;
  format?: string;
  quality?: number;
  autoFocus?: boolean;
  exposure?: number;
  iso?: number;
}

export interface ProcessingJob {
  id: string;
  cardId: string;
  imageData: Buffer | string;
  priority: number;
  attempts: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface PerformanceMetrics {
  captureLatencyMs: number;
  processingLatencyMs: number;
  ocrLatencyMs: number;
  totalLatencyMs: number;
  queueDepth: number;
  throughputPerMinute: number;
  memoryUsageMb: number;
  cpuUsagePercent: number;
}

export interface CameraDevice {
  id: string;
  name: string;
  type: 'USB' | 'ETHERNET' | 'SSH';
  status: 'connected' | 'disconnected' | 'error';
  capabilities: CameraCapabilities;
}

export interface CameraCapabilities {
  resolutions: string[];
  formats: string[];
  maxFps: number;
  hasAutoFocus: boolean;
  hasExposureControl: boolean;
}