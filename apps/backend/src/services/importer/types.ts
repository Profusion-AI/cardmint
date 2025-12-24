// EverShop importer types

export interface EverShopConfig {
  apiUrl: string; // e.g., "https://shop.local/api"
  adminToken: string; // Bearer token from admin panel
  environment: "staging" | "production";
  // SSH config for direct PostgreSQL access (EverShop v2.x has no product mutation API)
  sshKeyPath?: string; // Path to SSH private key
  sshUser?: string; // SSH username (default: cardmint)
  sshHost?: string; // SSH host (droplet IP)
  dockerComposePath?: string; // Path to docker-compose.yml on server
  dbUser?: string; // PostgreSQL user (default: evershop)
  dbName?: string; // PostgreSQL database (default: evershop)
}

export interface ProductPayload {
  sku: string; // product_sku
  name: string; // card_name
  description?: string;
  price: number; // launch_price (market_price * 1.25)
  quantity: number; // total_quantity
  condition: string; // condition_bucket
  set_name?: string;
  collector_no?: string;
  hp_value?: number;
  rarity?: string;
  image_url?: string; // URL to processed front image (CDN)
  back_image_url?: string; // URL to processed back image (CDN)
  product_slug?: string; // URL key for SEO-friendly URLs
  cardmint_scan_id?: string; // CardMint scan/job ID for traceability
  category_id?: number; // EverShop category mapped from mastersetlist.csv
  variant_tags?: string[]; // Variant tags (First Edition, Holo, etc.) for bidirectional sync
  // CardMint Ops Grid Projection Fields
  cm_set_name?: string;
  cm_variant?: string;
  cm_market_price?: number | null;
  cm_pricing_source?: string | null;
  cm_pricing_status?: string | null;
  cm_pricing_updated_at?: string | null;
  cm_product_uid?: string;
  cm_inventory_status?: string;
  cm_evershop_sync_state?: string;
}

export interface ImportResult {
  sku: string;
  status: "created" | "updated" | "skipped" | "error";
  evershop_product_id?: string;
  evershop_uuid?: string; // EverShop's UUID for bidirectional sync
  error?: string;
}

export interface ImportReport {
  job_id: string;
  started_at: string;
  completed_at?: string;
  environment: "staging" | "production";
  dry_run: boolean;
  total_skus: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  results: ImportResult[];
  notes?: string;
}
