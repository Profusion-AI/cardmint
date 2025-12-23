/**
 * Sync Infrastructure Types
 * RFC-fullduplexDB_triple Phase 1
 */

export type SyncEventType =
  | "promote"
  | "sale"
  | "price_update"
  | "return"
  | "rollback"
  | "unpromote"
  | "evershop_hide_listing";
export type SyncEventStatus = "pending" | "synced" | "failed" | "conflict" | "partial_failure";
export type SyncDbSource = "staging" | "production";
export type EverShopSyncState = "not_synced" | "vault_only" | "evershop_hidden" | "evershop_live" | "sync_error";

export interface ProductSnapshot {
  product_uid: string;
  public_sku: string | null;
  card_name: string;
  set_name: string;
  collector_no: string;
  condition_bucket: string;
  market_price: number | null;
  launch_price: number | null;
  pricing_status: string | null;
  total_quantity: number;
  status: string;
  evershop_sync_state: EverShopSyncState;
  sync_version: number;
  cdn_image_url: string | null;
  cdn_back_image_url: string | null;
  cm_card_id: string | null;
  variant_tags: string | null;
  created_at: number;
  updated_at: number;
}

export interface SyncEvent {
  id?: number;
  event_uid: string;
  event_type: SyncEventType;
  product_uid: string;
  item_uid: string | null;
  stripe_session_id: string | null;
  product_sku: string | null;
  source_db: SyncDbSource;
  target_db: SyncDbSource;
  operator_id: string | null;
  payload: string;
  stripe_event_id: string | null;
  status: SyncEventStatus;
  error_message: string | null;
  retry_count: number;
  created_at: number;
  synced_at: number | null;
}

export interface SyncResult {
  success: boolean;
  event_uid: string;
  evershop_sync_state?: EverShopSyncState;
  error?: string;
}

export interface SyncHealthReport {
  overall: "green" | "yellow" | "red";
  staging_db: "reachable" | "unreachable" | "unknown";
  prod_sqlite: "reachable" | "unreachable" | "unknown";
  evershop_db: "reachable" | "unreachable" | "unknown";
  state_counts: {
    not_synced: number;
    vault_only: number;
    evershop_hidden: number;
    evershop_live: number;
    sync_error: number;
  };
  pending_events: number;
  oldest_pending_age_seconds: number | null;
  failed_events: number;
  conflict_events: number;
  pending_evershop_hide_events: number;
  oldest_pending_evershop_hide_age_seconds: number | null;
  evershop_visible_zero_qty_count: number;
  last_sync_cycle: string | null;
  daemon_lease_holder: string | null;
  daemon_lease_expires: string | null;
}

export interface PromoteCandidateRow {
  product_uid: string;
  product_sku: string;
  card_name: string;
  set_name: string;
  collector_no: string;
  condition_bucket: string;
  market_price: number | null;
  launch_price: number | null;
  cdn_image_url: string | null;
  staging_ready: number;
  evershop_sync_state: EverShopSyncState | null;
}

export interface PromoteRequest {
  product_uids: string[];
  dry_run?: boolean;
  operator_id?: string;
}

export interface PromoteResponse {
  dry_run: boolean;
  total: number;
  promoted: number;
  failed: number;
  results: Array<{
    product_uid: string;
    success: boolean;
    event_uid?: string;
    evershop_sync_state?: EverShopSyncState;
    error?: string;
  }>;
}

export interface UnpromoteRequest {
  product_uids: string[];
  operator_id?: string;
}

export interface UnpromoteResponse {
  total: number;
  unpromoted: number;
  failed: number;
  results: Array<{
    product_uid: string;
    success: boolean;
    error?: string;
  }>;
}

export interface SyncLeader {
  id: number;
  lease_owner: string;
  lease_expires_at: number;
  last_heartbeat: number;
}

// Phase 2: Sale sync types
export interface SaleSnapshot {
  item_uid: string;
  product_uid: string | null;
  status: "SOLD";
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  name: string | null;
  set_name: string | null;
  collector_no: string | null;
  condition: string | null;
  price_cents: number | null;
  sold_at: number;
}

export interface EvershopHideListingPayload {
  product_uid: string;
  item_uid: string;
  stripe_session_id: string;
  product_sku: string;
  reason: "sold";
  total_quantity: number;
  livemode: boolean;
  evershop_product_id?: number | null;
}

export interface SyncSalesResult {
  total: number;
  synced: number;
  failed: number;
  skipped: number;
  results: Array<{
    event_uid: string;
    item_uid: string;
    success: boolean;
    error?: string;
  }>;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

// EverShop Webhook Types (Dec 2025 - bidirectional sync)
export type WebhookEventType =
  | "evershop_product_updated"
  | "evershop_product_created"
  | "evershop_product_deleted"
  | "stripe_checkout_completed"
  | "stripe_payment_failed";

export type WebhookEventSource = "evershop" | "stripe" | "internal";
export type WebhookEventStatus = "pending" | "processed" | "failed" | "skipped";

export interface EverShopWebhookPayload {
  uuid: string;
  sku: string;
  visibility: boolean;
  status: boolean;
  cardmint_scan_id?: string;
  updated_at: string;
  product_id?: number;
  // Dec 8, 2025: Added for bidirectional category sync (set_name in CardMint)
  category_name?: string | null;
  // Dec 8, 2025: Added for bidirectional variant sync
  // JSON-encoded array or null (e.g., ["First Edition", "Holo"])
  variant_tags?: string[] | string | null;
  // Dec 9, 2025: Added for bidirectional price sync (launch_price in CardMint)
  price?: number | null;
  name?: string | null;
  qty?: number | null;
}

export interface WebhookEvent {
  id?: number;
  event_uid: string;
  event_type: WebhookEventType;
  source: WebhookEventSource;
  payload: EverShopWebhookPayload | Record<string, unknown>;
  product_uid: string | null;
  item_uid: string | null;
  processed_at: number | null;
  status: WebhookEventStatus;
  error_message: string | null;
  retry_count: number;
  created_at: number;
}

export interface WebhookProcessResult {
  success: boolean;
  event_uid: string;
  product_uid?: string;
  previous_state?: EverShopSyncState;
  new_state?: EverShopSyncState;
  state_changed: boolean;
  vault_sync_enqueued: boolean;
  error?: string;
}

export interface WebhookHealthStats {
  pending_count: number;
  processed_last_hour: number;
  failed_last_hour: number;
  oldest_pending_age_seconds: number | null;
  webhook_driven_transitions_last_hour: number;
}
