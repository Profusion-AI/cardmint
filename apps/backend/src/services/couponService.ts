/**
 * Coupon Validation Service
 *
 * Validates EverShop-managed coupons for CardMint's custom checkout flow.
 * Uses SSH to query EverShop Postgres directly (same pattern as evershopClient.ts).
 *
 * Supports percentage discount coupons only in v1.
 * Coupons are created/managed via EverShop Admin → Promotion → Coupons.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "pino";
import { promisify } from "node:util";
import { runtimeConfig } from "../config";
import { sqlString } from "./importer/sqlSanitizer";

/** Validation failure reasons */
export type CouponInvalidReason =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "MAX_USES_REACHED"
  | "UNSUPPORTED_TYPE"
  | "MIN_ORDER_NOT_MET";

/** Successful validation result */
export interface CouponValidResult {
  valid: true;
  coupon: {
    code: string;
    discount_pct: number;
    discount_type: "percentage";
    discount_cents: number;
  };
}

/** Failed validation result */
export interface CouponInvalidResult {
  valid: false;
  reason: CouponInvalidReason;
  message: string;
}

export type CouponValidationResult = CouponValidResult | CouponInvalidResult;

/** Raw coupon row from EverShop Postgres */
interface CouponRow {
  coupon_id: number;
  coupon: string;
  status: boolean;
  discount_amount: number;
  discount_type: string;
  start_date: string | null;
  end_date: string | null;
  used_time: number;
  max_uses_time_per_coupon: number | null;
  condition: string | null; // JSONB as string
}

/** Parsed condition JSONB (subset we care about) */
interface CouponCondition {
  order_total?: number; // Minimum order total in dollars
  order_qty?: number;
}

export class CouponService {
  private readonly sshHost: string;
  private readonly sshUser: string;
  private readonly sshKeyPath: string;
  private readonly dockerComposePath: string;
  private readonly dbUser: string;
  private readonly dbName: string;
  private readonly isLocalMode: boolean;

  constructor(private readonly logger: Logger) {
    this.sshHost = runtimeConfig.evershopSshHost;
    this.sshUser = runtimeConfig.evershopSshUser;
    this.sshKeyPath = runtimeConfig.evershopSshKeyPath;
    this.dockerComposePath = runtimeConfig.evershopDockerComposePath;
    this.dbUser = runtimeConfig.evershopDbUser;
    this.dbName = runtimeConfig.evershopDbName;

    // Prod deployment: backend runs on the droplet itself (PROD_SQLITE_LOCAL=1),
    // so EverShop Postgres queries should run locally (no SSH keys needed).
    this.isLocalMode = runtimeConfig.prodSqliteLocal && existsSync(this.dockerComposePath);

    if (runtimeConfig.prodSqliteLocal) {
      if (this.isLocalMode) {
        this.logger.info(
          { dockerComposePath: this.dockerComposePath },
          "CouponService: local mode enabled (docker compose exec)"
        );
      } else {
        this.logger.warn(
          { dockerComposePath: this.dockerComposePath },
          "CouponService: PROD_SQLITE_LOCAL=true but docker compose path not found, falling back to SSH"
        );
      }
    }
  }

  private readonly execFileAsync = promisify(execFile);

  /**
   * Validate a coupon code against EverShop Postgres
   *
   * @param code - The coupon code to validate (case-insensitive match)
   * @param validationSubtotalCents - Cart subtotal in cents used for eligibility checks (e.g. min order)
   * @param discountBaseCents - Optional cents value used for computing discount (defaults to validation subtotal)
   * @returns Validation result with discount info or failure reason
   */
  async validateCoupon(
    code: string,
    validationSubtotalCents: number,
    discountBaseCents?: number
  ): Promise<CouponValidationResult> {
    // Sanitize input: EverShop coupon codes allow [a-zA-Z0-9_-], no spaces
    const sanitizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!sanitizedCode) {
      return {
        valid: false,
        reason: "NOT_FOUND",
        message: "Invalid coupon code format",
      };
    }

