/**
 * Local-First Recognition Types
 * Core interfaces for pluggable matching strategies and confidence fusion
 */

export type MatchMethod = "phash" | "text" | "set_icon" | "number" | "fusion";

export interface MatchCandidate {
  id: string;
  set?: string;
  number?: string;
  name?: string;
  score?: number;
  path?: string;
  rarity?: string;
  price_data?: PriceData;
}

export interface MatchResult {
  method: MatchMethod;
  confidence: number; // 0..1
  best?: MatchCandidate;
  candidates: MatchCandidate[];
  timings?: Record<string, number>; // ms per strategy
  processing_time_ms: number;
}

export interface Matcher {
  readonly name: MatchMethod;
  match(imagePath: string, imageBuffer?: Buffer): Promise<MatchResult>;
  precompute?(): Promise<void>;
  isReady(): boolean;
}

export interface PriceData {
  loose_price?: number;
  graded_price?: number;
  bgs_10_price?: number;
  market_price?: number;
  currency: string;
  updated_at: Date;
}

export interface PerceptualHashEntry {
  image_id: string;
  image_path: string;
  phash64: string;
  width: number;
  height: number;
  card_name: string;
  set_code: string;
  card_number: string;
  dataset_version: string;
  created_at: number;
}

export interface DatabaseRecord {
  id: string;
  name: string;
  set_name: string;
  set_code: string;
  number: string;
  rarity?: string;
  hp?: number;
  types?: string;
  stage?: string;
  aliases?: string;
  release_year?: number;
}

export interface PriceLookupKey {
  set: string;
  number: string;
  name: string;
  normalized_key?: string;
}

export enum LocalMode {
  HYBRID = 'hybrid',
  LOCAL_ONLY = 'local-only', 
  ML_ONLY = 'ml-only'
}

export interface LocalMatchMetrics {
  scan_id: string;
  local_confidence: number;
  ml_used: boolean;
  match_method: string;
  latency_ms: number;
  decision: 'auto_approved' | 'needs_ml' | 'rejected';
  strategy_chain: string[];
  conf_scores: Record<string, number>;
  mode: LocalMode;
}

