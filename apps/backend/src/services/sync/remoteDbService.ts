/**
 * Remote Database Service
 * SSH tunnel to prod SQLite with retry/backoff
 * Supports local mode when running on prod server itself (PROD_SQLITE_LOCAL=1)
 * RFC-fullduplexDB_triple Phase 1
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "pino";
import { runtimeConfig } from "../../config";
import { RetryConfig, DEFAULT_RETRY_CONFIG } from "./types";

export interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface TransactionStatement {
  sql: string;
  params?: unknown[];
}

export interface TransactionResult {
  success: boolean;
  error?: string;
  results?: RunResult[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RemoteDbService {
  private readonly sshHost: string;
  private readonly sshUser: string;
  private readonly sshKeyPath: string;
  private readonly dbPath: string;
  private readonly retryConfig: RetryConfig;
  private readonly isLocalMode: boolean;

  constructor(
    private readonly logger: Logger,
    retryConfig?: Partial<RetryConfig>
  ) {
    this.sshHost = runtimeConfig.prodSshHost;
    this.sshUser = runtimeConfig.prodSshUser;
    this.sshKeyPath = runtimeConfig.prodSshKeyPath;
    this.dbPath = runtimeConfig.prodDbPath;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

    // Detect local mode: config flag + file must exist locally
    this.isLocalMode = runtimeConfig.prodSqliteLocal && existsSync(this.dbPath);

    if (runtimeConfig.prodSqliteLocal) {
      if (this.isLocalMode) {
        this.logger.info({ dbPath: this.dbPath }, "RemoteDbService: local mode enabled (direct file access)");
      } else {
        this.logger.warn(
          { dbPath: this.dbPath },
          "RemoteDbService: PROD_SQLITE_LOCAL=true but file not found, falling back to SSH"
        );
      }
    }
  }

  /**
   * Execute SQL on prod SQLite (local or via SSH depending on mode)
   */
  private executeSql(sql: string, timeoutMs = 30000): string {
    if (this.isLocalMode) {
      return this.executeLocalSql(sql, timeoutMs);
    }
    return this.executeSshSql(sql, timeoutMs);
  }

  /**
   * Execute SQL locally via sqlite3 CLI
   */
  private executeLocalSql(sql: string, timeoutMs = 30000): string {
    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const command = `echo ${sqlBase64} | base64 -d | sqlite3 "${this.dbPath}"`;

    try {
      const result = execSync(command, { encoding: "utf-8", timeout: timeoutMs, shell: "/bin/bash" });
      return result.trim();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown local SQL error";
      this.logger.error({ error: errorMsg, sql: sql.slice(0, 200) }, "Local SQL execution failed");
      throw error;
    }
  }

  /**
   * Execute SQL on prod SQLite via SSH
   */
  private executeSshSql(sql: string, timeoutMs = 30000): string {
    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const command = `ssh -i ${this.sshKeyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${this.sshUser}@${this.sshHost} "echo ${sqlBase64} | base64 -d | sqlite3 ${this.dbPath}"`;

    try {
      const result = execSync(command, { encoding: "utf-8", timeout: timeoutMs });
      return result.trim();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown SSH error";
      this.logger.error({ error: errorMsg, sql: sql.slice(0, 200) }, "SSH SQL execution failed");
      throw error;
    }
  }

  /**
   * Execute with retry/backoff
   */
  private async withRetry<T>(
    operation: () => T,
    context: string
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.retryConfig.maxRetries; attempt++) {
      try {
        return operation();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { attempt: attempt + 1, maxRetries: this.retryConfig.maxRetries, context, error: lastError.message },
          "Operation failed, retrying"
        );

        if (attempt < this.retryConfig.maxRetries - 1) {
          const delay = Math.min(
            this.retryConfig.baseDelayMs * Math.pow(2, attempt),
            this.retryConfig.maxDelayMs
          );
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /**
   * Query prod SQLite and return rows
   */
  async queryProd<T>(sql: string): Promise<T[]> {
    return this.withRetry(() => {
      const jsonSql = `SELECT json_group_array(json_object(${this.getJsonColumns(sql)})) FROM (${sql})`;
      const result = this.executeSql(jsonSql);

      if (!result || result === "[]" || result === "null") {
        return [];
      }

      try {
        return JSON.parse(result) as T[];
      } catch {
        this.logger.warn({ result }, "Failed to parse query result as JSON");
        return [];
      }
    }, `queryProd: ${sql.slice(0, 100)}`);
  }

  /**
   * Run a single SQL statement on prod SQLite (INSERT/UPDATE/DELETE)
   */
  async runProd(sql: string): Promise<RunResult> {
    return this.withRetry(() => {
      this.executeSql(sql);
      const changesResult = this.executeSql("SELECT changes();");
      const changes = parseInt(changesResult, 10) || 0;

      return { changes };
    }, `runProd: ${sql.slice(0, 100)}`);
  }

  /**
   * Execute multiple statements in a transaction
   */
  async transactionProd(statements: TransactionStatement[]): Promise<TransactionResult> {
    return this.withRetry(() => {
      const combinedSql = [
        "BEGIN IMMEDIATE;",
        ...statements.map((s) => this.interpolateSql(s.sql, s.params)),
        "COMMIT;",
      ].join("\n");

      try {
        this.executeSql(combinedSql);
        return { success: true, results: statements.map(() => ({ changes: 0 })) };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        try {
          this.executeSql("ROLLBACK;");
        } catch {
          // Ignore rollback errors
        }
        return { success: false, error: errorMsg };
      }
    }, "transactionProd");
  }

  /**
   * Check if prod SQLite is reachable
   */
  async isReachable(): Promise<boolean> {
    try {
      const result = this.executeSql("SELECT 1;", 5000);
      return result.trim() === "1";
    } catch {
      return false;
    }
  }

  /**
   * Get row count from a table
   */
  async getRowCount(table: string): Promise<number> {
    const result = this.executeSql(`SELECT COUNT(*) FROM ${table};`);
    return parseInt(result, 10) || 0;
  }

  /**
   * Execute raw SQL and return raw string result
   */
  async rawQuery(sql: string): Promise<string> {
    return this.withRetry(() => this.executeSql(sql), `rawQuery: ${sql.slice(0, 100)}`);
  }

  /**
   * Check if running in local mode
   */
  isLocal(): boolean {
    return this.isLocalMode;
  }

  /**
   * Interpolate SQL with parameters (basic escaping)
   */
  private interpolateSql(sql: string, params?: unknown[]): string {
    if (!params || params.length === 0) {
      return sql;
    }

    let result = sql;
    let paramIndex = 0;

    result = result.replace(/\?/g, () => {
      const param = params[paramIndex++];
      if (param === null || param === undefined) {
        return "NULL";
      }
      if (typeof param === "number") {
        return String(param);
      }
      if (typeof param === "boolean") {
        return param ? "1" : "0";
      }
      // String: escape single quotes
      return `'${String(param).replace(/'/g, "''")}'`;
    });

    return result;
  }

  /**
   * Extract column names from a SELECT query for json_object construction
   * This is a simplified version - for complex queries, use explicit column lists
   */
  private getJsonColumns(sql: string): string {
    // Match SELECT ... FROM pattern
    const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
    if (!selectMatch) {
      return "";
    }

    const selectClause = selectMatch[1];
    const columns = selectClause.split(",").map((col) => {
      const trimmed = col.trim();
      // Handle "column AS alias" or "table.column AS alias"
      const asMatch = trimmed.match(/(?:AS\s+)?(\w+)\s*$/i);
      const colName = asMatch ? asMatch[1] : trimmed.split(".").pop() || trimmed;
      return `'${colName}', ${colName}`;
    });

    return columns.join(", ");
  }
}
