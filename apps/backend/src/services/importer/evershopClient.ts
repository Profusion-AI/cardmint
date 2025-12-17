import type * as Database from "better-sqlite3";
import type { Logger } from "pino";
import type { EverShopConfig, ProductPayload, ImportResult, ImportReport } from "./types";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseCsvSync } from "csv-parse/sync";
import { runtimeConfig } from "../../config";
import { sqlString, sqlNumber, sqlInt, sqlBool, escapeString } from "./sqlSanitizer";
import { computeLaunchPrice, MINIMUM_LISTING_PRICE } from "../pricing/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CARD_WEIGHT_GRAMS = 2;

type MasterSetRow = {
  set_name?: string;
  series?: string;
  release_date?: string;
  card_count?: string | number;
  ppt_id?: string;
  tcgplayer_id?: string;
};

type CategoryLookup = {
  byName: Map<string, number>;
  byNormalized: Map<string, number>;
};

interface ProductRow {
  product_uid: string;
  product_sku: string;
  listing_sku: string;
  card_name: string;
  set_name: string;
  collector_no: string;
  condition_bucket: string;
  hp_value: number | null;
  rarity: string | null;
  market_price: number | null;
  launch_price: number | null;
  total_quantity: number;
  staging_ready: number;
  pricing_status: string | null;
  cdn_image_url: string | null;
  cdn_back_image_url: string | null;
  product_slug: string | null;
  primary_scan_id: string | null; // For EverShop traceability
  variant_tags: string | null; // JSON-encoded array from products table
}

export class EverShopImporter {
  private variantTagsAttributeId: number | null = null;
  private cachedCategoryLookup: CategoryLookup | null = null;
  private cachedCategoryLookupKey: string | null = null;
  private cachedCategoryLookupAtMs: number | null = null;
  private readonly categorySyncTtlMs = 6 * 60 * 60 * 1000; // 6 hours

  constructor(
    private readonly db: Database.Database,
    private readonly config: EverShopConfig,
    private readonly logger: Logger,
  ) { }

