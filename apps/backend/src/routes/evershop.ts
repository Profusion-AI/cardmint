/**
 * EverShop Routes (Staging & Import)
 *
 * Phase 3 extraction (Nov 2025).
 * Handles EverShop integration: staging dashboard and product import.
 * See apps/backend/docs/routes-evershop.md for rationale.
 */

import type { Express, Request, Response } from "express";
import type { AppContext } from "../app/context";
import { EverShopImporter } from "../services/importer/evershopClient";
import type { EverShopConfig } from "../services/importer/types";
import { computeLaunchPrice } from "../services/pricing/types";
import { runtimeConfig } from "../config";

export function registerEvershopRoutes(app: Express, ctx: AppContext): void {
  const { db, logger } = ctx;

  // Initialize EverShop importer with SSH config for direct PostgreSQL access
  // Config loaded from centralized runtimeConfig (env-driven, single source of truth)
  const evershopConfig: EverShopConfig = {
    apiUrl: runtimeConfig.evershopApiUrl,
    adminToken: runtimeConfig.evershopAdminToken,
    environment: runtimeConfig.evershopEnvironment as "staging" | "production",
    sshKeyPath: runtimeConfig.evershopSshKeyPath,
    sshUser: runtimeConfig.evershopSshUser,
    sshHost: runtimeConfig.evershopSshHost,
    dockerComposePath: runtimeConfig.evershopDockerComposePath,
    dbUser: runtimeConfig.evershopDbUser,
    dbName: runtimeConfig.evershopDbName,
  };
  const evershopImporter = new EverShopImporter(db, evershopConfig, logger);

  /**
   * POST /api/evershop/import
   * Trigger EverShop import for staging-ready products
   *
   * Query params:
   *   - limit: Max products to import (default: 10, max: EVERSHOP_IMPORT_BATCH_LIMIT)
   *   - confirm: Set to "true" to execute real import (requires env flag + idempotency key)
   *
   * Headers (for confirm=true):
   *   - X-Idempotency-Key: Required for confirmed imports (UUID format recommended)
   *   - Authorization: Basic Auth (user logged for audit)
   *
   * Safeguards:
   *   1. dry_run default unless confirm=true AND EVERSHOP_IMPORT_ENABLE_CONFIRM=true
   *   2. Batch size capped by EVERSHOP_IMPORT_BATCH_LIMIT (default 25)
   *   3. Idempotency key required for confirmed imports (rejects 409 on hash mismatch)
   *   4. Full audit trail (user, IP, payload, results)
   */
  app.post("/api/evershop/import", async (req: Request, res: Response) => {
    const { importSafeguards } = ctx;
    const maxBatchSize = runtimeConfig.evershopImportBatchLimit;

    // Parse and cap limit
    const requestedLimit = parseInt(req.query.limit as string, 10) || 10;
    const limit = Math.min(requestedLimit, maxBatchSize);

    // Log if limit was capped
    if (requestedLimit > maxBatchSize) {
      logger.warn(
        { requested: requestedLimit, capped: limit, max: maxBatchSize },
        "evershop_import.batch_limit_exceeded"
      );
    }

    // Determine dry-run vs confirm mode (query param only, ignore body)
    const confirmRequested = req.query.confirm === "true";
    const confirmEnabled = runtimeConfig.evershopImportEnableConfirm;

    // Default to dry-run unless BOTH confirm=true AND env flag is set
    let dryRun = true;
    if (confirmRequested) {
      if (!confirmEnabled) {
        logger.warn(
          { confirmRequested },
          "evershop_import.confirm_blocked_envflag"
        );
        return res.status(403).json({
          error: "CONFIRM_DISABLED",
          message: "Live imports disabled. Set EVERSHOP_IMPORT_ENABLE_CONFIRM=true to enable.",
        });
      }
      dryRun = false;
    }

    // Extract audit info
    const userId = importSafeguards.extractBasicAuthUser(req.headers.authorization);
    const clientIp = importSafeguards.extractClientIp(
      req.headers["x-forwarded-for"] as string | undefined,
      req.socket.remoteAddress
    );
    const userAgent = req.headers["user-agent"] ?? null;

    // Idempotency key required for confirmed imports
    const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;

    if (!dryRun && !idempotencyKey) {
      return res.status(400).json({
        error: "IDEMPOTENCY_KEY_REQUIRED",
        message: "X-Idempotency-Key header required for confirmed imports",
      });
    }

    // Query staging-ready product UIDs for idempotency hash (BEFORE import)
    // This ensures same key can't be reused if staging_ready set changes
    const stagingReadyUids = db.prepare(`
      SELECT product_uid FROM products
      WHERE staging_ready = 1
        AND pricing_status = 'fresh'
        AND market_price IS NOT NULL
        AND cdn_image_url IS NOT NULL
        AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
      ORDER BY product_uid
      LIMIT ?
    `).all(limit) as { product_uid: string }[];

    const productUids = stagingReadyUids.map(r => r.product_uid);
    const payloadHash = importSafeguards.hashPayload(limit, productUids);

    // Check idempotency (for confirmed imports only)
    if (!dryRun && idempotencyKey) {
      const check = importSafeguards.checkIdempotency(idempotencyKey);
      if (check.exists) {
        // Key already used - check status and hash
        if (check.status === "pending") {
          logger.info({ idempotencyKey, jobId: check.jobId }, "evershop_import.already_in_progress");
          return res.status(409).json({
            error: "IMPORT_IN_PROGRESS",
            message: "Import with this idempotency key is already in progress",
            job_id: check.jobId,
          });
        }

        // For completed/failed, check payload hash matches (409 on mismatch)
        if (check.requestHash && check.requestHash !== payloadHash) {
          logger.warn(
            { idempotencyKey, existingHash: check.requestHash, newHash: payloadHash },
            "evershop_import.idempotency_hash_mismatch"
          );
          return res.status(409).json({
            error: "IDEMPOTENCY_KEY_MISMATCH",
            message: "Idempotency key already used with different payload. Use a new key to retry.",
          });
        }

        // Allow replay if failed with same hash (user is retrying)
        if (check.status === "failed") {
          logger.info({ idempotencyKey, status: check.status }, "evershop_import.retry_after_failure");
          // Continue to run import (don't return cached failure)
        } else {
          // Return cached result with stored report details for completed/aborted
          logger.info({ idempotencyKey, status: check.status }, "evershop_import.idempotent_replay");
          const storedReport = importSafeguards.getAuditEntryByIdempotencyKey(idempotencyKey);
          return res.status(200).json({
            ok: check.status === "completed",
            idempotent: true,
            message: `Import already processed (${check.status})`,
            job_id: check.jobId,
            // Return stored results so caller knows what happened
            stored_report: storedReport
              ? {
                  total_skus: storedReport.imported,
                  created_count: storedReport.created,
                  updated_count: storedReport.updated,
                  error_count: storedReport.errored,
                  result_status: storedReport.status,
                }
              : null,
          });
        }
      }

      // Register idempotency key before processing
      const registered = importSafeguards.registerIdempotencyKey(
        idempotencyKey,
        payloadHash,
        userId,
        clientIp
      );

      if (!registered) {
        // Concurrent request beat us to it
        logger.info({ idempotencyKey }, "evershop_import.concurrent_request");
        return res.status(409).json({
          error: "IMPORT_IN_PROGRESS",
          message: "Import with this idempotency key is already in progress",
        });
      }
    }

    // Create audit entry before import (ensures failures are logged)
    let auditId: number | null = null;
    if (!dryRun && idempotencyKey) {
      auditId = importSafeguards.createAuditEntry({
        jobId: null, // Updated after import starts
        idempotencyKey,
        userId,
        clientIp,
        userAgent,
        payloadSummary: {
          limit,
          skuCount: productUids.length,
          firstSkus: productUids.slice(0, 5), // First 5 for audit trail
        },
        confirmMode: true,
      });
    }

    try {
      logger.info(
        {
          limit,
          dryRun,
          userId: userId ?? "unknown",
          clientIp: clientIp ?? "unknown",
          idempotencyKey: idempotencyKey ?? "(dry-run)",
        },
        "evershop_import.starting"
      );

      const report = await evershopImporter.runImport(limit, dryRun);

      // Update audit and idempotency with results (for confirmed imports)
      if (!dryRun && idempotencyKey) {
        // Update idempotency with job_id
        importSafeguards.updateIdempotencyJobId(idempotencyKey, report.job_id);

        // Complete audit entry
        const resultStatus =
          report.error_count === 0
            ? "success"
            : report.error_count < report.total_skus
              ? "partial"
              : "failed";

        importSafeguards.completeAuditEntry(idempotencyKey, {
          imported: report.total_skus,
          created: report.created_count,
          updated: report.updated_count,
          errored: report.error_count,
          status: resultStatus,
        });

        importSafeguards.completeIdempotency(
          idempotencyKey,
          report.error_count === 0 ? "completed" : "failed"
        );
      }

      res.json({
        ok: true,
        report,
        safeguards: {
          dry_run: dryRun,
          confirm_enabled: confirmEnabled,
          batch_limit: maxBatchSize,
          idempotency_key: idempotencyKey ?? null,
        },
      });
    } catch (error) {
      logger.error({ error, idempotencyKey }, "evershop_import.failed");

      // Mark idempotency as failed and complete audit (even on errors)
      if (!dryRun && idempotencyKey) {
        importSafeguards.completeAuditEntry(idempotencyKey, {
          imported: 0,
          created: 0,
          updated: 0,
          errored: 0,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        importSafeguards.completeIdempotency(idempotencyKey, "failed");
      }

      res.status(500).json({
        error: "IMPORT_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /admin/staging
   * Staging dashboard HTML page showing products ready for import
   * Matches EverShop admin theme/styling
   */
  app.get("/admin/staging", (req: Request, res: Response) => {
    try {
      const products = db.prepare(`
        SELECT
          product_uid, product_sku, listing_sku, card_name, set_name,
          collector_no, condition_bucket, market_price, launch_price,
          total_quantity, staging_ready, pricing_status, cdn_image_url,
          cdn_back_image_url, product_slug, last_imported_at
        FROM products
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
        ORDER BY updated_at DESC
        LIMIT 50
      `).all() as any[];

      const importedCount = products.filter(p => p.last_imported_at).length;
      const pendingCount = products.length - importedCount;

      const productRows = products.map(p => {
        const launchPrice = p.launch_price ?? computeLaunchPrice(p.market_price);
        const status = p.last_imported_at ? '✓ Imported' : '⏳ Pending';
        const statusClass = p.last_imported_at ? 'imported' : 'pending';
        return `
          <tr class="${statusClass}">
            <td><img src="${p.cdn_image_url}" alt="${p.card_name}" style="width:50px;height:70px;object-fit:cover;border-radius:4px;"></td>
            <td><strong>${p.card_name}</strong><br><small>${p.set_name} #${p.collector_no}</small></td>
            <td><code>${p.product_sku}</code></td>
            <td>$${p.market_price.toFixed(2)}</td>
            <td>$${launchPrice.toFixed(2)}</td>
            <td>${p.total_quantity}</td>
            <td>${p.condition_bucket}</td>
            <td class="status-${statusClass}">${status}</td>
          </tr>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Staging - CardMint Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; }
    .header { background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); color: white; padding: 1.5rem 2rem; }
    .header h1 { font-size: 1.5rem; font-weight: 600; }
    .header p { opacity: 0.9; margin-top: 0.25rem; }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    .stats { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: white; border-radius: 8px; padding: 1rem 1.5rem; flex: 1; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 0.875rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 2rem; font-weight: 700; color: #1f2937; margin-top: 0.25rem; }
    .stat-card.pending .value { color: #f59e0b; }
    .stat-card.imported .value { color: #10b981; }
    .actions { margin-bottom: 1.5rem; }
    .btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.25rem; border: none; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; transition: all 0.15s; }
    .btn-primary { background: #4f46e5; color: white; }
    .btn-primary:hover { background: #4338ca; }
    .btn-secondary { background: white; color: #374151; border: 1px solid #d1d5db; }
    .btn-secondary:hover { background: #f9fafb; }
    table { width: 100%; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-collapse: collapse; overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    tr:hover { background: #f9fafb; }
    tr.imported { background: #f0fdf4; }
    tr.pending { background: #fffbeb; }
    .status-imported { color: #059669; font-weight: 500; }
    .status-pending { color: #d97706; font-weight: 500; }
    code { background: #f3f4f6; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.75rem; }
    small { color: #6b7280; }
    .nav { background: #1f2937; padding: 0.75rem 2rem; display: flex; gap: 1rem; }
    .nav a { color: #d1d5db; text-decoration: none; font-size: 0.875rem; padding: 0.5rem 1rem; border-radius: 4px; }
    .nav a:hover, .nav a.active { background: #374151; color: white; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/admin">← Dashboard</a>
    <a href="/admin/products">Products</a>
    <a href="/admin/staging" class="active">Staging</a>
    <a href="/admin/orders">Orders</a>
  </nav>
  <div class="header">
    <h1>📦 Staging Queue</h1>
    <p>Products ready for EverShop import from CardMint inventory</p>
  </div>
  <div class="container">
    <div class="stats">
      <div class="stat-card pending">
        <h3>Pending Import</h3>
        <div class="value">${pendingCount}</div>
      </div>
      <div class="stat-card imported">
        <h3>Imported</h3>
        <div class="value">${importedCount}</div>
      </div>
      <div class="stat-card">
        <h3>Total Staging Ready</h3>
        <div class="value">${products.length}</div>
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" onclick="runImport()">🚀 Run Import (Dry Run)</button>
      <button class="btn btn-secondary" onclick="location.reload()">🔄 Refresh</button>
    </div>
    <table>
      <thead>
        <tr>
          <th>Image</th>
          <th>Card</th>
          <th>SKU</th>
          <th>Market</th>
          <th>Launch</th>
          <th>Qty</th>
          <th>Condition</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${productRows || '<tr><td colspan="8" style="text-align:center;padding:2rem;color:#6b7280;">No staging-ready products found</td></tr>'}
      </tbody>
    </table>
  </div>
  <script>
    async function runImport() {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '⏳ Running...';
      try {
        const res = await fetch('/api/evershop/import?limit=10', { method: 'POST' });
        const data = await res.json();
        alert('Import Result:\\n' + JSON.stringify(data.report, null, 2));
        location.reload();
      } catch (e) {
        alert('Import failed: ' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '🚀 Run Import (Dry Run)';
    }
  </script>
</body>
</html>`;

      res.type('html').send(html);
    } catch (error) {
      logger.error({ error }, "Failed to render staging dashboard");
      res.status(500).send('Error loading staging dashboard');
    }
  });

  /**
   * GET /api/evershop/staging-ready
   * List products ready for EverShop import
   */
  app.get("/api/evershop/staging-ready", (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;

      const products = db.prepare(`
        SELECT
          product_uid, product_sku, listing_sku, card_name, set_name,
          collector_no, condition_bucket, market_price, launch_price,
          total_quantity, staging_ready, pricing_status, cdn_image_url,
          cdn_back_image_url, product_slug
        FROM products
        WHERE staging_ready = 1
          AND pricing_status = 'fresh'
          AND market_price IS NOT NULL
          AND cdn_image_url IS NOT NULL
          AND (accepted_without_canonical IS NULL OR accepted_without_canonical = 0)
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(limit);

      res.json({
        ok: true,
        count: products.length,
        products,
      });
    } catch (error) {
      logger.error({ error }, "Failed to fetch staging-ready products");
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