    try {
      const coupon = await this.fetchCoupon(sanitizedCode);

      if (!coupon) {
        this.logger.debug({ code: sanitizedCode }, "Coupon not found");
        return {
          valid: false,
          reason: "NOT_FOUND",
          message: "Coupon code not found",
        };
      }

      // Validation checks in order of priority
      // 1. Active status
      if (!coupon.status) {
        return {
          valid: false,
          reason: "INACTIVE",
          message: "This coupon is no longer active",
        };
      }

      // 2. Start date
      if (coupon.start_date) {
        const startDate = new Date(coupon.start_date);
        if (startDate > new Date()) {
          return {
            valid: false,
            reason: "NOT_STARTED",
            message: "This coupon is not yet active",
          };
        }
      }

      // 3. End date
      if (coupon.end_date) {
        const endDate = new Date(coupon.end_date);
        if (endDate < new Date()) {
          return {
            valid: false,
            reason: "EXPIRED",
            message: "This coupon has expired",
          };
        }
      }

      // 4. Usage limit
      if (
        coupon.max_uses_time_per_coupon !== null &&
        coupon.used_time >= coupon.max_uses_time_per_coupon
      ) {
        return {
          valid: false,
          reason: "MAX_USES_REACHED",
          message: "This coupon has reached its usage limit",
        };
      }

      // 5. Discount type (only percentage supported in v1)
      if (coupon.discount_type !== "percentage_discount_to_entire_order") {
        this.logger.warn(
          { code: sanitizedCode, type: coupon.discount_type },
          "Unsupported coupon type"
        );
        return {
          valid: false,
          reason: "UNSUPPORTED_TYPE",
          message: "This coupon type is not supported for online checkout",
        };
      }

      // 6. Minimum order condition
      const condition = this.parseCondition(coupon.condition);
      if (condition?.order_total) {
        const minOrderCents = Math.round(condition.order_total * 100);
        if (validationSubtotalCents < minOrderCents) {
          return {
            valid: false,
            reason: "MIN_ORDER_NOT_MET",
            message: `Minimum order of $${condition.order_total.toFixed(2)} required`,
          };
        }
      }

      // All checks passed - calculate discount
      const discountPct = coupon.discount_amount;
      const baseCents = typeof discountBaseCents === "number" ? discountBaseCents : validationSubtotalCents;
      const discountCents = Math.floor((baseCents * discountPct) / 100);

      this.logger.info(
        {
          code: sanitizedCode,
          discountPct,
          discountCents,
          validationSubtotalCents,
          discountBaseCents: baseCents,
        },
        "Coupon validated successfully"
      );

      return {
        valid: true,
        coupon: {
          code: sanitizedCode,
          discount_pct: discountPct,
          discount_type: "percentage",
          discount_cents: discountCents,
        },
      };
    } catch (error) {
      this.logger.error(
        { error, code: sanitizedCode },
        "Error validating coupon"
      );
      throw error;
    }
  }

  /**
   * Increment coupon usage counter after successful payment
   * Called from Stripe webhook handler
   *
   * @param code - The coupon code to increment
   */
  async incrementUsage(code: string): Promise<boolean> {
    const sanitizedCode = code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!sanitizedCode) {
      this.logger.warn({ code }, "Cannot increment usage for invalid code");
      return false;
    }

    try {
      const sql = `UPDATE coupon SET used_time = COALESCE(used_time, 0) + 1 WHERE UPPER(coupon) = ${sqlString(sanitizedCode)}`;
      await this.executeSql(sql);
      this.logger.info({ code: sanitizedCode }, "Incremented coupon usage");
      return true;
    } catch (error) {
      // Log but don't throw - usage tracking is non-critical
      this.logger.error(
        { error, code: sanitizedCode },
        "Failed to increment coupon usage"
      );
      return false;
    }
  }

  /**
   * Fetch coupon from EverShop Postgres
   */
  private async fetchCoupon(code: string): Promise<CouponRow | null> {
    // Query with case-insensitive match (EverShop stores as-entered)
    const sql = `
      SELECT
        coupon_id,
        coupon,
        status,
        discount_amount,
        discount_type,
        start_date,
        end_date,
        used_time,
        max_uses_time_per_coupon,
        condition
      FROM coupon
      WHERE UPPER(coupon) = ${sqlString(code)}
      LIMIT 1
    `;

    const result = await this.executeSql(sql);
    if (!result.trim()) {
      return null;
    }

    // Parse pipe-delimited result (psql -F '|')
    const parts = result.trim().split("|");
    if (parts.length < 10) {
      this.logger.warn(
        { result, parts: parts.length },
        "Unexpected coupon query result format"
      );
      return null;
    }

    return {
      coupon_id: parseInt(parts[0], 10),
      coupon: parts[1],
      status: parts[2] === "t" || parts[2] === "true",
      discount_amount: parseFloat(parts[3]) || 0,
      discount_type: parts[4],
      start_date: parts[5] || null,
      end_date: parts[6] || null,
      used_time: parseInt(parts[7], 10) || 0,
      max_uses_time_per_coupon: parts[8] ? parseInt(parts[8], 10) : null,
      condition: parts[9] || null,
    };
  }

  /**
   * Parse JSONB condition field
   */
  private parseCondition(conditionStr: string | null): CouponCondition | null {
    if (!conditionStr) return null;

    try {
      const parsed = JSON.parse(conditionStr);
      const rawOrderTotal = parsed?.order_total;
      const orderTotal =
        typeof rawOrderTotal === "number"
          ? rawOrderTotal
          : typeof rawOrderTotal === "string"
            ? parseFloat(rawOrderTotal)
            : undefined;

      const rawOrderQty = parsed?.order_qty;
      const orderQty =
        typeof rawOrderQty === "number"
          ? rawOrderQty
          : typeof rawOrderQty === "string"
            ? parseInt(rawOrderQty, 10)
            : undefined;

      return {
        order_total:
          typeof orderTotal === "number" && Number.isFinite(orderTotal) && orderTotal > 0
            ? orderTotal
            : undefined,
        order_qty:
          typeof orderQty === "number" && Number.isFinite(orderQty) && orderQty > 0
            ? orderQty
            : undefined,
      };
    } catch {
      this.logger.debug(
        { conditionStr },
        "Failed to parse coupon condition JSONB"
      );
      return null;
    }
  }

  /**
   * Execute SQL (local in prod, else via SSH)
   */
  private async executeSql(sql: string): Promise<string> {
    if (this.isLocalMode) {
      return this.executeLocalSql(sql);
    }
    return this.executeSshSql(sql);
  }

  /**
   * Execute SQL locally against EverShop PostgreSQL (Docker Compose)
   */
  private async executeLocalSql(sql: string): Promise<string> {
    try {
      const { stdout } = await this.execFileAsync(
        "docker",
        [
          "compose",
          "-f",
          this.dockerComposePath,
          "exec",
          "-T",
          "database",
          "psql",
          "-U",
          this.dbUser,
          "-d",
          this.dbName,
          "-qAt",
          "-F",
          "|",
          "-c",
          sql,
        ],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      return stdout.trim();
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      this.logger.error(
        {
          error: err?.message ?? String(error),
          stderr: err?.stderr?.slice(0, 500),
          sql: sql.slice(0, 200),
        },
        "Local SQL execution failed"
      );
      throw error;
    }
  }

  /**
   * Execute SQL via SSH to EverShop PostgreSQL (Docker)
   * Pattern copied from evershopClient.ts:515-534
   */
  private async executeSshSql(sql: string): Promise<string> {
    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const remoteCommand = `echo ${sqlBase64} | base64 -d | docker compose -f ${this.dockerComposePath} exec -T database psql -U ${this.dbUser} -d ${this.dbName} -qAt -F '|'`;

    try {
      const { stdout } = await this.execFileAsync(
        "ssh",
        [
          "-i",
          this.sshKeyPath,
          "-o",
          "StrictHostKeyChecking=no",
          `${this.sshUser}@${this.sshHost}`,
          remoteCommand,
        ],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }
      );
      return stdout.trim();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown SSH error";
      this.logger.error(
        { error: errorMsg, sql: sql.slice(0, 200) },
        "SSH SQL execution failed"
      );
      throw error;
    }
  }
}