  /**
   * Look up the cardmint_variant_tags attribute_id from EverShop
   * Caches the result for the lifetime of the importer instance
   * Returns null if attribute doesn't exist (migration not run)
   */
  private getVariantTagsAttributeId(): number | null {
    if (this.variantTagsAttributeId !== null) {
      return this.variantTagsAttributeId;
    }

    try {
      const result = this.executeSshSql(
        `SELECT attribute_id FROM attribute WHERE attribute_code = 'cardmint_variant_tags'`
      );
      const attrId = parseInt(result.trim(), 10);
      if (!isNaN(attrId)) {
        this.variantTagsAttributeId = attrId;
        this.logger.info({ attribute_id: attrId }, "Resolved cardmint_variant_tags attribute_id");
        return attrId;
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to look up cardmint_variant_tags attribute; variant sync disabled");
    }

    return null;
  }

  /**
   * Sync variant_tags to EverShop product_attribute_value_index
   * Handles create, update, and delete (when tags are empty/null)
   */
  private syncVariantTagsAttribute(productId: number, variantTags: string[] | undefined): void {
    const attrId = this.getVariantTagsAttributeId();
    if (attrId === null) {
      return; // Attribute doesn't exist, skip silently
    }

    // Delete existing attribute value first (for both update and clear scenarios)
    const deleteSql = `DELETE FROM product_attribute_value_index WHERE product_id = ${sqlInt(productId)} AND attribute_id = ${sqlInt(attrId)}`;
    this.executeSshSql(deleteSql);

    // If we have tags, insert the new value
    if (variantTags && variantTags.length > 0) {
      const variantText = variantTags.join(", ");
      const insertSql = `INSERT INTO product_attribute_value_index (product_id, attribute_id, option_text) VALUES (${sqlInt(productId)}, ${sqlInt(attrId)}, ${sqlString(variantText)})`;
      this.executeSshSql(insertSql);
      this.logger.info({ product_id: productId, variant_tags: variantTags }, "Synced variant_tags attribute");
    } else {
      this.logger.debug({ product_id: productId }, "Cleared variant_tags attribute (empty/null)");
    }
  }

  /**
   * Test authentication with EverShop API
   */
  async authenticate(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiUrl}/me`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.adminToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        this.logger.error({ status: response.status }, "EverShop authentication failed");
        return false;
      }

      this.logger.info("EverShop authentication successful");
      return true;
    } catch (error) {
      this.logger.error({ error }, "Failed to authenticate with EverShop");
      return false;
    }
  }

  /**
   * Fetch products ready for import
   * Nov 21 Guard: Exclude products accepted without canonical match (UNKNOWN/NULL cm_card_id)
   */
  private fetchStagingReadyProducts(limit: number): ProductRow[] {
    return this.db
      .prepare(
        `SELECT
           product_uid, product_sku, listing_sku, card_name, set_name,
           collector_no, condition_bucket, hp_value, rarity,
           market_price, launch_price, total_quantity,
           staging_ready, pricing_status, cdn_image_url,
           cdn_back_image_url, product_slug, primary_scan_id, variant_tags
         FROM products
         WHERE staging_ready = 1
           AND pricing_status = 'fresh'
           AND market_price IS NOT NULL
           AND cdn_image_url IS NOT NULL
           AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
         LIMIT ?`,
      )
      .all(limit) as ProductRow[];
  }

  /**
   * Resolve the master set list CSV path (data/mastersetlist.csv)
   */
  private resolveMasterSetlistPath(): string | null {
    const candidates = [
      path.resolve(process.cwd(), "data/mastersetlist.csv"),
      path.resolve(process.cwd(), "../../data/mastersetlist.csv"),
      path.resolve(__dirname, "../../../../data/mastersetlist.csv"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Convert a set name into a URL-safe slug
   */
  private toSlug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  /**
   * Ensure slug uniqueness by appending a numeric suffix when necessary
   */
  private ensureUniqueSlug(base: string, usedSlugs: Set<string>, fallbackSeed: string): string {
    const fallback = base || `set-${createHash("sha1").update(fallbackSeed).digest("hex").slice(0, 8)}`;
    let candidate = fallback;
    let suffix = 2;

    while (usedSlugs.has(candidate)) {
      const suffixStr = `-${suffix}`;
      const trimmedBase = fallback.slice(0, Math.max(1, 60 - suffixStr.length));
      candidate = `${trimmedBase}${suffixStr}`;
      suffix += 1;
    }

    usedSlugs.add(candidate);
    return candidate;
  }

  /**
   * Load master set names from CSV for category seeding
   */
  private loadMasterSetSeeds(): { name: string; slug: string }[] {
    const csvPath = this.resolveMasterSetlistPath();

    if (!csvPath) {
      this.logger.warn("mastersetlist.csv not found; skipping EverShop category sync");
      return [];
    }

    const csvContent = fs.readFileSync(csvPath, "utf8");
    const rows = parseCsvSync(csvContent, { columns: true, skip_empty_lines: true, bom: true, trim: true }) as MasterSetRow[];

    const seeds: { name: string; slug: string }[] = [];
    const seenNames = new Set<string>();
    const usedSlugs = new Set<string>();

    for (const row of rows) {
      const name = row.set_name?.trim();
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        continue;
      }

      const baseSlug = this.toSlug(name);
      const slug = this.ensureUniqueSlug(baseSlug, usedSlugs, row.tcgplayer_id ?? row.ppt_id ?? name);

      seeds.push({ name, slug });
      seenNames.add(key);
    }

    return seeds;
  }

  /**
   * Sync EverShop categories with mastersetlist.csv, returning a mapping of set_name -> category_id
   */
  private syncCategoriesFromMasterSetlist(): CategoryLookup {
    const categoryMap = new Map<string, number>();
    const normalizedMap = new Map<string, number>();
    const seeds = this.loadMasterSetSeeds();

    if (seeds.length === 0) {
      return { byName: categoryMap, byNormalized: normalizedMap };
    }

    let existing: { category_id: number; name: string; slug?: string }[] = [];
    try {
      const existingRaw = this.executeSshSql(
        `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (
          SELECT c.category_id, LOWER(cd.name) as name, cd.url_key as slug
          FROM category c
          JOIN category_description cd ON cd.category_description_category_id = c.category_id
        ) t;`,
      );
      existing = JSON.parse(existingRaw.trim());
    } catch (error) {
      this.logger.warn({ error }, "Failed to load existing EverShop categories; proceeding with inserts");
      existing = [];
    }

    const usedSlugs = new Set<string>();
    for (const row of existing) {
      if (row.slug) {
        usedSlugs.add(row.slug);
      }
    }

    const seedsWithSlugs = seeds.map((seed) => {
      const slug = this.ensureUniqueSlug(seed.slug, usedSlugs, seed.name);
      return { ...seed, slug };
    });

    // Use escapeString for safe SQL array building
    const namesArray = seedsWithSlugs.map((seed) => `'${escapeString(seed.name)}'`).join(", ");
    const slugsArray = seedsWithSlugs.map((seed) => `'${escapeString(seed.slug)}'`).join(", ");
    const namesLowerArray = seedsWithSlugs.map((seed) => `'${escapeString(seed.name.toLowerCase())}'`).join(", ");

    const upsertSql = `
DO $$
DECLARE
  names text[] := ARRAY[${namesArray}];
  slugs text[] := ARRAY[${slugsArray}];
  idx integer;
  existing_id integer;
BEGIN
  UPDATE category
  SET status = false, include_in_nav = false
  WHERE category_id IN (
    SELECT category_description_category_id FROM category_description WHERE name IN ('Men', 'Women', 'Kids')
  );

  FOR idx IN array_lower(names, 1)..array_upper(names, 1) LOOP
    SELECT category_description_category_id INTO existing_id
    FROM category_description
    WHERE lower(name) = lower(names[idx])
    LIMIT 1;

    IF existing_id IS NULL THEN
      INSERT INTO category (status, include_in_nav, show_products)
      VALUES (true, true, true)
      RETURNING category_id INTO existing_id;

      INSERT INTO category_description (category_description_category_id, name, description, url_key, meta_title, meta_description)
      VALUES (existing_id, names[idx], NULL, slugs[idx], names[idx], 'Pokemon TCG cards from ' || names[idx])
      ON CONFLICT (category_description_category_id) DO UPDATE SET
        name = excluded.name,
        url_key = excluded.url_key,
        meta_title = excluded.meta_title,
        meta_description = excluded.meta_description;
    ELSE
      UPDATE category
      SET status = true, include_in_nav = true, show_products = true
      WHERE category_id = existing_id;

      UPDATE category_description
      SET name = names[idx],
          url_key = slugs[idx],
          meta_title = names[idx],
          meta_description = 'Pokemon TCG cards from ' || names[idx]
      WHERE category_description_category_id = existing_id;
    END IF;
  END LOOP;
END $$;
`;

    this.executeSshSql(upsertSql);

    const mappingRaw = this.executeSshSql(
      `SELECT COALESCE(json_object_agg(lower(cd.name), c.category_id), '{}'::json)
       FROM category c
       JOIN category_description cd ON cd.category_description_category_id = c.category_id
       WHERE lower(cd.name) = ANY (ARRAY[${namesLowerArray}])`,
    );

    try {
      const mapping = JSON.parse(mappingRaw.trim() || "{}") as Record<string, number>;
      for (const [name, id] of Object.entries(mapping)) {
        if (typeof id === "number") {
          categoryMap.set(name, id);
          const normalized = this.toSlug(name.replace(/[^a-z0-9]+/gi, " ").trim());
          if (normalized) {
            normalizedMap.set(normalized, id);
          }
        }
      }
    } catch (error) {
      this.logger.warn({ error, mappingRaw }, "Failed to parse EverShop category mapping response");
    }

    this.logger.info(
      { categories_synced: categoryMap.size },
      "EverShop categories synchronized from mastersetlist.csv",
    );

    return { byName: categoryMap, byNormalized: normalizedMap };
  }

  /**
   * Resolve category_id from set name using exact and normalized lookups
   */
  private resolveCategoryId(setName: string | null | undefined, lookup: CategoryLookup): number | undefined {
    if (!setName) return undefined;
    const key = setName.toLowerCase();
    const exact = lookup.byName.get(key);
    if (exact) return exact;

    const normalized = this.toSlug(setName.replace(/[^a-z0-9]+/gi, " ").trim());
    return normalized ? lookup.byNormalized.get(normalized) : undefined;
  }

  private getCategoryLookupCached(): CategoryLookup {
    const now = Date.now();
    const csvPath = this.resolveMasterSetlistPath();

    if (!csvPath) {
      return { byName: new Map(), byNormalized: new Map() };
    }

    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(csvPath);
    } catch {
      stat = null;
    }

    const key = stat ? `${csvPath}:${stat.size}:${stat.mtimeMs}` : `${csvPath}:missing`;

    const isFresh =
      this.cachedCategoryLookup &&
      this.cachedCategoryLookupKey === key &&
      this.cachedCategoryLookupAtMs !== null &&
      now - this.cachedCategoryLookupAtMs < this.categorySyncTtlMs;

    if (isFresh && this.cachedCategoryLookup) {
      return this.cachedCategoryLookup;
    }

    try {
      const lookup = this.syncCategoriesFromMasterSetlist();
      this.cachedCategoryLookup = lookup;
      this.cachedCategoryLookupKey = key;
      this.cachedCategoryLookupAtMs = now;
      return lookup;
    } catch (error) {
      if (this.cachedCategoryLookup) {
        this.logger.warn(
          { error, csvPath },
          "EverShop category sync failed; using cached category mapping",
        );
        return this.cachedCategoryLookup;
      }
      this.logger.warn(
        { error, csvPath },
        "EverShop category sync failed; continuing without category mapping",
      );
      return { byName: new Map(), byNormalized: new Map() };
    }
  }

  /**
   * Build product payload for EverShop API
   */
  private buildProductPayload(product: ProductRow, categoryId?: number): ProductPayload {
    // Use canonical computeLaunchPrice which enforces MINIMUM_LISTING_PRICE floor ($0.79)
    const launchPrice = product.launch_price ?? (product.market_price ? computeLaunchPrice(product.market_price) : MINIMUM_LISTING_PRICE);

    // Use actual CDN URLs from database (persisted after ImageKit upload)
    const imageUrl = product.cdn_image_url || undefined;
    const backImageUrl = product.cdn_back_image_url || undefined;

    // Parse variant_tags from JSON string (stored in SQLite as JSON array)
    let variantTags: string[] | undefined;
    if (product.variant_tags) {
      try {
        const parsed = JSON.parse(product.variant_tags);
        if (Array.isArray(parsed) && parsed.length > 0) {
          variantTags = parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
        }
      } catch {
        this.logger.warn({ sku: product.product_sku, variant_tags: product.variant_tags }, "Failed to parse variant_tags JSON");
      }
    }

    return {
      sku: product.product_sku,
      name: product.card_name,
      description: `${product.card_name} from ${product.set_name} (#${product.collector_no})`,
      price: launchPrice,
      quantity: product.total_quantity,
      condition: product.condition_bucket,
      set_name: product.set_name,
      collector_no: product.collector_no,
      hp_value: product.hp_value ?? undefined,
      rarity: product.rarity ?? undefined,
      image_url: imageUrl, // Front image CDN URL
      back_image_url: backImageUrl, // Back image CDN URL
      product_slug: product.product_slug ?? undefined, // SEO-friendly URL key
      cardmint_scan_id: product.primary_scan_id ?? undefined, // For EverShop traceability
      category_id: categoryId,
      variant_tags: variantTags,
    };
  }

  /**
   * Execute SQL via SSH to EverShop PostgreSQL (Docker)
   * EverShop v2.x has no product mutation API, so we use direct PostgreSQL access
   */
  private executeSshSql(sql: string): string {
    const sshKey = this.config.sshKeyPath ?? `${process.env.HOME}/.ssh/cardmint_droplet`;
    const sshUser = this.config.sshUser ?? "cardmint";
    const sshHost = this.config.sshHost ?? "157.245.213.233";
    const dockerPath = this.config.dockerComposePath ?? "/opt/cardmint/docker-compose.yml";
    const dbUser = this.config.dbUser ?? "evershop";
    const dbName = this.config.dbName ?? "evershop";

    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const command = `ssh -i ${sshKey} -o StrictHostKeyChecking=no ${sshUser}@${sshHost} "echo ${sqlBase64} | base64 -d | docker compose -f ${dockerPath} exec -T database psql -U ${dbUser} -d ${dbName} -qAt -F '|'"`;

    try {
      const result = execSync(command, { encoding: "utf-8", timeout: 30000 });
      return result.trim();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown SSH error";
      this.logger.error({ error: errorMsg, sql: sql.slice(0, 200) }, "SSH SQL execution failed");
      throw error;
    }
  }

  private parseFirstRow(result: string): string | null {
    const line = result
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && l.includes("|") && !/^(INSERT|UPDATE|DELETE|SELECT)\b/i.test(l));
    return line ?? null;
  }

  /**
   * Generate SEO-friendly URL key from product name and set
   */
  private generateUrlKey(payload: ProductPayload): string {
    // Use product_slug if available, otherwise generate from name
    if (payload.product_slug) {
      return payload.product_slug;
    }

    const base = `${payload.name}-${payload.set_name ?? ""}-${payload.collector_no ?? ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100);

    return base || `product-${payload.sku.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }

  /**
   * Upsert a single product to EverShop (dry-run or real via PostgreSQL)
   */
  private async upsertProduct(
    payload: ProductPayload,
    dryRun: boolean,
  ): Promise<ImportResult> {
    if (dryRun) {
      this.logger.info({ sku: payload.sku, payload }, "[DRY RUN] Would create/update product");

      return {
        sku: payload.sku,
        status: "created",
        evershop_product_id: `dry-run-${payload.sku}`,
      };
    }

    try {
      // Check if product already exists (use parameterized-style escaping)
      // Also fetch uuid for bidirectional sync linkage
      const existsQuery = `SELECT product_id, uuid FROM product WHERE sku = ${sqlString(payload.sku)}`;
      const existsResult = this.executeSshSql(existsQuery);
      let existingProductId: number | null = null;
      let existingUuid: string | null = null;
      if (existsResult && existsResult.trim()) {
        const row = this.parseFirstRow(existsResult) ?? existsResult.trim();
        const [idStr, uuidStr] = row.split("|").map((s) => s.trim());
        existingProductId = idStr ? parseInt(idStr, 10) : null;
        existingUuid = uuidStr || null;
      }

      const urlKey = this.generateUrlKey(payload);
      const weightGrams = DEFAULT_CARD_WEIGHT_GRAMS;

      if (existingProductId && !isNaN(existingProductId)) {
        // UPDATE existing product
        this.logger.info({ sku: payload.sku, product_id: existingProductId }, "Updating existing EverShop product");

        // Update product table (include cardmint_scan_id for traceability)
        // Note: visibility stays unchanged on UPDATE - operator controls publish state in EverShop admin
        const scanIdClause = payload.cardmint_scan_id ? `, cardmint_scan_id = ${sqlString(payload.cardmint_scan_id)}` : "";
        const categoryClause = payload.category_id ? `, category_id = ${sqlInt(payload.category_id)}` : "";
        const updateProductSql = `UPDATE product SET price = ${sqlNumber(payload.price, { decimals: 4 })}, weight = ${sqlNumber(weightGrams, { decimals: 4 })}, status = true${scanIdClause}${categoryClause}, updated_at = NOW() WHERE product_id = ${sqlInt(existingProductId)}`;
        this.executeSshSql(updateProductSql);

        // Update product_description
        const metaDesc = `${payload.name} from ${payload.set_name ?? ""}`;
        const updateDescSql = `UPDATE product_description SET name = ${sqlString(payload.name)}, description = ${sqlString(payload.description)}, meta_title = ${sqlString(payload.name)}, meta_description = ${sqlString(metaDesc)} WHERE product_description_product_id = ${sqlInt(existingProductId)}`;
        this.executeSshSql(updateDescSql);

        // Update product_inventory
        const updateInvSql = `UPDATE product_inventory SET qty = ${sqlInt(payload.quantity)}, manage_stock = true, stock_availability = ${sqlBool(payload.quantity > 0)} WHERE product_inventory_product_id = ${sqlInt(existingProductId)}`;
        this.executeSshSql(updateInvSql);

        // Update images (Phase 2J: handle images on UPDATE path)
        // Query existing images for this product
        const existingImagesSql = `SELECT product_image_id, origin_image, is_main FROM product_image WHERE product_image_product_id = ${sqlInt(existingProductId)}`;
        const existingImagesRaw = this.executeSshSql(existingImagesSql);
        const existingImages = existingImagesRaw
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const [id, origin, isMain] = line.split("|");
            return { id: id?.trim(), origin: origin?.trim(), isMain: isMain?.trim() === "t" };
          });

        const hasFront = existingImages.some((img) => img.isMain);
        const hasBack = existingImages.some((img) => !img.isMain);

        // Add/update front image if available
        if (payload.image_url) {
          if (!hasFront) {
            // INSERT front image
            const insertImgSql = `INSERT INTO product_image (product_image_product_id, origin_image, is_main) VALUES (${sqlInt(existingProductId)}, ${sqlString(payload.image_url)}, true)`;
            this.executeSshSql(insertImgSql);
            const fixImagesSql = `UPDATE product_image SET thumb_image = ${sqlString(payload.image_url)}, listing_image = ${sqlString(payload.image_url)}, single_image = ${sqlString(payload.image_url)} WHERE product_image_product_id = ${sqlInt(existingProductId)} AND is_main = true`;
            this.executeSshSql(fixImagesSql);
            this.logger.info({ sku: payload.sku, product_id: existingProductId }, "Added front image to existing product");
          } else {
            // UPDATE front image if URL changed
            const frontImg = existingImages.find((img) => img.isMain);
            if (frontImg && frontImg.origin !== payload.image_url) {
              const updateImgSql = `UPDATE product_image SET origin_image = ${sqlString(payload.image_url)}, thumb_image = ${sqlString(payload.image_url)}, listing_image = ${sqlString(payload.image_url)}, single_image = ${sqlString(payload.image_url)} WHERE product_image_id = ${sqlInt(frontImg.id)}`;
              this.executeSshSql(updateImgSql);
              this.logger.info({ sku: payload.sku, product_id: existingProductId }, "Updated front image on existing product");
            }
          }
        }

        // Add/update back image if available
        if (payload.back_image_url) {
          if (!hasBack) {
            // INSERT back image
            const insertBackImgSql = `INSERT INTO product_image (product_image_product_id, origin_image, is_main) VALUES (${sqlInt(existingProductId)}, ${sqlString(payload.back_image_url)}, false)`;
            this.executeSshSql(insertBackImgSql);
            const fixBackImagesSql = `UPDATE product_image SET thumb_image = ${sqlString(payload.back_image_url)}, listing_image = ${sqlString(payload.back_image_url)}, single_image = ${sqlString(payload.back_image_url)} WHERE product_image_product_id = ${sqlInt(existingProductId)} AND origin_image = ${sqlString(payload.back_image_url)}`;
            this.executeSshSql(fixBackImagesSql);
            this.logger.info({ sku: payload.sku, product_id: existingProductId }, "Added back image to existing product");
          } else {
            // UPDATE back image if URL changed
            const backImg = existingImages.find((img) => !img.isMain);
            if (backImg && backImg.origin !== payload.back_image_url) {
              const updateBackImgSql = `UPDATE product_image SET origin_image = ${sqlString(payload.back_image_url)}, thumb_image = ${sqlString(payload.back_image_url)}, listing_image = ${sqlString(payload.back_image_url)}, single_image = ${sqlString(payload.back_image_url)} WHERE product_image_id = ${sqlInt(backImg.id)}`;
              this.executeSshSql(updateBackImgSql);
              this.logger.info({ sku: payload.sku, product_id: existingProductId }, "Updated back image on existing product");
            }
          }
        }

        // Sync variant_tags attribute (Dec 9, 2025)
        // Handles create, update, and delete (when cleared)
        this.syncVariantTagsAttribute(existingProductId, payload.variant_tags);

        return {
          sku: payload.sku,
          status: "updated",
          evershop_product_id: String(existingProductId),
          evershop_uuid: existingUuid ?? undefined,
        };
      }

      // INSERT new product
      this.logger.info({ sku: payload.sku }, "Creating new EverShop product");

      // 1. Insert into product table (include cardmint_scan_id for traceability)
      // visibility=false: Products start in staging (hidden from storefront)
      // Operator publishes via EverShop admin by setting visibility=true
      const scanIdColumn = payload.cardmint_scan_id ? ", cardmint_scan_id" : "";
      const scanIdValue = payload.cardmint_scan_id ? `, ${sqlString(payload.cardmint_scan_id)}` : "";
      const categoryColumn = payload.category_id ? ", category_id" : "";
      const categoryValue = payload.category_id ? `, ${sqlInt(payload.category_id)}` : "";
      // Return both product_id and uuid for bidirectional sync linkage
      const insertProductSql = `INSERT INTO product (sku, price, weight, status, visibility${scanIdColumn}${categoryColumn}) VALUES (${sqlString(payload.sku)}, ${sqlNumber(payload.price, { decimals: 4 })}, ${sqlNumber(weightGrams, { decimals: 4 })}, true, false${scanIdValue}${categoryValue}) RETURNING product_id, uuid`;
      const insertResult = this.executeSshSql(insertProductSql);
      // Parse "product_id | uuid" format from psql output
      const row = this.parseFirstRow(insertResult) ?? insertResult.trim();
      const [productIdStr, uuidStr] = row.split("|").map((s) => s.trim());
      const productId = parseInt(productIdStr, 10);
      const evershopUuid = uuidStr;

      if (isNaN(productId) || !evershopUuid) {
        throw new Error(`Failed to get product_id/uuid from INSERT: ${insertResult}`);
      }

      // 2. Insert into product_description
      const metaDescNew = `${payload.name} from ${payload.set_name ?? ""}`;
      const insertDescSql = `INSERT INTO product_description (product_description_product_id, name, description, url_key, meta_title, meta_description) VALUES (${sqlInt(productId)}, ${sqlString(payload.name)}, ${sqlString(payload.description)}, ${sqlString(urlKey)}, ${sqlString(payload.name)}, ${sqlString(metaDescNew)})`;
      this.executeSshSql(insertDescSql);

      // 3. Insert into product_inventory
      const insertInvSql = `INSERT INTO product_inventory (product_inventory_product_id, qty, manage_stock, stock_availability) VALUES (${sqlInt(productId)}, ${sqlInt(payload.quantity)}, true, ${sqlBool(payload.quantity > 0)})`;
      this.executeSshSql(insertInvSql);

      // 4. Insert front image if available
      if (payload.image_url) {
        const insertImgSql = `INSERT INTO product_image (product_image_product_id, origin_image, is_main) VALUES (${sqlInt(productId)}, ${sqlString(payload.image_url)}, true)`;
        this.executeSshSql(insertImgSql);

        // Fix the trigger issue: EverShop's PRODUCT_IMAGE_ADDED trigger prepends /assets to URLs
        // We need to correct thumb_image, listing_image, single_image to use the original CDN URL
        const fixImagesSql = `UPDATE product_image SET thumb_image = ${sqlString(payload.image_url)}, listing_image = ${sqlString(payload.image_url)}, single_image = ${sqlString(payload.image_url)} WHERE product_image_product_id = ${sqlInt(productId)} AND is_main = true`;
        this.executeSshSql(fixImagesSql);
      }

      // 5. Insert back image if available
      if (payload.back_image_url) {
        const insertBackImgSql = `INSERT INTO product_image (product_image_product_id, origin_image, is_main) VALUES (${sqlInt(productId)}, ${sqlString(payload.back_image_url)}, false)`;
        this.executeSshSql(insertBackImgSql);

        // Fix back image URLs too
        const fixBackImagesSql = `UPDATE product_image SET thumb_image = ${sqlString(payload.back_image_url)}, listing_image = ${sqlString(payload.back_image_url)}, single_image = ${sqlString(payload.back_image_url)} WHERE product_image_product_id = ${sqlInt(productId)} AND origin_image = ${sqlString(payload.back_image_url)}`;
        this.executeSshSql(fixBackImagesSql);
      }

      // 6. Sync variant_tags attribute (Dec 9, 2025)
      this.syncVariantTagsAttribute(productId, payload.variant_tags);

      this.logger.info({ sku: payload.sku, product_id: productId, uuid: evershopUuid }, "EverShop product created successfully");

      return {
        sku: payload.sku,
        status: "created",
        evershop_product_id: String(productId),
        evershop_uuid: evershopUuid,
      };
    } catch (error) {
      this.logger.error({ error, sku: payload.sku }, "Failed to upsert product to EverShop");

      return {
        sku: payload.sku,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Record import job in database
   */
  private recordImportJob(report: ImportReport): void {
    try {
      this.db
        .prepare(
          `INSERT INTO evershop_import_jobs
           (job_id, started_at, completed_at, environment, dry_run,
            total_skus, created_count, updated_count, skipped_count, error_count,
            report_path, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          report.job_id,
          Math.floor(new Date(report.started_at).getTime() / 1000),
          report.completed_at ? Math.floor(new Date(report.completed_at).getTime() / 1000) : null,
          report.environment,
          report.dry_run ? 1 : 0,
          report.total_skus,
          report.created_count,
          report.updated_count,
          report.skipped_count,
          report.error_count,
          null, // report_path will be set after file write
          report.notes ?? null,
        );
    } catch (error) {
      this.logger.error({ error, job_id: report.job_id }, "Failed to record import job");
    }
  }

  /**
   * Run import for N products (dry-run or real)
   */
  async runImport(limit: number, dryRun = true): Promise<ImportReport> {
    const jobId = randomUUID();
    const startedAt = new Date().toISOString();

    this.logger.info(
      {
        jobId,
        limit,
        dryRun,
        environment: this.config.environment,
      },
      "Starting EverShop import",
    );

    const categoryLookup = this.getCategoryLookupCached();

    // Fetch products
    const products = this.fetchStagingReadyProducts(limit);

    this.logger.info({ count: products.length, limit }, "Fetched staging-ready products");

    if (products.length === 0) {
      const report: ImportReport = {
        job_id: jobId,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        environment: this.config.environment,
        dry_run: dryRun,
        total_skus: 0,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        error_count: 0,
        results: [],
        notes: "No staging-ready products found",
      };

      this.logger.info("No products to import");
      return report;
    }

    // Process each product
    const results: ImportResult[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const product of products) {
      const categoryId = this.resolveCategoryId(product.set_name, categoryLookup);
      const payload = this.buildProductPayload(product, categoryId);
      const result = await this.upsertProduct(payload, dryRun);

      results.push(result);

      switch (result.status) {
        case "created":
          createdCount++;
          break;
        case "updated":
          updatedCount++;
          break;
        case "skipped":
          skippedCount++;
          break;
        case "error":
          errorCount++;
          break;
      }

      // Update product record with import metadata (only if not dry-run)
      // Store evershop_uuid for bidirectional sync linkage
      // Only set evershop_sync_state to 'evershop_hidden' for first-time imports
      // (when current state is NULL/not_synced/vault_only) - never regress live products
      if (!dryRun && result.status !== "error") {
        this.db
          .prepare(
            `UPDATE products
             SET last_imported_at = ?,
                 import_job_id = ?,
                 evershop_uuid = COALESCE(?, evershop_uuid),
                 evershop_sync_state = CASE
                   WHEN ? IS NOT NULL AND (evershop_sync_state IS NULL OR evershop_sync_state IN ('not_synced', 'vault_only'))
                     THEN 'evershop_hidden'
                   ELSE evershop_sync_state
                 END
             WHERE product_uid = ?`,
          )
          .run(
            Math.floor(Date.now() / 1000),
            jobId,
            result.evershop_uuid ?? null,
            result.evershop_uuid ?? null,
            product.product_uid
          );
      }
    }

    const completedAt = new Date().toISOString();

    const report: ImportReport = {
      job_id: jobId,
      started_at: startedAt,
      completed_at: completedAt,
      environment: this.config.environment,
      dry_run: dryRun,
      total_skus: products.length,
      created_count: createdCount,
      updated_count: updatedCount,
      skipped_count: skippedCount,
      error_count: errorCount,
      results,
    };

    // Write report to file
    const resultsDir = path.resolve(process.cwd(), "results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const reportPath = path.join(resultsDir, `import_report_${jobId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    this.logger.info({ reportPath }, "Wrote import report");

    // Record in database
    this.recordImportJob(report);

    // Summary
    this.logger.info(
      {
        job_id: jobId,
        total: report.total_skus,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        errors: errorCount,
        dry_run: dryRun,
      },
      "Import complete",
    );

    return report;
  }

  /**
   * Export staging-ready products to CSV
   */
  async exportToCSV(limit: number, outputPath: string): Promise<void> {
    this.logger.info({ limit, outputPath }, "Starting CSV export");

    const products = this.fetchStagingReadyProducts(limit);

    if (products.length === 0) {
      this.logger.info("No products to export");
      return;
    }

    const headers = [
      "sku",
      "name",
      "set_name",
      "collector_no",
      "condition",
      "price_cents",
      "quantity",
      "image_url",
      "product_uid",
    ];

    const rows = products.map((p) => {
      const payload = this.buildProductPayload(p);
      return [
        payload.sku,
        payload.name,
        payload.set_name,
        payload.collector_no,
        payload.condition,
        Math.round(payload.price * 100), // price_cents
        payload.quantity,
        payload.image_url ?? "",
        p.product_uid,
      ].map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v));
    });

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, csvContent);
    this.logger.info({ path: outputPath, count: products.length }, "CSV export complete");
  }

  /**
   * Fetch a single product by product_uid if it meets staging gates
   * Same criteria as batch import: staging_ready=1, pricing_status='fresh', cdn_image_url present
   */
  private fetchProductByUid(productUid: string): ProductRow | null {
    return this.db
      .prepare(
        `SELECT
           product_uid, product_sku, listing_sku, card_name, set_name,
           collector_no, condition_bucket, hp_value, rarity,
           market_price, launch_price, total_quantity,
           staging_ready, pricing_status, cdn_image_url,
           cdn_back_image_url, product_slug, primary_scan_id, variant_tags
         FROM products
         WHERE product_uid = ?
           AND staging_ready = 1
           AND pricing_status = 'fresh'
           AND market_price IS NOT NULL
           AND cdn_image_url IS NOT NULL
           AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)`,
      )
      .get(productUid) as ProductRow | null;
  }

  /**
   * Auto-import a single product after Accept (if staging gates are met)
   * Called by jobActions after Stage 3 promotion completes
   * Fire-and-forget pattern: non-blocking, logs failures without throwing
   */
  async importProductIfReady(productUid: string): Promise<{ imported: boolean; reason?: string }> {
    try {
      const product = this.fetchProductByUid(productUid);

      if (!product) {
        // Product doesn't meet staging gates (not ready, missing price/image, etc.)
        this.logger.debug({ productUid }, "Product not ready for auto-import (staging gates not met)");
        return { imported: false, reason: "staging_gates_not_met" };
      }

      this.logger.info({ productUid, sku: product.product_sku }, "Auto-importing product to EverShop");

      const categoryLookup = this.getCategoryLookupCached();
      const categoryId = this.resolveCategoryId(product.set_name, categoryLookup);

      const payload = this.buildProductPayload(product, categoryId);
      const result = await this.upsertProduct(payload, false); // dry_run = false

      if (result.status === "error") {
        this.logger.warn({ productUid, error: result.error }, "Auto-import failed");
        return { imported: false, reason: result.error };
      }

      // Update product record with import metadata and evershop_uuid for bidirectional sync
      // Only set evershop_sync_state to 'evershop_hidden' for first-time imports
      // (when current state is NULL/not_synced/vault_only) - never regress live products
      this.db
        .prepare(
          `UPDATE products
           SET last_imported_at = ?,
               import_job_id = 'auto-import',
               evershop_product_id = COALESCE(?, evershop_product_id),
               evershop_uuid = COALESCE(?, evershop_uuid),
               evershop_sync_state = CASE
                 WHEN ? IS NOT NULL AND (evershop_sync_state IS NULL OR evershop_sync_state IN ('not_synced', 'vault_only'))
                   THEN 'evershop_hidden'
                 ELSE evershop_sync_state
               END
           WHERE product_uid = ?`,
        )
        .run(
          Math.floor(Date.now() / 1000),
          result.evershop_product_id ? parseInt(result.evershop_product_id, 10) : null,
          result.evershop_uuid ?? null,
          result.evershop_uuid ?? null,
          productUid
        );

      this.logger.info(
        { productUid, sku: product.product_sku, evershopProductId: result.evershop_product_id, evershopUuid: result.evershop_uuid },
        "Auto-import successful",
      );

      return { imported: true };
    } catch (error) {
      this.logger.error({ error, productUid }, "Auto-import threw exception");
      return { imported: false, reason: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}
